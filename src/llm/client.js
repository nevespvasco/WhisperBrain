'use strict';
// Minimal OpenAI-compatible chat client. Works with Ollama (/v1), llama.cpp, LM Studio, vLLM, OpenRouter, OpenAI...

const DEFAULT_MAX_TOKENS = 4096; // ~3000 words: longer than any summary or answer the app asks for

class LlmError extends Error {
  constructor(message, { status, code } = {}) { super(message); this.status = status; this.code = code; }
}

function normalizeBase(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) throw new LlmError('No LLM server URL is configured. Set one in Settings → AI.', { code: 'not-configured' });
  return u;
}

// Reasoning models emit <think>…</think>; hide it from notes. Stateful so tags may be split across chunks.
class ThinkFilter {
  constructor() { this.inside = false; this.buf = ''; }
  push(text) {
    this.buf += text;
    let out = '';
    for (;;) {
      if (this.inside) {
        const end = this.buf.indexOf('</think>');
        if (end < 0) { this.buf = this.buf.slice(Math.max(0, this.buf.length - 8)); return out; }
        this.buf = this.buf.slice(end + 8).replace(/^\s+/, '');
        this.inside = false;
      } else {
        const start = this.buf.indexOf('<think>');
        if (start >= 0) { out += this.buf.slice(0, start); this.buf = this.buf.slice(start + 7); this.inside = true; continue; }
        // keep a possible partial "<think" at the end
        const keep = partialTagLength(this.buf, '<think>');
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
    }
  }
  flush() { const r = this.inside ? '' : this.buf; this.buf = ''; return r; }
}
function partialTagLength(s, tag) {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (s.endsWith(tag.slice(0, n))) return n;
  return 0;
}

class LlmClient {
  // getConfig: () => settings.llm
  constructor(getConfig, { fetchImpl = globalThis.fetch } = {}) { this.getConfig = getConfig; this.fetch = fetchImpl; }

  headers(cfg) {
    const h = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
    return h;
  }

  async listModels() {
    const cfg = this.getConfig();
    const res = await this.request(`${normalizeBase(cfg.baseUrl)}/models`, { headers: this.headers(cfg) });
    const json = await res.json();
    return (json.data || json.models || []).map((m) => m.id || m.name).filter(Boolean);
  }

  async resolveModel(cfg) {
    if (cfg.model) return cfg.model;
    const models = await this.listModels();
    if (!models.length) throw new LlmError('The LLM server has no models. Pull one (for Ollama: `ollama pull llama3.2`) and pick it in Settings → AI.', { code: 'no-model' });
    return models[0];
  }

  async request(url, init) {
    let res;
    try { res = await this.fetch(url, init); } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new LlmError(`Cannot reach the LLM server at ${url.replace(/\/(chat\/completions|models)$/, '')} (${e.cause?.code || e.message}). Is it running?`, { code: 'unreachable' });
    }
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j.error?.message || j.error || j.message || ''; } catch { /* not json */ }
      throw new LlmError(`LLM request failed (${res.status})${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`, { status: res.status, code: res.status === 401 ? 'unauthorized' : 'http' });
    }
    return res;
  }

  // Async generator of text deltas.
  async *stream(messages, { signal, temperature, maxTokens, frequencyPenalty } = {}) {
    const cfg = this.getConfig();
    const model = await this.resolveModel(cfg);
    // Always cap the reply: a small local model can fall into a repeat loop, and without a cap Ollama keeps
    // generating forever (it shifts the context), holding its single slot so every later request waits.
    const body = { model, messages, stream: true, temperature: temperature ?? cfg.temperature, max_tokens: maxTokens || DEFAULT_MAX_TOKENS };
    if (frequencyPenalty) body.frequency_penalty = frequencyPenalty;
    const res = await this.request(`${normalizeBase(cfg.baseUrl)}/chat/completions`, { method: 'POST', headers: this.headers(cfg), body: JSON.stringify(body), signal });
    const filter = new ThinkFilter();
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { const tail = filter.flush(); if (tail) yield tail; return; }
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        if (json.error) throw new LlmError(`LLM error: ${json.error.message || JSON.stringify(json.error)}`);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) { const t = filter.push(delta); if (t) yield t; }
      }
    }
    const tail = filter.flush();
    if (tail) yield tail;
  }

  async complete(messages, opts) {
    let out = '';
    for await (const d of this.stream(messages, opts)) out += d;
    return out.trim();
  }

  async test() {
    const cfg = this.getConfig();
    try {
      const models = await this.listModels();
      const model = cfg.model || models[0] || '';
      if (!model) return { ok: false, error: 'Connected, but the server has no models.', models };
      const reply = await this.complete([{ role: 'user', content: 'Reply with the single word: ok' }], { maxTokens: 16, temperature: 0 });
      return { ok: true, model, models, reply: reply.slice(0, 40) };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code };
    }
  }
}

module.exports = { LlmClient, LlmError, ThinkFilter };
