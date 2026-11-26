'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Speakers, printProblem } = require('../src/speakers/store');
const { cosine } = require('../src/speakers/cluster');
const { open } = require('../src/core/db');
const { Bus } = require('../src/core/events');
const { Notes } = require('../src/core/notes');

function voice(seed, dim = 32) { const v = new Float32Array(dim); let x = seed * 9301 + 49297; for (let i = 0; i < dim; i++) { x = (x * 9301 + 49297) % 233280; v[i] = x / 233280 - 0.5; } return v; }
const unit = (v) => { const n = Math.hypot(...v); return Float32Array.from(v, (x) => x / n); };
// a print whose cosine with `base` is `c`, the rest pointing at `other` made orthogonal to base
function near(base, other, c) {
  const b = unit(base), o0 = unit(other);
  const d = o0.reduce((a, x, i) => a + x * b[i], 0);
  const o = unit(Float32Array.from(o0, (x, i) => x - d * b[i]));
  return Float32Array.from(b, (x, i) => c * x + Math.sqrt(1 - c * c) * o[i]);
}
const ANA = voice(1), OTHER = voice(7);

function setup() {
  const db = open(':memory:');
  const bus = new Bus();
  const notes = new Notes(db, bus), sp = new Speakers(db, bus);
  sp.adapt = false; sp.mean = new Float32Array(32); // no centring in these synthetic 32-d voices: scores are plain cosines
  const meeting = (centroid, quality = null) => {
    const n = notes.create({});
    notes.addSegments(n.id, [{ speaker: 'them', speakerId: 's1', startMs: 0, endMs: 20000, text: 'hello there' }]);
    sp.save(n.id, { speakerId: 's1', channel: 'system', centroid, count: 5 });
    if (quality) db.prepare('UPDATE note_speakers SET quality = ? WHERE note_id = ?').run(JSON.stringify(quality), n.id);
    return n.id;
  };
  return { sp, meeting };
}

test('printProblem: short, clipped or noisy speech is not remembered; unknown quality is not checked', () => {
  assert.equal(printProblem(null), null);
  assert.equal(printProblem({ seconds: 20, clipped: 0, snrDb: 25 }), null);
  assert.equal(printProblem({ seconds: 4, clipped: 0, snrDb: 25 }).code, 'short');
  assert.equal(printProblem({ seconds: 20, clipped: 0.05, snrDb: 25 }).code, 'clipped');
  assert.equal(printProblem({ seconds: 20, clipped: 0, snrDb: 5 }).code, 'noisy');
});

test('a voice print from too little clean speech names the speaker but is not remembered', () => {
  const { sp, meeting } = setup();
  const id = meeting(ANA, { seconds: 4, clipped: 0, snrDb: 30 });
  const r = sp.rename(id, 's1', 'Ana', { remember: true, consentSource: 'user' });
  assert.equal(r.name, 'Ana');
  assert.equal(r.printSkipped.code, 'short');
  assert.equal(sp.voices().length, 0);
  const ok = meeting(ANA, { seconds: 25, clipped: 0, snrDb: 30 });
  assert.equal(sp.rename(ok, 's1', 'Ana', { remember: true, consentSource: 'user' }).printSkipped, undefined);
  assert.equal(sp.voices().length, 1);
});

test('a speaker fairly like a saved voice is suggested ("Ana?"), not linked; yes links it, no remembers it is not her', () => {
  const { sp, meeting } = setup();
  sp.rename(meeting(ANA), 's1', 'Ana', { remember: true, consentSource: 'user' });
  const ana = sp.voices()[0];

  const sure = meeting(near(ANA, OTHER, 0.9));
  sp.autoMatch(sure);
  assert.equal(sp.forNote(sure)[0].voiceId, ana.id, 'a clear match is linked as before');
  assert.equal(sp.forNote(sure)[0].suggestedName, null);

  const unsure = meeting(near(ANA, OTHER, 0.52));
  assert.ok(Math.abs(cosine(sp.forNote(unsure)[0].centroid, ANA) - 0.52) < 1e-3);
  sp.autoMatch(unsure);
  let s = sp.forNote(unsure)[0];
  assert.equal(s.voiceId, null);
  assert.equal(s.suggestedName, 'Ana');
  const yes = sp.answerSuggestion(unsure, 's1', true);
  assert.equal(yes.name, 'Ana');
  assert.equal(sp.forNote(unsure)[0].voiceId, ana.id);
  assert.equal(sp.forNote(unsure)[0].suggestedName, null);

  const stranger = meeting(near(ANA, voice(11), 0.5));
  sp.autoMatch(stranger);
  assert.equal(sp.forNote(stranger)[0].suggestedName, 'Ana');
  sp.answerSuggestion(stranger, 's1', false);
  s = sp.forNote(stranger)[0];
  assert.equal(s.name, '');
  assert.equal(s.suggestedName, null);
  sp.autoMatch(stranger);
  assert.equal(sp.forNote(stranger)[0].suggestedName, null, 'not asked again after a no');

  const far = meeting(near(ANA, OTHER, 0.2));
  sp.autoMatch(far);
  assert.equal(sp.forNote(far)[0].suggestedName, null, 'a voice unlike any saved one is left alone');
});

test('migration v15 adds the suggestion and quality columns to an older database', () => {
  const { MIGRATIONS } = require('../src/core/db');
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(':memory:');
  for (let v = 0; v < 14; v++) old.exec(MIGRATIONS[v]);
  old.exec('PRAGMA user_version = 14');
  const db = open(':memory:'); // a fresh one is migrated all the way
  const cols = db.prepare('PRAGMA table_info(note_speakers)').all().map((c) => c.name);
  for (const c of ['suggested_voice_id', 'suggested_score', 'quality']) assert.ok(cols.includes(c), c);
  old.exec(MIGRATIONS[14]);
  assert.ok(old.prepare('PRAGMA table_info(note_speakers)').all().some((c) => c.name === 'quality'));
});
