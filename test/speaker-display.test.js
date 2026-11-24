'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { displayMap, describe, substantive } = require('../src/speakers/display');

const SAY = 'one two three four';           // a substantive line: three or more words
const line = (speakerId, text = SAY, extra = {}) => ({ speaker: speakerId?.[0] === 'm' ? 'me' : 'them', speakerId, text, speakerName: '', ...extra });
const many = (speakerId, n, text = SAY, extra = {}) => Array.from({ length: n }, () => line(speakerId, text, extra));
const labels = (rows, opts) => { const map = displayMap(rows, opts); return rows.map((r) => describe(map, r).label); };

test('substantive: three words with letters, or four CJK characters; "yeah." and a stray dot are not', () => {
  assert.equal(substantive('yeah'), false);
  assert.equal(substantive('.'), false);
  assert.equal(substantive('yes of course'), true);
  assert.equal(substantive('1 2 3 4'), false, 'numbers are not words');
  assert.equal(substantive('大家好'), false);
  assert.equal(substantive('大家好啊朋友'), true);
  assert.equal(substantive('ありがとうございます'), true);
  assert.equal(substantive('감사합니다 여러분'), true);
});

test('live: an unnamed voice is hidden until its fifth substantive line; a backchannel does not count', () => {
  // s1: four real lines, "yeah", "ok" (do not count), then s2 gets five real lines, then s1 its fifth real one
  const rows = [...many('s1', 4), line('s1', 'yeah'), line('s1', 'ok'), ...many('s2', 5)];
  assert.deepEqual([...new Set(labels(rows, { live: true }))], ['Them'], 'only s2 is shown, and one voice alone is not numbered; s1 is hidden');
  const withFifth = [...rows, line('s1')];
  const l = labels(withFifth, { live: true });
  assert.equal(l[0], 'Speaker 2', 's1 was the last to reach five real lines (had "yeah" counted it would have been first)');
  assert.equal(l[l.length - 2], 'Speaker 1', 's2 -> Speaker 1');
});

test('live: numbers need two shown voices (a one-to-one call stays "Them"), and follow the order voices were shown, with no gaps', () => {
  const alone = [...many('s7', 9)];
  assert.deepEqual([...new Set(labels(alone, { live: true }))], ['Them']);
  const rows = [...many('s3', 2), ...many('s5', 5), ...many('s3', 3), ...many('s9', 5)];
  const l = labels(rows, { live: true });
  // s5 reached 5 lines first (index 6), then s3 (index 9), then s9
  assert.equal(l[2], 'Speaker 1', 's5 -> 1');
  assert.equal(l[0], 'Speaker 2', 's3 -> 2');
  assert.equal(l[l.length - 1], 'Speaker 3', 's9 -> 3: ids 3, 5, 9 are numbered 2, 1, 3 and there are no holes');
  const grown = labels([...rows, ...many('s3', 4), ...many('s11', 5)], { live: true });
  assert.deepEqual(grown.slice(0, rows.length), l, 'a number never moves once shown, whoever arrives later');
});

test('named voices are shown from their first line and take their place in the numbering', () => {
  const ana = { speakerName: 'Ana' };
  const one = [line('s1', 'hello', ana)];
  assert.equal(labels(one, { live: true })[0], 'Ana', 'a single named voice is shown by name');
  const rows = [line('s1', 'hello', ana), ...many('s2', 5)];
  const l = labels(rows, { live: true });
  assert.equal(l[0], 'Ana');
  assert.equal(l[1], 'Speaker 2', 'Ana holds slot 1, and with her there are two voices: the other is numbered');
  const early = [line('s1', 'hello', ana), ...many('s2', 3)];
  assert.equal(labels(early, { live: true })[1], 'Them', 'the unnamed one is not shown yet');
});

test('after the recording every voice is shown, numbered by first appearance, and a lone anonymous voice is still "Them"', () => {
  const rows = [line('s4', 'hi'), line('s1', 'hello'), line('s4', 'hi')];
  assert.deepEqual(labels(rows), ['Speaker 1', 'Speaker 2', 'Speaker 1'], 'ids 4 and 1: first heard is 1');
  assert.deepEqual(labels([line('s1', 'hi'), line('s1', 'yo')]), ['Them', 'Them']);
  assert.deepEqual(labels([line('s2', 'hi', { speakerName: 'Bruno' })]), ['Bruno']);
});

test('the user and the room: m1 is always "Me", other microphone voices are people in the room', () => {
  const rows = [line('m1', 'a'), line('m2', 'hi'), ...many('m3', 5), line('m1', 'b')];
  const live = labels(rows, { live: true });
  assert.equal(live[0], 'Me');
  assert.equal(live[1], 'Someone in the room', 'a room voice with one line is not a person yet');
  assert.equal(live[2], 'Room speaker 2', 'm3 reached five lines: the first shown room voice, after "Me", is 2');
  assert.equal(live[live.length - 1], 'Me');
  const done = labels(rows);
  assert.equal(done[1], 'Room speaker 2', 'after the recording m2 is shown too, by first appearance');
  assert.equal(done[2], 'Room speaker 3');
});

test('lines with no voice id take the name of their channel', () => {
  assert.deepEqual(labels([{ speaker: 'me', speakerId: null, text: 'x', speakerName: '' }, { speaker: 'them', speakerId: null, text: 'y', speakerName: '' }]), ['Me', 'Them']);
  const map = displayMap([line('s1'), line('s2')]);
  assert.deepEqual(describe(map, line('s1')), { label: 'Speaker 1', kind: 'speaker', n: 1 });
  assert.deepEqual(describe(map, { speaker: 'me', speakerId: null, text: '', speakerName: '' }, { userName: 'Vasco' }), { label: 'Vasco', kind: 'me', n: null });
});

test('live: a voice named after it was already heard does not push the numbers of voices that were already shown', () => {
  const { displayFor } = require('../src/speakers/display');
  const live = new Map([['n1', []]]);
  const before = [...many('s5', 5), ...many('s7', 5), line('s9', 'hi there my friend'), line('s9', 'again hello friend')];
  const first = displayFor(before, 'n1', live);
  assert.deepEqual(before.slice(0, 10).map((r) => describe(first, r).label), [...Array(5).fill('Speaker 1'), ...Array(5).fill('Speaker 2')]);
  // s9 spoke twice (hidden: fewer than five lines) and is then recognised as Ana: she is shown, after the two voices that were
  const named = before.map((r) => (r.speakerId === 's9' ? { ...r, speakerName: 'Ana' } : r));
  const second = displayFor(named, 'n1', live);
  assert.deepEqual(named.slice(0, 10).map((r) => describe(second, r).label), [...Array(5).fill('Speaker 1'), ...Array(5).fill('Speaker 2')], 'the numbers already shown stay');
  assert.equal(describe(second, named[10]).label, 'Ana');
  assert.deepEqual(live.get('n1'), ['s5', 's7', 's9'], 'the order is remembered for the next look');
  // a note that is not being recorded has nothing remembered, and numbers by first appearance
  assert.deepEqual(labels(named.slice(0, 10)), [...Array(5).fill('Speaker 1'), ...Array(5).fill('Speaker 2')]);
});
