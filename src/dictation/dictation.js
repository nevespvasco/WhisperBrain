'use strict';
const { PushSource } = require('../audio/source');
const { pcm16ToWav } = require('../audio/pcm');

const MAX_MS = 5 * 60 * 1000;
const MIN_MS = 350;

// Push-to-dictate: toggle() starts listening on the microphone; toggle() again transcribes what was said and
// pastes it into the focused app (or leaves it on the clipboard). States: idle -> listening -> transcribing -> idle.
class Dictation {
  constructor({ platform, engine, models, settings, bus, now = Date.now }) {
    Object.assign(this, { platform, engine, models, settings, bus, now });
    this.state = 'idle';
    this.source = null;
    this.chunks = [];
    this.startedAt = 0;
    this.timer = null;
  }

  status() { return { state: this.state, rendererCapture: this.platform.capture.mic === 'renderer' }; }

  set(state, extra = {}) { this.state = state; this.bus.publish('dictation.state', { state, ...extra }); }

  async toggle() {
    if (this.state === 'listening') return this.finish();
    if (this.state === 'transcribing') return { state: this.state };
    return this.begin();
  }

  async begin() {
    const s = this.settings.all();
    const model = this.models.resolve(s.asrModel);
    if (!model) throw new Error('No speech model is installed. Download one in Settings → Transcription.');
    await this.engine.start(model, { role: 'dictation', vadPath: this.models.vadPath(), threads: s.asrThreads, language: s.asrLanguage });
    const src = this.platform.capture.mic === 'native' ? this.platform.createMicSource({ device: s.micDevice }) : new PushSource();
    this.source = src;
    this.chunks = [];
    src.on('pcm', (b) => { this.chunks.push(b); });
    src.on('error', (e) => { this.bus.publish('dictation.error', { message: e.message }); this.cancel(); });
    src.start();
    this.startedAt = this.now();
    this.timer = setTimeout(() => this.finish().catch(() => {}), MAX_MS);
    this.timer.unref?.();
    this.set('listening');
    if (src instanceof PushSource) this.bus.publish('capture.request', { dictation: true, channels: ['mic'] });
    return { state: 'listening' };
  }

  // Audio from the renderer bridge (macOS/Windows).
  pushPcm(buf) {
    if (this.state === 'listening' && this.source instanceof PushSource) { this.source.push(buf); return true; }
    return false;
  }

  cancel() {
    clearTimeout(this.timer);
    try { this.source?.stop(); } catch { /* ignore */ }
    this.source = null;
    this.chunks = [];
    if (this.state !== 'idle') this.set('idle');
  }

  async finish() {
    if (this.state !== 'listening') return { state: this.state };
    clearTimeout(this.timer);
    const duration = this.now() - this.startedAt;
    this.source.stop();
    this.source = null;
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    if (duration < MIN_MS || pcm.length < 16000 * 2 * 0.2) { this.set('idle'); return { state: 'idle', text: '', skipped: 'too short' }; }
    this.set('transcribing');
    try {
      let text = await this.engine.transcribe(pcm);
      text = tidy(text);
      const cfg = this.settings.get('dictation');
      let paste = null;
      if (text && cfg.autoPaste) paste = await this.platform.paste(text);
      else if (text && this.platform.clipboard?.write) await this.platform.clipboard.write(text);
      this.bus.publish('dictation.result', { text, paste, durationMs: duration });
      return { state: 'idle', text, paste };
    } catch (e) {
      this.bus.publish('dictation.error', { message: e.message });
      throw e;
    } finally {
      this.set('idle');
    }
  }
}

// Spoken text from the recognizer: normalise spacing; keep a single trailing space off.
function tidy(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }

module.exports = { Dictation, tidy, MAX_MS, MIN_MS, pcm16ToWav };
