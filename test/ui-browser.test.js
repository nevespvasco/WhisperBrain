'use strict';
// The UI in a real (headless) browser, served by the real server: what only layout, focus and real clicks can show.
// Skipped where there is no headless Chromium (test/support/cdp.js says how to point at one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');
const { tmpDir, ROOT } = require('./helpers');
const { browserMissing, launch, sleep } = require('./support/cdp');

const skip = browserMissing() || false;

async function boot(t) {
  const dataDir = tmpDir('wb-ui-');
  const app = createApp({ dataDir, version: 'test', detect: false });
  await app.ready;
  app.settings.update({ setupSeen: true });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  const b = await launch();
  t.after(async () => { b.close(); await srv.close(); app.close(); await app.settled; fs.rmSync(dataDir, { recursive: true, force: true }); });
  await b.goto(`http://127.0.0.1:${port}/?token=${token}`);
  await b.waitFor(`!!document.querySelector('#main .page')`, 10000);
  return { app, b, base: `http://127.0.0.1:${port}` };
}
// opens a modal from the app's own lib.js (the same module instance the page uses)
const openModal = (b, body) => b.evaluate(`import('/lib.js').then((L) => { L.modal({ title: 'Test', body: ${JSON.stringify(body)} }); return true; })`);

test('pickers: a select inside a modal dialog can be picked from with the mouse', { skip, timeout: 60000 }, async (t) => {
  const { b } = await boot(t);
  await openModal(b, '<label class="field"><span>Who</span><select id="who"><option value="a">Ana</option><option value="b" selected>Bob</option><option value="c">Carla</option></select></label>');
  await sleep(250);   // the dialog's opening animation
  await b.clickOn('#who');
  await b.waitFor(`!!document.querySelector('.menu.picker')`);
  assert.equal(await b.evaluate(`document.querySelector('.menu.picker').parentElement.tagName`), 'DIALOG', 'the list opens inside the dialog (the top layer), not under it');
  assert.deepEqual(await b.evaluate(`(() => { const a = document.querySelector('#who'), m = document.querySelector('.menu.picker'); return [a.getAttribute('aria-expanded'), a.getAttribute('aria-haspopup'), a.getAttribute('aria-controls') === m.id && !!m.id, m.getAttribute('aria-label')]; })()`), ['true', 'listbox', true, 'Who'], 'the field says it opens a list, which one, and the list is named after the field');
  await b.clickOn('.menu.picker [data-v="c"]');
  await sleep(100);
  assert.equal(await b.evaluate(`document.querySelector('#who').value`), 'c', 'the click reached the option');
  assert.equal(await b.evaluate(`!!document.querySelector('.menu.picker')`), false, 'and closed the list');
  assert.equal(await b.evaluate(`document.querySelector('#who').getAttribute('aria-expanded')`), 'false');
  assert.equal(await b.evaluate(`!!document.querySelector('dialog[open]')`), true, 'without closing the dialog');
  assert.deepEqual(b.errors, []);
});

test('pickers: a date field opens the calendar with a click, on the page and inside a dialog', { skip, timeout: 60000 }, async (t) => {
  const { b } = await boot(t);
  // on the page: the calendar used to close on the same mousedown that opened it
  await b.evaluate(`(() => { const i = document.createElement('input'); i.type = 'date'; i.id = 'd1'; document.querySelector('#main').prepend(i); })()`);
  await b.clickOn('#d1');
  await b.waitFor(`!!document.querySelector('.menu.datepick')`);
  await sleep(50);
  const day = await b.evaluate(`document.querySelectorAll('.menu.datepick .dp-day:not(:disabled)')[9].dataset.v`);
  await b.clickOn(`.menu.datepick [data-v="${day}"]`);
  assert.equal(await b.evaluate(`document.querySelector('#d1').value`), day);
  // inside a dialog
  await openModal(b, '<input type="date" id="d2">');
  await sleep(250);
  await b.clickOn('#d2');
  await b.waitFor(`!!document.querySelector('dialog .menu.datepick')`);
  await sleep(50);
  const day2 = await b.evaluate(`document.querySelectorAll('.menu.datepick .dp-day:not(:disabled)')[3].dataset.v`);
  await b.clickOn(`.menu.datepick [data-v="${day2}"]`);
  assert.equal(await b.evaluate(`document.querySelector('#d2').value`), day2);
  assert.deepEqual(b.errors, []);
});

test('pickers: a popover menu opened from a button in a dialog works, and the dialog closing takes the list with it', { skip, timeout: 60000 }, async (t) => {
  const { b } = await boot(t);
  await openModal(b, '<button type="button" id="mb">More</button><select id="s"><option>1</option><option>2</option></select>');
  await sleep(250);
  await b.evaluate(`(() => { const btn = document.querySelector('#mb'); window.__ran = 0; btn.onclick = () => import('/lib.js').then((L) => L.menu(btn, [{ label: 'One', run: () => { window.__ran = 1; } }])); })()`);
  await b.clickOn('#mb');
  await b.waitFor(`!!document.querySelector('.menu [data-i="0"]')`);
  assert.equal(await b.evaluate(`document.querySelector('.menu').parentElement.tagName`), 'DIALOG');
  await b.clickOn('.menu [data-i="0"]');
  await sleep(100);
  assert.equal(await b.evaluate('window.__ran'), 1);
  // a list left open when the dialog goes is settled (its promise resolves, the select is usable again)
  await b.clickOn('#s');
  await b.waitFor(`!!document.querySelector('.menu.picker')`);
  await b.evaluate(`document.querySelector('dialog[open]').close()`);
  await sleep(100);
  assert.equal(await b.evaluate(`!!document.querySelector('.menu.picker')`), false);
  assert.equal(await b.evaluate(`document.querySelector('#s')?.dataset.open ?? 'gone'`), 'gone');
  assert.deepEqual(b.errors, []);
});

test('pickers: the Access sheet\'s "May an AI see it?" can be changed with the mouse', { skip, timeout: 60000 }, async (t) => {
  const { b } = await boot(t);
  await b.evaluate(`import('/access-sheet.js').then((m) => { window.__sheet = m.openAccessSheet({ provider: 'gmail', mode: 'connect', accounts: [{ id: 'primary', email: '' }] }); return true; })`);
  await b.waitFor(`!!document.querySelector('dialog[open] #as-reach')`);
  await sleep(250);
  await b.clickOn('#as-reach');
  await b.waitFor(`!!document.querySelector('.menu.picker [data-v="any"]')`);
  await b.clickOn('.menu.picker [data-v="any"]');
  await sleep(100);
  assert.equal(await b.evaluate(`document.querySelector('#as-reach').value`), 'any');
  assert.deepEqual(b.errors, []);
});

test('navigation: opening the Inbox again does not stack its keyboard handler (one press of A accepted twice)', { skip, timeout: 60000 }, async (t) => {
  const { b } = await boot(t);
  const before = await b.listeners('keydown');
  await b.evaluate(`location.hash = '#/inbox'`);
  await b.waitFor(`document.querySelector('#main h1')?.textContent === 'Inbox'`);
  const once = await b.listeners('keydown');
  assert.equal(once, before + 1, 'the Inbox adds its handler');
  for (const q of ['?a=1', '?a=2', '?a=3']) {
    await b.evaluate(`location.hash = '#/inbox${q}'`);
    await sleep(300);
  }
  assert.equal(await b.listeners('keydown'), once, 'still one handler after opening it three more times');
  await b.evaluate(`location.hash = '#/glossary'`);
  await b.waitFor(`document.querySelector('#main h1')?.textContent === 'Glossary'`);
  assert.equal(await b.listeners('keydown'), before, 'and none once the page is left');
  assert.deepEqual(b.errors, []);
});

test('navigation: a meeting that loads slowly does not draw over the page the user went to meanwhile', { skip, timeout: 60000 }, async (t) => {
  const { app, b } = await boot(t);
  const n = app.notes.create({ source: 'manual', title: 'Slow meeting' });
  await b.send('Fetch.enable', { patterns: [{ urlPattern: `*/api/notes/${n.id}/overview*`, requestStage: 'Request' }] });
  const paused = b.once('Fetch.requestPaused');
  await b.evaluate(`location.hash = '#/note/${n.id}'`);
  const req = await paused;   // the meeting's first answer is held back
  await b.evaluate(`location.hash = '#/glossary'`);
  await b.waitFor(`document.querySelector('#main h1')?.textContent === 'Glossary'`);
  await b.send('Fetch.continueRequest', { requestId: req.requestId }).catch(() => { /* already cancelled by leaving */ });
  await sleep(800);
  assert.equal(await b.evaluate(`document.querySelector('#main h1')?.textContent`), 'Glossary', 'the Glossary is still what is on screen');
  assert.equal(await b.evaluate(`document.querySelector('#main').textContent.includes('Slow meeting')`), false);
  assert.equal(await b.evaluate(`location.hash`), '#/glossary');
  assert.deepEqual(b.errors.filter((e) => !/AbortError|aborted/i.test(e)), []);
});

// a meeting with 40 lines from two voices, and glossary terms whose definitions name each other
function seedMeeting(app) {
  const n = app.notes.create({ source: 'recorded', title: 'Seeded' });
  app.notes.addSegments(n.id, Array.from({ length: 40 }, (_, i) => ({ speaker: 'them', speakerId: i % 2 ? 's1' : 's2', startMs: i * 4000, endMs: i * 4000 + 3000, text: `Line ${i} about Orion for ACME` })));
  for (const sid of ['s1', 's2']) app.db.prepare("INSERT OR IGNORE INTO note_speakers(note_id, speaker_id, channel, count) VALUES(?, ?, 'system', 3)").run(n.id, sid);
  app.notes.update(n.id, { status: 'done' });
  app.knowledge.upsertTerm({ term: 'Orion', definition: 'Project "Orion" <b>with</b> ACME', aliases: [], noteId: n.id });
  app.knowledge.upsertTerm({ term: 'ACME', definition: 'A customer of Orion', aliases: [], noteId: n.id });
  return n;
}

test('transcript: a voice renamed while somebody types in the search box keeps the box, the focus and the lines; terms are marked cleanly', { skip, timeout: 60000 }, async (t) => {
  const { app, b } = await boot(t);
  const n = seedMeeting(app);
  await b.evaluate(`location.hash = '#/note/${n.id}?tab=transcript'`);
  await b.waitFor(`document.querySelectorAll('#segs .seg').length === 40`);
  // glossary marks: one span per term, the definition escaped in the title, no span inside an attribute
  const first = await b.evaluate(`document.querySelector('#segs .seg .txt').innerHTML`);
  assert.equal((first.match(/<span class="term"/g) || []).length, 2, first);
  assert.equal(await b.evaluate(`document.querySelector('#segs .seg .txt').textContent`), 'Line 0 about Orion for ACME', `the words read as said: ${first}`);
  assert.deepEqual(await b.evaluate(`[...document.querySelectorAll('#segs .seg .txt')][0].querySelectorAll('.term').length && [...document.querySelector('#segs .seg .txt').querySelectorAll('.term')].map((x) => x.title)`), ['Project "Orion" <b>with</b> ACME', 'A customer of Orion']);
  await b.evaluate(`document.querySelector('#segs').__mark = 1; document.querySelector('#segs .seg').__mark = 1`);
  await b.clickOn('#tr-q');
  await b.insertText('line 1');
  await sleep(250);   // the search waits for a pause in typing
  assert.equal(await b.evaluate(`[...document.querySelectorAll('#segs .seg')].filter((x) => !x.hidden).length`), 11, 'Line 1 and Line 10-19');
  assert.equal(await b.evaluate(`document.querySelectorAll('#segs mark').length`), 11);
  app.speakers.rename(n.id, 's1', 'Ana');
  app.bus.publish('speakers.updated', { noteId: n.id });
  await b.waitFor(`[...document.querySelectorAll('#segs .who [data-rename="s1"]')].every((x) => x.textContent === 'Ana')`);
  await b.waitFor(`document.querySelector('#tr-people .chips')?.textContent.includes('Ana')`);
  assert.equal(await b.evaluate(`document.activeElement?.id`), 'tr-q', 'the search box kept the focus');
  assert.equal(await b.evaluate(`document.querySelector('#tr-q').value`), 'line 1');
  assert.equal(await b.evaluate(`document.querySelector('#segs').__mark === 1 && document.querySelector('#segs .seg').__mark === 1`), true, 'the lines were patched, not drawn again');
  assert.equal(await b.evaluate(`[...document.querySelectorAll('#segs .seg')].filter((x) => !x.hidden).length`), 11, 'the search still applies');
  await b.insertText('5');
  await sleep(250);
  assert.equal(await b.evaluate(`[...document.querySelectorAll('#segs .seg')].filter((x) => !x.hidden).map((x) => x.dataset.id).length`), 1);
  assert.deepEqual(b.errors, []);
});
