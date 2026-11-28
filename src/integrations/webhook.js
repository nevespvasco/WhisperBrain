'use strict';
// Outgoing webhooks: JSON POST, optionally signed with HMAC-SHA256 so receivers can verify the sender.
const crypto = require('node:crypto');

const sign = (body, secret) => `sha256=${crypto.createHmac('sha256', String(secret)).update(body).digest('hex')}`;

// For receivers (and tests): constant-time check of an X-WhisperBrain-Signature header.
function verifySignature(body, secret, header) {
  const want = Buffer.from(sign(body, secret));
  const got = Buffer.from(String(header || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

async function postWebhook({ url, secret, payload, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { throw new Error('The webhook URL is not valid'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Webhook URLs must start with http:// or https://');
  const body = JSON.stringify(payload ?? {});
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'WhisperBrain' };
  if (payload?.event) headers['X-WhisperBrain-Event'] = String(payload.event);
  if (secret) headers['X-WhisperBrain-Signature'] = sign(body, secret);
  let res;
  try {
    // redirects are not followed: a 307/308 would re-POST the signed payload to wherever the receiver (or someone who took over
    // its address) points it
    res = await fetchImpl(u.href, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    const err = new Error(timeout ? `The webhook did not answer within ${Math.round(timeoutMs / 1000)}s` : `Cannot reach the webhook at ${u.host} (${e.cause?.code || e.message})`);
    err.code = timeout ? 'timeout' : 'unreachable';
    throw err;
  }
  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
    let to = '';
    try { to = new URL(res.headers?.get?.('location') || '', u).host; } catch { /* no usable Location */ }
    const err = new Error(`The webhook answered with a redirect (HTTP ${res.status}${to ? ` to ${to}` : ''}); redirects are not followed: use the final address`);
    err.status = res.status;
    err.code = 'redirect';
    throw err;
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).trim().slice(0, 200); } catch { /* no body */ }
    const err = new Error(`Webhook returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    err.status = res.status;
    err.code = 'http';
    throw err;
  }
  return { ok: true, status: res.status };
}

module.exports = { postWebhook, verifySignature, sign };
