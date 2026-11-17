import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory-store.js';

const silentLogger = {
  log() {},
  info() {},
  warn() {},
  error() {},
};

async function startServer(t, overrides = {}) {
  const store = overrides.store ?? new MemoryStore({ cleanupIntervalMs: 0 });
  const { app, hub } = createApp({
    store,
    rateLimitEnabled: false,
    logger: silentLogger,
    ...overrides,
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  t.after(async () => {
    hub.close();
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });

  return { baseUrl: `http://127.0.0.1:${port}`, store, hub, server };
}

async function createBin(baseUrl) {
  const response = await fetch(`${baseUrl}/api/bins`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  assert.equal(response.status, 201);
  return response.json();
}

function sseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    async next(timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;

      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          const dataLines = frame
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6));

          if (dataLines.length > 0) return JSON.parse(dataLines.join('\n'));
          continue;
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Timed out waiting for an SSE event');

        let timer;
        const timeout = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Timed out waiting for an SSE event')), remaining);
        });

        try {
          const chunk = await Promise.race([reader.read(), timeout]);
          if (chunk.done) throw new Error('SSE stream closed unexpectedly');
          buffer += decoder.decode(chunk.value, { stream: true });
        } finally {
          clearTimeout(timer);
        }
      }
    },
    cancel() {
      return reader.cancel().catch(() => {});
    },
  };
}

test('creates a bin and captures a JSON webhook end to end', async (t) => {
  const { baseUrl } = await startServer(t);
  const bin = await createBin(baseUrl);

  assert.match(bin.token, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(bin.endpoint, `/wh/${bin.token}`);
  assert.equal(bin.ttlWindowSeconds, 3600);
  assert.ok(Date.parse(bin.expiresAt) > Date.now());

  const rawBody = '{\n  "action": "opened",\n  "nested": { "ok": true }\n}\n';
  const response = await fetch(`${baseUrl}/wh/${bin.token}?foo=bar&tag=a&tag=b`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-custom': 'hello',
    },
    body: rawBody,
  });

  assert.equal(response.status, 200);
  const delivery = await response.json();
  assert.equal(delivery.ok, true);
  assert.equal(delivery.deliveredTo, 0);

  const historyResponse = await fetch(`${baseUrl}/api/bins/${bin.token}`);
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();

  assert.equal(history.requests.length, 1);
  const request = history.requests[0];

  assert.equal(request.method, 'POST');
  assert.equal(request.path, `/wh/${bin.token}?foo=bar&tag=a&tag=b`);
  assert.equal(request.body.action, 'opened');
  assert.deepEqual(request.body.nested, { ok: true });
  assert.equal(request.rawBody, rawBody);
  assert.equal(request.bodyType, 'json');
  assert.equal(request.isJson, true);
  assert.equal(request.query.foo, 'bar');
  assert.deepEqual(request.query.tag, ['a', 'b']);
  assert.equal(request.headers['x-github-event'], 'push');
  assert.equal(request.headers['x-custom'], 'hello');
  assert.equal(request.contentType, 'application/json');
  assert.ok(request.ip);
  assert.ok(request.bodySize > 0);
  assert.ok(Date.parse(request.receivedAt));
});

test('captures plain text and URL-encoded form bodies', async (t) => {
  const { baseUrl } = await startServer(t);
  const bin = await createBin(baseUrl);

  await fetch(`${baseUrl}/wh/${bin.token}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'hello from a webhook',
  });

  await fetch(`${baseUrl}/wh/${bin.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Sipho&role=engineer&tag=one&tag=two',
  });

  const history = await (await fetch(`${baseUrl}/api/bins/${bin.token}`)).json();
  assert.equal(history.requests.length, 2);

  const formRequest = history.requests[0];
  assert.equal(formRequest.bodyType, 'form');
  assert.equal(formRequest.body.name, 'Sipho');
  assert.equal(formRequest.body.role, 'engineer');
  assert.deepEqual(formRequest.body.tag, ['one', 'two']);

  const textRequest = history.requests[1];
  assert.equal(textRequest.bodyType, 'text');
  assert.equal(textRequest.body, 'hello from a webhook');
  assert.equal(textRequest.rawBody, 'hello from a webhook');
});

test('keeps binary payloads as base64 instead of corrupting them', async (t) => {
  const { baseUrl } = await startServer(t);
  const bin = await createBin(baseUrl);
  const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);

  const response = await fetch(`${baseUrl}/wh/${bin.token}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  assert.equal(response.status, 200);

  const history = await (await fetch(`${baseUrl}/api/bins/${bin.token}`)).json();
  const request = history.requests[0];

  assert.equal(request.method, 'PUT');
  assert.equal(request.bodyType, 'binary');
  assert.equal(request.bodyEncoding, 'base64');
  assert.equal(request.body, null);
  assert.equal(request.rawBody, bytes.toString('base64'));
  assert.equal(request.bodySize, bytes.length);
});

test('returns 404 for missing and expired bins', async (t) => {
  const { baseUrl } = await startServer(t, { binTtlSeconds: 0.12 });

  const missing = await fetch(`${baseUrl}/wh/does-not-exist`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'BIN_NOT_FOUND');

  const bin = await createBin(baseUrl);
  assert.equal((await fetch(`${baseUrl}/api/bins/${bin.token}`)).status, 200);

  await new Promise((resolve) => setTimeout(resolve, 180));

  assert.equal((await fetch(`${baseUrl}/api/bins/${bin.token}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/bins/${bin.token}/meta`)).status, 404);

  const expiredWebhook = await fetch(`${baseUrl}/wh/${bin.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"late":true}',
  });
  assert.equal(expiredWebhook.status, 404);
});

test('caps history at maxRequestsPerBin and returns newest first', async (t) => {
  const { baseUrl } = await startServer(t, { maxRequestsPerBin: 2 });
  const bin = await createBin(baseUrl);

  for (const index of [1, 2, 3]) {
    const response = await fetch(`${baseUrl}/wh/${bin.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ index }),
    });
    assert.equal(response.status, 200);
  }

  const history = await (await fetch(`${baseUrl}/api/bins/${bin.token}`)).json();
  assert.equal(history.requests.length, 2);
  assert.deepEqual(
    history.requests.map((request) => request.body.index),
    [3, 2],
  );
});

test('deletes a bin immediately and idempotently', async (t) => {
  const { baseUrl } = await startServer(t);
  const bin = await createBin(baseUrl);

  assert.equal((await fetch(`${baseUrl}/api/bins/${bin.token}`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${baseUrl}/api/bins/${bin.token}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/bins/${bin.token}`, { method: 'DELETE' })).status, 204);
});

test('rejects bodies over the configured limit with JSON 413', async (t) => {
  const { baseUrl } = await startServer(t, { maxBodySize: '1kb' });
  const bin = await createBin(baseUrl);

  const response = await fetch(`${baseUrl}/wh/${bin.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(2_048) }),
  });

  assert.equal(response.status, 413);
  const payload = await response.json();
  assert.equal(payload.code, 'PAYLOAD_TOO_LARGE');
});

test('streams captured requests to SSE subscribers in real time', async (t) => {
  const { baseUrl } = await startServer(t);
  const bin = await createBin(baseUrl);

  const controller = new AbortController();
  t.after(() => controller.abort());

  const streamResponse = await fetch(`${baseUrl}/api/bins/${bin.token}/stream`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get('content-type'), /text\/event-stream/);

  const stream = sseReader(streamResponse);
  t.after(() => stream.cancel());

  const connected = await stream.next();
  assert.equal(connected.type, 'connected');
  assert.equal(connected.token, bin.token);

  const delivery = await fetch(`${baseUrl}/wh/${bin.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"streamed":true}',
  });
  assert.equal(delivery.status, 200);
  assert.equal((await delivery.json()).deliveredTo, 1);

  const event = await stream.next();
  assert.equal(event.type, 'request');
  assert.equal(event.request.method, 'POST');
  assert.equal(event.request.body.streamed, true);
  assert.ok(event.expiresAt);
});

test('health endpoint reports the active store', async (t) => {
  const { baseUrl } = await startServer(t);
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.store, 'memory');
});
