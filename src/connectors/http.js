'use strict';
// What every service connector needs from HTTP: a JSON request with a timeout, a clear error, and the rate limits handled the way the
// services ask: a short Retry-After is waited out once, a long one stops the sync with a message saying when to try again (the next
// scheduled run then continues from the saved cursor).
const TIMEOUT_MS = 20_000;
const MAX_WAIT_MS = 30_000;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RateLimited extends Error {
  constructor(service, retryAfterMs) { super(`${service} asked to slow down; trying again later.`); this.code = 'rate-limited'; this.retryAfterMs = retryAfterMs; }
}

// -> { status, headers, json }. `service` names the service in errors. onUnauthorized: a message for a 401 / 403 that means the token is bad.
async function request(url, { service = 'The service', headers = {}, method = 'GET', body, fetchImpl = globalThis.fetch, sleep = defaultSleep, signal, retried = false } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { method, headers: { Accept: 'application/json', ...headers }, body, signal: signal || AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') throw Object.assign(new Error(`${service} did not answer in time.`), { code: 'timeout' });
    throw Object.assign(new Error(`Cannot reach ${service} (${e.cause?.code || e.message}).`), { code: 'unreachable' });
  }
  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const wait = res.headers.get('retry-after') ? Number(res.headers.get('retry-after')) * 1000 : (reset ? Math.max(0, reset * 1000 - Date.now()) : 60_000);
    if (!retried && wait <= MAX_WAIT_MS) { await sleep(wait); return request(url, { service, headers, method, body, fetchImpl, sleep, signal, retried: true }); }
    throw new RateLimited(service, wait);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const detail = json?.message || json?.error?.message || (typeof json?.error === 'string' ? json.error : '') || '';
    const e = new Error(`${service}: ${detail || `HTTP ${res.status}`}`);
    e.status = res.status;
    e.code = res.status === 401 || res.status === 403 ? 'unauthorized' : res.status === 404 ? 'not-found' : 'http';
    throw e;
  }
  return { status: res.status, headers: res.headers, json };
}

// rel="next" of a Link header (GitHub), or null
const nextLink = (headers) => /<([^>]+)>;\s*rel="next"/.exec(headers.get('link') || '')?.[1] || null;

module.exports = { request, nextLink, RateLimited, defaultSleep };
