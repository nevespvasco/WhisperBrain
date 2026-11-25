'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isFiller, isBackchannel, endsDangling, isRepeatRequest, echoOverlap, sameQuestion, questionKind } = require('../src/assistant/filters');

test('filler: words that carry nothing are not worth an answer, in English and Portuguese', () => {
  for (const s of ['ok', 'Okay.', 'uh huh', 'right, right', 'yeah', 'hmm', 'ok, obrigado', 'pois', 'certo.', 'sim sim', 'está bem', "let's move on", 'vamos avançar']) assert.equal(isFiller(s), true, s);
  for (const s of ['ok, so when can the next release go out?', 'Right, tell me about your last project.', 'Pois, e qual é o prazo?']) assert.equal(isFiller(s), false, s);
});

test('backchannel: the short sounds of listening do not interrupt a question being asked', () => {
  for (const s of ['mm-hmm', 'uh-huh', 'yeah', 'aham', 'hum', 'sim']) assert.equal(isBackchannel(s), true, s);
  for (const s of ['yes, I agree with the plan', 'what?', 'so']) assert.equal(isBackchannel(s), false, s);
});

test('dangling: a sentence cut off mid-way waits for its end', () => {
  for (const s of ['Tell me about the time you —', 'And the deadline is…', 'So what I wanted to ask is, um', 'Could you explain how the', 'E o que acham de, hum', 'What about the...']) assert.equal(endsDangling(s), true, s);
  for (const s of ['What is the deadline?', 'Tell me about the last release.', 'Qual é o prazo?', 'We use Kubernetes']) assert.equal(endsDangling(s), false, s);
});

test('repeat request: "can you repeat" asks for the last answer again, not a new one', () => {
  for (const s of ['Sorry, can you repeat that?', 'Could you say that again?', 'Pode repetir?', 'Não percebi, podes repetir a pergunta?', 'pardon?']) assert.equal(isRepeatRequest(s), true, s);
  for (const s of ['Can you repeat the experiment with more users?', 'How often do you repeat the deploy?']) assert.equal(isRepeatRequest(s), false, s);
});

test('echo: the user reading a suggestion aloud is recognised (word trigrams), a different sentence is not', () => {
  const answers = ['I led the migration of our billing service to Kubernetes, which cut deploy time from an hour to ten minutes.'];
  assert.ok(echoOverlap('led the migration of our billing service to Kubernetes which cut deploy time', answers) >= 0.6);
  assert.ok(echoOverlap('What was the hardest part of the billing migration for your team?', answers) < 0.6);
  assert.equal(echoOverlap('', answers), 0);
  assert.equal(echoOverlap('anything at all', []), 0);
});

test('same question: growth of the same words, a re-recognised line or a trailing filler is the same question', () => {
  assert.equal(sameQuestion('When can the next release', 'When can the next release go out?'), true);
  assert.equal(sameQuestion('When can the next release go out?', 'when can the next release go out'), true);
  assert.equal(sameQuestion('When can the next release go out? ok', 'When can the next release go out?'), true);
  assert.equal(sameQuestion('When can the next release go out?', 'What budget are you expecting?'), false);
  assert.equal(sameQuestion('Why?', 'Why not?'), false, 'very short lines are never merged');
});

test('question kind: a question, a prompt ("tell me about…") or a statement; English and Portuguese', () => {
  assert.equal(questionKind('When can the next release go out?'), 'question');
  assert.equal(questionKind('how would you scale this service'), 'question', 'no question mark, but it starts like a question');
  assert.equal(questionKind('Qual é o prazo de entrega?'), 'question');
  assert.equal(questionKind('Podes explicar como funciona o deploy'), 'question');
  assert.equal(questionKind('Tell me about the plan for the cut-over.'), 'prompt');
  assert.equal(questionKind('Walk me through your last project'), 'prompt');
  assert.equal(questionKind('Fala-me um pouco do teu último projeto.'), 'prompt');
  assert.equal(questionKind('We shipped the release on Friday.'), 'statement');
  assert.equal(questionKind('Vamos rever o orçamento na próxima semana.'), 'statement');
});

test('question kind: a short lead-in clause before the question or prompt ("So, to start, tell me…") does not hide it', () => {
  assert.equal(questionKind('So, to start, tell me a bit about where the migration stands.'), 'prompt');
  assert.equal(questionKind('Right, and then, what happened next'), 'question');
  assert.equal(questionKind('Ok, pois, como é que resolveste isso'), 'question');
  assert.equal(questionKind('Bom, para começar, fala-me do ponto da migração.'), 'prompt');
  assert.equal(questionKind('We moved to Kubernetes, then what happened was a long outage.'), 'statement', 'a question word deep inside a statement is not a question');
});
