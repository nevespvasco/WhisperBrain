'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings, DEFAULTS } = require('../src/core/settings');
const { LlmClient } = require('../src/llm/client');
const { LlmScheduler } = require('../src/llm/scheduler');
const { AssistantService } = require('../src/assistant/service');
const { startFakeLlm } = require('./fake-llm');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await wait(10); }
}

// A service on a real database, bus, settings and a fake AI server; the turn engine runs on short delays.
async function rig(t, { reply = () => '- The 12th, after the billing tests.\n- Reporting follows in May.', assistant = {}, llmUrl, briefings = [], consent } = {}) {
  const fake = await startFakeLlm((messages) => reply(messages));
  t.after(() => fake.close());
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  await settings.init();
  settings.update({ llm: { ...settings.get('llm'), baseUrl: llmUrl || fake.url, model: 'fake-model' }, assistant: { enabled: true, ...assistant } });
  const sched = new LlmScheduler(new LlmClient(() => settings.get('llm')));
  const knowledge = { glossary: () => [{ term: 'SLA', definition: 'service level agreement', aliases: [] }] };
  const svc = new AssistantService({ db, notes, settings, bus, llm: sched, knowledge, briefings: { forNote: () => briefings }, engineOptions: { tiers: { question: 20, normal: 60, dangling: 300 }, quickRevealMs: 80, revealMs: 150 } });
  svc.attach();
  t.after(() => svc.close());
  const note = notes.create({ title: 'Call' });
  if (consent) notes.update(note.id, { consent });
  const events = [];
  bus.subscribe((e) => { if (e.type.startsWith('assistant.')) events.push(e); });
  const of = (type) => events.filter((e) => e.type === type).map((e) => e.data);
  const say = (speaker, text) => bus.publish('transcript.segment', { noteId: note.id, segment: { id: Math.floor(Math.random() * 1e9), speaker, label: speaker === 'me' ? 'Me' : 'Them', text, startMs: 0, endMs: 1000 } });
  const partial = (text) => bus.publish('transcript.partial', { noteId: note.id, ch: 'system', speaker: 'them', startMs: 0, text });
  bus.publish('recording.started', { noteId: note.id });
  return { fake, db, bus, notes, settings, svc, note, events, of, say, partial };
}

test('settings: the assistant is off by default, with checked modes, delays and shortcuts', async () => {
  assert.equal(DEFAULTS.assistant.enabled, false);
  assert.equal(DEFAULTS.assistant.allowRemote, false, 'a remote AI server needs an explicit yes');
  const s = new Settings(open(':memory:'), new Bus());
  await s.init();
  assert.equal(DEFAULTS.assistant.mode, 'bullets');
  s.update({ assistant: { enabled: true, mode: 'spoken' } });
  assert.equal(s.get('assistant').mode, 'spoken');
  assert.equal(s.get('assistant').trigger, 'auto', 'the rest is kept');
  s.update({ assistant: { hotkeys: { answer: 'CommandOrControl+Alt+A' } } });
  assert.equal(s.get('assistant').hotkeys.answer, 'CommandOrControl+Alt+A');
  assert.equal(s.get('assistant').hotkeys.ask, DEFAULTS.assistant.hotkeys.ask, 'one shortcut changed, the others kept');
  assert.throws(() => s.update({ assistant: { mode: 'stealth' } }), /mode/);
  assert.throws(() => s.update({ assistant: { trigger: 'always' } }), /trigger/);
  assert.throws(() => s.update({ assistant: { revealMs: 99999 } }), /revealMs/);
  assert.throws(() => s.update({ assistant: { hotkeys: { answer: 'Banana+Q' } } }), /answer/);
});

test('settings: the old style names still work: "meeting" reads as bullets and "interview" as spoken', async () => {
  const db = open(':memory:');
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?)').run('assistant', JSON.stringify({ enabled: true, mode: 'interview' }));
  const s = new Settings(db, new Bus());
  await s.init();
  assert.equal(s.get('assistant').mode, 'spoken', 'a value stored by an older version');
  assert.equal(s.get('assistant').enabled, true, 'and the rest of it is kept');
  s.update({ assistant: { mode: 'meeting' } });
  assert.equal(s.get('assistant').mode, 'bullets', 'an older client sending the old name');
  assert.equal(JSON.parse(db.prepare('SELECT value FROM settings WHERE key = ?').get('assistant').value).mode, 'bullets', 'stored under the new name');
  assert.throws(() => s.update({ assistant: { mode: 'stealth' } }), /assistant.mode must be bullets or spoken/);
});

test('a question from the other side becomes a grounded suggestion: question, sentences, done, saved in the history', async (t) => {
  const r = await rig(t, { briefings: [{ title: 'Release plan', kind: 'project', text: 'Next release: the 12th, after the billing tests.\n\nReporting: moves in May.' }] });
  r.say('them', 'When can the next release go out?');
  await until(() => r.of('assistant.done').length);
  assert.equal(r.of('assistant.question')[0].question, 'When can the next release go out?');
  const closed = r.of('assistant.sentence').filter((s) => s.closed);
  assert.deepEqual(closed.map((s) => s.text), ['The 12th, after the billing tests.', 'Reporting follows in May.']);
  assert.ok(closed.every((s) => s.bullet));
  assert.equal(r.of('assistant.done')[0].text, '- The 12th, after the billing tests.\n- Reporting follows in May.');
  const sent = r.fake.requests[0].messages;
  assert.match(sent[1].content, /Next release: the 12th/, 'the briefing excerpt is in the request');
  assert.match(sent[1].content, /When can the next release go out\?/);
  const hist = r.svc.history(r.note.id);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].kind, 'suggestion');
  assert.equal(hist[0].question, 'When can the next release go out?');
});

test('the other side speaking again before it is shown cancels the suggestion: nothing reaches the screen', async (t) => {
  const r = await rig(t, { assistant: { revealMs: 2000 } });
  r.svc.engineOptions.revealMs = 400;
  r.say('them', 'how would you scale it');
  await wait(100);
  r.partial('and also how would you');
  await wait(600);
  assert.equal(r.of('assistant.question').length, 0);
  assert.equal(r.of('assistant.sentence').length, 0);
});

test('privacy gates: a remote AI server needs allowRemote, a meeting where someone objected gets no help, and off is off', async (t) => {
  const remote = await rig(t, { llmUrl: 'https://api.example.com/v1' });
  remote.say('them', 'When can the next release go out?');
  await wait(300);
  assert.equal(remote.fake.requests.length, 0);
  assert.equal(remote.svc.state(remote.note.id).blocked, 'remote');

  const declined = await rig(t, { consent: 'declined' });
  declined.say('them', 'When can the next release go out?');
  await wait(300);
  assert.equal(declined.fake.requests.length, 0);
  assert.equal(declined.svc.state(declined.note.id).blocked, 'consent');

  const off = await rig(t, { assistant: { enabled: false } });
  off.say('them', 'When can the next release go out?');
  await wait(300);
  assert.equal(off.fake.requests.length, 0);
  assert.equal(off.svc.state(off.note.id).active, false);
  off.svc.toggle(off.note.id, true);
  assert.equal(off.svc.state(off.note.id).active, true, 'switched on for this meeting only');
  off.say('them', 'When do we ship?');
  await until(() => off.of('assistant.done').length);
});

test('answer now and another angle work in manual mode; "can you repeat that" shows the last answer again', async (t) => {
  let n = 0;
  const r = await rig(t, { assistant: { trigger: 'manual' }, reply: () => `Answer ${++n}.` });
  r.say('them', 'We need to decide the release date.');
  await wait(200);
  assert.equal(r.fake.requests.length, 0, 'manual: nothing by itself');
  r.svc.action(r.note.id, 'answer');
  await until(() => r.of('assistant.done').length === 1);
  r.svc.action(r.note.id, 'regenerate');
  await until(() => r.of('assistant.done').length === 2);
  assert.match(r.fake.requests[1].messages[1].content, /different angle/);
  r.svc.settings.update({ assistant: { trigger: 'auto' } });
  r.say('them', 'Sorry, can you repeat that?');
  await until(() => r.of('assistant.repeat').length);
  assert.equal(r.of('assistant.repeat')[0].text, 'Answer 2.');
});

test('asking about the call streams an answer from the conversation and is kept in the history', async (t) => {
  const r = await rig(t, { reply: (m) => (/deadline/.test(m.at(-1).content) ? 'They said Friday.' : 'x') });
  r.say('them', 'The deadline is Friday.');
  r.say('me', 'Friday works for me.');
  await wait(50);
  const deltas = [];
  const out = await r.svc.ask(r.note.id, 'What deadline did they give?', { onDelta: (d) => deltas.push(d) });
  assert.equal(out.text, 'They said Friday.');
  assert.ok(deltas.length >= 1);
  assert.match(r.fake.requests.at(-1).messages[1].content, /Them: The deadline is Friday\./);
  assert.equal(r.svc.history(r.note.id).at(-1).kind, 'ask');
});

test('when the recording stops the assistant goes quiet and says so', async (t) => {
  const r = await rig(t);
  r.bus.publish('recording.stopped', { noteId: r.note.id });
  assert.equal(r.svc.state(r.note.id).active, false);
  r.say('them', 'When can the next release go out?');
  await wait(300);
  assert.equal(r.fake.requests.length, 0);
  assert.ok(r.of('assistant.state').some((s) => s.active === false));
});

test('live summary: on demand it folds what was said into summary, decisions, actions and open questions; then only new lines are sent', async (t) => {
  const reply = (m) => (/running summary/.test(m[0].content)
    ? JSON.stringify({ summary: 'Release planning.', decisions: ['Ship on Friday'], actions: [{ text: 'Write the notes', owner: 'Me' }], openQuestions: ['Who tests?'] })
    : 'x');
  const r = await rig(t, { reply, assistant: { liveSummaryMin: 0 } });
  r.say('them', 'We will ship on Friday.');
  r.say('me', 'I will write the release notes.');
  await wait(30);
  r.svc.action(r.note.id, 'summary');
  await until(() => r.of('assistant.summary').length);
  const s = r.of('assistant.summary')[0];
  assert.equal(s.summary, 'Release planning.');
  assert.deepEqual(s.decisions, ['Ship on Friday']);
  assert.deepEqual(s.actions, [{ text: 'Write the notes', owner: 'Me' }]);
  assert.match(r.fake.requests.at(-1).messages[1].content, /Them: We will ship on Friday\./);
  assert.equal(r.svc.state(r.note.id).summary.summary, 'Release planning.');
  r.say('them', 'Ana will test it.');
  await wait(30);
  r.svc.action(r.note.id, 'summary');
  await until(() => r.of('assistant.summary').length === 2);
  const second = r.fake.requests.at(-1).messages[1].content;
  assert.match(second, /Ana will test it/);
  assert.doesNotMatch(second, /We will ship on Friday\./, 'old lines are in the previous summary, not sent again');
  assert.match(second, /Release planning\./);
});

test('live summary: a reply that is not JSON is ignored, and nothing runs with nothing new said', async (t) => {
  const r = await rig(t, { reply: () => 'sorry, I cannot', assistant: { liveSummaryMin: 0 } });
  r.svc.action(r.note.id, 'summary');
  await wait(100);
  assert.equal(r.fake.requests.length, 0, 'nothing said yet: no request');
  r.say('them', 'We will ship on Friday.');
  await wait(30);
  r.svc.action(r.note.id, 'summary');
  await until(() => r.fake.requests.length === 1);
  await wait(100);
  assert.equal(r.of('assistant.summary').length, 0);
});

test('term cards: a glossary term is explained without the AI; an unknown one is explained once and saved to the glossary', async (t) => {
  const saved = [];
  const r = await rig(t, { reply: (m) => (/ONE plain sentence/i.test(m[0].content) ? 'A tool that runs containers across many machines.' : 'x') });
  r.svc.knowledge = { glossary: () => [{ term: 'SLA', definition: 'service level agreement', aliases: [] }, ...saved], upsertTerm: (x) => saved.push({ ...x, aliases: [] }) };
  r.say('them', 'Our SLA is four nines.');
  await until(() => r.of('assistant.term').length === 1);
  assert.deepEqual(r.of('assistant.term')[0], { noteId: r.note.id, id: r.of('assistant.term')[0].id, term: 'SLA', definition: 'service level agreement', ai: false });
  assert.equal(r.fake.requests.length, 0);
  r.svc.live.terms.lastAt = 0;
  r.svc.live.terms = new (require('../src/assistant/terms').TermSpotter)({ glossary: () => r.svc.glossary(), minGapMs: 0 });
  r.say('them', 'We run everything on k8s.');
  await until(() => r.of('assistant.term').length === 2);
  assert.equal(r.of('assistant.term')[1].term, 'k8s');
  assert.equal(r.of('assistant.term')[1].ai, true);
  assert.equal(saved[0].term, 'k8s');
  assert.equal(saved[0].auto, true);
});

test('while the assistant helps a recording, background AI work is held; Stop (or switching it off) lets it run again', async (t) => {
  const r = await rig(t);
  const sched = r.svc.scheduler;
  assert.equal(sched.stats().held, true, 'held from the start of an assisted recording');
  r.svc.toggle(r.note.id, false);
  assert.equal(sched.stats().held, false, 'switched off for this meeting');
  r.svc.toggle(r.note.id, true);
  assert.equal(sched.stats().held, true);
  r.bus.publish('recording.stopped', { noteId: r.note.id });
  assert.equal(sched.stats().held, false, 'released at Stop');
});

test('the live summary and term cards are live work: they run while held, without thinking, and Stop aborts them', async (t) => {
  const r = await rig(t, { reply: (m) => (/running summary/.test(m[0].content) ? JSON.stringify({ summary: 'KPIs.', decisions: [], actions: [], openQuestions: [] }) : 'Key performance indicator.'), assistant: { liveSummaryMin: 0, termCards: true } });
  const seen = { summary: [], background: [] };
  for (const lane of ['summary', 'background']) {
    const client = r.svc.llm[lane];
    const orig = client.complete.bind(client);
    client.complete = (messages, opts) => { seen[lane].push(opts); return orig(messages, opts); };
  }
  r.say('them', 'We need to agree the KPI targets for the quarter.');
  r.svc.action(r.note.id, 'summary');
  await until(() => r.of('assistant.summary').length && seen.background.length);
  for (const opts of [seen.summary[0], seen.background[0]]) {
    assert.equal(opts.reasoning, 'off');
    assert.equal(opts.live, true, 'runs while background work is held');
    assert.equal(opts.signal.aborted, false);
  }
  r.bus.publish('recording.stopped', { noteId: r.note.id });
  assert.equal(seen.summary[0].signal.aborted, true, 'Stop aborts the live summary');
  assert.equal(seen.background[0].signal.aborted, true, 'and the term cards');
});
