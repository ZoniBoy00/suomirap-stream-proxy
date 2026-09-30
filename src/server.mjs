import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildStreamUrl } from "./stream-url.mjs";

const DEFAULT_ORIGIN = "https://suomirap-redirect.vercel.app";
const DEFAULT_STATE_FILE = "/var/lib/suomirap-proxy/usage.json";
const DEFAULT_MONTHLY_BYTES = 800_000_000_000;
const ALLOWED_UPSTREAM_HEADERS = [
  "icy-metaint",
  "icy-br",
  "icy-name",
  "icy-genre",
  "icy-description",
  "icy-url",
];
const EXPOSE_HEADERS =
  "Icy-MetaInt, Icy-Br, Icy-Name, Icy-Genre, Icy-Description, Icy-Url, Content-Type";

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function jsonResponse(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function textResponse(res, status, message, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(message);
}

function waitForDrainOrClose(res) {
  if (res.destroyed || res.writableEnded) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolvePromise();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

function loadUsage(stateFile, period) {
  try {
    const value = JSON.parse(readFileSync(stateFile, "utf8"));
    if (value.period === period && Number.isSafeInteger(value.bytes) && value.bytes >= 0)
      return value.bytes;
    return 0;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw new Error(`Cannot read stream-proxy usage state: ${error.message}`);
  }
}

export function createProxyHandler({
  allowedOrigins = process.env.PROXY_ALLOWED_ORIGINS || DEFAULT_ORIGIN,
  fetchImpl = globalThis.fetch,
  maxConcurrent = Number(process.env.PROXY_MAX_CONCURRENT || 8),
  maxRelayBytes = Number(process.env.PROXY_MAX_MONTHLY_BYTES || DEFAULT_MONTHLY_BYTES),
  now = () => new Date(),
  stateFile = process.env.PROXY_STATE_FILE || DEFAULT_STATE_FILE,
  upstreamTimeoutMs = 12_000,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const origins = new Set(
    (Array.isArray(allowedOrigins) ? allowedOrigins : String(allowedOrigins).split(","))
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  const streamLimit = Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 8;
  const byteLimit = Number.isSafeInteger(maxRelayBytes) && maxRelayBytes > 0
    ? maxRelayBytes
    : DEFAULT_MONTHLY_BYTES;
  let period = monthKey(now());
  let usedBytes = loadUsage(stateFile, period);
  let activeStreams = 0;
  let writeQueue = Promise.resolve();
  let lastPersistedBytes = usedBytes;
  let persistTimer = null;

  function refreshPeriod() {
    const currentPeriod = monthKey(now());
    if (currentPeriod !== period) {
      period = currentPeriod;
      usedBytes = 0;
      lastPersistedBytes = -1;
    }
  }

  function persistUsage() {
    refreshPeriod();
    const snapshot = JSON.stringify({ period, bytes: usedBytes });
    const temporaryPath = `${stateFile}.${process.pid}.tmp`;
    writeQueue = writeQueue
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(stateFile), { recursive: true });
        await writeFile(temporaryPath, snapshot, { mode: 0o600 });
        await rename(temporaryPath, stateFile);
        lastPersistedBytes = usedBytes;
      });
    return writeQueue;
  }

  function schedulePersist() {
    if (usedBytes - lastPersistedBytes >= 16 * 1024 * 1024) {
      void persistUsage().catch((error) => console.error("usage checkpoint failed", error));
      return;
    }
    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistUsage().catch((error) => console.error("usage checkpoint failed", error));
    }, 15_000);
    persistTimer.unref?.();
  }

  function corsHeaders(origin) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Expose-Headers": EXPOSE_HEADERS,
      "Vary": "Origin",
    };
  }

  const handler = (req, res) => {
    void handleRequest(req, res).catch((error) => {
      if (!res.headersSent) textResponse(res, 502, "Stream upstream unavailable.");
      else if (!res.destroyed) res.destroy(error);
    });
  };

  async function handleRequest(req, res) {
    const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/health" && req.method === "GET") {
      jsonResponse(res, 200, { ok: true });
      return;
    }
    if (requestUrl.pathname !== "/stream") {
      textResponse(res, 404, "Not found.");
      return;
    }

    const origin = req.headers.origin || "";
    if (!origins.has(origin)) {
      textResponse(res, 403, "Origin not allowed.");
      return;
    }
    const cors = corsHeaders(origin);

    if (req.method === "OPTIONS") {
      const requestedMethod = (req.headers["access-control-request-method"] || "GET").toUpperCase();
      const requestedHeaders = String(req.headers["access-control-request-headers"] || "")
        .split(",")
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
      const allowedHeaders = new Set(["icy-metadata", "range"]);
      if (requestedMethod !== "GET" || requestedHeaders.some((header) => !allowedHeaders.has(header))) {
        textResponse(res, 403, "CORS request not allowed.", cors);
        return;
      }
      res.writeHead(204, {
        ...cors,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Icy-MetaData, Range",
        "Access-Control-Max-Age": "600",
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }
    if (req.method !== "GET") {
      textResponse(res, 405, "Method not allowed.", { ...cors, Allow: "GET, OPTIONS" });
      return;
    }

    refreshPeriod();
    if (usedBytes >= byteLimit) {
      textResponse(res, 503, "Monthly stream relay safety limit reached.", {
        ...cors,
        "Retry-After": "3600",
      });
      return;
    }
    if (activeStreams >= streamLimit) {
      textResponse(res, 503, "Stream relay is at capacity.", {
        ...cors,
        "Retry-After": "30",
      });
      return;
    }

    activeStreams += 1;
    const abortController = new AbortController();
    let reader = null;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeStreams = Math.max(0, activeStreams - 1);
    };
    const onClose = () => {
      if (!res.writableEnded) abortController.abort();
      release();
      if (reader) void reader.cancel().catch(() => {});
      schedulePersist();
    };
    res.once("close", onClose);

    const timeout = setTimeout(() => abortController.abort(), upstreamTimeoutMs);
    timeout.unref?.();
    try {
      const requestedQuality = requestUrl.searchParams.get("q") || "";
      const upstream = await fetchImpl(buildStreamUrl(requestedQuality), {
        headers: { "Icy-MetaData": "1" },
        signal: abortController.signal,
      });
      clearTimeout(timeout);
      if (!upstream.ok || !upstream.body) {
        if (!res.destroyed) {
          textResponse(res, upstream.status || 502, "Stream upstream unavailable.", cors);
        }
        await upstream.body?.cancel().catch(() => {});
        return;
      }

      const responseHeaders = {
        ...cors,
        "Cache-Control": "no-store, no-cache, must-revalidate, no-transform",
        "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      };
      for (const name of ALLOWED_UPSTREAM_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders[name] = value;
      }
      res.writeHead(200, responseHeaders);

      reader = upstream.body.getReader();
      while (!res.destroyed && !res.writableEnded) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;

        refreshPeriod();
        usedBytes += value.byteLength;
        schedulePersist();
        if (usedBytes >= byteLimit) {
          await reader.cancel().catch(() => {});
          break;
        }
        if (usedBytes + value.byteLength > byteLimit) {
          await reader.cancel().catch(() => {});
          break;
        }
        usedBytes += value.byteLength;
        schedulePersist();
        if (!res.write(Buffer.from(value))) await waitForDrainOrClose(res);
      }
      if (!res.destroyed && !res.writableEnded) res.end();
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        if (!res.headersSent) {
          textResponse(res, 502, "Stream upstream unavailable.", cors);
        } else {
          res.end();
        }
      }
      if (error?.name !== "AbortError") console.error("stream relay error", error);
    } finally {
      clearTimeout(timeout);
      if (reader) await reader.cancel().catch(() => {});
      release();
      schedulePersist();
    }
  }

  const flushTimer = setInterval(() => {
    void persistUsage().catch((error) => console.error("usage checkpoint failed", error));
  }, 30_000);
  flushTimer.unref?.();
  handler.flush = async () => {
    clearInterval(flushTimer);
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = null;
    await persistUsage();
  };
  handler.stats = () => {
    refreshPeriod();
    return { activeStreams, period, usedBytes, maxRelayBytes: byteLimit };
  };
  return handler;
}

function startServer() {
  const handler = createProxyHandler();
  const credentialDir = process.env.CREDENTIALS_DIRECTORY || "";
  const certPath =
    process.env.TLS_CERT_PATH || (credentialDir && join(credentialDir, "fullchain.pem"));
  const keyPath =
    process.env.TLS_KEY_PATH || (credentialDir && join(credentialDir, "privkey.pem"));
  const host = process.env.HOST || "127.0.0.1";
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error("TLS_CERT_PATH and TLS_KEY_PATH must be configured together.");
  }
  if (!certPath && !["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("TLS certificates are required when listening on a public interface.");
  }
  const server =
    certPath && keyPath
      ? createSecureServer(
          { cert: readFileSync(certPath), key: readFileSync(keyPath) },
          handler,
        )
      : createServer(handler);
  const port = Number(process.env.PORT || 8819);
  server.listen(port, host, () => console.log(`Suomirap stream proxy listening on ${host}:${port}`));

  const shutdown = () => {
    server.close();
    server.closeAllConnections();
    void handler.flush().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer();
}
