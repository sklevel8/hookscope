/**
 * Lazy-expiring in-memory implementation of the webhook store.
 * Used for tests and as a development fallback when Redis is unavailable.
 */
export class MemoryStore {
  name = 'memory';

  #bins = new Map();
  #cleanupTimer;

  constructor({ now = Date.now, cleanupIntervalMs = 60_000 } = {}) {
    this.now = now;

    if (cleanupIntervalMs > 0) {
      this.#cleanupTimer = setInterval(() => this.#sweep(), cleanupIntervalMs);
      this.#cleanupTimer.unref?.();
    }
  }

  #sweep() {
    const now = this.now();
    for (const [token, bin] of this.#bins) {
      if (bin.expiresAt <= now) this.#bins.delete(token);
    }
  }

  #liveBin(token) {
    const bin = this.#bins.get(token);
    if (!bin) return null;

    if (bin.expiresAt <= this.now()) {
      this.#bins.delete(token);
      return null;
    }

    return bin;
  }

  async createBin(token, ttlSeconds) {
    if (this.#liveBin(token)) return false;

    this.#bins.set(token, {
      createdAt: this.now(),
      expiresAt: this.now() + ttlSeconds * 1000,
      requests: [],
    });

    return true;
  }

  async getBinMeta(token) {
    const bin = this.#liveBin(token);
    if (!bin) return null;

    return {
      ttlSeconds: Math.max(0, Math.ceil((bin.expiresAt - this.now()) / 1000)),
    };
  }

  async addRequest(token, request, { ttlSeconds, maxRequests }) {
    const bin = this.#liveBin(token);
    if (!bin) return null;

    bin.requests.push(request);
    if (bin.requests.length > maxRequests) {
      bin.requests.splice(0, bin.requests.length - maxRequests);
    }

    bin.expiresAt = this.now() + ttlSeconds * 1000;
    return ttlSeconds;
  }

  async listRequests(token) {
    const bin = this.#liveBin(token);
    if (!bin) return null;

    return {
      requests: [...bin.requests].reverse(),
      ttlSeconds: Math.max(0, Math.ceil((bin.expiresAt - this.now()) / 1000)),
    };
  }

  async deleteBin(token) {
    return this.#bins.delete(token);
  }

  async close() {
    if (this.#cleanupTimer) clearInterval(this.#cleanupTimer);
    this.#bins.clear();
  }
}
