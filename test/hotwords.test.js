'use strict';
// Contextual biasing: splitting terms into the model's pieces, building a meeting's vocabulary, and the recognizer
// actually preferring those words (only when there are any).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AsrEngine } = require('../src/asr/engine');
const { loadVocab, piecesOf, tokenizeTerm, normalizeTerms, hotwordsString, meetingTerms, MAX_TERMS } = require('../src/asr/hotwords');
const { termsForNote, nameFromEmail } = require('../src/asr/vocabulary');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');
const { Settings, DEFAULTS } = require('../src/core/settings');
const { Speakers } = require('../src/speakers/store');
const { Knowledge } = require('../src/knowledge/store');
const { decodeAudio } = require('../src/recording/import');
const { testModels } = require('./helpers');

// pieces as they appear in Parakeet v3's tokens.txt
const MINI = new Set(['▁Para', 'ke', 'et', '▁V', 'as', 'co', '▁Wh', 'is', 'per', '▁B', 'B', 'rai', 'n', '▁Br', 'ai', '▁Ne', 'ves', '▁do', 'ct', 'or', '▁Jos', 'é', 'ra', '▁r', 'ab']);

test('tokenizer: terms become the SentencePiece pieces of the model, greedy longest match first', () => {
  assert.equal(tokenizeTerm('Parakeet', MINI), '▁Para ke et');
  assert.equal(tokenizeTerm('Vasco', MINI), '▁V as co');
  assert.equal(tokenizeTerm('WhisperBrain', MINI), '▁Wh is per B rai n');
  assert.equal(tokenizeTerm('Whisper Brain', MINI), '▁Wh is per ▁Br ai n', 'each word opens with its own marker');
  assert.equal(tokenizeTerm('José', MINI), '▁Jos é');
  assert.equal(tokenizeTerm('  "Vasco"  ', MINI), '▁V as co', 'surrounding punctuation is not part of the word');
  assert.equal(tokenizeTerm('Xyzzy', MINI), null, 'a word the vocabulary cannot spell is dropped, not guessed');
  assert.equal(tokenizeTerm('Vasco Xyzzy', MINI), null);
  assert.equal(tokenizeTerm('', MINI), null);
});

test('tokenizer: a longest match that strands the rest backs off to a shorter piece', () => {
  assert.deepEqual(piecesOf('abc', new Set(['▁ab', '▁a', 'bc'])), ['▁a', 'bc'], '▁ab would leave "c" with no piece');
  assert.deepEqual(piecesOf('abc', new Set(['▁abc', '▁a', 'bc'])), ['▁abc'], 'the longest wins when it fits');
  assert.equal(piecesOf('abc', new Set(['▁ab'])), null);
});

test('hotwords string: "/" between phrases, a score on each, unspellable and repeated terms left out', () => {
  assert.equal(hotwordsString(['Vasco', 'vasco', 'Xyzzy', 'Parakeet'], MINI, { score: 2 }), '▁V as co :2/▁Para ke et :2');
  assert.equal(hotwordsString([], MINI), '');
  assert.equal(hotwordsString(['Xyzzy'], MINI), '', 'nothing to bias with means no phrases at all');
});

test('terms: trimmed, deduplicated without regard to case, short and non-word entries dropped, capped', () => {
  assert.deepEqual(normalizeTerms(['  Ana  Silva ', 'ana silva', 'A', '1234', '', null, 'Acme']), ['Ana Silva', 'Acme']);
  const many = Array.from({ length: 200 }, (_, i) => `Term${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i / 26) | 0))}`);
  assert.equal(normalizeTerms(many).length, MAX_TERMS);
  assert.equal(normalizeTerms(['x'.repeat(200)]).length, 0);
});

test('meeting terms: attendees, speakers and the glossary; people first; names also by their long parts; no addresses', () => {
  const t = meetingTerms({
    attendees: [{ name: 'Vasco Neves', email: 'v@x.io' }, 'ana@acme.com', { name: 'Li Wu' }],
    speakerNames: ['Joana Pereira', 'vasco neves'],
    glossary: [{ term: 'Parakeet' }, 'OKR'],
    userName: 'Rui',
  });
  assert.deepEqual(t, ['Vasco Neves', 'Vasco', 'Neves', 'Li Wu', 'Joana Pereira', 'Joana', 'Pereira', 'Rui', 'Parakeet', 'OKR']);
  assert.ok(!t.some((x) => x.includes('@')));
  assert.ok(meetingTerms({ glossary: Array.from({ length: 80 }, (_, i) => `Glossary${'abcdefghij'[i % 10]}${'klmnopqrst'[(i / 10) | 0]}`) }).length <= MAX_TERMS);
});

test('vocabulary for a note: calendar attendees, saved speakers and glossary from the app stores', () => {
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus);
  const settings = new Settings(db, bus);
  const speakers = new Speakers(db, bus);
  const knowledge = new Knowledge({ db, notes, settings, bus });
  settings.update({ userName: 'Rui Costa' });
  const earlier = notes.create({});
  speakers.save(earlier.id, { speakerId: 's1', channel: 'system', centroid: new Float32Array(4).fill(0.5), count: 3 });
  speakers.rename(earlier.id, 's1', 'Joana Pereira', { remember: true }); // a saved voice
  knowledge.upsertTerm({ term: 'Kubernetes', definition: 'orchestrator' });
  knowledge.upsertTerm({ term: 'Zeta Protocol', definition: 'auto', auto: true });
  const n = notes.create({ attendees: [{ name: 'Vasco Neves', email: 'v@x.io' }, { email: 'ana.silva@acme.com' }, { name: '', email: 'x1@y.z' }] });
  const t = termsForNote({ notes, speakers, knowledge, settings }, n.id);
  for (const want of ['Vasco Neves', 'Ana Silva', 'Joana Pereira', 'Rui Costa', 'Kubernetes', 'Zeta Protocol']) assert.ok(t.includes(want), `${want} in ${JSON.stringify(t)}`);
  assert.ok(t.indexOf('Vasco Neves') < t.indexOf('Kubernetes'), 'people before glossary terms');
  assert.ok(t.length <= MAX_TERMS);
  assert.deepEqual(termsForNote({ notes, speakers, knowledge, settings }, 'nope'), []);
  assert.deepEqual(termsForNote({ notes }, n.id).filter((x) => x.includes(' ')), ['Vasco Neves', 'Ana Silva'], 'every store is optional');
  assert.equal(nameFromEmail('ana.silva@acme.com'), 'Ana Silva');
  assert.equal(nameFromEmail('x1@y.z'), '');
  assert.equal(nameFromEmail('info@acme.com'), 'Info');
  assert.equal(DEFAULTS.asrHotwords, true, 'on by default');
});

// ---- the real model ----
const models = testModels();
const skip = models && models.isInstalled('parakeet-tdt-0.6b-v3') ? false : 'needs parakeet-tdt-0.6b-v3 (npm run models)';
const parakeet = () => models.describe('parakeet-tdt-0.6b-v3');

test('the tokenizer reads the real vocabulary', { skip }, () => {
  const v = loadVocab(parakeet().files.tokens);
  assert.equal(tokenizeTerm('Parakeet', v), '▁Para ke et');
  assert.equal(tokenizeTerm('Vasco', v), '▁Va s co');
  assert.equal(tokenizeTerm('WhisperBrain', v), '▁Wh is per B rai n');
  assert.equal(tokenizeTerm('Whisper Brain', v), '▁Wh is per ▁Br ai n');
  assert.ok(hotwordsString(['Vasco', 'Parakeet', 'WhisperBrain'], v).split('/').length === 3);
});

// white noise at a fixed level, from a fixed seed: the same degraded audio every run
function noisy(pcm, snrDb, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const x = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
  let p = 0;
  for (const v of x) p += (v / 32768) ** 2;
  const sigma = Math.sqrt(p / x.length / 10 ** (snrDb / 10));
  const out = Buffer.alloc(pcm.length);
  const y = new Int16Array(out.buffer, out.byteOffset, x.length);
  for (let i = 0; i < x.length; i++) {
    const g = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    y[i] = Math.max(-32768, Math.min(32767, Math.round((x[i] / 32768 + g * sigma) * 32768)));
  }
  return out;
}

test('hotwords: a name the model mishears in noise is recovered; without hotwords nothing changes', { skip, timeout: 180000 }, async (t) => {
  const engine = new AsrEngine({ pools: 'shared' });
  t.after(() => engine.stop());
  await engine.start(parakeet(), { vadPath: models.vadPath(), threads: 4 });
  const wavOf = (l) => fs.readFileSync(path.join(models.modelDir('parakeet-tdt-0.6b-v3'), 'test_wavs', `${l}.wav`));
  const fr = noisy(await decodeAudio(wavOf('fr'), 'fr.wav', { engine }), 0, 1); // "…ce que votre pays peut faire…" at 0 dB SNR
  const clean = await decodeAudio(wavOf('en'), 'en.wav', { engine });

  const plain = await engine.transcribe(fr);
  const cleanPlain = await engine.transcribe(clean);
  assert.match(plain, /votre fil/i, 'the baseline mishears the word (if this changes, pick another noisy clip)');

  await engine.setHotwords(['pays']);
  const biased = await engine.transcribe(fr);
  assert.match(biased, /votre pays/i, `biasing fixes the word: ${biased}`);
  assert.equal(await engine.transcribe(clean), cleanPlain, 'a clear recording comes out the same with unrelated hotwords');

  await engine.setHotwords(['Vasco', 'Parakeet', 'WhisperBrain']); // terms that are not in the audio must not leak into it
  assert.equal(await engine.transcribe(clean), cleanPlain);

  await engine.setHotwords([]);
  assert.equal(await engine.transcribe(fr), plain, 'back to the exact no-hotwords output');
  assert.equal(await engine.transcribe(clean), cleanPlain);
  assert.equal(engine.live.beamOn, false, 'greedy search again once the list is empty');
});

test('hotwords reach live segments: the VAD path biases and releases between meetings without a restart', { skip, timeout: 180000 }, async (t) => {
  const engine = new AsrEngine({ pools: 'shared' });
  t.after(() => engine.stop());
  await engine.start(parakeet(), { vadPath: models.vadPath(), threads: 4 });
  const pid = engine.child.pid;
  const en = await decodeAudio(fs.readFileSync(path.join(models.modelDir('parakeet-tdt-0.6b-v3'), 'test_wavs', 'en.wav')), 'en.wav', { engine });
  const live = async () => {
    const got = [];
    const on = (s) => got.push(s.text);
    engine.on('segment', on);
    const audio = Buffer.concat([en, Buffer.alloc(32000)]);
    for (let i = 0; i < audio.length; i += 3200) engine.feed('mic', audio.subarray(i, i + 3200));
    await engine.flush('mic');
    engine.reset('mic');
    engine.off('segment', on);
    return got.join(' ');
  };
  const before = await live();
  assert.match(before, /ask not what your country/i);
  await engine.setHotwords(['Kennedy', 'Country']);
  assert.equal(engine.live.beamOn, true);
  assert.match(await live(), /ask not what your country/i);
  await engine.releaseHotwords(); // the meeting ends: words forgotten, recognizer kept for the next one
  assert.equal(engine.live.hotwordsOn, false);
  assert.equal(engine.live.beamOn, true);
  assert.match(await live(), /ask not what your country/i);
  assert.equal(engine.child.pid, pid, 'never a worker restart');
});
