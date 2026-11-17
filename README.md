# HookScope — Real-Time Webhook Inspector

An ephemeral webhook tester in the spirit of Webhook.site: open the app, get a unique
endpoint, fire any HTTP request at it, and watch the method, headers, query parameters,
raw body, and parsed payload stream into a browser inspector over Server-Sent Events.

Bins expire automatically. In production, payloads live in Redis with a sliding TTL, so
the inspector never becomes a permanent data store.

## Features

- **Unique capability URLs** — 96-bit URL-safe tokens (`/wh/:token`), no accounts needed.
- **Live capture over SSE** — requests appear instantly without polling or refreshing.
- **Full request inspection** — headers, decoded query params, IP address, HTTP version,
  content type, body size, parsed JSON/form data, and the exact raw body.
- **Raw body preservation** — important for inspecting Stripe/GitHub style HMAC signatures
  that break if a body is re-serialized.
- **Redis-backed TTL storage** — a bin and its payloads disappear 1 hour after the last
  request. The TTL is refreshed on every captured webhook.- **Automatic Redis fallback** — in development, if Redis is unavailable the app logs a
  warning and uses an in-memory store, so `npm run dev` works without Docker.
- **Copy as cURL** — rebuild a captured request, including custom signature headers and
  the raw body, from the inspector.
- **Safe rendering** — untrusted payloads are rendered with DOM text nodes, never
  `innerHTML`, under a strict Content Security Policy.
- **Operational details** — SSE heartbeats, client backpressure limits, reconnect handling,
  body-size limits, per-IP rate limits, request caps, graceful shutdown, and health checks.

## Quick start

Requirements: Node.js 20.11+ and npm. Redis is optional for local development.

```bash
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
npm run dev
```

Open <http://localhost:3000>. The dashboard creates a new bin and gives you a URL like:

```text
http://localhost:3000/wh/4f9b2c1a9d3e7f80
```

Send a request from another terminal:

```bash
curl -X POST http://localhost:3000/wh/YOUR_TOKEN \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -d '{"action":"opened","repository":{"name":"high-performance-url-shortener"}}'
```

The request appears in the list immediately. Click it to inspect the body, headers, query
parameters, and reconstructed raw HTTP request.

> If port 3000 is already taken by another project, use `PORT=3100 npm start` or set
> `PORT=3100` in `.env`.

### Run with Redis

Redis is what makes the TTL behavior real. With Docker:

```bash
docker compose up --build
```

Or run Redis by itself and point `.env` at it:

```bash
docker run --rm -p 6379:6379 redis:7-alpine
```

```env
STORE_DRIVER=redis
REDIS_URL=redis://localhost:6379
```

Then `npm run dev`. The header badge and `/api/health` show `redis` instead of `memory`.

`STORE_DRIVER=auto` (the default) probes Redis and falls back to memory if it is not
reachable. Use `STORE_DRIVER=redis` in production so a misconfiguration fails fast instead
of silently losing history on restart.

## How it works

```text
                         POST /api/bins
Browser ──────────────────────────────────────┐
   │                                          ▼
   │  EventSource                   Express (Node.js)
   │  GET /api/bins/:token/stream   ├── static dashboard
   └──────────── SSE ───────────────┤
                                     ├── POST /api/bins       → allocate token
Webhook sender                       ├── ALL  /wh/:token      → capture request
   │                                 ├── GET  /api/bins/:token → history
   └──── POST /wh/:token ────────────┤
                                     └── Redis store
                                          RPUSH requests
                                          EXPIRE bin + list
```

1. The browser asks the API for a new bin. The server generates a random token and creates
   a Redis key with a TTL.
2. The browser opens an `EventSource` to `/api/bins/:token/stream`. The SSE hub keeps one
   response stream per viewer and sends a heartbeat every 20 seconds.
3. An external service posts to `/wh/:token`. Express captures the raw bytes, parses them
   best-effort, appends the request to Redis, and publishes the same object to every live
   SSE viewer for that token.
4. Each new webhook refreshes the bin's TTL. Redis removes the metadata and request list
   after the configured inactivity window.

### Captured request shape

```json
{
  "id": "0659bc89-3e0f-419c-8a02-d2da6765fe43",
  "method": "POST",
  "path": "/wh/nKS2De0SHb714A0_?source=github",
  "pathname": "/wh/nKS2De0SHb714A0_",
  "query": { "source": "github" },
  "rawQuery": "source=github",
  "headers": { "content-type": "application/json" },
  "ip": "127.0.0.1",
  "remoteAddress": "::ffff:127.0.0.1",
  "httpVersion": "1.1",
  "protocol": "http",
  "receivedAt": "2026-10-29T12:15:17.865Z",
  "contentType": "application/json",
  "body": { "event": "deployment" },
  "rawBody": "{\"event\":\"deployment\"}",
  "bodyEncoding": "utf8",
  "bodyType": "json",
  "isJson": true,
  "parseError": null,
  "bodySize": 23
}
```

Binary bodies are stored as base64 (`bodyEncoding: "base64"`) so images, protobuf, and
other non-UTF-8 payloads are not corrupted. Multipart bodies are shown as a raw preview.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/bins` | Create a bin. Returns `token`, `endpoint`, `ttlSeconds`, `expiresAt`. |
| `GET` | `/api/bins/:token` | Fetch request history, newest first. `404` when expired. |
| `GET` | `/api/bins/:token/meta` | Lightweight TTL/status check used by SSE reconnect logic. |
| `GET` | `/api/bins/:token/stream` | SSE stream. Emits `connected` and `request` events. |
| `DELETE` | `/api/bins/:token` | Delete a bin immediately (idempotent, `204`). |
| `ANY` | `/wh/:token` | Capture any method/path. Responds `200` with the received request ID. |
| `GET` | `/api/health` | `{ ok, store, uptimeSeconds }`. |

All mutating webhook responses use the same envelope:

```json
{ "ok": true, "id": "…", "receivedAt": "…", "deliveredTo": 1 }
```

`deliveredTo` is the number of live SSE viewers that saw the event.

## Configuration

Copy `.env.example` to `.env` and adjust as needed.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `STORE_DRIVER` | `auto` | `auto`, `redis`, or `memory`. |
| `REDIS_URL` | — | Required for `redis`; `rediss://` works for Upstash/TLS. |
| `BIN_TTL_SECONDS` | `3600` | Sliding inactivity TTL, refreshed on each webhook. |
| `MAX_REQUESTS_PER_BIN` | `200` | Stored history cap; oldest requests are trimmed. |
| `MAX_BODY_SIZE` | `1mb` | Express raw body limit; larger requests get a JSON `413`. |
| `TRUST_PROXY` | `0` | Set to `1` behind Render/Railway/Fly/nginx so `req.ip` uses `X-Forwarded-For`. |
| `SSE_HEARTBEAT_MS` | `20000` | SSE keep-alive comment interval. |
| `MAX_SSE_CLIENTS_PER_BIN` | `20` | Prevents a single bin from exhausting stream slots. |
| `RATE_LIMIT_DISABLED` | `0` | Set to `1` for load tests. |

## Security and resource notes

- A bin token is a **capability URL**: anyone with the URL can send requests to it and
  view its history. Treat it like a secret while the bin is alive.
- Payloads are untrusted. The frontend builds every value with `textContent` and the app
  ships a strict CSP (`script-src 'self'`, no inline scripts/styles).
- The webhook receiver has a 1 MB body limit, a per-IP rate limit, a per-bin stored-request
  cap, and a Redis TTL. There is no authentication or per-bin byte budget; if you expose
  this publicly, put it behind your normal abuse controls and use managed Redis limits.
- Webhook payloads are never written to logs. Only counts/errors are logged.
- `TRUST_PROXY=1` is only appropriate when there is exactly one trusted reverse proxy in
  front of the app. Otherwise clients can spoof `X-Forwarded-For`.
- In-memory mode is for development and tests. It is not shared between processes and is
  lost on restart.

## Testing

```bash
npm test
```

The suite uses Node's built-in test runner and an in-memory store. It covers JSON, form,
text, and binary capture; raw body preservation; TTL expiry; request caps; deletion;
oversized payloads; SSE delivery; health; and the Redis fallback path.

To watch tests:

```bash
npm run test:watch
```

## Deployment

SSE needs a long-lived Node process. **Do not deploy this to Vercel serverless functions**:
functions are short-lived, connections are not guaranteed to stay open, and the in-memory
store is not shared across instances. Use Render, Railway, Fly.io, a VPS, or any container
host that supports streaming responses.

### Render

1. Push this repository to GitHub.
2. Create a Render **Key Value** (Redis-compatible) instance, or an Upstash Redis database.
3. Create a **Web Service** from the repository:
   - Runtime: Node
   - Build command: `npm ci`
   - Start command: `npm start`
   - Health check path: `/api/health`
4. Set environment variables:

```env
NODE_ENV=production
STORE_DRIVER=redis
REDIS_URL=rediss://...        # copy from your Redis provider
TRUST_PROXY=1
BIN_TTL_SECONDS=3600
```

5. Deploy, open the service URL, and check `/api/health` reports `"store": "redis"`.

### Docker / any VPS

```bash
docker compose up --build -d
```

The included `compose.yaml` runs the app and a local Redis instance. For a public
deployment, terminate TLS at your proxy and set `TRUST_PROXY=1` (or the number of proxy
hops). The app sends `X-Accel-Buffering: no` on the SSE route so nginx does not buffer the
stream.

## Project structure

```text
src/
  app.js                 Express app factory, routes, SSE wiring, error handling
  index.js               Startup, listener, graceful shutdown
  config.js              Environment parsing and validation
  lib/
    body.js              Raw-buffer parsing, JSON/form/text/binary detection
    request.js           Captured-request model
    token.js             96-bit URL-safe token helpers
  realtime/
    hub.js               SSE channel hub, heartbeats, backpressure
  store/
    index.js             Store selection + Redis probe/fallback
    redis-store.js       Redis list + TTL implementation
    memory-store.js      Development/test implementation
public/
  index.html             Dashboard shell
  app.js                 SSE client, inspector, filtering, copy-as-cURL
  styles.css             Design system, responsive layout
  favicon.svg
test/
  app.test.js            End-to-end HTTP/SSE tests
  unit.test.js           Parser, store, and fallback tests
```

## Design decisions worth calling out

- **Raw bytes over parsed-only bodies.** Many webhook providers sign the raw request body.
  Re-serializing JSON changes whitespace/key order and breaks signature checks, so the
  server preserves the original text/base64 alongside the parsed view.
- **Sliding TTL.** The TTL refreshes on each new request, so an actively used bin stays
  alive; an abandoned one disappears. Redis expires both the metadata and the request list.
- **SSE instead of WebSockets.** The data flow is one-way (server → browser), SSE is built
  into browsers, reconnects automatically, and works over plain HTTP without an upgrade.
- **Text nodes, not HTML.** A webhook inspector is an XSS target by definition: the payload
  is attacker-controlled. Rendering is entirely DOM/text based, and CSP is a second layer.
- **Pluggable store.** The app factory accepts any store with a small interface, which keeps
  HTTP tests fast and makes the Redis path explicit at startup.
