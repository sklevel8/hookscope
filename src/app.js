import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { buildCapturedRequest } from './lib/request.js';
import { generateToken, isValidToken } from './lib/token.js';
import { SseHub } from './realtime/hub.js';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PUBLIC_DIR = path.join(CURRENT_DIR, '..', 'public');

const BIN_NOT_FOUND = 'Bin not found or expired. Create a new bin to continue.';

function expiresAtFromTtl(ttlSeconds) {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function binNotFound(res) {
  return res.status(404).json({ ok: false, error: BIN_NOT_FOUND, code: 'BIN_NOT_FOUND' });
}

function rateLimiter({ enabled, limit, windowMs, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => !enabled,
    message: { ok: false, error: message, code: 'RATE_LIMITED' },
  });
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  next();
}

export function createApp({
  store,
  binTtlSeconds = 3600,
  maxRequestsPerBin = 200,
  maxBodySize = '1mb',
  trustProxy = false,
  sseHeartbeatMs = 20_000,
  maxSseClientsPerBin = 20,
  rateLimitEnabled = true,
  staticMaxAge = 0,
  publicDir = DEFAULT_PUBLIC_DIR,
  logger = console,
} = {}) {
  if (!store) throw new Error('createApp requires a store');

  const app = express();
  const hub = new SseHub({
    heartbeatMs: sseHeartbeatMs,
    maxClientsPerBin: maxSseClientsPerBin,
    logger,
  });

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.locals.store = store;
  app.locals.hub = hub;

  app.use(securityHeaders);

  const apiLimiter = rateLimiter({
    enabled: rateLimitEnabled,
    windowMs: 60_000,
    limit: 300,
    message: 'Too many API requests. Try again shortly.',
  });

  const createLimiter = rateLimiter({
    enabled: rateLimitEnabled,
    windowMs: 60_000,
    limit: 30,
    message: 'Too many bins created from this IP. Try again in a minute.',
  });

  const ingestLimiter = rateLimiter({
    enabled: rateLimitEnabled,
    windowMs: 60_000,
    limit: 900,
    message: 'Too many webhook requests from this IP.',
  });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      store: store.name,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.use('/api', apiLimiter);

  // ── Create an ephemeral bin ────────────────────────────────────────────
  app.post(
    '/api/bins',
    createLimiter,
    express.json({ limit: '16kb' }),
    async (req, res, next) => {
      try {
        let token = null;

        for (let attempt = 0; attempt < 5; attempt += 1) {
          const candidate = generateToken();
          if (await store.createBin(candidate, binTtlSeconds)) {
            token = candidate;
            break;
          }
        }

        if (!token) {
          return res.status(503).json({
            ok: false,
            error: 'Could not allocate a unique bin. Please retry.',
            code: 'TOKEN_ALLOCATION_FAILED',
          });
        }

        return res.status(201).json({
          ok: true,
          token,
          endpoint: `/wh/${token}`,
          ttlSeconds: binTtlSeconds,
          ttlWindowSeconds: binTtlSeconds,
          expiresAt: expiresAtFromTtl(binTtlSeconds),
        });
      } catch (error) {
        return next(error);
      }
    },
  );

  // ── Lightweight bin status (used by the SSE reconnect logic) ───────────
  app.get('/api/bins/:token/meta', async (req, res, next) => {
    const { token } = req.params;
    if (!isValidToken(token)) return binNotFound(res);

    try {
      const bin = await store.getBinMeta(token);
      if (!bin) return binNotFound(res);

      return res.json({
        ok: true,
        token,
        ttlSeconds: bin.ttlSeconds,
        ttlWindowSeconds: binTtlSeconds,
        expiresAt: expiresAtFromTtl(bin.ttlSeconds),
      });
    } catch (error) {
      return next(error);
    }
  });

  // ── Historical requests for a bin ──────────────────────────────────────
  app.get('/api/bins/:token', async (req, res, next) => {
    const { token } = req.params;
    if (!isValidToken(token)) return binNotFound(res);

    try {
      const result = await store.listRequests(token);
      if (!result) return binNotFound(res);

      return res.json({
        ok: true,
        token,
        requests: result.requests,
        ttlSeconds: result.ttlSeconds,
        ttlWindowSeconds: binTtlSeconds,
        expiresAt: expiresAtFromTtl(result.ttlSeconds),
      });
    } catch (error) {
      return next(error);
    }
  });

  // ── Server-Sent Events stream ──────────────────────────────────────────
  app.get('/api/bins/:token/stream', async (req, res, next) => {
    const { token } = req.params;
    if (!isValidToken(token)) return binNotFound(res);

    try {
      const bin = await store.getBinMeta(token);
      if (!bin) return binNotFound(res);

      if (hub.clientCount(token) >= maxSseClientsPerBin) {
        return res.status(503).json({
          ok: false,
          error: 'This bin already has the maximum number of live streams.',
          code: 'TOO_MANY_STREAMS',
        });
      }

      return hub.subscribe(req, res, token, {
        type: 'connected',
        token,
        ttlSeconds: bin.ttlSeconds,
        expiresAt: expiresAtFromTtl(bin.ttlSeconds),
      });
    } catch (error) {
      return next(error);
    }
  });

  // ── Delete a bin immediately (idempotent) ──────────────────────────────
  app.delete('/api/bins/:token', async (req, res, next) => {
    const { token } = req.params;
    if (!isValidToken(token)) return binNotFound(res);

    try {
      await store.deleteBin(token);
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  // ── Catch-all webhook receiver ─────────────────────────────────────────
  app.use('/wh', (req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '600',
    });
    next();
  });

  app.all(
    '/wh/:token',
    ingestLimiter,
    (req, res, next) => {
      if (!isValidToken(req.params.token)) return binNotFound(res);
      return next();
    },
    express.raw({ type: () => true, limit: maxBodySize }),
    async (req, res, next) => {
      const { token } = req.params;

      try {
        const captured = buildCapturedRequest(req);
        const ttlSeconds = await store.addRequest(token, captured, {
          ttlSeconds: binTtlSeconds,
          maxRequests: maxRequestsPerBin,
        });

        if (ttlSeconds === null) return binNotFound(res);

        const expiresAt = expiresAtFromTtl(ttlSeconds);
        const delivered = hub.publish(token, {
          type: 'request',
          request: captured,
          ttlSeconds,
          expiresAt,
        });

        return res.status(200).json({
          ok: true,
          id: captured.id,
          receivedAt: captured.receivedAt,
          deliveredTo: delivered,
        });
      } catch (error) {
        return next(error);
      }
    },
  );

  // ── Static frontend + shareable bin URLs ───────────────────────────────
  app.use(
    express.static(publicDir, {
      index: false,
      maxAge: staticMaxAge,
      fallthrough: true,
    }),
  );

  const sendDashboard = (req, res, next) => {
    res.sendFile(path.join(publicDir, 'index.html'), {
      headers: { 'Cache-Control': 'no-cache' },
    }, (error) => {
      if (error) next(error);
    });
  };

  app.get('/', sendDashboard);
  app.get('/b/:token', sendDashboard);
  app.get('/b', (req, res) => res.redirect('/'));

  app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, error: 'API route not found', code: 'NOT_FOUND' });
  });

  app.use((req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    if (error.type === 'entity.too.large' || error.status === 413) {
      return res.status(413).json({
        ok: false,
        error: `Request body is too large. Maximum size is ${maxBodySize}.`,
        code: 'PAYLOAD_TOO_LARGE',
      });
    }

    if (error.status >= 400 && error.status < 500) {
      return res.status(error.status).json({
        ok: false,
        error: error.expose ? error.message : 'Bad request',
        code: 'BAD_REQUEST',
      });
    }

    logger.error?.('Unhandled request error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  });

  return { app, hub };
}
