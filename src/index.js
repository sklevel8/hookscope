import { config } from './config.js';
import { createApp } from './app.js';
import { createStore } from './store/index.js';

const logger = console;

async function main() {
  const store = await createStore({
    driver: config.storeDriver,
    redisUrl: config.redisUrl,
    logger,
  });

  const { app, hub } = createApp({
    store,
    binTtlSeconds: config.binTtlSeconds,
    maxRequestsPerBin: config.maxRequestsPerBin,
    maxBodySize: config.maxBodySize,
    trustProxy: config.trustProxy,
    sseHeartbeatMs: config.sseHeartbeatMs,
    maxSseClientsPerBin: config.maxSseClientsPerBin,
    rateLimitEnabled: config.rateLimitEnabled,
    staticMaxAge: 0,
    logger,
  });

  const server = app.listen(config.port, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    console.log(`Webhook Inspector running at http://localhost:${port}`);
    console.log(
      `Store: ${store.name}  |  Bin TTL: ${config.binTtlSeconds}s  |  Body limit: ${config.maxBodySize}`,
    );
  });

  // Node's default request timeout is fine, but give SSE connections room to
  // breathe behind proxies that keep idle connections open.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received. Closing connections...`);

    hub.close();
    server.close(() => {
      store
        .close()
        .catch((error) => logger.error('Store shutdown error:', error))
        .finally(() => process.exit(0));
    });

    setTimeout(() => {
      logger.warn('Forcing shutdown after 10s.');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Failed to start Webhook Inspector:', error);
  process.exitCode = 1;
});
