'use strict';
// When should the assistant prepare help, and when should it show it? A state machine over the live transcript, with no AI and
// no I/O, so it is tested on a mocked clock.
//
//   them final ──► wait for quiet ──► speculate (prepare an answer, hidden) ──► reveal (show it)
//        ▲            120 ms after "?", 600 ms normally,          quick for "?", revealMs otherwise
//        │            3.2 s when the sentence was cut off
//        └── them speaking again cancels a speculation that is not shown yet (and bumps seq, so its late result is dropped)
//
// Fillers ("ok", "pois"), backchannels ("mm-hmm") and the user's own answer heard back through the speakers are ignored. The same
// question within 20 s is suppressed. "Can you repeat that?" asks for the last answer again. Manual requests skip all of that.
const { EventEmitter } = require('node:events');
const { isFiller, isBackchannel, endsDangling, isRepeatRequest, echoOverlap, sameQuestion, questionKind } = require('./filters');

const TIERS = { question: 120, normal: 600, dangling: 3200 };
const KEEP_LINES = 3;        // a question keeps the lines just before it as its preamble, no more
const KEEP_ANSWERS = 3;      // answers remembered to recognise the user reading one aloud
const KEEP_ME = 12;          // what the user said, so suggestions do not contradict or repeat it
const ECHO = 0.6;
const endsWithQuestionMark = (s) => /[?？؟]\s*$/.test(s);

class TurnEngine extends EventEmitter {
  // mode: 'meeting' (questions trigger) | 'interview' (questions and "tell me about…" prompts trigger)
  // trigger: 'auto' | 'manual' (only answerNow / regenerate)
  constructor({ mode = 'meeting', trigger = 'auto', revealMs = 1500, quickRevealMs = 400, dedupMs = 20000, tiers = TIERS } = {}) {
    super();
    Object.assign(this, { mode, trigger, revealMs, quickRevealMs, dedupMs, tiers: { ...TIERS, ...tiers } });
    this.seq = 0;
    this.reset();
  }

  configure(opts = {}) {
    for (const k of ['mode', 'trigger', 'revealMs', 'quickRevealMs', 'dedupMs']) if (opts[k] !== undefined) this[k] = opts[k];
  }

  reset() {
    this.clearTimers();
    this.phase = 'idle';            // idle | waiting (for quiet) | preparing (speculation hidden) | shown
    this.lines = [];                // what the other side said since the last answer (the question and its preamble)
    this.current = null;            // { seq, question, quick } being prepared or shown
    this.lastQuestion = '';
    this.variation = 0;
    this.answers = [];
    this.me = [];
    this.asked = [];                // [{ question, at }] answered recently
  }

  clearTimers() {
    clearTimeout(this.waitTimer); clearTimeout(this.revealTimer);
    this.waitTimer = this.revealTimer = null;
  }

  state() { return { phase: this.phase, question: this.current?.question || this.lastQuestion || '', seq: this.seq }; }
  meSaid() { return [...this.me]; }
  heardLines() { return [...this.lines]; }

  // { speaker: 'them' | 'me', text, final }
  heard({ speaker, text, final }) {
    const s = String(text ?? '').trim();
    if (!s) return;
    if (speaker === 'me') {
      if (final) { this.me.push(s); if (this.me.length > KEEP_ME) this.me.shift(); }
      return;
    }
    if (isBackchannel(s) || (final && isFiller(s))) return;
    if (echoOverlap(s, this.answers) >= ECHO) return;
    if (!final) {
      // they are still talking: whatever was being prepared is for a question that is not finished
      if (this.phase === 'preparing') this.cancel('speech');
      else if (this.phase === 'waiting') { this.clearTimers(); this.phase = 'idle'; }
      return;
    }
    if (this.phase === 'preparing') this.cancel('speech');
    this.clearTimers();
    this.lines.push(s);
    if (this.lines.length > KEEP_LINES) this.lines.shift();
    this.phase = 'waiting';
    const last = this.lines[this.lines.length - 1];
    const wait = endsDangling(last) ? this.tiers.dangling : endsWithQuestionMark(last) ? this.tiers.question : this.tiers.normal;
    this.waitTimer = setTimeout(() => this.settle(), wait);
  }

  // The other side has been quiet long enough: is what they said worth an answer?
  settle() {
    this.waitTimer = null;
    const last = this.lines[this.lines.length - 1] || '';
    const question = this.lines.join(' ');
    if (isRepeatRequest(last)) { this.lines = []; this.phase = 'idle'; this.emit('repeat', { question: this.lastQuestion }); return; }
    const kind = questionKind(last);
    const wanted = this.trigger === 'auto' && (kind === 'question' || (kind === 'prompt' && this.mode === 'interview'));
    if (!wanted) { this.phase = 'idle'; return; }
    const now = Date.now();
    this.asked = this.asked.filter((a) => now - a.at < this.dedupMs);
    if (this.asked.some((a) => sameQuestion(a.question, question))) {
      this.lines = []; this.phase = 'idle';
      this.emit('suppress', { reason: 'duplicate', question });
      return;
    }
    this.variation = 0;
    this.speculate(question, { kind, quick: endsWithQuestionMark(last) });
    this.revealTimer = setTimeout(() => this.reveal(), this.current.quick ? this.quickRevealMs : this.revealMs);
  }

  speculate(question, { kind = questionKind(question), quick = false, manual = false } = {}) {
    this.seq++;
    this.current = { seq: this.seq, question, quick };
    this.phase = 'preparing';
    this.emit('speculate', { seq: this.seq, question, kind, manual, variation: this.variation });
  }

  reveal() {
    clearTimeout(this.revealTimer); this.revealTimer = null;
    if (!this.current || this.phase !== 'preparing') return;
    this.phase = 'shown';
    this.lastQuestion = this.current.question;
    this.asked.push({ question: this.current.question, at: Date.now() });
    this.lines = [];
    this.emit('reveal', { seq: this.current.seq, question: this.current.question });
  }

  cancel(reason) {
    const seq = this.current?.seq ?? this.seq;
    this.clearTimers();
    this.current = null;
    this.phase = 'idle';
    this.seq++;   // anything still arriving for the cancelled request is now stale
    this.emit('cancel', { seq, reason });
  }

  // The answer that was shown, so the user reading it aloud is not taken for the other side.
  answered(text) {
    if (!text) return;
    this.answers.push(String(text));
    if (this.answers.length > KEEP_ANSWERS) this.answers.shift();
  }

  // "Answer now": show what is being prepared, or prepare one from what was last said. Never suppressed. -> false when there is nothing to answer
  answerNow() {
    if (this.phase === 'preparing') { this.reveal(); return true; }
    const question = this.lines.length ? this.lines.join(' ') : this.lastQuestion;
    if (!question) return false;
    this.clearTimers();
    this.variation = 0;
    this.speculate(question, { manual: true });
    this.reveal();
    return true;
  }

  // "Another angle": the last question again, asked for a different answer.
  regenerate() {
    const question = this.lastQuestion;
    if (!question) return false;
    if (this.phase === 'preparing') this.cancel('regenerate');
    this.clearTimers();
    this.variation++;
    this.speculate(question, { manual: true });
    this.reveal();
    return true;
  }

  dismiss() {
    if (this.phase === 'preparing') this.cancel('dismissed');
    this.clearTimers();
    this.lines = [];
    if (this.phase !== 'idle') this.phase = 'idle';
  }
}

module.exports = { TurnEngine, TIERS };
