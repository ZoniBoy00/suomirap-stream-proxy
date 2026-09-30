import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyHandler } from "../src/server.mjs";

const PLAYER_ORIGIN = "https://suomirap-redirect.vercel.app";

async function withProxy(options, callback) {
  const stateDir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "sr-proxy-"));
  const { beforeStart, ...handlerOptions } = options;
  if (beforeStart) await beforeStart(stateDir);
  const server = createServer(
    createProxyHandler({
      allowedOrigins: [PLAYER_ORIGIN],
      stateFile: join(stateDir, "usage.json"),
      ...handlerOptions,
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`, stateDir);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}

function upstreamResponse(chunks = ["audio-one", "audio-two"]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "audio/mpeg",
      "icy-metaint": "1024",
      "icy-br": "128",
      "icy-name": "Suomirap",
    },
  });
}

test("answers only the player origin's ICY CORS preflight", async () => {
  await withProxy({ fetchImpl: async () => assert.fail("preflight must not fetch") }, async (base) => {
    const allowed = await fetch(`${base}/stream?q=128`, {
      method: "OPTIONS",
      headers: {
        Origin: PLAYER_ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Icy-MetaData",
      },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), PLAYER_ORIGIN);
    assert.match(allowed.headers.get("access-control-allow-headers"), /icy-metadata/i);

    const denied = await fetch(`${base}/stream?q=128`, {
      method: "OPTIONS",
      headers: { Origin: "https://example.invalid" },
    });
    assert.equal(denied.status, 403);
  });
});

test("passes ICY audio bytes and metadata headers from the fixed stream origin", async () => {
  let upstreamUrl;
  let upstreamHeaders;
  await withProxy(
    {
      fetchImpl: async (url, options) => {
        upstreamUrl = new URL(url);
        upstreamHeaders = new Headers(options.headers);
        return upstreamResponse();
      },
    },
    async (base) => {
      const response = await fetch(`${base}/stream?q=128`, {
        headers: { Origin: PLAYER_ORIGIN, "Icy-MetaData": "1" },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "audio/mpeg");
      assert.equal(response.headers.get("icy-metaint"), "1024");
      assert.equal(response.headers.get("access-control-allow-origin"), PLAYER_ORIGIN);
      assert.match(response.headers.get("access-control-expose-headers"), /icy-metaint/i);
      assert.equal(await response.text(), "audio-oneaudio-two");
      assert.equal(upstreamUrl.hostname, "live-bauerfi.sharp-stream.com");
      assert.equal(upstreamUrl.pathname, "/fi_suomirap_128.mp3");
      assert.equal(upstreamUrl.searchParams.get("direct"), "true");
      assert.equal(upstreamUrl.searchParams.get("aw_0_1st.playerid"), "BMUK_inpage_html5");
      assert.match(upstreamUrl.searchParams.get("aw_0_1st.skey"), /^\d+$/);
      assert.ok(upstreamUrl.searchParams.get("aw_0_req.userConsentV2"));
      assert.equal(upstreamHeaders.get("icy-metadata"), "1");
    },
  );
});

test("rejects other paths and origins without opening an upstream connection", async () => {
  let upstreamCalls = 0;
  await withProxy({ fetchImpl: async () => (upstreamCalls++, upstreamResponse()) }, async (base) => {
    const wrongPath = await fetch(`${base}/anything`, {
      headers: { Origin: PLAYER_ORIGIN },
    });
    assert.equal(wrongPath.status, 404);

    const wrongOrigin = await fetch(`${base}/stream?q=64`, {
      headers: { Origin: "https://example.invalid" },
    });
    assert.equal(wrongOrigin.status, 403);
    assert.equal(upstreamCalls, 0);
  });
});

test("enforces the persisted relay-byte safety limit", async () => {
  let upstreamCalls = 0;
  await withProxy(
    {
      maxRelayBytes: 1000,
      now: () => new Date("2026-09-30T12:00:00Z"),
      beforeStart: (stateDir) =>
        writeFile(
          join(stateDir, "usage.json"),
          JSON.stringify({ period: "2026-09", bytes: 1000 }),
        ),
      fetchImpl: async () => (upstreamCalls++, upstreamResponse()),
    },
    async (base, stateDir) => {
      const response = await fetch(`${base}/stream?q=64`, {
        headers: { Origin: PLAYER_ORIGIN },
      });
      assert.equal(response.status, 503);
      assert.equal(upstreamCalls, 0);
      assert.deepEqual(JSON.parse(await readFile(join(stateDir, "usage.json"), "utf8")), {
        period: "2026-09",
        bytes: 1000,
      });
    },
  );
});

test("limits simultaneous streams and aborts the upstream when a listener disconnects", async () => {
  let upstreamSignal;
  await withProxy(
    {
      maxConcurrent: 1,
      fetchImpl: async (_url, options) => {
        upstreamSignal = options.signal;
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("audio"));
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "audio/mpeg", "icy-metaint": "1024" },
        });
      },
    },
    async (base) => {
      const first = await fetch(`${base}/stream?q=128`, {
        headers: { Origin: PLAYER_ORIGIN },
      });
      assert.equal(first.status, 200);
      const reader = first.body.getReader();
      await reader.read();

      const second = await fetch(`${base}/stream?q=64`, {
        headers: { Origin: PLAYER_ORIGIN },
      });
      assert.equal(second.status, 503);
      await reader.cancel();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(upstreamSignal.aborted, true);
    },
  );
});
