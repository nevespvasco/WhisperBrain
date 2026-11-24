'use strict';
// The last resort for knowing who is speaking: look at the meeting window and ask the user's own vision model (any
// OpenAI-compatible server, Ollama included: the picture goes where the LLM setting says, which is normally this computer).
// It runs only while a recording does, only when no better source (the extension, the accessibility reader) is connected,
// and never unless the person switched it on in Settings. The model only has to read what is on the screen, so a small one
// will do, but it has to be able to see: a text-only model answers nonsense, which is noticed and reported.
const crypto = require('node:crypto');

const SOURCE = 'vision';
const ASK = (user, known) => `This is a screenshot of a video call window. Read it and answer with JSON only, no other text:
{"participants": [every person's name that is visible], "speaking": [the names of people whose tile shows they are speaking right now (a highlighted border, a moving sound indicator or a speaking icon)], "confidence": "high" or "low"}
${user ? `The person looking at this screen is called "${user}"; leave them out of "speaking". ` : ''}${known.length ? `Names already known on this call: ${known.slice(0, 40).join(', ')}. Use these spellings. ` : ''}If you cannot tell, use an empty list and "low". Never guess a name that is not on the screen.`;

// -> { participants: [string], speaking: [string], confidence } or null when the answer is not what was asked for
function parseAnswer(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 80)) : null);
  const participants = list(j.participants), speaking = list(j.speaking);
  if (!participants || !speaking) return null;
  return { participants, speaking, confidence: j.confidence === 'high' ? 'high' : 'low' };
}

class VisionSource {
  // llm: LlmClient. capture(): -> { jpeg: Buffer, title } | null (no meeting window); may throw an Error with code 'permission'.
  constructor({ hub, llm, capture, userName = () => '', intervalMs = 2000, maxFailures = 4 }) {
    Object.assign(this, { hub, llm, capture, userName, intervalMs, maxFailures });
    this.timer = null; this.busy = false; this.failures = 0; this.last = ''; this.lastFrame = ''; this.speaker = undefined; this.roster = ''; this.inCall = null;
    this.known = new Set();
  }

  get on() { return !!this.timer; }

  start() {
    if (this.timer) return true;
    if (!this.capture) { this.hub.report(SOURCE, { kind: 'vision', state: 'off', detail: 'this system cannot look at another window' }); return false; }
    this.failures = 0; this.speaker = undefined; this.roster = ''; this.inCall = null; this.lastFrame = '';
    this.hub.report(SOURCE, { kind: 'vision', state: 'waiting', detail: 'waiting: it only looks when no other source is connected' });
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
    return true;
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    if (this.speaker) { try { this.hub.ingest({ type: 'speaker', name: null }, { source: SOURCE, kind: 'vision' }); } catch { /* nobody listens */ } }
    this.hub.report(SOURCE, { kind: 'vision', state: 'off', detail: '' });
  }

  async tick() {
    if (this.busy || !this.timer) return;
    if (this.hub.anyConnected([SOURCE])) { this.hub.report(SOURCE, { kind: 'vision', state: 'waiting', detail: 'not needed: another source is connected' }); return; }
    this.busy = true;
    try {
      let frame;
      try { frame = await this.capture(); } catch (e) {
        this.hub.report(SOURCE, { kind: 'vision', state: e.code === 'permission' ? 'denied' : 'error', detail: e.code === 'permission' ? 'Screen recording permission is needed to look at the meeting window.' : e.message });
        return;
      }
      if (!frame) { this.hub.report(SOURCE, { kind: 'vision', state: 'waiting', detail: 'no meeting window found' }); return; }
      const sum = crypto.createHash('md5').update(frame.jpeg).digest('hex');
      if (sum === this.lastFrame) return;            // the screen did not change: the answer would not either
      this.lastFrame = sum;
      const text = await this.llm.complete([{ role: 'user', content: [
        { type: 'text', text: ASK(this.userName(), [...this.known]) },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frame.jpeg.toString('base64')}` } },
      ] }], { temperature: 0, maxTokens: 300 });
      const a = parseAnswer(text);
      if (!a) {
        if (++this.failures >= this.maxFailures) { this.hub.report(SOURCE, { kind: 'vision', state: 'error', detail: 'The model does not answer as asked. Is it a model that can see pictures?' }); this.failures = 0; }
        return;
      }
      this.failures = 0;
      this.emit(a, frame);
    } catch (e) {
      this.hub.report(SOURCE, { kind: 'vision', state: 'error', detail: e.message });
    } finally { this.busy = false; }
  }

  emit(a, frame) {
    const send = (m) => { try { this.hub.ingest(m, { source: SOURCE, kind: 'vision' }); } catch { /* a bad message is dropped */ } };
    a.participants.forEach((n) => this.known.add(n));
    const inCall = a.participants.length > 0;
    if (inCall !== this.inCall) { this.inCall = inCall; send({ type: 'meeting', inCall, code: /([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(frame.title || '')?.[1] || '', title: frame.title || '' }); }
    const rk = [...a.participants].sort().join('|');
    if (inCall && rk !== this.roster) { this.roster = rk; send({ type: 'roster', participants: a.participants.map((name) => ({ name })) }); }
    // only a name that is on the screen, and only when the model says it is sure, and only one at a time
    const names = new Map(a.participants.map((n) => [n.toLowerCase(), n]));
    const real = a.speaking.map((n) => names.get(n.toLowerCase())).filter(Boolean);
    const who = a.confidence === 'high' && real.length === 1 ? real[0] : null;
    if (who !== this.speaker && (this.speaker !== undefined || who)) { this.speaker = who; send({ type: 'speaker', name: who }); }
  }
}

module.exports = { VisionSource, parseAnswer };
