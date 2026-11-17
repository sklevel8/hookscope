import crypto from 'node:crypto';
import { parseBody } from './body.js';

export function buildCapturedRequest(req) {
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const parsed = parseBody(buffer, req.headers['content-type']);

  const queryIndex = req.originalUrl.indexOf('?');
  const rawQuery = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex + 1);

  return {
    id: crypto.randomUUID(),
    method: req.method,
    path: req.originalUrl,
    pathname: req.path,
    query: { ...req.query },
    rawQuery,
    headers: { ...req.headers },
    ip: req.ip || req.socket?.remoteAddress || null,
    remoteAddress: req.socket?.remoteAddress || null,
    httpVersion: req.httpVersion,
    protocol: req.protocol,
    receivedAt: new Date().toISOString(),
    contentType: req.headers['content-type'] || null,
    ...parsed,
  };
}
