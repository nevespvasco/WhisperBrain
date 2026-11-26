'use strict';
// Embeddings from the same OpenAI-compatible server as the AI (Ollama: /v1/embeddings). Off until a model is named in Settings → AI;
// then every piece of text that is to be searched by meaning is sent to that server, so a private source is only embedded when the server
// is on this computer (src/items/policy.js decides, the index asks). Returns unit-length Float32Arrays.

const BATCH = 16;

class LlmEmbedder {
  // getConfig: () => settings.llm ({ baseUrl, apiKey }); getModel: () => the embedding model name ('' = off)
  constructor({ getConfig, getModel, fetchImpl = globalThis.fetch, timeoutMs = 60_000 }) { Object.assign(this, { getConfig, getModel, fetch: fetchImpl, timeoutMs }); }

  model() { return String(this.getModel() || '').trim(); }
  configured() { return !!this.model() && !!String(this.getConfig()?.baseUrl || '').trim(); }

  async embed(texts) {
    if (!this.configured()) throw new Error('No embedding model is set (Settings → AI).');
    const cfg = this.getConfig();
    const url = `${String(cfg.baseUrl).trim().replace(/\/+$/, '')}/embeddings`;
    const out = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const part = texts.slice(i, i + BATCH);
      let res;
      try {
        res = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) }, body: JSON.stringify({ model: this.model(), input: part }), signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (e) { throw new Error(`Cannot reach the embedding server (${e.cause?.code || e.message}).`); }
      if (!res.ok) {
        let detail = ''; try { const j = await res.json(); detail = j.error?.message || j.error || ''; } catch { /* not json */ }
        throw new Error(`Embedding request failed (${res.status})${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
      }
      const json = await res.json();
      const rows = (json.data || []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== part.length) throw new Error('The embedding server returned the wrong number of vectors.');
      for (const r of rows) out.push(unit(r.embedding));
    }
    return out;
  }
}

function unit(v) {
  const a = Float32Array.from(v || []);
  let n = 0; for (const x of a) n += x * x;
  n = Math.sqrt(n) || 1;
  return a.map((x) => x / n);
}

module.exports = { LlmEmbedder };
