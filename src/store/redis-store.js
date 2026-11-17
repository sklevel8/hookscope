const META_KEY = (token) => `webhook:bin:${token}:meta`;
const LIST_KEY = (token) => `webhook:bin:${token}:requests`;

/**
 * Atomically appends a request only if the bin still exists, trims the list to
 * the configured cap, and refreshes the inactivity TTL on both keys.
 * Returns the remaining TTL in seconds, or -1 if the bin is gone.
 */
const ADD_REQUEST_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return -1
end

redis.call('RPUSH', KEYS[2], ARGV[1])
redis.call('LTRIM', KEYS[2], -tonumber(ARGV[2]), -1)
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))

return redis.call('TTL', KEYS[1])
`;

export class RedisStore {
  name = 'redis';

  constructor(client, { logger = console } = {}) {
    this.client = client;
    this.logger = logger;
    this.client.on('error', (error) => {
      this.logger.error?.('Redis client error:', error.message);
    });
  }

  async createBin(token, ttlSeconds) {
    const result = await this.client.set(META_KEY(token), new Date().toISOString(), {
      EX: ttlSeconds,
      NX: true,
    });

    return result === 'OK';
  }

  async getBinMeta(token) {
    const [exists, ttl] = await Promise.all([
      this.client.exists(META_KEY(token)),
      this.client.ttl(META_KEY(token)),
    ]);

    if (!exists) return null;
    return { ttlSeconds: Math.max(0, ttl) };
  }

  async addRequest(token, request, { ttlSeconds, maxRequests }) {
    const ttl = await this.client.eval(ADD_REQUEST_SCRIPT, {
      keys: [META_KEY(token), LIST_KEY(token)],
      arguments: [JSON.stringify(request), String(maxRequests), String(ttlSeconds)],
    });

    if (Number(ttl) < 0) return null;
    return Number(ttl);
  }

  async listRequests(token) {
    const exists = await this.client.exists(META_KEY(token));
    if (!exists) return null;

    const [rawRequests, ttl] = await Promise.all([
      this.client.lRange(LIST_KEY(token), 0, -1),
      this.client.ttl(META_KEY(token)),
    ]);

    const requests = [];
    for (const raw of rawRequests) {
      try {
        requests.push(JSON.parse(raw));
      } catch (error) {
        this.logger.warn?.('Skipping unreadable webhook entry:', error.message);
      }
    }

    return {
      requests: requests.reverse(),
      ttlSeconds: Math.max(0, ttl),
    };
  }

  async deleteBin(token) {
    const deleted = await this.client.del([META_KEY(token), LIST_KEY(token)]);
    return deleted > 0;
  }

  async close() {
    if (!this.client.isOpen) return;

    try {
      await this.client.quit();
    } catch {
      this.client.destroy();
    }
  }
}
