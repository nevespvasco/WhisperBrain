'use strict';
// The last resort: look at the meeting window with the user's own vision model.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SignalHub } = require('../src/meet/hub');
const { VisionSource, parseAnswer } = require('../src/meet/vision');
const { LlmClient } = require('../src/llm/client');
const { startFakeLlm } = require('./fake-llm');

const frame = (n = 'a') => ({ jpeg: Buffer.from(`jpeg-${n}`), title: 'Meet - abc-defg-hij - Google Chrome' });

async function rig(t, answers, { capture, userName = () => 'Vasco' } = {}) {
  let i = 0;
  const llm = await startFakeLlm((messages) => { const a = answers[Math.min(i++, answers.length - 1)]; return typeof a === 'string' ? a : JSON.stringify(a); });
  t.after(() => llm.close());
  const client = new LlmClient(() => ({ baseUrl: llm.url, apiKey: '', model: 'vision', temperature: 0 }));
  const hub = new SignalHub();
  const heard = [];
  hub.on('signal', ({ msg, source, kind }) => heard.push([msg.type, msg.type === 'speaker' ? msg.name : msg.type === 'roster' ? msg.participants.map((p) => p.name) : msg.inCall, source, kind]));
  let n = 0;
  const v = new VisionSource({ hub, llm: client, capture: capture || (async () => frame(String(n++))), userName, intervalMs: 3600000 });
  v.timer = {}; // a tick is driven by the test, not by time
  return { v, hub, heard, llm };
}

test('answer: JSON in any wrapping is read; anything else is not an answer', () => {
  assert.deepEqual(parseAnswer('Sure! ```json\n{"participants":["Ana","Bruno"],"speaking":["Ana"],"confidence":"high"}\n```'), { participants: ['Ana', 'Bruno'], speaking: ['Ana'], confidence: 'high' });
  assert.equal(parseAnswer('{"participants":["Ana"],"speaking":[]}').confidence, 'low');
  assert.equal(parseAnswer('I see a video call.'), null);
  assert.equal(parseAnswer('{"participants":"Ana"}'), null);
  assert.equal(parseAnswer('{broken'), null);
});

test('vision: a picture becomes the call, the people and the one who speaks, and the picture goes with the question', async (t) => {
  const r = await rig(t, [{ participants: ['Ana Silva', 'Bruno Costa', 'Vasco'], speaking: ['Bruno Costa'], confidence: 'high' }]);
  await r.v.tick();
  assert.deepEqual(r.heard, [['meeting', true, 'vision', 'vision'], ['roster', ['Ana Silva', 'Bruno Costa', 'Vasco'], 'vision', 'vision'], ['speaker', 'Bruno Costa', 'vision', 'vision']]);
  const sent = r.llm.requests[0].messages[0].content;
  assert.equal(sent[1].type, 'image_url');
  assert.match(sent[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.match(sent[0].text, /called "Vasco"/, 'the user is told to be left out');
});

test('vision: only a confident, single name that is on the screen counts; the same answer again says nothing', async (t) => {
  const r = await rig(t, [
    { participants: ['Ana', 'Bruno'], speaking: ['Ana'], confidence: 'low' },
    { participants: ['Ana', 'Bruno'], speaking: ['Ana', 'Bruno'], confidence: 'high' },
    { participants: ['Ana', 'Bruno'], speaking: ['Zed'], confidence: 'high' },
    { participants: ['Ana', 'Bruno'], speaking: ['bruno'], confidence: 'high' },
    { participants: ['Ana', 'Bruno'], speaking: ['Bruno'], confidence: 'high' },
  ]);
  for (let i = 0; i < 5; i++) await r.v.tick();
  assert.deepEqual(r.heard.filter((h) => h[0] === 'speaker').map((h) => h[1]), ['Bruno'], 'unsure, two at once and a name not on the screen: nothing; "bruno" is Bruno; again: nothing new');
});

test('vision: it looks only when nothing better is connected, and not at all at the same frame', async (t) => {
  const r = await rig(t, [{ participants: ['Ana'], speaking: [], confidence: 'high' }]);
  r.hub.ingest({ type: 'meeting', inCall: true }, { source: 'a11y', kind: 'a11y' });
  await r.v.tick();
  assert.equal(r.llm.requests.length, 0, 'the accessibility reader is connected: no picture is sent anywhere');
  assert.equal(r.hub.status().sources.find((s) => s.id === 'vision').detail, 'not needed: another source is connected');
  const same = await rig(t, [{ participants: ['Ana'], speaking: [], confidence: 'high' }], { capture: async () => frame('same') });
  await same.v.tick(); await same.v.tick();
  assert.equal(same.llm.requests.length, 1, 'the screen did not change: the model is not asked again');
});

test('vision: a missing window, a missing permission and a model that cannot see are said plainly', async (t) => {
  const none = await rig(t, ['{}'], { capture: async () => null });
  await none.v.tick();
  assert.match(none.hub.status().sources.find((s) => s.id === 'vision').detail, /no meeting window/);
  const denied = await rig(t, ['{}'], { capture: async () => { throw Object.assign(new Error('x'), { code: 'permission' }); } });
  await denied.v.tick();
  assert.equal(denied.hub.status().sources.find((s) => s.id === 'vision').state, 'denied');
  const blind = await rig(t, ['I see a video call with several people.']);
  blind.v.maxFailures = 3;
  for (let i = 0; i < 3; i++) await blind.v.tick();
  const s = blind.hub.status().sources.find((x) => x.id === 'vision');
  assert.equal(s.state, 'error');
  assert.match(s.detail, /see pictures/);
  assert.equal(blind.heard.length, 0);
});

test('vision: stopping says nobody is speaking, and a system that cannot capture a window says so', async (t) => {
  const r = await rig(t, [{ participants: ['Ana'], speaking: ['Ana'], confidence: 'high' }]);
  await r.v.tick();
  r.v.timer = setInterval(() => {}, 1e9);
  r.v.stop();
  assert.deepEqual(r.heard.at(-1).slice(0, 2), ['speaker', null]);
  const none = new VisionSource({ hub: new SignalHub(), llm: null, capture: null });
  assert.equal(none.start(), false);
  assert.equal(none.hub.status().sources[0].state, 'off');
});
