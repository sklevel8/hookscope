import { createClient } from 'redis';
import { MemoryStore } from './memory-store.js';
import { RedisStore } from './redis-store.js';

function maskRedisUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<invalid REDIS_URL>';
  }
}

async function connectRedis(url, { reconnect = true, connectTimeout = 5_000 } = {}) {
  let ready = false;

  const client = createClient({
    url,
    socket: {
      connectTimeout,
      reconnectStrategy: reconnect
        ? (retries) => {
            // Fail fast on the initial connection, but keep retrying after a
            // previously healthy connection drops.
            if (!ready) return false;
            return Math.min(250 * 2 ** Math.min(retries, 4), 4_000);
          }
        : false,
    },
  });

  // Register before connect so a connection failure cannot become an
  // unhandled EventEmitter error.
  let lastError;
  client.on('error', (error) => {
    lastError = error;
  });
  client.on('ready', () => {
    ready = true;
  });

  try {
    await client.connect();
    return client;
  } catch (error) {
    try {
      client.destroy();
    } catch {
      // Ignore cleanup failures.
    }

    error.cause ??= lastError;
    throw error;
  }
}

export async function createStore({ driver, redisUrl, logger = console }) {
  if (driver === 'memory') {
    return new MemoryStore();
  }

  if (!redisUrl) {
    if (driver === 'redis') {
      throw new Error('STORE_DRIVER=redis requires REDIS_URL to be set');
    }

    logger.warn('REDIS_URL is not set. Using the in-memory store (data is lost on restart).');
    return new MemoryStore();
  }

  if (driver === 'redis') {
    const client = await connectRedis(redisUrl);
    logger.info(`Connected to Redis at ${maskRedisUrl(redisUrl)}`);
    return new RedisStore(client, { logger });
  }

  if (driver !== 'auto') {
    throw new Error(`Unknown store driver: ${driver}`);
  }

  try {
    const client = await connectRedis(redisUrl, {
      reconnect: false,
      connectTimeout: 2_000,
    });
    logger.info(`Connected to Redis at ${maskRedisUrl(redisUrl)}`);
    return new RedisStore(client, { logger });
  } catch (error) {
    logger.warn(
      `Redis is unavailable at ${maskRedisUrl(redisUrl)} (${error.message}). ` +
        'Falling back to the in-memory store; webhook history will not survive a restart.',
    );
    return new MemoryStore();
  }
}
