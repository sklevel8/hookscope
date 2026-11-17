import dotenv from 'dotenv';

dotenv.config({ quiet: true });

function readInt(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`Invalid ${name}: expected an integer >= ${min}, got "${raw}"`);
  }

  return value;
}

function readTrustProxy() {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw || raw === 'false' || raw === '0') return false;
  if (raw === 'true') return true;

  const hops = Number(raw);
  if (Number.isInteger(hops) && hops >= 0) return hops;

  // Express also accepts IP addresses, subnets, and comma-separated lists.
  return raw;
}

function readStoreDriver() {
  const driver = (process.env.STORE_DRIVER || 'auto').toLowerCase();
  if (!['auto', 'redis', 'memory'].includes(driver)) {
    throw new Error(`Invalid STORE_DRIVER: expected auto, redis, or memory, got "${driver}"`);
  }
  return driver;
}

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: readInt('PORT', 3000),
  storeDriver: readStoreDriver(),
  redisUrl: process.env.REDIS_URL?.trim() || '',
  binTtlSeconds: readInt('BIN_TTL_SECONDS', 3600, { min: 1 }),
  maxRequestsPerBin: readInt('MAX_REQUESTS_PER_BIN', 200, { min: 1 }),
  maxBodySize: process.env.MAX_BODY_SIZE?.trim() || '1mb',
  sseHeartbeatMs: readInt('SSE_HEARTBEAT_MS', 20_000, { min: 1_000 }),
  maxSseClientsPerBin: readInt('MAX_SSE_CLIENTS_PER_BIN', 20, { min: 1 }),
  trustProxy: readTrustProxy(),
  rateLimitEnabled: process.env.RATE_LIMIT_DISABLED !== '1',
});
