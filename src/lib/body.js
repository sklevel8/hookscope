const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const TEXTUAL_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/xhtml+xml',
  'application/javascript',
  'application/x-javascript',
  'application/graphql',
  'application/x-www-form-urlencoded',
  'application/sql',
  'application/yaml',
  'application/x-yaml',
  'application/csv',
  'application/x-ndjson',
]);

const BINARY_TYPES = new Set([
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/wasm',
]);

function mediaTypeOf(contentType = '') {
  return String(contentType).split(';', 1)[0].trim().toLowerCase();
}

function isTextual(mediaType) {
  return (
    mediaType.startsWith('text/') ||
    mediaType.endsWith('+json') ||
    mediaType.endsWith('+xml') ||
    TEXTUAL_TYPES.has(mediaType)
  );
}

function isClearlyBinary(mediaType) {
  return (
    /^(image|audio|video|font)\//.test(mediaType) ||
    BINARY_TYPES.has(mediaType)
  );
}

function decodeUtf8(buffer) {
  try {
    const text = UTF8_DECODER.decode(buffer);
    // NUL bytes are a strong signal that this is not human-readable text.
    return text.includes('\u0000') ? null : text;
  } catch {
    return null;
  }
}

function parseForm(text) {
  const params = new URLSearchParams(text);
  const result = Object.create(null);

  for (const [key, value] of params) {
    if (!(key in result)) {
      result[key] = value;
    } else if (Array.isArray(result[key])) {
      result[key].push(value);
    } else {
      result[key] = [result[key], value];
    }
  }

  return result;
}

function looksLikeJson(text) {
  const first = text.trimStart()[0];
  return first === '{' || first === '[';
}

/**
 * Turn a raw request body into a display-friendly payload while preserving the
 * original bytes (as UTF-8 text or base64) for signature verification and
 * "copy as cURL".
 */
export function parseBody(buffer, contentTypeHeader) {
  const bodySize = buffer.length;

  if (bodySize === 0) {
    return {
      body: null,
      rawBody: '',
      bodyEncoding: 'utf8',
      bodyType: 'empty',
      isJson: false,
      parseError: null,
      bodySize,
    };
  }

  const mediaType = mediaTypeOf(contentTypeHeader);
  const text = decodeUtf8(buffer);

  if (text === null || isClearlyBinary(mediaType)) {
    return {
      body: null,
      rawBody: buffer.toString('base64'),
      bodyEncoding: 'base64',
      bodyType: 'binary',
      isJson: false,
      parseError: null,
      bodySize,
    };
  }

  if (mediaType === 'multipart/form-data') {
    return {
      body: null,
      rawBody: text,
      bodyEncoding: 'utf8',
      bodyType: 'multipart',
      isJson: false,
      parseError: null,
      bodySize,
    };
  }

  if (mediaType === 'application/x-www-form-urlencoded') {
    return {
      body: parseForm(text),
      rawBody: text,
      bodyEncoding: 'utf8',
      bodyType: 'form',
      isJson: false,
      parseError: null,
      bodySize,
    };
  }

  const jsonExpected =
    mediaType === 'application/json' ||
    mediaType.endsWith('+json') ||
    mediaType === 'application/x-ndjson';

  if (jsonExpected || isTextual(mediaType) === false || looksLikeJson(text)) {
    if (jsonExpected || looksLikeJson(text)) {
      try {
        return {
          body: JSON.parse(text),
          rawBody: text,
          bodyEncoding: 'utf8',
          bodyType: 'json',
          isJson: true,
          parseError: null,
          bodySize,
        };
      } catch {
        return {
          body: text,
          rawBody: text,
          bodyEncoding: 'utf8',
          bodyType: 'json',
          isJson: false,
          parseError: 'The payload declares JSON but could not be parsed.',
          bodySize,
        };
      }
    }
  }

  const bodyType = mediaType.includes('xml')
    ? 'xml'
    : looksLikeJson(text)
      ? 'json'
      : 'text';

  if (bodyType === 'json') {
    try {
      return {
        body: JSON.parse(text),
        rawBody: text,
        bodyEncoding: 'utf8',
        bodyType,
        isJson: true,
        parseError: null,
        bodySize,
      };
    } catch {
      // Fall through to plain text.
    }
  }

  return {
    body: text,
    rawBody: text,
    bodyEncoding: 'utf8',
    bodyType,
    isJson: false,
    parseError: null,
    bodySize,
  };
}
