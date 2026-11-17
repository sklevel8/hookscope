const STORAGE_KEY = 'hookscope.currentBin';
const MAX_RENDER_CHARS = 200_000;
const JSON_TOKEN_RE = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

const EXCLUDED_CURL_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'accept-encoding',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ray',
]);

const METHOD_CLASSES = {
  POST: 'method--post',
  GET: 'method--get',
  PUT: 'method--put',
  PATCH: 'method--patch',
  DELETE: 'method--delete',
  OPTIONS: 'method--options',
  HEAD: 'method--head',
};

const state = {
  token: null,
  endpoint: '',
  requests: [],
  byId: new Map(),
  selectedId: null,
  selectionAuto: false,
  filter: '',
  expiresAt: null,
  eventSource: null,
  activeTab: 'body',
  expired: false,
  verifying: false,
  binCheckTimer: null,
  creating: false,
  timeUpdateCounter: 0,
};

const searchCache = new WeakMap();

const $ = (id) => document.getElementById(id);

const dom = {
  newBinBtn: $('newBinBtn'),
  bannerNewBinBtn: $('bannerNewBinBtn'),
  expiredBanner: $('expiredBanner'),
  storeBadge: $('storeBadge'),
  storeLabel: $('storeLabel'),
  footerStore: $('footerStore'),
  connectionStatus: $('connectionStatus'),
  connectionLabel: $('connectionLabel'),
  streamHint: $('streamHint'),
  endpointUrl: $('endpointUrl'),
  copyUrlBtn: $('copyUrlBtn'),
  expiryBadge: $('expiryBadge'),
  ttlNote: $('ttlNote'),
  statCount: $('statCount'),
  statTtl: $('statTtl'),
  curlSample: $('curlSample'),
  copyCurlBtn: $('copyCurlBtn'),
  requestCount: $('requestCount'),
  requestSummary: $('requestSummary'),
  requestList: $('requestList'),
  requestEmpty: $('requestEmpty'),
  filterInput: $('filterInput'),
  inspectorEmpty: $('inspectorEmpty'),
  inspectorView: $('inspectorView'),
  detailMethod: $('detailMethod'),
  detailPath: $('detailPath'),
  detailTime: $('detailTime'),
  metaIp: $('metaIp'),
  metaContentType: $('metaContentType'),
  metaSize: $('metaSize'),
  metaId: $('metaId'),
  tabBody: $('tab-body'),
  tabHeaders: $('tab-headers'),
  tabQuery: $('tab-query'),
  tabRaw: $('tab-raw'),
  bodyNote: $('bodyNote'),
  bodySizeNote: $('bodySizeNote'),
  bodyContent: $('bodyContent'),
  headersNote: $('headersNote'),
  headersTable: $('headersTable'),
  queryNote: $('queryNote'),
  queryTable: $('queryTable'),
  rawContent: $('rawContent'),
  copyCurlRequestBtn: $('copyCurlRequestBtn'),
  copyJsonBtn: $('copyJsonBtn'),
  toastRegion: $('toastRegion'),
};

const tabs = [
  { name: 'body', button: dom.tabBody, panel: $('panel-body') },
  { name: 'headers', button: dom.tabHeaders, panel: $('panel-headers') },
  { name: 'query', button: dom.tabQuery, panel: $('panel-query') },
  { name: 'raw', button: dom.tabRaw, panel: $('panel-raw') },
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const extraMinutes = minutes % 60;
  return extraMinutes ? `${hours}h ${extraMinutes}m` : `${hours}h`;
}

function formatTtlWindow(ttlSeconds) {
  const value = Number(ttlSeconds);
  if (!Number.isFinite(value) || value <= 0) return '1 hour';

  if (value % 3600 === 0) {
    const hours = value / 3600;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (value % 60 === 0) {
    const minutes = value / 60;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${value} second${value === 1 ? '' : 's'}`;
}

function formatRelativeTime(timestamp) {
  const then = Date.parse(timestamp);
  if (!Number.isFinite(then)) return 'unknown time';

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatClock(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatFullTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function methodClass(method) {
  return METHOD_CLASSES[String(method).toUpperCase()] || 'method--other';
}

function previewOf(request) {
  if (request.bodyType === 'empty') return 'no body';
  if (request.bodySize && request.bodyEncoding === 'base64') return `${formatBytes(request.bodySize)} binary`;

  let value;
  if (request.body !== null && typeof request.body === 'object') {
    value = JSON.stringify(request.body);
  } else if (typeof request.body === 'string') {
    value = request.body;
  } else {
    value = request.rawBody || '';
  }

  const compact = String(value).replace(/\s+/g, ' ').trim();
  if (!compact) return 'empty payload';
  return compact.length > 80 ? `${compact.slice(0, 80)}…` : compact;
}

function searchTextOf(request) {
  const cached = searchCache.get(request);
  if (cached) return cached;

  const headers = Object.entries(request.headers || {})
    .map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(' ') : value}`)
    .join(' ');

  const query = Object.entries(request.query || {})
    .map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(' ') : value}`)
    .join(' ');

  const text = [
    request.method,
    request.path,
    request.ip,
    query,
    headers,
    request.rawBody,
    request.body && typeof request.body === 'object' ? JSON.stringify(request.body) : request.body,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  searchCache.set(request, text);
  return text;
}

function filteredRequests() {
  if (!state.filter) return state.requests;
  return state.requests.filter((request) => searchTextOf(request).includes(state.filter));
}

function setConnection(mode, label) {
  dom.connectionStatus.className = `conn conn--${mode}`;
  dom.connectionLabel.textContent = label;
}

function updateStreamHint(mode) {
  const labels = {
    live: 'SSE stream live',
    connecting: 'SSE stream connecting',
    reconnecting: 'SSE stream reconnecting',
    offline: 'SSE stream closed',
  };
  const variants = {
    live: '',
    connecting: '',
    reconnecting: 'stream-hint--reconnecting',
    offline: 'stream-hint--offline',
  };

  dom.streamHint.className = `stream-hint ${variants[mode] || ''}`.trim();
  const dot = el('span', 'mini-dot');
  dot.setAttribute('aria-hidden', 'true');
  dom.streamHint.replaceChildren(dot, document.createTextNode(labels[mode] || labels.offline));
}

function showToast(message, type = 'success') {
  const toast = el('div', `toast toast--${type}`, message);
  dom.toastRegion.append(toast);

  setTimeout(() => {
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 200);
  }, 2_800);
}

async function copyText(text, successMessage = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage);
    return true;
  } catch {
    const textarea = el('textarea', 'clipboard-helper');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    document.body.append(textarea);
    textarea.select();

    try {
      const copied = document.execCommand('copy');
      if (!copied) throw new Error('copy command failed');
      showToast(successMessage);
      return true;
    } catch {
      showToast('Could not copy. Copy the text manually.', 'error');
      return false;
    } finally {
      textarea.remove();
    }
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    cache: 'no-store',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return { response, data };
}

function parseTokenFromPath() {
  const match = window.location.pathname.match(/^\/b\/([A-Za-z0-9_-]{8,64})\/?$/);
  return match ? match[1] : null;
}

function expiresAtFromData(data) {
  if (data?.expiresAt) {
    const parsed = Date.parse(data.expiresAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (Number.isFinite(data?.ttlSeconds)) {
    return Date.now() + data.ttlSeconds * 1000;
  }
  return null;
}

function applyBin(token, data) {
  state.token = token;
  state.expired = false;
  state.verifying = false;
  state.selectedId = null;
  state.filter = '';
  state.expiresAt = expiresAtFromData(data);
  state.requests = Array.isArray(data.requests) ? data.requests.filter((request) => request?.id) : [];
  state.byId = new Map(state.requests.map((request) => [request.id, request]));
  state.endpoint = `${window.location.origin}/wh/${token}`;

  dom.endpointUrl.textContent = state.endpoint;
  dom.endpointUrl.title = state.endpoint;
  dom.ttlNote.textContent = `${formatTtlWindow(data.ttlWindowSeconds ?? data.ttlSeconds)} after the last request`;
  dom.filterInput.value = '';
  dom.expiredBanner.hidden = true;
  dom.inspectorView.hidden = true;
  dom.inspectorEmpty.hidden = false;

  window.history.replaceState(null, '', `/b/${token}`);
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Private browsing can block localStorage; the URL still carries the bin.
  }

  updateCurlSample();
  renderList();
  updateExpiry();
  updateStreamHint('connecting');

  if (state.requests.length > 0) {
    selectRequest(state.requests[0].id, { scroll: false, auto: true });
  }
}

async function loadBin(token) {
  try {
    const { response, data } = await fetchJson(`/api/bins/${encodeURIComponent(token)}`);

    if (response.status === 404) {
      return 'missing';
    }

    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || `Server returned ${response.status}`);
    }

    closeStream();
    applyBin(token, data);
    connectStream();
    return 'loaded';
  } catch (error) {
    setConnection('offline', 'Offline');
    updateStreamHint('offline');
    if (!state.token) {
      dom.endpointUrl.textContent = 'Server unavailable';
      dom.endpointUrl.title = '';
      dom.expiryBadge.textContent = 'offline';
      dom.curlSample.textContent = 'Start the server, then refresh this page.';
    }
    showToast(`Could not load this bin: ${error.message}`, 'error');
    return 'error';
  }
}

async function createNewBin({ reason = '' } = {}) {
  if (state.creating) return;

  state.creating = true;
  dom.newBinBtn.disabled = true;
  dom.bannerNewBinBtn.disabled = true;

  try {
    const { response, data } = await fetchJson('/api/bins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || `Server returned ${response.status}`);
    }

    closeStream();
    applyBin(data.token, {
      requests: [],
      expiresAt: data.expiresAt,
      ttlSeconds: data.ttlSeconds,
    });
    connectStream();

    if (reason === 'expired') {
      showToast('Fresh bin created. New webhooks will appear here live.', 'success');
    } else {
      showToast('New bin ready — copy the URL and send a request.', 'success');
    }
  } catch (error) {
    setConnection('offline', 'Offline');
    if (!state.token) {
      dom.endpointUrl.textContent = 'Could not create a bin';
      dom.curlSample.textContent = 'Start the server, then refresh this page.';
    }
    showToast(`Could not create a bin: ${error.message}`, 'error');
  } finally {
    state.creating = false;
    dom.newBinBtn.disabled = false;
    dom.bannerNewBinBtn.disabled = false;
  }
}

function closeStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  if (state.binCheckTimer) {
    clearTimeout(state.binCheckTimer);
    state.binCheckTimer = null;
  }
}

function connectStream() {
  closeStream();
  if (!state.token || state.expired) return;

  setConnection('connecting', 'Connecting');
  updateStreamHint('connecting');

  const source = new EventSource(`/api/bins/${encodeURIComponent(state.token)}/stream`);
  state.eventSource = source;

  source.onopen = () => {
    if (source !== state.eventSource) return;
    setConnection('live', 'Live');
    updateStreamHint('live');
  };

  source.onmessage = (event) => {
    if (source !== state.eventSource) return;

    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (payload.type === 'connected') {
      if (payload.expiresAt) {
        const parsed = Date.parse(payload.expiresAt);
        if (Number.isFinite(parsed)) state.expiresAt = parsed;
      }
      setConnection('live', 'Live');
      updateStreamHint('live');
      updateExpiry();
      return;
    }

    if (payload.type === 'request' && payload.request) {
      if (payload.expiresAt) {
        const parsed = Date.parse(payload.expiresAt);
        if (Number.isFinite(parsed)) state.expiresAt = parsed;
      }
      insertRequest(payload.request);
      setConnection('live', 'Live');
      updateStreamHint('live');
      updateExpiry();
    }
  };

  source.onerror = () => {
    if (source !== state.eventSource || state.expired) return;
    setConnection('reconnecting', 'Reconnecting');
    updateStreamHint('reconnecting');
    checkBinAliveSoon();
  };
}

function checkBinAliveSoon() {
  if (state.binCheckTimer || state.expired) return;

  state.binCheckTimer = setTimeout(async () => {
    state.binCheckTimer = null;
    if (!state.token || state.expired) return;

    try {
      const { response, data } = await fetchJson(`/api/bins/${encodeURIComponent(state.token)}/meta`);
      if (response.status === 404) {
        handleExpired();
        return;
      }
      if (response.ok && data?.ok) {
        const parsed = Date.parse(data.expiresAt);
        if (Number.isFinite(parsed)) {
          state.expiresAt = parsed;
          updateExpiry();
        }
      }
    } catch {
      // The EventSource will keep reconnecting; the next error retries this check.
    }
  }, 2_500);
}

function handleExpired() {
  if (state.expired) return;

  state.expired = true;
  state.expiresAt = Date.now();
  closeStream();
  setConnection('expired', 'Expired');
  updateStreamHint('offline');
  dom.expiredBanner.hidden = false;
  updateExpiry();
  showToast('This bin expired. Create a new bin to keep testing.', 'info');
}

function verifyExpiry() {
  if (state.expired || state.verifying || !state.token) return;
  state.verifying = true;

  fetchJson(`/api/bins/${encodeURIComponent(state.token)}/meta`)
    .then(({ response, data }) => {
      if (response.status === 404) {
        handleExpired();
      } else if (response.ok && data?.ok) {
        const parsed = Date.parse(data.expiresAt);
        if (Number.isFinite(parsed)) {
          state.expiresAt = parsed;
          updateExpiry();
        }
      }
    })
    .catch(() => {})
    .finally(() => {
      state.verifying = false;
    });
}

function updateExpiry() {
  const remaining = state.expiresAt === null ? null : state.expiresAt - Date.now();

  if (state.expired) {
    dom.statTtl.textContent = '0m';
    dom.expiryBadge.textContent = 'expired';
    dom.expiryBadge.className = 'expiry-badge expiry-badge--expired';
    return;
  }

  dom.statTtl.textContent = remaining === null ? '—' : formatCountdown(remaining);
  dom.expiryBadge.textContent = remaining === null ? 'expiry unknown' : `expires in ${formatCountdown(remaining)}`;
  dom.expiryBadge.className = `expiry-badge${remaining !== null && remaining <= 5 * 60_000 ? ' expiry-badge--warning' : ''}`;

  if (remaining !== null && remaining <= 0) verifyExpiry();
}

function updateCounts() {
  const total = state.requests.length;
  const shown = filteredRequests().length;

  dom.requestCount.textContent = String(total);
  dom.statCount.textContent = String(total);
  dom.requestCount.setAttribute('aria-label', `${total} requests`);

  if (total === 0) {
    dom.requestSummary.textContent = 'Waiting for the first request';
  } else if (state.filter) {
    dom.requestSummary.textContent = `${shown} of ${total} request${total === 1 ? '' : 's'} shown`;
  } else {
    dom.requestSummary.textContent = `${total} request${total === 1 ? '' : 's'} captured`;
  }

  document.title = total
    ? `HookScope — ${total} request${total === 1 ? '' : 's'}`
    : 'HookScope — Real-Time Webhook Inspector';
}

function insertRequest(request) {
  if (!request?.id || state.byId.has(request.id)) return;

  const previousNewest = state.requests[0]?.id;
  const followsNewest =
    !state.selectedId ||
    (state.selectionAuto && state.selectedId === previousNewest);

  state.requests.unshift(request);
  state.byId.set(request.id, request);
  renderList();
  updateCounts();

  const item = dom.requestList.querySelector(`[data-id="${request.id}"]`);
  if (item) {
    item.classList.add('is-fresh');
    setTimeout(() => item.classList.remove('is-fresh'), 450);
  }

  const visibleInFilter = !state.filter || searchTextOf(request).includes(state.filter);
  if (followsNewest && visibleInFilter) {
    selectRequest(request.id, { scroll: false, auto: true });
  }
}

function renderList() {
  const requests = filteredRequests();
  const fragment = document.createDocumentFragment();

  for (const request of requests) {
    fragment.append(createRequestItem(request));
  }

  if (state.requests.length > 0 && requests.length === 0) {
    const empty = el('div', 'filter-empty');
    empty.append(
      el('strong', '', 'No matching requests'),
      el('span', '', 'Try a different path, header, or body value.'),
    );
    fragment.append(empty);
  }

  dom.requestList.replaceChildren(fragment);
  dom.requestEmpty.hidden = state.requests.length > 0;
  updateCounts();
}

function createRequestItem(request) {
  const button = el('button', 'request-item');
  button.type = 'button';
  button.dataset.id = request.id;

  if (request.id === state.selectedId) {
    button.classList.add('is-selected');
    button.setAttribute('aria-current', 'true');
  }

  const top = el('span', 'request-item-top');
  const method = el('span', `method ${methodClass(request.method)}`, String(request.method).toUpperCase());
  const time = el('time', 'request-time', formatClock(request.receivedAt));
  time.dateTime = request.receivedAt;
  time.dataset.ts = request.receivedAt;
  top.append(method, time);

  const path = el('span', 'request-path', request.path);
  path.title = request.path;

  const foot = el('span', 'request-foot');
  foot.append(
    el('span', 'request-ip', request.ip || 'unknown ip'),
    el('span', 'request-dot'),
    el('span', 'request-preview', previewOf(request)),
  );

  button.append(top, path, foot);
  return button;
}

function selectRequest(id, { scroll = true, auto = false } = {}) {
  const request = state.byId.get(id);
  if (!request) return;

  state.selectedId = id;
  state.selectionAuto = auto;

  for (const item of dom.requestList.querySelectorAll('.request-item')) {
    const selected = item.dataset.id === id;
    item.classList.toggle('is-selected', selected);
    if (selected) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  }

  dom.inspectorEmpty.hidden = true;
  dom.inspectorView.hidden = false;
  renderInspector(request);

  if (scroll) {
    const item = dom.requestList.querySelector(`[data-id="${id}"]`);
    item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function clearSelection() {
  state.selectedId = null;
  state.selectionAuto = false;
  dom.inspectorView.hidden = true;
  dom.inspectorEmpty.hidden = false;

  for (const item of dom.requestList.querySelectorAll('.request-item')) {
    item.classList.remove('is-selected');
    item.removeAttribute('aria-current');
  }
}

function renderInspector(request) {
  dom.detailMethod.className = `method ${methodClass(request.method)}`;
  dom.detailMethod.textContent = String(request.method).toUpperCase();
  dom.detailPath.textContent = request.path;
  dom.detailPath.title = request.path;
  dom.detailTime.textContent = `${formatFullTime(request.receivedAt)} · ${formatRelativeTime(request.receivedAt)}`;

  dom.metaIp.textContent = request.ip || 'unknown';
  dom.metaIp.title = request.ip || '';
  dom.metaContentType.textContent = request.contentType || 'not provided';
  dom.metaContentType.title = request.contentType || '';
  dom.metaSize.textContent = formatBytes(request.bodySize);
  dom.metaId.textContent = request.id;
  dom.metaId.title = request.id;

  const headerCount = Object.keys(request.headers || {}).length;
  const queryCount = Object.keys(request.query || {}).length;
  dom.tabHeaders.dataset.count = String(headerCount);
  dom.tabQuery.dataset.count = String(queryCount);
  delete dom.tabBody.dataset.count;
  delete dom.tabRaw.dataset.count;

  renderBody(request);
  renderHeaders(request);
  renderQuery(request);
  renderRaw(request);
  setActiveTab(state.activeTab, { focus: false });
}

function renderBody(request) {
  dom.bodyContent.replaceChildren();

  const notes = {
    json: request.isJson ? 'Parsed JSON payload' : 'JSON payload (unparsed)',
    form: 'URL-encoded form (parsed)',
    text: 'Plain text payload',
    xml: 'XML payload',
    multipart: 'Multipart form data (raw preview)',
    binary: 'Binary payload (base64 preview)',
    empty: 'No request body',
  };

  dom.bodyNote.textContent = notes[request.bodyType] || 'Request body';
  dom.bodySizeNote.textContent = formatBytes(request.bodySize);

  if (request.parseError) {
    dom.bodyContent.append(el('p', 'parse-warning', request.parseError));
  }

  if (request.bodyType === 'empty' || (!request.body && !request.rawBody)) {
    const empty = el('div', 'code-empty');
    empty.append(
      el('strong', '', 'No request body'),
      el('span', '', 'This request arrived without a payload.'),
    );
    dom.bodyContent.append(empty);
    return;
  }

  let text;
  if (request.body !== null && typeof request.body === 'object') {
    text = JSON.stringify(request.body, null, 2);
  } else if (typeof request.body === 'string') {
    text = request.body;
  } else {
    text = request.rawBody || '';
  }

  if (request.bodyEncoding === 'base64') {
    text = request.rawBody || '';
  }

  const truncated = text.length > MAX_RENDER_CHARS;
  const visibleText = truncated ? text.slice(0, MAX_RENDER_CHARS) : text;

  if (truncated) {
    dom.bodySizeNote.textContent = `${formatBytes(request.bodySize)} · showing first 200 KB`;
  }

  const wrap = el('div', 'code-wrap');
  const pre = el('pre', 'code-block');

  if (request.isJson && !request.parseError) {
    highlightJsonInto(pre, visibleText);
  } else {
    pre.textContent = visibleText;
  }

  wrap.append(pre);
  dom.bodyContent.append(wrap);
}

function highlightJsonInto(container, text) {
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  let match;

  JSON_TOKEN_RE.lastIndex = 0;

  while ((match = JSON_TOKEN_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    if (match[1]) {
      const isKey = Boolean(match[2]);
      fragment.append(el('span', isKey ? 'tok-key' : 'tok-string', match[1]));
      if (match[2]) fragment.append(document.createTextNode(match[2]));
    } else if (match[3]) {
      const className = match[3] === 'null' ? 'tok-null' : 'tok-boolean';
      fragment.append(el('span', className, match[3]));
    } else if (match[4]) {
      fragment.append(el('span', 'tok-number', match[4]));
    }

    lastIndex = JSON_TOKEN_RE.lastIndex;
  }

  if (lastIndex < text.length) {
    fragment.append(document.createTextNode(text.slice(lastIndex)));
  }

  container.append(fragment);
}

function renderHeaders(request) {
  const entries = Object.entries(request.headers || {});
  dom.headersTable.replaceChildren();
  dom.headersNote.textContent = `${entries.length} request header${entries.length === 1 ? '' : 's'}`;

  if (entries.length === 0) {
    dom.headersTable.append(el('div', 'kv-empty', 'No headers were captured.'));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const [key, value] of entries) {
    const row = el('div', 'kv-row');
    const displayValue = Array.isArray(value) ? value.join(', ') : String(value);
    row.append(el('div', 'kv-key', key), el('div', 'kv-value', displayValue));
    fragment.append(row);
  }

  dom.headersTable.append(fragment);
}

function flattenQuery(query) {
  const rows = [];
  for (const [key, value] of Object.entries(query || {})) {
    if (Array.isArray(value)) {
      rows.push([key, value.join(', ')]);
    } else if (value !== null && typeof value === 'object') {
      rows.push([key, JSON.stringify(value)]);
    } else {
      rows.push([key, value === null ? 'null' : String(value)]);
    }
  }
  return rows;
}

function renderQuery(request) {
  const rows = flattenQuery(request.query);
  dom.queryTable.replaceChildren();
  dom.queryNote.textContent = `${rows.length} query parameter${rows.length === 1 ? '' : 's'}`;

  if (rows.length === 0) {
    dom.queryTable.append(el('div', 'kv-empty', 'No query parameters were sent.'));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const [key, value] of rows) {
    const row = el('div', 'kv-row');
    row.append(el('div', 'kv-key', key), el('div', 'kv-value', value));
    fragment.append(row);
  }

  dom.queryTable.append(fragment);
}

function renderRaw(request) {
  const lines = [`${request.method} ${request.path} HTTP/${request.httpVersion || '1.1'}`];

  for (const [key, value] of Object.entries(request.headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${key}: ${item}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }

  lines.push('');

  if (request.bodyType !== 'empty' && request.rawBody) {
    if (request.bodyEncoding === 'base64') {
      lines.push(`[binary body: ${formatBytes(request.bodySize)}, base64 encoded]`);
    }
    lines.push(request.rawBody);
  }

  dom.rawContent.textContent = lines.join('\n');
}

function setActiveTab(name, { focus = false } = {}) {
  const active = tabs.find((tab) => tab.name === name) || tabs[0];
  state.activeTab = active.name;

  for (const tab of tabs) {
    const selected = tab === active;
    tab.button.setAttribute('aria-selected', String(selected));
    tab.button.tabIndex = selected ? 0 : -1;
    tab.panel.hidden = !selected;
  }

  if (focus) active.button.focus();
}

function shellQuote(value) {
  return String(value).replaceAll("'", "'\\''");
}

function buildRequestCurl(request) {
  const url = `${window.location.origin}${request.path}`;
  const lines = [`curl -X ${request.method} '${shellQuote(url)}'`];

  for (const [key, value] of Object.entries(request.headers || {})) {
    if (EXCLUDED_CURL_HEADERS.has(key.toLowerCase())) continue;
    const displayValue = Array.isArray(value) ? value.join(', ') : String(value);
    if (!displayValue) continue;
    lines.push(`  -H '${shellQuote(key)}: ${shellQuote(displayValue)}'`);
  }

  if (request.bodyType !== 'empty' && request.rawBody) {
    if (request.bodyEncoding === 'base64') {
      lines.push(`  --data-binary @payload.bin # ${formatBytes(request.bodySize)} binary payload`);
    } else {
      lines.push(`  --data-raw '${shellQuote(request.rawBody)}'`);
    }
  }

  return lines.join(' \\\n');
}

function buildSampleCurl() {
  const endpoint = state.endpoint || `${window.location.origin}/wh/your-token`;
  return [
    `curl -X POST '${shellQuote(endpoint)}'`,
    `  -H 'Content-Type: application/json'`,
    `  -H 'X-GitHub-Event: push'`,
    `  -d '{"action":"opened","repository":{"name":"my-repo"}}'`,
  ].join(' \\\n');
}

function updateCurlSample() {
  dom.curlSample.textContent = buildSampleCurl();
}

function selectedRequest() {
  return state.selectedId ? state.byId.get(state.selectedId) : null;
}

function updateRelativeTimes() {
  for (const node of dom.requestList.querySelectorAll('time[data-ts]')) {
    node.textContent = formatRelativeTime(node.dataset.ts);
  }

  const selected = selectedRequest();
  if (selected) {
    dom.detailTime.textContent = `${formatFullTime(selected.receivedAt)} · ${formatRelativeTime(selected.receivedAt)}`;
  }

  if (state.requests.length > 0) {
    const latest = state.requests[0];
    const shown = filteredRequests().length;
    if (state.filter) {
      dom.requestSummary.textContent = `${shown} of ${state.requests.length} requests shown`;
    } else {
      dom.requestSummary.textContent = `${state.requests.length} request${state.requests.length === 1 ? '' : 's'} · latest ${formatRelativeTime(latest.receivedAt)}`;
    }
  }
}

function navigateRequests(delta) {
  const requests = filteredRequests();
  if (requests.length === 0) return;

  const currentIndex = requests.findIndex((request) => request.id === state.selectedId);
  let nextIndex;

  if (currentIndex === -1) {
    nextIndex = delta > 0 ? 0 : requests.length - 1;
  } else {
    nextIndex = (currentIndex + delta + requests.length) % requests.length;
  }

  selectRequest(requests[nextIndex].id);
}

function isTypingTarget(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable
  );
}

function bindEvents() {
  dom.newBinBtn.addEventListener('click', () => createNewBin());
  dom.bannerNewBinBtn.addEventListener('click', () => createNewBin({ reason: 'expired' }));

  dom.copyUrlBtn.addEventListener('click', async () => {
    if (!state.endpoint) return;
    await copyText(state.endpoint, 'Webhook URL copied');
    dom.copyUrlBtn.classList.add('is-copied');
    setTimeout(() => dom.copyUrlBtn.classList.remove('is-copied'), 1_200);
  });

  dom.copyCurlBtn.addEventListener('click', () => {
    copyText(buildSampleCurl(), 'Example cURL copied');
  });

  dom.copyCurlRequestBtn.addEventListener('click', () => {
    const request = selectedRequest();
    if (request) copyText(buildRequestCurl(request), 'Request cURL copied');
  });

  dom.copyJsonBtn.addEventListener('click', () => {
    const request = selectedRequest();
    if (request) copyText(JSON.stringify(request, null, 2), 'Request JSON copied');
  });

  dom.filterInput.addEventListener('input', () => {
    state.filter = dom.filterInput.value.trim().toLowerCase();
    renderList();
  });

  dom.filterInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dom.filterInput.value = '';
      state.filter = '';
      renderList();
      dom.filterInput.blur();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const requests = filteredRequests();
      if (requests.length > 0) selectRequest(requests[0].id);
    }
  });

  dom.requestList.addEventListener('click', (event) => {
    const item = event.target.closest('.request-item');
    if (item?.dataset.id) selectRequest(item.dataset.id, { scroll: false });
  });

  dom.requestList.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const item = event.target.closest('.request-item');
    if (!item?.dataset.id) return;
    event.preventDefault();
    selectRequest(item.dataset.id, { scroll: false });
  });

  for (const tab of tabs) {
    tab.button.addEventListener('click', () => setActiveTab(tab.name));
  }

  document.querySelector('.tabs')?.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();

    const currentIndex = tabs.findIndex((tab) => tab.button.getAttribute('aria-selected') === 'true');
    let nextIndex = currentIndex;

    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;

    setActiveTab(tabs[nextIndex].name, { focus: true });
  });

  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const typing = isTypingTarget(event.target);

    if (event.key === '/' && !typing) {
      event.preventDefault();
      dom.filterInput.focus();
      dom.filterInput.select();
      return;
    }

    if (event.key === 'Escape' && !typing) {
      if (state.selectedId) clearSelection();
      return;
    }

    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !typing) {
      event.preventDefault();
      navigateRequests(event.key === 'ArrowDown' ? 1 : -1);
    }
  });
}

async function loadHealth() {
  try {
    const { response, data } = await fetchJson('/api/health');
    if (!response.ok || !data?.ok) return;

    const isRedis = data.store === 'redis';
    dom.storeBadge.className = `store-badge store-badge--${isRedis ? 'redis' : 'memory'}`;
    dom.storeLabel.textContent = isRedis ? 'Redis' : 'Memory';
    dom.footerStore.textContent = data.store;
    dom.storeBadge.title = isRedis
      ? 'Redis-backed ephemeral storage with automatic TTL expiry'
      : 'In-memory storage: history is lost when the server restarts (development fallback)';
  } catch {
    dom.storeBadge.className = 'store-badge';
    dom.storeLabel.textContent = 'Offline';
  }
}

async function init() {
  bindEvents();

  const pathToken = parseTokenFromPath();
  let storedToken = null;

  try {
    storedToken = localStorage.getItem(STORAGE_KEY);
  } catch {
    storedToken = null;
  }

  const candidate = pathToken || storedToken;

  if (candidate) {
    const result = await loadBin(candidate);
    if (result === 'loaded') {
      startTimers();
      loadHealth();
      return;
    }

    if (result === 'error') {
      // Do not create a second bin when the server itself is unreachable.
      startTimers();
      loadHealth();
      return;
    }
  }

  await createNewBin({ reason: pathToken ? 'expired' : '' });
  startTimers();
  loadHealth();
}

function startTimers() {
  setInterval(() => {
    updateExpiry();
    state.timeUpdateCounter += 1;
    if (state.timeUpdateCounter % 10 === 0) updateRelativeTimes();
  }, 1_000);
}

init();
