'use strict';
// Minimal OpenAI-compatible chat client. Works with Ollama (/v1), llama.cpp, LM Studio, vLLM, OpenRouter, OpenAI...

const DEFAULT_MAX_TOKENS = 4096; // ~3000 words: longer than any summary or answer the app asks for
// Our own time limits, so a stuck server never holds the one AI slot until undici's 300 s defaults run out. Once the reply is
// streaming every chunk (thinking included) arrives within a second or two, so a minute of silence means it is stuck. The first
// byte may take much longer: Ollama loading a model, or reading a long prompt on a CPU, sends nothing until it is done.
const IDLE_MS = 60_000;
const FIRST_BYTE_MS = 300_000;

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
  constructor() { this.inside = false; this.buf = ''; this.saw = false; }
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
        if (start >= 0) { out += this.buf.slice(0, start); this.buf = this.buf.slice(start + 7); this.inside = true; this.saw = true; continue; }
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

  async listModels({ signal } = {}) {
    const cfg = this.getConfig();
    const res = await this.request(`${normalizeBase(cfg.baseUrl)}/models`, { headers: this.headers(cfg), signal });
    const json = await res.json();
    return (json.data || json.models || []).map((m) => m.id || m.name).filter(Boolean);
  }

  async resolveModel(cfg, { signal } = {}) {
    if (cfg.model) return cfg.model;
    const models = await this.listModels({ signal });
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

  // Ollama's OpenAI endpoint switches a reasoning model's thinking off with reasoning_effort "none" (it ignores `think`).
  // Other servers are not sent it: OpenAI rejects reasoning_effort for models that do not reason.
  static isOllama(cfg) { return cfg.provider === 'ollama' || /:11434(\/|$)/.test(String(cfg.baseUrl || '')); }

  // Async generator of text deltas.
  // reasoning: 'off' asks the server not to think first (short, structured replies: titles, JSON). Whatever is asked, a
  // reply that ended on the token cap while still thinking, with no answer yet, is tried once more: without thinking
  // (Ollama) or with a larger cap. If that is empty too it is an error, never a silent empty answer.
  // idleMs / firstByteMs: see IDLE_MS. onStart(): the request is under way (the scheduler calls it when a slot is granted instead).
  // onProgress(): every chunk the server sends, thinking included, so a caller's own "has it started?" timer can tell a model that
  // thinks from one that is stuck. onFinish(reason): the server's finish_reason at the end ('length': the reply hit maxTokens, so
  // JSON in it may be cut off).
  async *stream(messages, { signal, temperature, maxTokens, frequencyPenalty, reasoning, idleMs = IDLE_MS, firstByteMs = FIRST_BYTE_MS, onStart, onProgress, onFinish } = {}) {
    onStart?.();
    const cfg = this.getConfig();
    const model = await this.resolveModel(cfg, { signal });
    const ollama = LlmClient.isOllama(cfg);
    // Always cap the reply: a small local model can fall into a repeat loop, and without a cap Ollama keeps
    // generating forever (it shifts the context), holding its single slot so every later request waits.
    const body = { model, messages, stream: true, temperature: temperature ?? cfg.temperature, max_tokens: maxTokens || DEFAULT_MAX_TOKENS };
    if (frequencyPenalty) body.frequency_penalty = frequencyPenalty;
    if (reasoning === 'off' && ollama) body.reasoning_effort = 'none';
    for (let attempt = 0; ; attempt++) {
      const run = { yielded: false, thought: false, finish: null };
      for await (const t of this.attempt(cfg, body, signal, run, { idleMs, firstByteMs, onProgress })) { run.yielded = true; yield t; }
      if (run.yielded || run.finish !== 'length' || !run.thought) { try { onFinish?.(run.finish); } catch { /* a caller's hook */ } return; }
      if (attempt > 0) throw new LlmError(`The model "${model}" used its whole reply budget thinking and gave no answer. Pick a model that does not reason first in Settings → AI.`, { code: 'thinking-cutoff' });
      if (ollama && body.reasoning_effort !== 'none') body.reasoning_effort = 'none';
      else body.max_tokens = Math.max(body.max_tokens * 8, 2048);
    }
  }

  // One request. Our own controller sits between the caller's signal and the fetch: the caller's abort still ends it as an AbortError,
  // our idle limit ends it as an LlmError with code 'timeout'. The limit counts only time spent waiting for the server, not time the
  // consumer spends on a chunk.
  async *attempt(cfg, body, signal, run, { idleMs = IDLE_MS, firstByteMs = FIRST_BYTE_MS, onProgress } = {}) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(signal.reason);
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    let timer = null, timedOut = 0;
    const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => { timedOut = ms; ctl.abort(); }, ms); timer.unref?.(); };
    const filter = new ThinkFilter();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      arm(firstByteMs);
      const res = await this.request(`${normalizeBase(cfg.baseUrl)}/chat/completions`, { method: 'POST', headers: this.headers(cfg), body: JSON.stringify(body), signal: ctl.signal });
      arm(idleMs);
      for await (const chunk of res.body) {
        clearTimeout(timer);
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { const tail = filter.flush(); if (tail.trim() || (run.yielded && tail)) yield tail; return; }
          let json;
          try { json = JSON.parse(data); } catch { continue; }
          if (json.error) throw new LlmError(`LLM error: ${json.error.message || JSON.stringify(json.error)}`);
          const choice = json.choices?.[0];
          if (choice?.finish_reason) run.finish = choice.finish_reason;
          if (choice?.delta?.reasoning || choice?.delta?.reasoning_content) run.thought = true;
          if (choice?.delta) { try { onProgress?.(); } catch { /* a caller's hook never breaks the stream */ } }
          const delta = choice?.delta?.content;
          if (delta) { const t = filter.push(delta); if (t && (run.yielded || t.trim())) yield t; }
        }
        arm(idleMs);
      }
      const tail = filter.flush();
      if (tail.trim() || (run.yielded && tail)) yield tail;
    } catch (e) {
      if (timedOut && !signal?.aborted) {
        throw new LlmError(`The AI server stopped sending: nothing for ${Math.round(timedOut / 1000)} s, so the request was stopped. Is the model still loading, or the server stuck?`, { code: 'timeout' });
      }
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (filter.saw) run.thought = true;
    }
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
      const reply = await this.complete([{ role: 'user', content: 'Reply with the single word: ok' }], { maxTokens: 16, temperature: 0, reasoning: 'off' });
      return { ok: true, model, models, reply: reply.slice(0, 40) };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code };
    }
  }
}

module.exports = { LlmClient, LlmError, ThinkFilter, IDLE_MS, FIRST_BYTE_MS };
