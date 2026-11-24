'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, cleanName, nameKey, SignalError } = require('../src/meet/protocol');
const { nameSpeakers, activeIntervals, speechOf, remoteHeadCount } = require('../src/meet/names');

// A scripted call: [speaker, startMs, endMs]. The meeting UI highlights the speaker `lag` ms after they start.
const SCRIPT = [['s1', 0, 6000], ['s2', 6500, 12000], ['s3', 12500, 20000], ['s1', 20500, 26000], ['s2', 26500, 31000], ['s3', 31500, 36000]];
const WHO = { s1: 'Ana Silva', s2: 'Bruno Costa', s3: 'Carla Dias' };
const speechFrom = (script) => { const m = new Map(); for (const [id, a, b] of script) { if (!m.has(id)) m.set(id, []); m.get(id).push([a, b]); } return m; };
const eventsFrom = (script, lag = 500, wrong = () => null) => {
  const ev = [];
  script.forEach(([id, a, b], i) => { ev.push({ t: a + lag, name: wrong(i) || WHO[id] }); ev.push({ t: b + lag, name: null }); });
  return ev;
};

test('messages: names lose their "(You)" mark and placeholder words are not names', () => {
  assert.deepEqual(cleanName('Ana Silva (You)'), { name: 'Ana Silva', self: true });
  assert.deepEqual(cleanName('You'), { name: '', self: true });
  assert.deepEqual(cleanName('  José   da  Silva '), { name: 'José da Silva', self: false });
  assert.equal(cleanName('Unknown').name, '');
  assert.equal(nameKey('José da Silva'), nameKey('jose  DA silva'));
});

test('messages: speaker, roster, meeting and caption are cleaned; nonsense is refused', () => {
  assert.deepEqual(normalize({ type: 'speaker', name: ' Ana\u0000 ' }), { type: 'speaker', name: 'Ana', id: '', self: false });
  assert.equal(normalize({ type: 'speaker', name: null }).name, null);
  const r = normalize({ type: 'roster', participants: ['Ana', { name: 'Ana' }, { name: 'Bruno', id: 'p2' }, { name: 'Eu (You)' }, { name: '' }] });
  assert.deepEqual(r.participants.map((p) => [p.name, p.self]), [['Ana', false], ['Bruno', false], ['Eu', true]]);
  assert.deepEqual(normalize({ type: 'meeting', inCall: 1, code: 'abc-defg-hij' }), { type: 'meeting', inCall: true, code: 'abc-defg-hij', title: '' });
  assert.equal(normalize({ type: 'caption', name: 'Ana', text: ' hello  there ' }).text, 'hello there');
  assert.throws(() => normalize({ type: 'caption', name: 'Ana', text: '' }), SignalError);
  assert.throws(() => normalize({ type: 'nope' }), SignalError);
  assert.throws(() => normalize(null), SignalError);
  assert.throws(() => normalize({ type: 'roster' }), SignalError);
});

test('active speaker: the lag is taken off, flickers are dropped, a repeated name is joined', () => {
  const iv = activeIntervals([{ t: 1500, name: 'Ana' }, { t: 4500, name: null }, { t: 4600, name: 'Bruno' }, { t: 4650, name: null }, { t: 6000, name: 'Ana' }, { t: 6100, name: null }, { t: 6200, name: 'Ana' }, { t: 9000, name: null }], { lagMs: 500 });
  assert.deepEqual(iv, [{ startMs: 1000, endMs: 4000, name: 'Ana' }, { startMs: 5700, endMs: 8500, name: 'Ana' }]);
});

test('active speaker: an old highlight is not believed for ever', () => {
  const iv = activeIntervals([{ t: 1000, name: 'Ana' }], { lagMs: 0, maxMs: 60000, endMs: 10 * 60000 });
  assert.equal(iv[0].endMs - iv[0].startMs, 60000);
});

test('speech: pauses inside an utterance are not speech', () => {
  const m = speechOf([{ speakerId: 's1', startMs: 1000, endMs: 9000, words: [['a', 0, 400], ['b', 500, 900], ['c', 5000, 5400]] }, { speakerId: 's2', startMs: 0, endMs: 500, words: null }]);
  assert.deepEqual(m.get('s1'), [[1000, 1900], [6000, 6400]]);
  assert.deepEqual(m.get('s2'), [[0, 500]]);
});

test('vote: each voice takes the name highlighted over its speech, lag included', () => {
  const r = nameSpeakers({ speech: speechFrom(SCRIPT), active: activeIntervals(eventsFrom(SCRIPT), { lagMs: 500 }) });
  assert.deepEqual(r.named.map((n) => [n.speakerId, n.name, n.via]).sort(), [['s1', 'Ana Silva', 'vote'], ['s2', 'Bruno Costa', 'vote'], ['s3', 'Carla Dias', 'vote']]);
  assert.equal(r.unresolved.length, 0);
});

test('vote: a wrong lag still names everybody when turns are long enough, a huge one does not invent names', () => {
  const ok = nameSpeakers({ speech: speechFrom(SCRIPT), active: activeIntervals(eventsFrom(SCRIPT, 1200), { lagMs: 500 }) });
  assert.equal(ok.named.length, 3);
});

test('vote: a noisy highlight stream (one wrong name in three turns) is outvoted', () => {
  const script = [['s1', 0, 6000], ['s2', 6500, 12000], ['s1', 12500, 18000], ['s2', 18500, 24000], ['s3', 24500, 30000], ['s2', 30500, 36000], ['s3', 36500, 42000]];
  const wrong = (i) => (i === 3 ? 'Carla Dias' : null); // the second turn of s2 is highlighted as somebody else
  const r = nameSpeakers({ speech: speechFrom(script), active: activeIntervals(eventsFrom(script, 500, wrong), { lagMs: 500 }) });
  assert.equal(r.named.find((n) => n.speakerId === 's2')?.name, 'Bruno Costa');
  assert.equal(r.named.find((n) => n.speakerId === 's3')?.name, 'Carla Dias');
  assert.equal(r.named.find((n) => n.speakerId === 's1')?.name, 'Ana Silva');
});

test('vote: a voice highlighted as two names about equally, with nobody else to explain either, is left unnamed rather than guessed', () => {
  const script = [['s1', 0, 6000], ['s2', 6500, 12000], ['s2', 12500, 17000]];
  const wrong = (i) => (i === 1 ? 'Carla Dias' : null); // s2 speaks twice; one turn lit as Carla, the other as Bruno
  const r = nameSpeakers({ speech: speechFrom(script), active: activeIntervals(eventsFrom(script, 500, wrong), { lagMs: 500 }) });
  assert.equal(r.named.find((n) => n.speakerId === 's2'), undefined);
  assert.equal(r.named.find((n) => n.speakerId === 's1')?.name, 'Ana Silva');
});

test('vote: ...but when one of the two names is clearly another voice\'s, the voice takes the other (one name, one voice)', () => {
  const wrong = (i) => (i === 1 ? 'Carla Dias' : null); // one of s2\'s two turns is lit as Carla, whose own voice is s3
  const r = nameSpeakers({ speech: speechFrom(SCRIPT), active: activeIntervals(eventsFrom(SCRIPT, 500, wrong), { lagMs: 500 }) });
  assert.deepEqual(r.named.map((n) => [n.speakerId, n.name]).sort(), [['s1', 'Ana Silva'], ['s2', 'Bruno Costa'], ['s3', 'Carla Dias']]);
});

test('vote: with no clear winner the voice stays unnamed', () => {
  // s1 is highlighted as Ana half the time and as Bruno the other half
  const speech = new Map([['s1', [[0, 10000]]]]);
  const active = [{ startMs: 0, endMs: 5000, name: 'Ana' }, { startMs: 5000, endMs: 10000, name: 'Bruno' }];
  const r = nameSpeakers({ speech, active });
  assert.equal(r.named.length, 0);
  assert.equal(r.unresolved[0].speakerId, 's1');
});

test('vote: too little highlighted time names nobody', () => {
  const r = nameSpeakers({ speech: new Map([['s1', [[0, 10000]]]]), active: [{ startMs: 0, endMs: 900, name: 'Ana' }] });
  assert.equal(r.named.length, 0);
});

test('vote: one name goes to one voice; the other voice stays unnamed', () => {
  // a person split into two voices by the clustering: both overlap Ana, the longer one gets the name
  const speech = new Map([['s1', [[0, 9000]]], ['s2', [[10000, 14000]]]]);
  const active = [{ startMs: 0, endMs: 14000, name: 'Ana' }];
  const r = nameSpeakers({ speech, active });
  assert.deepEqual(r.named.map((n) => n.speakerId), ['s1']);
  assert.equal(r.unresolved.find((u) => u.speakerId === 's2').duplicate, true);
});

test('vote: the user is never given to a remote voice', () => {
  const speech = new Map([['s1', [[0, 10000]]]]);
  const active = [{ startMs: 0, endMs: 10000, name: 'Vasco Neves' }];
  const r = nameSpeakers({ speech, active, selfKeys: [nameKey('Vasco Neves')] });
  assert.equal(r.named.length, 0);
});

test('vote: one other person on the call names the only remote voice without any highlight', () => {
  const speech = new Map([['s1', [[0, 20000]]]]);
  const r = nameSpeakers({ speech, active: [], remotes: ['Bruno Costa'], selfKeys: [nameKey('Vasco')] });
  assert.deepEqual(r.named.map((n) => [n.speakerId, n.name, n.via]), [['s1', 'Bruno Costa', 'sole']]);
  // ...but not when the roster lists two others, or the voice barely spoke
  assert.equal(nameSpeakers({ speech, active: [], remotes: ['Bruno', 'Carla'] }).named.length, 0);
  assert.equal(nameSpeakers({ speech: new Map([['s1', [[0, 1000]]]]), active: [], remotes: ['Bruno'] }).named.length, 0);
});

test('head count: the other people on the call, the user left out; big calls say nothing', () => {
  const p = (n, self = false) => ({ name: n, self });
  assert.equal(remoteHeadCount([p('Vasco', true), p('Ana'), p('Bruno')]), 2);
  assert.equal(remoteHeadCount([p('Vasco', true), p('Ana')]), 1);
  assert.equal(remoteHeadCount([p('Vasco', true)]), null);
  assert.equal(remoteHeadCount([p('Vasco'), p('Ana')], { selfKeys: [nameKey('vasco')] }), 1);
  assert.equal(remoteHeadCount(Array.from({ length: 12 }, (_, i) => p(`P${i}`))), null);
  assert.equal(remoteHeadCount(null), null);
});

// ---- the aligner: lag found from the data, scores that weigh both sides, one-to-one with an "unknown" ----
const { estimateLag, rawIntervals, nameFromEvents } = require('../src/meet/names');

// short turns with short gaps: a wrong lag moves the highlight onto the next speaker
const SHORT = Array.from({ length: 12 }, (_, i) => [['s1', 's2', 's3'][i % 3], i * 3000, i * 3000 + 2500]);
const rawFrom = (script, lag) => script.flatMap(([id, a, b]) => [{ t: a + lag, name: WHO[id] }, { t: b + lag, name: null }]);

test('lag: the delay of a source is found from where its highlights fall over the speech', () => {
  for (const lag of [300, 900, 1600]) {
    const est = estimateLag({ raw: rawIntervals(rawFrom(SHORT, lag)), speech: speechFrom(SHORT), prior: 500 });
    assert.ok(Math.abs(est - lag) <= 100, `true ${lag}, found ${est}`);
  }
});

test('lag: with nothing to go on the usual delay is kept', () => {
  assert.equal(estimateLag({ raw: [], speech: speechFrom(SHORT), prior: 500 }), 500);
  assert.equal(estimateLag({ raw: rawIntervals(rawFrom(SHORT, 900)), speech: new Map(), prior: 500 }), 500);
  // one name lit for the whole call says nothing about timing
  assert.equal(estimateLag({ raw: [{ startMs: 0, endMs: 40000, name: 'Ana' }], speech: speechFrom(SHORT), prior: 500 }), 500);
});

test('naming: a source that is slower than usual no longer costs the names (short turns, 1.6 s late, 0.5 s assumed)', () => {
  const events = rawFrom(SHORT, 1600);
  const after = nameFromEvents({ events, speech: speechFrom(SHORT), priorLagMs: 500 });
  assert.ok(Math.abs(after.lagMs - 1600) <= 100, `the delay was found (${after.lagMs})`);
  assert.deepEqual(after.named.map((n) => [n.speakerId, n.name]).sort(), [['s1', 'Ana Silva'], ['s2', 'Bruno Costa'], ['s3', 'Carla Dias']]);
});

test('naming: each name has a score, higher when both the voice and the name are mostly each other', () => {
  const { named } = nameFromEvents({ events: rawFrom(SCRIPT, 500), speech: speechFrom(SCRIPT), priorLagMs: 500 });
  for (const n of named) assert.ok(n.score > 0.8 && n.score <= 1, `${n.name} ${n.score}`);
  // Ana is lit over s1 for 9 s and over s2 for 4 s (the same person heard as two voices): s1 owns the name, with the higher score
  const speech = new Map([['s1', [[0, 9000]]], ['s2', [[10000, 14000]]]]);
  const r = nameSpeakers({ speech, active: [{ startMs: 0, endMs: 14000, name: 'Ana' }] });
  assert.deepEqual(r.named.map((n) => n.speakerId), ['s1']);
  assert.ok(r.named[0].score > 0.75);
});

test('naming: people lit up while nobody speaks do not dilute anyone', () => {
  const speech = new Map([['s1', [[0, 8000]]], ['s2', [[9000, 17000]]]]);
  const active = [{ startMs: 0, endMs: 8000, name: 'Ana' }, { startMs: 9000, endMs: 17000, name: 'Bruno' },
    { startMs: 30000, endMs: 60000, name: 'Carla' }, { startMs: 62000, endMs: 90000, name: 'Ana' }];   // a long ghost of each, in silence
  const r = nameSpeakers({ speech, active });
  assert.deepEqual(r.named.map((n) => [n.speakerId, n.name]).sort(), [['s1', 'Ana'], ['s2', 'Bruno']]);
});

// ---- invited people as a prior (never forced) ----
test('candidates: a highlight that is a short form of exactly one invited person takes the invited person\'s full name', () => {
  const speech = new Map([['s1', [[0, 9000]]], ['s2', [[10000, 19000]]]]);
  const active = [{ startMs: 0, endMs: 9000, name: 'Ana S.' }, { startMs: 10000, endMs: 19000, name: 'Bruno' }];
  const candidates = ['Ana Silva', 'Bruno Costa', 'Carla Dias'];
  const r = nameSpeakers({ speech, active, candidates });
  assert.deepEqual(r.named.map((n) => [n.speakerId, n.name]).sort(), [['s1', 'Ana Silva'], ['s2', 'Bruno Costa']]);
});

test('candidates: the same person shown as "Ana" and as "Ana Silva" is one name, not two competing ones', () => {
  const speech = new Map([['s1', [[0, 10000]]]]);
  const active = [{ startMs: 0, endMs: 5000, name: 'Ana' }, { startMs: 5000, endMs: 10000, name: 'Ana Silva' }];
  assert.equal(nameSpeakers({ speech, active }).named.length, 0, 'without the invitation it is a tie between two names');
  assert.deepEqual(nameSpeakers({ speech, active, candidates: ['Ana Silva'] }).named.map((n) => n.name), ['Ana Silva']);
});

test('candidates: never forced: an ambiguous short form, a guest, or nobody invited stay exactly as the window showed them', () => {
  const speech = new Map([['s1', [[0, 9000]]], ['s2', [[10000, 19000]]]]);
  const active = [{ startMs: 0, endMs: 9000, name: 'Bruno' }, { startMs: 10000, endMs: 19000, name: 'Gina Guest' }];
  const r = nameSpeakers({ speech, active, candidates: ['Bruno Costa', 'Bruno Dias', 'Ana Silva'] });
  assert.deepEqual(r.named.map((n) => [n.speakerId, n.name]).sort(), [['s1', 'Bruno'], ['s2', 'Gina Guest']]);
  assert.equal(nameSpeakers({ speech, active, candidates: [] }).named.length, 2);
});

test('candidates: an invitation alone names nobody (one invited person is not "the only voice")', () => {
  const r = nameSpeakers({ speech: new Map([['s1', [[0, 20000]]]]), active: [], candidates: ['Bruno Costa'] });
  assert.equal(r.named.length, 0);
});

// ---- found in review ----
test('candidates: the user being invited does not make a remote voice the user', () => {
  const speech = new Map([['s1', [[0, 12000]]]]);
  const active = [{ startMs: 0, endMs: 12000, name: 'Vasco' }];
  assert.equal(nameSpeakers({ speech, active, selfKeys: [nameKey('Vasco')], candidates: ['Vasco Neves', 'Ana Silva'] }).named.length, 0);
  assert.equal(nameSpeakers({ speech, active, selfKeys: [nameKey('Vasco Neves')], candidates: ['Vasco Neves'] }).named.length, 0);
});

test('candidates: a first name has to be the same: "Jo" is not "John Smith"', () => {
  const speech = new Map([['s1', [[0, 12000]]]]);
  const r = nameSpeakers({ speech, active: [{ startMs: 0, endMs: 12000, name: 'Jo' }], candidates: ['John Smith'] });
  assert.deepEqual(r.named.map((n) => n.name), ['Jo']);
});

test('vote: a voice whose best name holds barely a third of what was lit over it is not named', () => {
  const speech = new Map([['s1', [[0, 30000]]]]);
  const active = [{ startMs: 0, endMs: 10800, name: 'Ana' }, { startMs: 10800, endMs: 20400, name: 'Bruno' }, { startMs: 20400, endMs: 30000, name: 'Carla' }];
  assert.equal(nameSpeakers({ speech, active }).named.length, 0);
});
