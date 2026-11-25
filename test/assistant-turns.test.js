'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TurnEngine } = require('../src/assistant/turns');

// A TurnEngine on mocked timers, with every event it emits recorded in order.
function rig(t, opts = {}) {
  if (!t.mockedClock) { t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.mockedClock = true; }
  const eng = new TurnEngine({ revealMs: 1500, quickRevealMs: 400, ...opts });
  const seen = [];
  for (const type of ['speculate', 'reveal', 'cancel', 'suppress', 'repeat']) eng.on(type, (e) => seen.push({ type, ...e }));
  const them = (text, final = true) => eng.heard({ speaker: 'them', text, final });
  const me = (text, final = true) => eng.heard({ speaker: 'me', text, final });
  const types = () => seen.map((e) => e.type);
  // in 10 ms steps: a timer set from inside another timer's callback runs in the same tick() call, as it would in real time
  const tick = (ms) => { for (let left = ms; left > 0; left -= 10) t.mock.timers.tick(Math.min(10, left)); };
  return { eng, seen, them, me, types, tick };
}

test('a question with a question mark is prepared after ~120 ms of quiet and shown soon after', (t) => {
  const r = rig(t);
  r.them('What is your notice period?');
  r.tick(100);
  assert.deepEqual(r.types(), [], 'not before the short pause');
  r.tick(30);
  assert.deepEqual(r.types(), ['speculate']);
  assert.equal(r.seen[0].question, 'What is your notice period?');
  r.tick(400);
  assert.deepEqual(r.types(), ['speculate', 'reveal']);
  assert.equal(r.seen[1].seq, r.seen[0].seq, 'the reveal is for the speculation that was prepared');
});

test('a question without a question mark waits the normal pause (600 ms) and the full reveal delay', (t) => {
  const r = rig(t);
  r.them('how would you scale this service');
  r.tick(590);
  assert.deepEqual(r.types(), []);
  r.tick(20);
  assert.deepEqual(r.types(), ['speculate']);
  r.tick(1400);
  assert.deepEqual(r.types(), ['speculate']);
  r.tick(150);
  assert.deepEqual(r.types(), ['speculate', 'reveal']);
});

test('a sentence cut off mid-way waits 3.2 s for the rest, and the rest joins it', (t) => {
  const r = rig(t);
  r.them('So what I wanted to ask is, um');
  r.tick(3000);
  assert.deepEqual(r.types(), []);
  r.them('how do you handle on-call?');
  r.tick(130);
  assert.deepEqual(r.types(), ['speculate']);
  assert.equal(r.seen[0].question, 'So what I wanted to ask is, um how do you handle on-call?');
});

test('the other side speaking again cancels a prepared answer before it is shown; the next question is new', (t) => {
  const r = rig(t);
  r.them('What is your notice period?');
  r.tick(130);
  const first = r.seen[0].seq;
  r.them('and also your salary expectations', false);
  assert.deepEqual(r.types(), ['speculate', 'cancel']);
  assert.equal(r.seen[1].seq, first);
  r.tick(5000);
  assert.deepEqual(r.types(), ['speculate', 'cancel'], 'nothing is shown while they are still talking');
  r.them('and also your salary expectations?');
  r.tick(130);
  assert.equal(r.seen[2].type, 'speculate');
  assert.notEqual(r.seen[2].seq, first);
  assert.match(r.seen[2].question, /notice period\? and also your salary/);
});

test('backchannels, fillers and the user\'s own answer heard back do not cancel or trigger anything', (t) => {
  const r = rig(t);
  r.them('What is your notice period?');
  r.tick(130);
  r.them('mm-hmm', false);
  r.them('ok');
  r.tick(400);
  assert.deepEqual(r.types(), ['speculate', 'reveal']);
  r.eng.answered('My notice period is one month, and I can start in early January if needed.');
  r.them('my notice period is one month and I can start in early January');
  r.tick(5000);
  assert.deepEqual(r.types(), ['speculate', 'reveal'], 'the echo of the answer is ignored');
});

test('statements do not trigger in meeting mode; prompts do in interview mode', (t) => {
  const r = rig(t);
  r.them('We shipped the release on Friday.');
  r.them('Tell me about a time you disagreed with your manager.');
  r.tick(5000);
  assert.deepEqual(r.types(), [], 'meeting mode: only questions');
  const r2 = rig(t, { mode: 'interview' });
  r2.them('Tell me about a time you disagreed with your manager.');
  r2.tick(610);
  assert.deepEqual(r2.types(), ['speculate']);
  assert.match(r2.seen[0].question, /^Tell me about/);
});

test('a statement before a question stays as its preamble, but only the last few lines are kept', (t) => {
  const r = rig(t);
  r.them('We have been discussing the new billing service.');
  r.tick(1000);
  r.them('How would you test it?');
  r.tick(130);
  assert.equal(r.seen[0].question, 'We have been discussing the new billing service. How would you test it?');
  const r2 = rig(t);
  for (let i = 1; i <= 6; i++) { r2.them(`Statement number ${i}.`); r2.tick(1000); }
  r2.them('Any questions?');
  r2.tick(130);
  assert.doesNotMatch(r2.seen[0].question, /number 1\./);
  assert.match(r2.seen[0].question, /number 6\. Any questions\?$/);
});

test('the same question asked again within 20 s is not answered twice; after that it is', (t) => {
  const r = rig(t);
  r.them('What is your notice period?');
  r.tick(600);
  r.them('What is your notice period?');
  r.tick(600);
  assert.deepEqual(r.types(), ['speculate', 'reveal', 'suppress']);
  assert.equal(r.seen[2].reason, 'duplicate');
  r.tick(20000);
  r.them('What is your notice period?');
  r.tick(600);
  assert.deepEqual(r.types().slice(3), ['speculate', 'reveal']);
});

test('"can you repeat that" asks for the last answer again', (t) => {
  const r = rig(t);
  r.them('Sorry, can you repeat that?');
  r.tick(200);
  assert.deepEqual(r.types(), ['repeat']);
});

test('answer now: shows a prepared answer at once, or prepares one from what was last said, even a duplicate or in manual mode', (t) => {
  const r = rig(t);
  r.them('What is your notice period?');
  r.tick(130);
  r.eng.answerNow();
  assert.deepEqual(r.types(), ['speculate', 'reveal']);
  const m = rig(t, { trigger: 'manual' });
  m.them('We shipped the release on Friday.');
  m.tick(5000);
  assert.deepEqual(m.types(), [], 'manual mode never triggers by itself');
  m.eng.answerNow();
  assert.deepEqual(m.types(), ['speculate', 'reveal']);
  assert.equal(m.seen[0].manual, true);
  assert.equal(m.seen[0].question, 'We shipped the release on Friday.');
  m.eng.answerNow();
  assert.deepEqual(m.types(), ['speculate', 'reveal', 'speculate', 'reveal'], 'a manual request is never suppressed as a duplicate');
});

test('another angle: the last question again with a new variation, shown at once', (t) => {
  const r = rig(t);
  r.them('What is your notice period?');
  r.tick(600);
  r.eng.regenerate();
  assert.deepEqual(r.types(), ['speculate', 'reveal', 'speculate', 'reveal']);
  assert.equal(r.seen[2].question, 'What is your notice period?');
  assert.equal(r.seen[2].variation, 1);
  r.eng.regenerate();
  assert.equal(r.seen[4].variation, 2);
});

test('what the user says is kept (recent lines), and dismiss cancels a pending answer', (t) => {
  const r = rig(t);
  r.me('I worked at Acme for five years.');
  r.me('Before that I was at Initech.');
  assert.deepEqual(r.eng.meSaid(), ['I worked at Acme for five years.', 'Before that I was at Initech.']);
  r.them('Why did you leave Acme?');
  r.tick(130);
  r.eng.dismiss();
  r.tick(1000);
  assert.deepEqual(r.types(), ['speculate', 'cancel']);
  assert.equal(r.seen[1].reason, 'dismissed');
});

test('state tells the UI what is going on', (t) => {
  const r = rig(t);
  assert.equal(r.eng.state().phase, 'idle');
  r.them('What is your notice period?');
  assert.equal(r.eng.state().phase, 'waiting');
  r.tick(130);
  assert.equal(r.eng.state().phase, 'preparing');
  r.tick(400);
  assert.equal(r.eng.state().phase, 'shown');
  assert.equal(r.eng.state().question, 'What is your notice period?');
  r.eng.reset();
  assert.equal(r.eng.state().phase, 'idle');
});

test('the user answering ends the other side\'s turn: their earlier lines are not the preamble of the next question', (t) => {
  const r = rig(t);
  r.them('We have been discussing the new billing service.');
  r.tick(1000);
  r.me('Yes, I built most of the invoicing part.');
  r.them('How would you test it?');
  r.tick(600);
  assert.equal(r.seen[0].question, 'How would you test it?');
  r.me('yeah');
  r.them('And the deadline is Friday.');
  r.tick(1000);
  r.me('mm-hmm');
  r.them('Can we make it?');
  r.tick(600);
  assert.equal(r.seen[2].question, 'And the deadline is Friday. Can we make it?', 'a backchannel from the user does not end their turn');
});
