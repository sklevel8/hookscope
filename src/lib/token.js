import crypto from 'node:crypto';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * 96 bits of entropy in a URL-safe 16-character token.
 */
export function generateToken() {
  return crypto.randomBytes(12).toString('base64url');
}

export function isValidToken(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}
