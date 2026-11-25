#!/usr/bin/env node
'use strict';
// Offline evaluation of the live assistant's question detection (src/assistant/turns.js) on timed dialogs
// (test/fixtures/assistant/*.json), on a simulated clock: no audio, no AI, the same result every run.
//
//   node eval/assistant-replay.js                 detection table
//   WB_EVAL_LLM=1 WB_EVAL_LLM_URL=http://127.0.0.1:11434/v1 WB_EVAL_LLM_MODEL=llama3.2 node eval/assistant-replay.js
//                                                 + time to the first words of a real suggestion, per question
//
// A fixture line: { t, dur, s: 'them'|'me', text, q?: true (a question that deserves help), joins?: the rest of a cut-off
// question, repeat?: "can you repeat", dup?: the same question again, echo?: the user reading the last suggestion aloud }.
// The final transcript of a line arrives ASR_DELAY_MS after the speaker stops (VAD 0.6 s + decoding), as in the app.
const fs = require('node:fs');
const path = require('node:path');
const { mock } = require('node:test');
const { TurnEngine } = require('../src/assistant/turns');

const ASR_DELAY_MS = 700;
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures', 'assistant');

function replay(fx, { revealMs = 1500 } = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    const eng = new TurnEngine({ mode: fx.mode, revealMs });
    const log = [];
    for (const type of ['speculate', 'reveal', 'cancel', 'suppress', 'repeat']) eng.on(type, (e) => log.push({ type, at: Date.now(), ...e }));
    // what the user reads aloud next is "the suggestion" for the question before it (so its echo can be recognised)
    eng.on('reveal', (e) => {
      const i = fx.lines.findIndex((l) => l.s === 'me' && l.t >= Date.now());
      if (i >= 0) eng.answered(fx.lines[i].text);
    });
    const arrivals = fx.lines.map((l, i) => ({ i, at: l.t + l.dur + ASR_DELAY_MS })).sort((a, b) => a.at - b.at);
    const end = Math.max(...arrivals.map((a) => a.at)) + 10000;
    let k = 0;
    for (let now = 0; now <= end; now += 10) {
      while (k < arrivals.length && arrivals[k].at <= now) { const l = fx.lines[arrivals[k].i]; eng.heard({ speaker: l.s, text: l.text, final: true }); k++; }
      mock.timers.tick(10);
    }
    return score(fx, log);
  } finally { mock.timers.reset(); }
}

function score(fx, log) {
  const expected = fx.lines.map((l, i) => ({ ...l, i })).filter((l) => l.q === true);
  const reveals = log.filter((e) => e.type === 'reveal');
  const matched = new Set();
  let tp = 0, fp = 0;
  const latencies = [];
  for (const r of reveals) {
    const hit = expected.find((l) => !matched.has(l.i) && r.question.includes(l.text) && r.at >= l.t + l.dur);
    if (hit) { matched.add(hit.i); tp++; latencies.push(r.at - (hit.t + hit.dur)); } else fp++;
  }
  const fn = expected.length - matched.size;
  const repeatsWanted = fx.lines.filter((l) => l.repeat).length;
  const dupsWanted = fx.lines.filter((l) => l.dup).length;
  const speculations = log.filter((e) => e.type === 'speculate').length;
  return {
    name: fx.name, mode: fx.mode, expected: expected.length, tp, fp, fn,
    repeats: `${log.filter((e) => e.type === 'repeat').length}/${repeatsWanted}`,
    dups: `${log.filter((e) => e.type === 'suppress' && e.reason === 'duplicate').length}/${dupsWanted}`,
    wasted: speculations - reveals.length,
    latencies,
    missed: expected.filter((l) => !matched.has(l.i)).map((l) => l.text),
    extra: reveals.filter((r) => !expected.some((l) => r.question.includes(l.text))).map((r) => r.question),
  };
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f1 = (tp, fp, fn) => (tp ? (2 * tp) / (2 * tp + fp + fn) : 0);

function loadFixtures() {
  return fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8')));
}

function evaluate(opts) {
  const rows = loadFixtures().map((fx) => replay(fx, opts));
  const tot = rows.reduce((a, r) => ({ tp: a.tp + r.tp, fp: a.fp + r.fp, fn: a.fn + r.fn }), { tp: 0, fp: 0, fn: 0 });
  return { rows, total: { ...tot, precision: tot.tp / Math.max(1, tot.tp + tot.fp), recall: tot.tp / Math.max(1, tot.tp + tot.fn), f1: f1(tot.tp, tot.fp, tot.fn), medianMs: median(rows.flatMap((r) => r.latencies)) } };
}

// Time from the end of a question to the first words of a real suggestion (only with WB_EVAL_LLM=1).
async function llmLatency() {
  const { LlmClient } = require('../src/llm/client');
  const { produceScript } = require('../src/assistant/script');
  const { buildContext } = require('../src/assistant/context');
  const { assistantMessages } = require('../src/llm/prompts');
  const llm = new LlmClient(() => ({ baseUrl: process.env.WB_EVAL_LLM_URL || 'http://127.0.0.1:11434/v1', model: process.env.WB_EVAL_LLM_MODEL || '', apiKey: process.env.WB_EVAL_LLM_KEY || '', temperature: 0.2 }));
  const out = [];
  for (const fx of loadFixtures()) {
    for (const l of fx.lines.filter((x) => x.q === true).slice(0, 3)) {
      const ctx = buildContext({ question: l.text, tail: fx.lines.filter((x) => x.t < l.t).slice(-8).map((x) => ({ speaker: x.s, text: x.text })) });
      const t0 = Date.now();
      let first = null;
      const r = await produceScript({ llm, messages: assistantMessages({ mode: fx.mode, question: l.text, context: ctx.text }), onEvent: () => { first ??= Date.now() - t0; }, firstTokenMs: 60000 });
      out.push({ fixture: fx.name, question: l.text, firstMs: first, totalMs: Date.now() - t0, words: r.text.split(/\s+/).length });
    }
  }
  return out;
}

async function main() {
  const { rows, total } = evaluate();
  console.log('fixture        mode       expected  tp  fp  fn  repeat  dup   wasted  median ms after question');
  for (const r of rows) console.log(`${r.name.padEnd(14)} ${r.mode.padEnd(10)} ${String(r.expected).padStart(8)} ${String(r.tp).padStart(3)} ${String(r.fp).padStart(3)} ${String(r.fn).padStart(3)}  ${r.repeats.padStart(6)} ${r.dups.padStart(5)} ${String(r.wasted).padStart(7)}  ${median(r.latencies) ?? '—'}`);
  console.log(`\nprecision ${total.precision.toFixed(2)}  recall ${total.recall.toFixed(2)}  F1 ${total.f1.toFixed(2)}  median engine latency ${total.medianMs} ms (end of speech → suggestion shown, AI time not included)`);
  for (const r of rows) {
    for (const m of r.missed) console.log(`  missed  [${r.name}] ${m}`);
    for (const x of r.extra) console.log(`  extra   [${r.name}] ${x}`);
  }
  if (process.env.WB_EVAL_LLM === '1') {
    const l = await llmLatency();
    console.log('\nreal AI: time to first words / full suggestion');
    for (const x of l) console.log(`  ${String(x.firstMs).padStart(6)} ms / ${String(x.totalMs).padStart(6)} ms  ${x.words} words  [${x.fixture}] ${x.question}`);
    console.log(`  median first words ${median(l.map((x) => x.firstMs))} ms`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { evaluate, replay, score };
