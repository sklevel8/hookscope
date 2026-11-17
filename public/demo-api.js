/* Demo shim: lets HookScope run as a fully static site.
   On any non-localhost origin (or with ?demo) every /api call is answered from
   an in-memory bin, and EventSource is replaced with a small simulator that
   streams realistic webhook requests. */
(() => {
  'use strict';

  const isLocalHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
  const forced = new URLSearchParams(location.search).has('demo');
  const DEMO = forced || location.protocol === 'file:' || !isLocalHost;

  if (!DEMO) return;

  const TTL_WINDOW_SECONDS = 3600;
  const TOKEN_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  const bins = new Map();
  const streams = new Set();

  function token(length = 12) {
    let out = '';
    const random = crypto.getRandomValues(new Uint8Array(length));
    for (let i = 0; i < length; i += 1) out += TOKEN_ALPHABET[random[i] % TOKEN_ALPHABET.length];
    return out;
  }

  function expiresAt() {
    return new Date(Date.now() + TTL_WINDOW_SECONDS * 1000).toISOString();
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'req-' + Math.random().toString(36).slice(2, 10);
  }

  const SAMPLES = [
    {
      method: 'POST',
      path: '/wh/TOKEN/stripe',
      contentType: 'application/json',
      headers: {
        host: 'hookscope.demo',
        'content-type': 'application/json',
        'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)',
        'stripe-signature': 't=1731571200,v1=9f2a41c7e0b8d3f6a1c4e7b9d2f5a8c3',
      },
      body: {
        id: 'evt_1QhT2kLmN4pQrStU',
        type: 'payment_intent.succeeded',
        created: 1731571200,
        data: {
          object: {
            id: 'pi_3QhT1zLmN4pQrStU',
            amount: 149900,
            currency: 'zar',
            status: 'succeeded',
            customer: 'cus_QX7b2Nk4',
          },
        },
      },
    },
    {
      method: 'POST',
      path: '/wh/TOKEN/github',
      contentType: 'application/json',
      headers: {
        host: 'hookscope.demo',
        'content-type': 'application/json',
        'user-agent': 'GitHub-Hookshot/9f2a41c',
        'x-github-event': 'push',
        'x-github-delivery': '7f3c1a2e-9b4d-4c8a-a1f6-2d5e8c0b9a73',
        'x-hub-signature-256': 'sha256=4d8f2c1b7a9e6f3d0c5b8a2e1f4d7c9b',
      },
      body: {
        ref: 'refs/heads/main',
        before: 'e6393c8cd7a0cbe77aeca4659b501a13bbde6828',
        after: '1ec83b8cbe9a8c32c2a512bb24f24788055e769d',
        repository: { full_name: 'sklevel8/smart-git-cli', private: false },
        commits: [
          { id: '1ec83b8', message: 'feat(ui): add repository dashboard', author: { name: 'Sipho Makubalo' }, added: 4, removed: 1 },
        ],
      },
    },
    {
      method: 'PUT',
      path: '/wh/TOKEN/orders?id=ORD-10482&expand=items',
      contentType: 'application/json',
      headers: {
        host: 'hookscope.demo',
        'content-type': 'application/json',
        'user-agent': 'Shopify-Webhook/2.1',
        'x-shopify-topic': 'orders/updated',
        'x-shopify-hmac-sha256': 'k3Jm8Qp2Xr7Tn1Vb5Lc9Wd4',
      },
      body: {
        id: 10482,
        email: 'thandi@example.co.za',
        total_price: '1499.00',
        currency: 'ZAR',
        financial_status: 'paid',
        items: [{ sku: 'ESC-1042', quantity: 1, price: '1499.00' }],
      },
    },
    {
      method: 'POST',
      path: '/wh/TOKEN/payfast/itn',
      contentType: 'application/x-www-form-urlencoded',
      headers: {
        host: 'hookscope.demo',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'PayFast-ITN/1.0',
      },
      body: 'm_payment_id=ESC-1042&pf_payment_id=2847193&payment_status=COMPLETE&amount_gross=1499.00&amount_fee=-34.48&amount_net=1464.52',
    },
    {
      method: 'GET',
      path: '/wh/TOKEN/health?probe=uptime',
      contentType: null,
      headers: {
        host: 'hookscope.demo',
        'user-agent': 'kube-probe/1.30',
        accept: '*/*',
      },
      body: null,
    },
  ];

  let sampleCursor = 0;

  function makeRequest(binToken, sample) {
    const contentType = sample.contentType;
    const isJson = Boolean(contentType && contentType.includes('json'));
    const rawBody = typeof sample.body === 'string'
      ? sample.body
      : sample.body
        ? JSON.stringify(sample.body, null, 2)
        : '';

    return {
      id: uuid(),
      method: sample.method,
      path: sample.path.replace('TOKEN', binToken),
      pathname: sample.path.replace('TOKEN', binToken).split('?')[0],
      query: Object.fromEntries(new URLSearchParams(sample.path.split('?')[1] || '')),
      rawQuery: sample.path.split('?')[1] || '',
      headers: sample.headers,
      ip: '196.25.14.7',
      remoteAddress: '196.25.14.7',
      httpVersion: '1.1',
      protocol: 'https',
      receivedAt: new Date().toISOString(),
      contentType,
      bodyType: rawBody ? (isJson ? 'json' : 'text') : 'empty',
      body: sample.body,
      rawBody,
      bodySize: rawBody.length,
      bodyEncoding: 'utf8',
      isJson,
      parseError: null,
    };
  }

  function json(body, status = 200, extraHeaders) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'X-Demo': 'true', ...(extraHeaders || {}) },
    });
  }

  function notFound() {
    return json({ ok: false, error: 'Bin not found or expired.', code: 'BIN_NOT_FOUND' }, 404);
  }

  function getBin(binToken) {
    return bins.get(binToken) || null;
  }

  function createBin() {
    const binToken = token();
    const bin = { token: binToken, requests: [], createdAt: Date.now() };

    // Seed with two captured requests so the inspector is populated on first paint.
    bin.requests.unshift(makeRequest(binToken, SAMPLES[1]));
    bin.requests.unshift(makeRequest(binToken, SAMPLES[0]));
    bins.set(binToken, bin);
    return bin;
  }

  function binResponse(bin, { includeRequests = true } = {}) {
    return {
      ok: true,
      token: bin.token,
      endpoint: `/wh/${bin.token}`,
      ...(includeRequests ? { requests: bin.requests } : {}),
      ttlSeconds: TTL_WINDOW_SECONDS,
      ttlWindowSeconds: TTL_WINDOW_SECONDS,
      expiresAt: expiresAt(),
    };
  }

  function broadcast(binToken, request) {
    for (const stream of streams) {
      if (stream.binToken !== binToken) continue;
      stream.push({ type: 'request', request, ttlSeconds: TTL_WINDOW_SECONDS, expiresAt: expiresAt() });
    }
  }

  /* ------------------------------------------------------------- API routes */
  function handle(url, init) {
    const method = (init?.method || 'GET').toUpperCase();
    const [pathname, query] = url.split('?');
    const params = new URLSearchParams(query || '');

    if (pathname === '/api/health') {
      return json({ ok: true, store: 'memory', uptimeSeconds: 12_400, demo: true });
    }

    if (pathname === '/api/bins' && method === 'POST') {
      const bin = createBin();
      return json(binResponse(bin, { includeRequests: false }), 201);
    }

    const binMatch = pathname.match(/^\/api\/bins\/([A-Za-z0-9_-]+)(\/meta)?$/);
    if (binMatch) {
      const bin = getBin(binMatch[1]);
      if (!bin) return notFound();

      if (method === 'DELETE') {
        bins.delete(bin.token);
        return new Response(null, { status: 204 });
      }

      if (binMatch[2]) return json(binResponse(bin, { includeRequests: false }));
      return json(binResponse(bin));
    }

    const ingestMatch = pathname.match(/^\/wh\/([A-Za-z0-9_-]+)/);
    if (ingestMatch) {
      const bin = getBin(ingestMatch[1]);
      if (!bin) return notFound();

      const sample = {
        method,
        path: pathname + (query ? `?${query}` : ''),
        contentType: init?.headers?.['Content-Type'] || init?.headers?.['content-type'] || null,
        headers: { host: 'hookscope.demo', ...(init?.headers || {}) },
        body: init?.body || null,
      };
      const request = makeRequest(bin.token, sample);
      bin.requests.unshift(request);
      broadcast(bin.token, request);
      return json({ ok: true, id: request.id, receivedAt: request.receivedAt, deliveredTo: streams.size });
    }

    // Unknown API route: acknowledge rather than 404 so the UI stays calm.
    if (pathname.startsWith('/api/')) {
      return json({ ok: true, demo: true, note: `No demo handler for ${method} ${pathname}` });
    }

    return null;
  }

  /* ------------------------------------------------------------ EventSource */
  class DemoEventSource {
    constructor(url) {
      this.url = String(url);
      const match = this.url.match(/\/api\/bins\/([A-Za-z0-9_-]+)\/stream/);
      this.binToken = match ? match[1] : null;
      this.readyState = 0;
      this.CONNECTING = 0;
      this.OPEN = 1;
      this.CLOSED = 2;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this._listeners = { open: [], message: [], error: [] };
      this._lastId = 0;
      this._timer = null;
      this._closed = false;

      streams.add(this);

      this._bootTimer = setTimeout(() => {
        if (this._closed) return;
        this.readyState = 1;
        this._dispatch('open', { type: 'open' });
        this.push({
          type: 'connected',
          token: this.binToken,
          ttlSeconds: TTL_WINDOW_SECONDS,
          expiresAt: expiresAt(),
        });
        this._schedule();
      }, 220);
    }

    _schedule() {
      const delay = 7000 + Math.floor(Math.random() * 5000);
      this._timer = setTimeout(() => {
        if (this._closed) return;
        const bin = this.binToken ? getBin(this.binToken) : null;
        if (!bin) {
          this._dispatch('error', { type: 'error' });
          return;
        }
        const sample = SAMPLES[sampleCursor % SAMPLES.length];
        sampleCursor += 1;
        const request = makeRequest(bin.token, sample);
        bin.requests.unshift(request);
        if (bin.requests.length > 60) bin.requests.length = 60;
        this.push({ type: 'request', request, ttlSeconds: TTL_WINDOW_SECONDS, expiresAt: expiresAt() });
        this._schedule();
      }, delay);
    }

    _dispatch(type, event) {
      const handler = this[`on${type}`];
      if (typeof handler === 'function') {
        try { handler.call(this, event); } catch (error) { console.error(error); }
      }
      for (const listener of this._listeners[type]) {
        try { listener.call(this, event); } catch (error) { console.error(error); }
      }
    }

    push(payload) {
      this._lastId += 1;
      this._dispatch('message', {
        type: 'message',
        data: JSON.stringify(payload),
        lastEventId: String(this._lastId),
        origin: location.origin,
      });
    }

    addEventListener(type, listener) {
      if (this._listeners[type]) this._listeners[type].push(listener);
    }

    removeEventListener(type, listener) {
      const list = this._listeners[type];
      if (!list) return;
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    }

    close() {
      this._closed = true;
      this.readyState = 2;
      clearTimeout(this._bootTimer);
      clearTimeout(this._timer);
      streams.delete(this);
    }
  }

  /* --------------------------------------------------------------- install */
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isSameOrigin = url.startsWith('/') || url.startsWith(location.origin);

    if (isSameOrigin && (url.includes('/api/') || url.includes('/wh/'))) {
      try {
        const response = handle(url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url, init);
        if (response) return Promise.resolve(response);
      } catch (error) {
        return Promise.resolve(json({ ok: false, error: error.message }, 500));
      }
    }

    return realFetch(input, init);
  };

  window.EventSource = DemoEventSource;
  window.__HOOKSCOPE_DEMO__ = true;

  document.addEventListener('DOMContentLoaded', () => {
    const actions = document.querySelector('.topbar-actions');
    if (actions && !document.querySelector('[data-demo-badge]')) {
      const badge = document.createElement('span');
      badge.className = 'store-badge';
      badge.dataset.demoBadge = 'true';
      badge.title = 'Static demo: requests are generated in your browser';
      badge.innerHTML = '<span class="store-dot" aria-hidden="true"></span><span>Demo</span>';
      actions.insertBefore(badge, actions.firstChild);
    }
  });
})();
