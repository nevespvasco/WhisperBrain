'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../eval/assistant-replay');

test('eval: question detection on the timed dialogs (en, pt-PT; meeting, interview) stays at F1 ≥ 0.85, repeats and duplicates handled', () => {
  const { rows, total } = evaluate();
  assert.ok(rows.length >= 4);
  assert.ok(total.f1 >= 0.85, `F1 ${total.f1.toFixed(2)}`);
  assert.ok(total.precision >= 0.85, `precision ${total.precision.toFixed(2)}`);
  for (const r of rows) {
    const [got, want] = r.repeats.split('/').map(Number);
    assert.equal(got, want, `${r.name}: "can you repeat" asks for the last answer again`);
    const [sup, dup] = r.dups.split('/').map(Number);
    assert.equal(sup, dup, `${r.name}: the same question again is not answered twice`);
  }
  assert.ok(total.medianMs <= 2000, `a suggestion is shown within 2 s of the question (engine only): ${total.medianMs} ms`);
});
