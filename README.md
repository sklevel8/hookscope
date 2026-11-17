# HookScope — real-time webhook inspector

Open the app, get a throwaway endpoint, point a provider at it, and watch the requests arrive live.
No account, no listener to deploy, no payload retained longer than an hour.

**Live demo:** https://sklevel8-hookscope.netlify.app
**Stack:** Node.js 20 · Express · Server-Sent Events · Redis (or in-memory)

---

## Why this exists

Debugging a webhook is uniquely awkward. You cannot see the request until you have something
listening, and the thing you most need to inspect — headers, query strings, the **exact bytes of
the body** — is exactly what frameworks normalise away. Stripe and GitHub sign the raw body, so a
re-serialised JSON object is useless for checking a signature.

The usual workaround is to stand up a tunnel and a throwaway server. That takes minutes and then
leaves a listener running. HookScope collapses that into: open a page, get a URL, send the request,
read it.

The second design driver is privacy. Webhook payloads routinely contain payment details, email
addresses and customer identifiers. A debugging tool should not become a permanent store of them,
so a bin and everything captured in it expire **one hour after the last request** — the TTL is
refreshed on every new payload, and expiry is the default rather than a cleanup job.

## How it works

```
Browser ──POST /api/bins──────────────► creates a bin, returns /wh/<token> + expiry
   │
   │◄────── SSE /api/bins/<token>/stream ──── pushed request objects + heartbeats
   │
Provider ──POST /wh/<token>──► capture raw body ─► store ─► broadcast to SSE subscribers
```

**Bins.** A token is 96 bits of URL-safe randomness (`/wh/:token`), so guessing one is not a
realistic path to someone else's traffic. The token *is* the capability — there is nothing else to
authenticate.

**Capture.** The ingest route reads the body as a buffer, preserving both the parsed form (JSON or
URL-encoded) and the untouched `rawBody`. The inspector shows you both, and "copy as cURL"
reconstructs the request with its original headers and bytes so signature checks behave the same
way when you replay it.

**Streaming.** Subscribers get new requests over Server-Sent Events, which is a better fit than
WebSockets here: traffic is one-directional, reconnection is built into the browser, and it stays
plain HTTP. The hub sends periodic heartbeats so proxies do not silently drop an idle stream, caps
concurrent subscribers per bin, and drops slow clients rather than buffering without bound.

**Expiry.** In production the store is Redis with a sliding TTL — each captured request resets it.
In development, if Redis is not running, the app logs a warning and falls back to an in-memory
store so `npm run dev` works with no Docker.

### API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness plus active store driver |
| `POST` | `/api/bins` | Create a bin |
| `GET` | `/api/bins/:token` | Bin metadata and captured requests |
| `GET` | `/api/bins/:token/meta` | Metadata only (used for expiry polling) |
| `DELETE` | `/api/bins/:token` | Destroy a bin immediately |
| `GET` | `/api/bins/:token/stream` | SSE stream of new requests |
| *any* | `/wh/:token/*` | Ingest a webhook |

## Features

- Capability-URL bins with 96-bit tokens and sliding expiry
- Live inspector over SSE with heartbeats and reconnect handling
- Headers, query parameters, IP, HTTP version, content type, body size, parsed body and raw body
- Copy-as-cURL that reproduces the original request
- Untrusted payloads rendered as DOM text nodes under a strict Content Security Policy — never
  `innerHTML`
- Body-size caps, per-IP rate limits, per-bin request caps and per-bin subscriber caps
- Graceful shutdown, health checks, and an in-memory fallback store

## Run it locally

Requirements: Node.js 20.11+. Redis is optional.

```bash
npm install
cp .env.example .env
npm run dev
```

Open <http://localhost:3000>, then from another terminal:

```bash
curl -X POST http://localhost:3000/wh/<your-token> \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -d '{"action":"opened","repository":{"name":"hookscope"}}'
```

The request appears in the list immediately.

With real TTL behaviour:

```bash
docker compose up --build     # Redis-backed store
```

| Variable | Default | Notes |
| --- | --- | --- |
| `STORE_DRIVER` | `auto` | `redis`, `memory`, or `auto` (fall back if Redis is down) |
| `BIN_TTL_SECONDS` | `3600` | Sliding window, refreshed on every request |
| `MAX_REQUESTS_PER_BIN` | `200` | Oldest requests are dropped beyond this |
| `MAX_BODY_SIZE` | `1mb` | Ingest body cap |
| `MAX_SSE_CLIENTS_PER_BIN` | `20` | Backpressure guard |
| `SSE_HEARTBEAT_MS` | `20000` | Keep-alive interval |

## The deployed demo

The Netlify site publishes `public/`. Before the app module loads, `public/demo-api.js` installs a
fetch interceptor and a small `EventSource` replacement, so the inspector runs entirely in the
browser: bins are created in memory, a realistic set of provider payloads (Stripe, GitHub,
Shopify, PayFast, a health probe) streams in on a timer, and the "new bin" button works as it does
locally.

That shim is what makes a static host useful here. A real webhook inspector needs a server that can
accept POSTs from third parties; the demo reproduces the interface and the data shapes, and labels
itself as a demo in the header. The genuine implementation is `src/`.

## Project layout

```
src/app.js                  routes, middleware, SSE hub wiring
src/index.js                server bootstrap and graceful shutdown
src/lib/body.js             body parsing that keeps raw bytes
src/lib/request.js          captured-request shape
src/lib/token.js            bin token generation
src/realtime/hub.js         SSE subscriber registry and broadcasting
src/store/memory-store.js   in-memory store with TTL
src/store/redis-store.js    Redis-backed sliding-TTL store
public/                     dashboard + demo shim (the deployed site)
test/                       node:test suites
```

## Tests

```bash
npm test
```

## Deployment

`netlify.toml` publishes `public/`, adds security headers, and rewrites `/b/*` back to `index.html`
so a shared bin link opens the inspector instead of 404-ing. The real service is a normal Node app
with a `Dockerfile` and `compose.yaml`.

## Licence

MIT
