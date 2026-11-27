'use strict';
// The teleprompter: its setting, the window's place, the suggestion state, following the reader by voice, and the steady scroll.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SIZE, MIN, shouldShowPrompter, defaultPrompterBounds, restorePrompterBounds } = require('../electron/prompter');
const { open } = require('../src/core/db');
const { Settings } = require('../src/core/settings');
const { Bus } = require('../src/core/events');
const { effectiveAssistantMode } = require('../src/assistant/service');
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');
const { tmpDir, ROOT } = require('./helpers');

const load = (rel) => import(path.join(ROOT, rel));
const screen = { x: 0, y: 0, width: 1920, height: 1040 };

// ---- setting ----
test('teleprompter setting: off by default, validated, merged with its defaults', () => {
  const s = new Settings(open(':memory:'), new Bus());
  assert.deepEqual(s.get('teleprompter'), { enabled: false, scroll: 'voice', wpm: 140, fontSize: 34, opacity: 0.85, mirror: false });
  assert.deepEqual(s.update({ teleprompter: { enabled: true, scroll: 'speed' } }).teleprompter, { enabled: true, scroll: 'speed', wpm: 140, fontSize: 34, opacity: 0.85, mirror: false });
  assert.throws(() => s.update({ teleprompter: { scroll: 'mouse' } }), /voice or speed/);
  assert.throws(() => s.update({ teleprompter: { wpm: 400 } }), /80 to 220/);
  assert.throws(() => s.update({ teleprompter: { wpm: 120.5 } }), /80 to 220/);
  assert.throws(() => s.update({ teleprompter: { fontSize: 8 } }), /18 to 80/);
  assert.throws(() => s.update({ teleprompter: { opacity: 0 } }), /0.2 to 1/);
  assert.throws(() => s.update({ teleprompter: { mirror: 'yes' } }), /must be a boolean/);
  assert.equal(s.update({ teleprompter: { bogus: 1 } }).teleprompter.bogus, undefined, 'unknown keys are dropped');
});

test('with the teleprompter on, suggestions are written as a spoken reply', () => {
  assert.equal(effectiveAssistantMode({ mode: 'bullets' }, { enabled: false }), 'bullets');
  assert.equal(effectiveAssistantMode({ mode: 'spoken' }, { enabled: false }), 'spoken');
  assert.equal(effectiveAssistantMode({ mode: 'bullets' }, { enabled: true }), 'spoken');
  assert.equal(effectiveAssistantMode({ mode: 'bullets' }, undefined), 'bullets', 'a settings store without the key');
});

test('the assistant service reads the style through the teleprompter switch', () => {
  const { AssistantService } = require('../src/assistant/service');
  const s = new Settings(open(':memory:'), new Bus());
  const svc = new AssistantService({ db: null, notes: { get: () => null }, settings: s, bus: new Bus(), llm: {} });
  assert.equal(svc.options().mode, 'bullets');
  s.update({ teleprompter: { enabled: true } });
  assert.equal(svc.options().mode, 'spoken');
  assert.equal(s.get('assistant').mode, 'bullets', 'the chosen style is kept for when the teleprompter goes off');
});

// ---- window ----
test('the window shows only when switched on, recording, with the assistant helping, and not hidden', () => {
  const on = { enabled: true, recording: true, assistantOn: true, hidden: false };
  assert.equal(shouldShowPrompter(on), true);
  for (const k of ['enabled', 'recording', 'assistantOn']) assert.equal(shouldShowPrompter({ ...on, [k]: false }), false, k);
  assert.equal(shouldShowPrompter({ ...on, hidden: true }), false);
});

test('the window opens top centre, under the camera, and keeps a remembered place on a screen that is there', () => {
  assert.deepEqual(defaultPrompterBounds(screen), { x: 600, y: 8, ...SIZE });
  assert.deepEqual(defaultPrompterBounds({ x: 1920, y: 30, width: 500, height: 300 }), { x: 1920, y: 38, width: 500, height: 220 }, 'never wider than the screen');
  assert.deepEqual(restorePrompterBounds({ x: 100, y: 200, width: 900, height: 300 }, [screen]), { x: 100, y: 200, width: 900, height: 300 });
  assert.deepEqual(restorePrompterBounds({ x: 5000, y: 200, width: 900, height: 300 }, [screen]), { x: 1020, y: 200, width: 900, height: 300 }, 'a screen that is gone');
  assert.deepEqual(restorePrompterBounds({ x: 0, y: 0, width: 10, height: 10 }, [screen]), { x: 0, y: 0, ...MIN }, 'not smaller than usable');
  assert.equal(restorePrompterBounds({ x: 'a' }, [screen]), null);
  assert.equal(restorePrompterBounds(null, [screen]), null);
});

test('the teleprompter page is served and wired only to what the main process offers', async () => {
  const dataDir = tmpDir('wb-prompter-');
  const core = createApp({ dataDir });
  const server = createServer(core, { uiDir: path.join(ROOT, 'ui') });
  const { url, token } = await server.listen(0);
  try {
    for (const f of ['prompter.html', 'prompter.js', 'prompter.css', 'prompter-track.js', 'prompter-scroll.js', 'suggestion-state.js']) {
      const res = await fetch(`${url}/${f}`, { headers: { 'x-wb-token': token } });
      assert.equal(res.status, 200, f);
    }
    const preload = fs.readFileSync(path.join(ROOT, 'electron', 'prompter-preload.js'), 'utf8');
    const page = fs.readFileSync(path.join(ROOT, 'ui', 'prompter.js'), 'utf8');
    const used = new Set([...page.matchAll(/bridge\??\.(\w+)\(/g)].map((m) => m[1]));
    assert.ok(used.size >= 3, `the page uses the bridge: ${[...used]}`);
    for (const fn of used) assert.match(preload, new RegExp(`\\b${fn}:`), `preload exposes ${fn}`);
    const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
    for (const ch of [...preload.matchAll(/send\('([\w:]+)'/g)].map((m) => m[1])) assert.ok(main.includes(`ipcMain.on('${ch}'`), `main handles ${ch}`);
    for (const ch of [...preload.matchAll(/ipcRenderer\.on\('([\w:]+)'/g)].map((m) => m[1])) assert.ok(main.includes(`'${ch}'`), `main sends ${ch}`);
    // every teleprompter shortcut reaches the window
    const { ACTIONS } = require('../src/assistant/hotkeys');
    for (const a of ACTIONS.filter((x) => x.startsWith('prompter'))) assert.match(main, new RegExp(`\\b${a}:`), `main maps ${a}`);
  } finally { await server.close(); core.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// ---- suggestion state ----
test('suggestion state: a question, sentences as they grow, a late gap flag, done', async () => {
  const { initialState, reduce } = await load('ui/suggestion-state.js');
  let s = initialState();
  s = reduce(s, 'assistant.question', { seq: 1, question: 'What did you build?' });
  s = reduce(s, 'assistant.sentence', { seq: 1, index: 0, text: 'I built', closed: false });
  s = reduce(s, 'assistant.sentence', { seq: 1, index: 0, text: 'I built a meeting app.', closed: true });
  s = reduce(s, 'assistant.sentence', { seq: 1, index: 1, text: 'It runs', closed: false });
  assert.deepEqual(s.current.sentences, ['I built a meeting app.', 'It runs']);
  assert.deepEqual(s.current.closed, [true, false]);
  s = reduce(s, 'assistant.done', { seq: 1, text: 'I built a meeting app. It runs locally.' });
  assert.equal(s.current.done, true);
  assert.deepEqual(s.current.closed, [true, true]);
  s = reduce(s, 'assistant.flag', { seq: 1, index: 1, kind: 'gap' });
  assert.ok(s.current.gaps.has(1), 'a flag after done still lands');
  s = reduce(s, 'assistant.flag', { seq: 99, index: 0, kind: 'gap' });
  assert.ok(!s.current.gaps.has(0), 'a flag for another suggestion is ignored');
});

test('suggestion state: a new question keeps the last answer as previous; errors and repeats', async () => {
  const { initialState, reduce } = await load('ui/suggestion-state.js');
  let s = initialState();
  s = reduce(s, 'assistant.question', { seq: 1, question: 'Q1' });
  s = reduce(s, 'assistant.question', { seq: 2, question: 'Q2' });
  assert.deepEqual(s.previous, [], 'an empty card is not kept');
  s = reduce(s, 'assistant.sentence', { seq: 2, index: 0, text: 'A2.', closed: true, gap: true });
  assert.ok(s.current.gaps.has(0));
  s = reduce(s, 'assistant.sentence', { seq: 3, index: 0, text: 'A3.', closed: true });
  assert.equal(s.current.seq, 3, 'a sentence for a question not seen starts a card');
  assert.equal(s.previous[0].seq, 2);
  s = reduce(s, 'assistant.error', { seq: 3, message: 'model down' });
  assert.equal(s.current.error, 'model down');
  const before = s.current;
  s = reduce(s, 'assistant.error', { message: 'term card failed' });
  assert.equal(s.current, before, 'an error not about a suggestion leaves the card alone');
  s = reduce(s, 'assistant.repeat', { question: 'Q2', text: 'A2 again.' });
  assert.deepEqual(s.current.sentences, ['A2 again.']);
  assert.equal(s.current.done, true);
  s = reduce(s, 'assistant.sentence', { seq: 4, index: -1, text: 'x' });
  assert.notEqual(s.current.seq, 4, 'a bad index is ignored');
});

// ---- following by voice ----
const SCRIPT = ['I led the migration of our billing system to Postgres last year.', 'It cut our monthly costs by about thirty percent.', 'The hardest part was moving twelve years of invoices without downtime.'];

test('voice: reading the suggestion aloud moves the position sentence by sentence', async () => {
  const { ReadingTracker } = await load('ui/prompter-track.js');
  const r = new ReadingTracker();
  r.setSentences(SCRIPT);
  assert.equal(r.sentence, 0);
  // a partial that grows, as the recogniser sends it
  r.hear('I led');
  r.hear('I led the migration of our');
  assert.equal(r.sentence, 0);
  r.hear('I led the migration of our billing system to Postgres last year');
  assert.equal(r.sentence, 1, 'the whole first sentence read');
  r.hear('it cut our monthly costs by about thirty percent');
  assert.equal(r.sentence, 2);
  r.hear('the hardest part was moving twelve years of invoices without downtime');
  assert.equal(r.done, true);
});

test('voice: skipped words, small changes and recognition mistakes still follow; unrelated talk does not move it', async () => {
  const { ReadingTracker } = await load('ui/prompter-track.js');
  const r = new ReadingTracker();
  r.setSentences(SCRIPT);
  r.hear('so I led the uh migration of the billing system to postgres');
  assert.equal(r.sentence, 0);
  assert.ok(r.pos >= 9, `most of the sentence is read (pos ${r.pos})`);
  r.hear('last year it cut monthly cost by about thirty per cent');
  assert.equal(r.sentence, 1);
  const at = r.pos;
  r.hear('sorry can you hear me okay');
  r.hear('let me check my notes for a second');
  assert.equal(r.pos, at, 'an aside matches nothing');
});

test('voice: never moves back by itself; the shortcuts move a sentence back or on', async () => {
  const { ReadingTracker } = await load('ui/prompter-track.js');
  const r = new ReadingTracker();
  r.setSentences(SCRIPT);
  r.hear('it cut our monthly costs by about thirty percent');
  assert.equal(r.sentence, 2, 'a reader may start further on');
  r.hear('I led the migration of our billing system');
  assert.equal(r.sentence, 2, 'saying an earlier sentence again does not go back');
  r.jump(-1);
  assert.equal(r.sentence, 1);
  r.jump(-5);
  assert.equal(r.sentence, 0);
  r.jump(+9);
  assert.equal(r.sentence, 2);
});

test('voice: Portuguese with accents, and a suggestion that grows while it is read', async () => {
  const { ReadingTracker, words } = await load('ui/prompter-track.js');
  assert.deepEqual(words('Já fiz 3,5 anos — não é?'), ['ja', 'fiz', '3', '5', 'anos', 'nao', 'e']);
  const r = new ReadingTracker();
  r.setSentences(['Liderei a migração da faturação para Postgres.']);
  r.hear('liderei a migracao da faturacao para postgres');
  assert.equal(r.done, true);
  r.setSentences(['Liderei a migração da faturação para Postgres.', 'Poupámos cerca de trinta por cento.']);
  assert.equal(r.done, false, 'new text after the read part');
  assert.equal(r.sentence, 1);
  r.hear('poupamos cerca de trinta por cento');
  assert.equal(r.done, true);
  r.reset(['Outra resposta.']);
  assert.equal(r.pos, 0);
});

test('voice: one common word is not enough to jump ahead', async () => {
  const { ReadingTracker } = await load('ui/prompter-track.js');
  const r = new ReadingTracker();
  r.setSentences(SCRIPT);
  r.hear('the');
  r.hear('and the');
  assert.equal(r.pos, 0);
});

// ---- steady scroll ----
test('speed: pixels per second from words per minute, the reading line a third down, an even pace with pause', async () => {
  const { pxPerSecond, readingScroll, Pacer } = await load('ui/prompter-scroll.js');
  assert.equal(pxPerSecond({ wpm: 120, wordsPerLine: 8, lineHeight: 48 }), 12);
  assert.equal(pxPerSecond({ wpm: 120, wordsPerLine: 0, lineHeight: 48 }), 0);
  assert.equal(readingScroll({ top: 400, viewHeight: 300, contentHeight: 2000 }), 300);
  assert.equal(readingScroll({ top: 50, viewHeight: 300, contentHeight: 2000 }), 0);
  assert.equal(readingScroll({ top: 1990, viewHeight: 300, contentHeight: 2000 }), 1700, 'never past the end');
  const p = new Pacer();
  let moved = 0;
  for (let i = 0; i < 60; i++) moved += p.tick(1000 / 60, 12);
  assert.ok(moved >= 11 && moved <= 12, `about 12 px in a second (${moved})`);
  p.pause();
  assert.equal(p.tick(1000, 12), 0);
  assert.equal(p.toggle(), false);
  assert.ok(p.tick(5000, 12) <= 3, 'a long gap is capped');
});
