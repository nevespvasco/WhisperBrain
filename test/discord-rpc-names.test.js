'use strict';
// Discord over local RPC names the voices of a recorded call: the roster and who speaks reach the hub, and the existing vote
// (collector → names.js) does the rest. Synthetic event streams; no Discord, no audio.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SignalHub } = require('../src/meet/hub');
const { MeetingCollector } = require('../src/meet/collector');
const { DiscordRpcSource } = require('../src/discord/rpc-source');
const { namingAccuracy } = require('../eval/metrics');

class FakeRpc extends EventEmitter {
  constructor(me = { id: '100', name: 'Vasco' }) { super(); this.st = { state: 'connected', detail: '', user: me, call: null }; this.people = []; }
  status() { return { ...this.st, call: this.st.call && { ...this.st.call, people: this.people } }; }
  join(people, call = { id: 'c1', name: 'Standup' }) { this.people = people; this.st.call = call; this.st.state = 'in-call'; this.emit('state', { state: 'in-call', detail: '' }); this.emit('call', call); this.emit('roster', people); }
  roster(people) { this.people = people; this.emit('roster', people); }
  speak(userId, speaking = true) { this.emit('speaking', { userId, speaking, self: userId === this.st.user.id }); }
  leave() { this.st.call = null; this.st.state = 'connected'; this.emit('call', null); }
}
const P = (id, name, self = false) => ({ id, name, self });
const ME = P('100', 'Vasco', true), ANA = P('200', 'Ana Silva'), BRUNO = P('300', 'Bruno Costa'), CARLA = P('400', 'Carla Dias');

// who speaks when on the system audio (voice, start, end), and the people that really are those voices
const SCRIPT = [['s1', 0, 6000], ['s2', 6500, 12000], ['s3', 12500, 20000], ['s1', 20500, 26000], ['s2', 26500, 31000], ['s3', 31500, 36000]];
const TRUTH = { s1: ANA, s2: BRUNO, s3: CARLA };
const utterances = SCRIPT.map(([id, a, b]) => ({ speaker: 'them', speakerId: id, startMs: a, endMs: b, words: Array.from({ length: Math.floor((b - a) / 500) }, (_, k) => ['w', k * 500, k * 500 + 400]) }));
const speechOf = () => { const m = new Map(); for (const [id, a, b] of SCRIPT) { m.set(id, [...(m.get(id) || []), [a, b]]); } return m; };

// runs a call: `events` is a list of [ms, fn(rpc)]; the hub stamps each message with the time it arrives
function run(events, { me, bot = () => null, lag = 150 } = {}) {
  let now = 0;
  const hub = new SignalHub();
  const col = new MeetingCollector({ hub, elapsed: () => now });
  const rpc = new FakeRpc(me);
  const src = new DiscordRpcSource({ hub, rpc, bot, every: () => ({ stop() {} }) });
  src.start();
  for (const [ms, fn] of [...events].sort((a, b) => a[0] - b[0])) { now = ms; fn(rpc); }
  src.stop();
  return { hub, col, rpc };
}
// the clean stream a call of SCRIPT gives: each person starts speaking `lag` after they really do
const stream = ({ lag = 150, who = (id) => TRUTH[id], skip = () => false } = {}) => SCRIPT.flatMap(([id, a, b], i) => skip(i) ? [] : [[a + lag, (r) => r.speak(who(id).id)], [b + lag, (r) => r.speak(who(id).id, false)]]);
const named = (res) => new Map(res.named.map((n) => [n.speakerId, n.name]));
const accuracy = (res) => namingAccuracy({ speech: speechOf(), truth: Object.fromEntries(Object.entries(TRUTH).map(([k, v]) => [k, v.name])), assigned: named(res) });

test('roster and speaker: the people in the call, and the one who speaks; nobody, the person themself, or two at once give nobody', () => {
  const seen = [];
  const hub = new SignalHub();
  hub.on('signal', (s) => { if (s.msg.type !== 'meeting') seen.push([s.msg.type, s.msg.platform, s.msg.type === 'roster' ? s.msg.participants.map((p) => [p.name, p.id, p.self]) : [s.msg.name, s.msg.id], s.kind, s.lagMs]); });
  const rpc = new FakeRpc();
  new DiscordRpcSource({ hub, rpc, every: () => ({ stop() {} }) }).start();
  rpc.join([ME, ANA, BRUNO]);
  rpc.speak('200'); rpc.speak('200', false);
  rpc.speak('200'); rpc.speak('300');            // two at once
  rpc.speak('200', false);                      // Bruno alone again
  rpc.speak('300', false);
  rpc.speak('100'); rpc.speak('100', false);    // the person themself: their voice is the microphone
  assert.deepEqual(seen[0], ['roster', 'discord', [['Vasco', '100', true], ['Ana Silva', '200', false], ['Bruno Costa', '300', false]], 'rpc', 150]);
  assert.deepEqual(seen.slice(1).map((s) => s[2]), [['Ana Silva', '200'], [null, ''], ['Ana Silva', '200'], [null, ''], ['Bruno Costa', '300'], [null, '']]);
  assert.ok(seen.every((s) => s[1] === 'discord' && s[3] === 'rpc'));
});

test('a clean call: every voice takes the name that was speaking while it spoke (naming accuracy 100%, from 0% with no names)', () => {
  const { col } = run([[0, (r) => r.join([ME, ANA, BRUNO, CARLA])], ...stream()]);
  const res = col.vote(utterances, { endMs: 40000 });
  assert.equal(accuracy(res).accuracy, 1);
  assert.deepEqual([...named(res).entries()].sort(), [['s1', 'Ana Silva'], ['s2', 'Bruno Costa'], ['s3', 'Carla Dias']]);
  const before = namingAccuracy({ speech: speechOf(), truth: { s1: 'Ana Silva', s2: 'Bruno Costa', s3: 'Carla Dias' }, assigned: new Map() });
  assert.equal(before.accuracy, 0, 'without the names: every voice is "Speaker N"');
});

test('the number of voices to expect is the roster without the person: the head count', () => {
  const { col } = run([[0, (r) => r.join([ME, ANA, BRUNO, CARLA])]]);
  assert.equal(col.expectedVoices(), 3);
  assert.equal(run([[0, (r) => r.join([ME, ANA])]]).col.expectedVoices(), 1);
});

test('people joining late and leaving, and people who never speak: the head count follows the roster, silent people name nobody', () => {
  const { col, hub } = run([
    [0, (r) => r.join([ME, ANA, BRUNO])],
    [10000, (r) => r.roster([ME, ANA, BRUNO, CARLA])],       // Carla joins at 10 s, speaks from 12.5 s
    [33000, (r) => r.roster([ME, ANA, CARLA])],              // Bruno leaves
    ...stream(),
    [34000, (r) => r.roster([ME, ANA, CARLA, P('900', 'Never Speaks')])],
  ]);
  assert.equal(col.expectedVoices(), 3, 'Ana, Carla and the one who never speaks');
  const res = col.vote(utterances, { endMs: 40000 });
  assert.equal(accuracy(res).accuracy, 1);
  assert.ok(![...named(res).values()].includes('Never Speaks'));
});

test('a wrong or noisy stream does not name the wrong person: one wrong highlight among many is outvoted', () => {
  // one in six of the highlights names the wrong person
  const { col } = run([[0, (r) => r.join([ME, ANA, BRUNO, CARLA])], ...stream({ who: (id) => TRUTH[id] }), [100, (r) => r.speak('400')], [2000, (r) => r.speak('400', false)]]);
  const res = col.vote(utterances, { endMs: 40000 });
  assert.equal(accuracy(res).accuracy, 1);
  // a stream that is mostly wrong gives wrong names or none, never a high-confidence mistake (what the vote refuses is told by `unresolved`)
  const bad = run([[0, (r) => r.join([ME, ANA, BRUNO, CARLA])], ...stream({ who: () => ANA })]).col.vote(utterances, { endMs: 40000 });
  const a = accuracy(bad);
  assert.ok(a.accuracy <= 0.5, `a stream naming one person for everyone does not give everybody his name (${a.accuracy})`);
});

test('long overlaps: nobody is named while several speak, so the highlight never merges two voices', () => {
  const speakers = [];
  const hub = new SignalHub(); hub.on('signal', (s) => { if (s.msg.type === 'speaker') speakers.push(s.msg.name); });
  const rpc = new FakeRpc(); new DiscordRpcSource({ hub, rpc, every: () => ({ stop() {} }) }).start();
  rpc.join([ME, ANA, P('999', 'Noise')]); rpc.speak('200'); rpc.speak('999'); rpc.speak('200', false); rpc.speak('999', false);
  assert.deepEqual(speakers, ['Ana Silva', null, 'Noise', null], 'two at once says nobody; the one left is named again');
  // and over a whole call, voices that overlap for their whole turn get no name from the highlight
  const { col } = run([[0, (r) => r.join([ME, ANA, BRUNO, CARLA, P('999', 'Noise')])], ...SCRIPT.flatMap(([id, a, b]) => [[a + 150, (r) => { r.speak(TRUTH[id].id); r.speak('999'); }], [b + 150, (r) => { r.speak(TRUTH[id].id, false); r.speak('999', false); }]])]);
  assert.equal(accuracy(col.vote(utterances, { endMs: 40000 })).wrongMs, 0, 'never a wrong name');
});

test('leaving the call says nobody speaks and the roster is not carried over to the next call', () => {
  const speakers = [];
  const hub = new SignalHub();
  hub.on('signal', (s) => { if (s.msg.type === 'speaker') speakers.push(s.msg.name); });
  const rpc = new FakeRpc(); new DiscordRpcSource({ hub, rpc, every: () => ({ stop() {} }) }).start();
  rpc.join([ME, ANA]); rpc.speak('200'); rpc.leave();
  assert.deepEqual(speakers, ['Ana Silva', null]);
  rpc.speak('200', false); rpc.speak('200');   // events after the call is over are ignored
  assert.deepEqual(speakers, ['Ana Silva', null]);
});

test('the source steps aside when the bot is in the same call (it hears each person on their own stream), and not otherwise', () => {
  const botIn = (id) => () => ({ joined: true, channelId: id });
  const mk = (bot) => { const types = []; const hub = new SignalHub(); hub.on('signal', (s) => types.push(s.msg.type)); const rpc = new FakeRpc(); new DiscordRpcSource({ hub, rpc, bot, every: () => ({ stop() {} }) }).start(); rpc.join([ME, ANA]); rpc.speak('200'); return types; };
  assert.deepEqual(mk(botIn('c1')), ['meeting'], 'the bot is in this call: the call is still told, the names and speaking are not');
  assert.deepEqual(mk(botIn('other')), ['meeting', 'roster', 'speaker'], 'the bot is in another channel: this source goes on');
  assert.deepEqual(mk(() => ({ joined: false })), ['meeting', 'roster', 'speaker']);
});

test('the person themself is read from who authorised: marked in the roster, never counted as a remote voice', () => {
  const { col } = run([[0, (r) => r.join([P('500', 'Dana', true), ANA, BRUNO])]], { me: { id: '500', name: 'Dana' } });
  assert.equal(col.expectedVoices(), 2);
  assert.deepEqual(col.roster().map((p) => [p.name, p.self]), [['Dana', true], ['Ana Silva', false], ['Bruno Costa', false]]);
});
