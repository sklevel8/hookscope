import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBody } from '../src/lib/body.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { createStore } from '../src/store/index.js';

const silentLogger = {
  log() {},
  info() {},
  warn() {},
  error() {},
};

test('parseBody leaves empty bodies empty', () => {
  const result = parseBody(Buffer.alloc(0), 'application/json');
  assert.equal(result.bodyType, 'empty');
  assert.equal(result.body, null);
  assert.equal(result.rawBody, '');
  assert.equal(result.bodySize, 0);
});

test('parseBody reports JSON parse errors without losing the raw payload', () => {
  const raw = '{"broken":';
  const result = parseBody(Buffer.from(raw), 'application/json');

  assert.equal(result.bodyType, 'json');
  assert.equal(result.isJson, false);
  assert.equal(result.body, raw);
  assert.equal(result.rawBody, raw);
  assert.match(result.parseError, /could not be parsed/i);
});

test('parseBody groups repeated form fields into arrays', () => {
  const result = parseBody(
    Buffer.from('a=1&b=two&b=three&__proto__=safe'),
    'application/x-www-form-urlencoded',
  );

  assert.equal(result.bodyType, 'form');
  assert.equal(result.body.a, '1');
  assert.deepEqual(result.body.b, ['two', 'three']);
  assert.equal(result.body.__proto__, 'safe');
});

test('MemoryStore refreshes its inactivity TTL on new requests', async () => {
  let now = 1_000;
  const store = new MemoryStore({ now: () => now, cleanupIntervalMs: 0 });

  assert.equal(await store.createBin('token-1234', 10), true);
  assert.equal(await store.createBin('token-1234', 10), false);

  now += 8_000;
  const ttl = await store.addRequest(
    'token-1234',
    { id: 'request-1' },
    { ttlSeconds: 10, maxRequests: 10 },
  );
  assert.equal(ttl, 10);

  now += 8_000;
  const history = await store.listRequests('token-1234');
  assert.equal(history.requests.length, 1);
  assert.equal(history.requests[0].id, 'request-1');

  now += 11_000;
  assert.equal(await store.getBinMeta('token-1234'), null);
  assert.equal(await store.listRequests('token-1234'), null);

  await store.close();
});

test('MemoryStore keeps only the newest requests', async () => {
  const store = new MemoryStore({ cleanupIntervalMs: 0 });
  await store.createBin('token-5678', 60);

  for (const id of ['one', 'two', 'three']) {
    await store.addRequest(
      'token-5678',
      { id },
      { ttlSeconds: 60, maxRequests: 2 },
    );
  }

  const history = await store.listRequests('token-5678');
  assert.deepEqual(history.requests.map((request) => request.id), ['three', 'two']);

  await store.close();
});

test('createStore falls back to memory when auto-detected Redis is down', async () => {
  const store = await createStore({
    driver: 'auto',
    redisUrl: 'redis://127.0.0.1:1',
    logger: silentLogger,
  });

  assert.equal(store.name, 'memory');
  await store.close();
});

test('createStore fails fast when Redis is explicitly required', async () => {
  await assert.rejects(
    createStore({
      driver: 'redis',
      redisUrl: 'redis://127.0.0.1:1',
      logger: silentLogger,
    }),
  );
});
