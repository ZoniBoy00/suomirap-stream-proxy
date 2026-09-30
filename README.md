# Suomirap Stream Proxy

A narrowly scoped ICY stream relay for the Suomirap radio player. It forwards only the configured Bauer/RadioPlay 64 kbps AAC or 128 kbps MP3 endpoint; it is not a general-purpose URL proxy.

## Runtime endpoint

The production player uses the direct IP-and-port URL:

```text
https://5.61.90.42:8443/stream?q=64
https://5.61.90.42:8443/stream?q=128
```

The service requests `Icy-MetaData: 1` upstream and streams the same ICY-framed response to the browser. The browser-side Icecast player parses metadata from that audio connection and schedules it against playback. CORS is restricted to `https://suomirap-redirect.vercel.app`.

The IP-address TLS certificate is a short-lived Let's Encrypt certificate. It must be automatically renewed; see `systemd/` and `scripts/renew-ip-cert.sh`.

## Resource and abuse limits

- Maximum 8 simultaneous streams.
- Monthly relay safety cap: 800,000,000,000 bytes, counting both bytes received from the radio source and bytes forwarded to listeners. The counter is persisted at `/var/lib/suomirap-proxy/usage.json` and resets by UTC calendar month.
- The upstream hostname and stream mounts are fixed in `src/stream-url.mjs`; requests cannot supply an arbitrary URL.
- Only GET and CORS OPTIONS are accepted for `/stream`; other paths do not proxy.

These are application-side safeguards, not a substitute for checking the VPS provider's traffic meter. The published Tietokettu Mini plan includes 1 TB/month; confirm how the provider accounts for ingress and egress if the plan changes.

## Install on Tietokettu

Requires Node.js 22.x, Docker (for the official Certbot image), systemd, and an available public TCP port 8443. The TLS-ALPN-01 certificate validation uses public TCP port 443.

1. Install this repository at `/opt/suomirap-stream-proxy` and create a locked service account `suomirap-proxy`.
2. Create `/var/lib/suomirap-proxy` owned by that account.
3. Issue the initial IP certificate with Certbot 5.4+ using the `shortlived` profile and `tls-alpn-01` challenge. Use the certificate name `suomirap-proxy-ip`.
4. Install `systemd/suomirap-stream-proxy.service`, `systemd/suomirap-certbot-renew.service`, and `systemd/suomirap-certbot-renew.timer`; enable both services.
5. Verify `https://5.61.90.42:8443/health`, CORS preflight, and a real stream request before switching the website.

The service unit loads certificate and private-key files through systemd credentials and binds only the stream service on port 8443. Do not place certificate keys or runtime usage state in Git.

## Development

```sh
node --test
node --check src/server.mjs
node --check src/stream-url.mjs
```

Tests use a local fake upstream; they do not make radio requests.

## Rights and consent

The software license applies only to this repository's code. RadioPlay/Bauer owns the upstream stream, artwork, and metadata. The upstream request preserves the existing fixed `userConsentV2` parameter; that value is not collected from individual listeners and must not be represented as their consent.
