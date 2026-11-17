const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export class SseHub {
  #channels = new Map();

  constructor({ heartbeatMs = 20_000, maxClientsPerBin = 20, logger = console } = {}) {
    this.heartbeatMs = heartbeatMs;
    this.maxClientsPerBin = maxClientsPerBin;
    this.logger = logger;
  }

  clientCount(token) {
    return this.#channels.get(token)?.size ?? 0;
  }

  subscribe(req, res, token, connectedPayload) {
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify(connectedPayload)}\n\n`);

    const client = {
      res,
      heartbeat: setInterval(() => {
        if (res.writableEnded) {
          this.#remove(token, client);
          return;
        }

        if (res.writableLength > MAX_BUFFERED_BYTES) {
          this.logger.warn?.(`Dropping slow SSE client for bin ${token}`);
          this.#remove(token, client, { end: true });
          return;
        }

        res.write(`: keep-alive ${Date.now()}\n\n`);
      }, this.heartbeatMs),
    };
    client.heartbeat.unref?.();

    if (!this.#channels.has(token)) this.#channels.set(token, new Set());
    this.#channels.get(token).add(client);

    const cleanup = () => this.#remove(token, client);
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    return client;
  }

  publish(token, payload) {
    const clients = this.#channels.get(token);
    if (!clients?.size) return 0;

    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    let delivered = 0;

    for (const client of [...clients]) {
      if (client.res.writableEnded) {
        this.#remove(token, client);
        continue;
      }

      try {
        client.res.write(frame);
        delivered += 1;
      } catch (error) {
        this.logger.warn?.(`SSE write failed for bin ${token}:`, error.message);
        this.#remove(token, client, { end: true });
      }
    }

    return delivered;
  }

  #remove(token, client, { end = false } = {}) {
    clearInterval(client.heartbeat);

    const clients = this.#channels.get(token);
    if (!clients) return;

    clients.delete(client);
    if (clients.size === 0) this.#channels.delete(token);

    if (end && !client.res.writableEnded) {
      try {
        client.res.end();
      } catch {
        // The socket may already be gone.
      }
    }
  }

  close() {
    for (const [token, clients] of this.#channels) {
      for (const client of [...clients]) {
        this.#remove(token, client, { end: true });
      }
    }
    this.#channels.clear();
  }
}
