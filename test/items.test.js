'use strict';
// Sources and items (src/items, src/connectors): syncing updates instead of duplicating, tombstones, the Obsidian/folder connector
// in pointer mode, re-importing from Notion/Obsidian/Linear, and the Sources API (docs/adr/0001-brain-data-model.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { open } = require('../src/core/db');
const { ItemStore } = require('../src/items/store');
const { FolderConnector } = require('../src/connectors/folder');
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');
const { tmpDir, ROOT } = require('./helpers');

const fakePlatform = () => ({
  id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
  async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
  async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
  async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null,
});
const write = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); } };

test('an item is created once and updated in place; unchanged content writes nothing; a missing one is tombstoned and can come back', () => {
  const st = new ItemStore(open(':memory:'));
  const s = st.addSource({ kind: 'folder', name: 'Notes' });
  const a = st.upsert(s.id, { externalId: 'plan.md', title: 'Plan', text: 'Budget for the spring campaign' });
  assert.equal(a.action, 'created');
  assert.equal(st.upsert(s.id, { externalId: 'plan.md', title: 'Plan', text: 'Budget for the spring campaign' }).action, 'unchanged');
  assert.equal(st.upsert(s.id, { externalId: 'plan.md', title: 'Plan', text: 'Budget for the autumn campaign' }).action, 'updated');
  assert.equal(st.sources()[0].items, 1, 'still one item');
  assert.equal(st.list({ q: 'autumn' }).length, 1);
  assert.equal(st.list({ q: 'spring' }).length, 0, 'the old text is no longer found');
  assert.equal(st.tombstoneMissing(s.id, new Set()), 1);
  assert.equal(st.list({ q: 'autumn' }).length, 0, 'a tombstoned item is not found');
  assert.equal(st.count(), 0);
  assert.equal(st.upsert(s.id, { externalId: 'plan.md', title: 'Plan', text: 'Budget for the autumn campaign' }).action, 'revived');
  assert.equal(st.list({ q: 'autumn' }).length, 1);
});

test('search finds words without accents, matches the start of a word, and cannot be broken by odd input', () => {
  const st = new ItemStore(open(':memory:'));
  const s = st.addSource({ kind: 'folder', name: 'Notes' });
  st.upsert(s.id, { externalId: 'a', title: 'Orçamento', text: 'Reunião sobre contratações e <b>marketing</b>' });
  assert.equal(st.list({ q: 'orcamento' }).length, 1);
  assert.equal(st.list({ q: 'contrata' }).length, 1, 'prefix');
  for (const q of ['"', 'AND OR', '*', 'a" OR "b', '(((']) assert.doesNotThrow(() => st.list({ q }), q);
  assert.ok(st.list({ q: 'marketing' })[0].snippet.includes('&lt;b>'), 'markup in a note is shown as text, never as markup');
});

test('removing a source removes its items and never touches the files', () => {
  const dir = tmpDir('wb-src-');
  const file = write(dir, 'keep.md', '# Keep\nthis stays');
  const st = new ItemStore(open(':memory:'));
  const s = st.addSource({ kind: 'folder', name: 'x', config: { path: dir } });
  st.upsert(s.id, { externalId: 'keep.md', title: 'Keep', text: 'this stays', path: file });
  st.removeSource(s.id);
  assert.equal(st.count(), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), '# Keep\nthis stays');
  assert.throws(() => st.removeSource(st.ensureSource('native').id), /cannot be removed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the folder connector reads notes in place: frontmatter, links, tags, and skips what WhisperBrain itself exported', async () => {
  const vault = tmpDir('wb-vault-');
  write(vault, '.obsidian/app.json', '{}');
  write(vault, 'Ideas/Pricing.md', '---\ntitle: Pricing ideas\ndate: 2025-03-04\ntags: [pricing, q2]\n---\nSee [[Competitors]] and #strategy for the free tier.');
  write(vault, 'Daily/2025-03-05.md', '# Daily\nCalled Rui about the contract.');
  write(vault, 'Meetings/Standup.md', '---\nwhisperbrain_id: abc\n---\nA meeting WhisperBrain wrote.');
  write(vault, 'Archive/old.txt', 'plain text note');
  write(vault, 'node_modules/x.md', 'ignored');
  const st = new ItemStore(open(':memory:'));
  const src = st.addSource({ kind: 'obsidian', name: 'Vault', config: { path: vault } });
  const c = new FolderConnector({ source: src, items: st });
  const r = await c.scan();
  assert.deepEqual([r.created, r.unchanged, r.removed], [3, 0, 0]);
  const pricing = st.byExternal(src.id, 'Ideas/Pricing.md');
  assert.equal(pricing.title, 'Pricing ideas');
  assert.deepEqual(pricing.meta.links, ['Competitors']);
  assert.deepEqual([...pricing.meta.tags].sort(), ['pricing', 'q2', 'strategy']);
  assert.equal(pricing.occurredAt, Date.parse('2025-03-04'));
  assert.match(pricing.uri, new RegExp(`^obsidian://open\\?vault=${path.basename(vault)}&file=Ideas%2FPricing$`));
  assert.equal(st.byExternal(src.id, 'Meetings/Standup.md'), null, 'a note WhisperBrain exported is not read back as a document');
  assert.equal(st.byExternal(src.id, 'Daily/2025-03-05.md').title, 'Daily', 'the first heading is the title');
  assert.equal(st.list({ q: 'contract' }).length, 1);
  // a second scan opens nothing: the files did not change
  const again = await c.scan();
  assert.deepEqual([again.created, again.updated, again.unchanged], [0, 0, 3]);
  // pointer mode: the files are untouched
  assert.match(fs.readFileSync(path.join(vault, 'Ideas/Pricing.md'), 'utf8'), /^---\ntitle: Pricing ideas/);
  fs.rmSync(vault, { recursive: true, force: true });
});

test('editing a note updates its item, deleting it leaves a tombstone, a folder can be excluded', async () => {
  const vault = tmpDir('wb-vault-');
  write(vault, 'a.md', '# A\nfirst version');
  write(vault, 'Meetings/b.md', '# B\nexported by the app');
  const st = new ItemStore(open(':memory:'));
  const src = st.addSource({ kind: 'obsidian', name: 'V', config: { path: vault, exclude: ['Meetings'] } });
  const c = new FolderConnector({ source: src, items: st });
  await c.scan();
  assert.equal(st.count(), 1, 'the excluded folder is not read');
  await new Promise((r) => setTimeout(r, 20));
  write(vault, 'a.md', '# A\nsecond version, longer');
  assert.deepEqual([(await c.scan()).updated], [1]);
  assert.equal(st.list({ q: 'second' }).length, 1);
  fs.unlinkSync(path.join(vault, 'a.md'));
  assert.equal((await c.scan()).removed, 1);
  assert.equal(st.count(), 0);
  assert.ok(st.byExternal(src.id, 'a.md').deletedAt, 'kept as a tombstone');
  fs.rmSync(vault, { recursive: true, force: true });
});

test('the watcher picks up an edit, a new note and a deletion within a few seconds', async (t) => {
  const vault = tmpDir('wb-vault-');
  write(vault, 'a.md', '# A\nfirst');
  const st = new ItemStore(open(':memory:'));
  const src = st.addSource({ kind: 'obsidian', name: 'V', config: { path: vault } });
  const c = new FolderConnector({ source: src, items: st });
  await c.scan();
  c.watch({ delay: 150 });
  t.after(() => { c.unwatch(); fs.rmSync(vault, { recursive: true, force: true }); });
  const t0 = Date.now();
  write(vault, 'a.md', '# A\nedited while the app was open');
  await until(() => st.list({ q: 'edited' }).length === 1, 5000);
  assert.ok(Date.now() - t0 < 5000, 'an edit shows up within 5 seconds');
  write(vault, 'sub/new.md', '# New\nbrand new note');
  await until(() => st.list({ q: 'brand' }).length === 1, 5000);
  fs.unlinkSync(path.join(vault, 'a.md'));
  await until(() => st.list({ q: 'edited' }).length === 0, 5000);
  assert.ok(st.byExternal(src.id, 'a.md').deletedAt, 'deleting tombstones the item');
});

test('2,000 notes are indexed in the background without freezing the app', async () => {
  const vault = tmpDir('wb-big-');
  for (let i = 0; i < 2000; i++) write(vault, `folder${i % 40}/note-${i}.md`, `# Note ${i}\n${'Meeting about the roadmap and the budget for the spring campaign. '.repeat(20)}\nUnique token zeta${i}.`);
  const st = new ItemStore(open(':memory:'));
  const src = st.addSource({ kind: 'obsidian', name: 'Big', config: { path: vault } });
  const c = new FolderConnector({ source: src, items: st });
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const t0 = Date.now();
  const r = await c.scan();
  const first = Date.now() - t0;
  h.disable();
  assert.equal(r.created, 2000);
  assert.equal(st.list({ q: 'zeta1999' }).length, 1);
  const maxMs = h.max / 1e6;
  const t1 = Date.now();
  const again = await c.scan();
  console.log(`      2,000 notes: first scan ${first} ms (event loop blocked at most ${maxMs.toFixed(0)} ms), unchanged scan ${Date.now() - t1} ms`);
  assert.equal(again.unchanged, 2000);
  assert.ok(maxMs < 200, `the event loop was blocked for ${maxMs.toFixed(0)} ms (limit 200)`);
  fs.rmSync(vault, { recursive: true, force: true });
});

test('importing the same Notion page, Obsidian note or Linear issue again updates its meeting instead of duplicating it', async (t) => {
  const dataDir = tmpDir('wb-imp-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  t.after(() => { app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await app.ready;
  const imp = (md, source, ref, title) => app.importer.importMarkdown(md, { title, source, sourceRef: ref });
  const a = imp('# Kick-off\n\nWe agreed the scope.', 'notion', 'page-1', 'Kick-off');
  const b = imp('# Kick-off\n\nWe agreed the scope.', 'notion', 'page-1', 'Kick-off');
  assert.equal(b.id, a.id, 'same page, same meeting');
  assert.equal(b.unchanged, true, 'nothing changed, nothing done');
  const c = imp('# Kick-off\n\nWe agreed the scope and the dates.', 'notion', 'page-1', 'Kick-off');
  assert.equal(c.id, a.id);
  assert.equal(c.updated, true);
  assert.match(app.notes.get(a.id).body, /and the dates/);
  imp('# Other\n\ntext', 'notion', 'page-2', 'Other');
  imp('# Issue\n\ntext', 'linear', 'ENG-1', 'ENG-1 Issue');
  imp('# Issue\n\ntext', 'linear', 'ENG-1', 'ENG-1 Issue');
  imp('# Note\n\ntext', 'obsidian', 'a/b.md', 'Note');
  imp('# Note\n\ntext', 'obsidian', 'a/b.md', 'Note');
  const counts = app.notes.sourceCounts();
  assert.deepEqual([counts.notion, counts.linear, counts.obsidian], [2, 1, 1]);
  // a file import is a different thing: the same file name twice is two files
  imp('# Same\n\ntext', 'file', 'same.md', 'Same'); imp('# Same\n\ntext', 'file', 'same.md', 'Same');
  assert.equal(app.notes.sourceCounts().file, 2);
});

test('every meeting is an item, new ones too, and the start-up backfill covers meetings made before items existed', async (t) => {
  const dataDir = tmpDir('wb-items-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  t.after(() => { app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await app.ready;
  const n = app.notes.create({ title: 'Weekly' });
  assert.equal(app.items.forNote(n.id).title, 'Weekly', 'made with the meeting');
  app.notes.update(n.id, { title: 'Weekly sync' });
  assert.equal(app.items.forNote(n.id).title, 'Weekly sync', 'follows a rename');
  app.items.db.prepare('DELETE FROM items WHERE note_id = ?').run(n.id);   // as if it was made by a version without items
  assert.equal(app.items.forNote(n.id), null);
  assert.equal(app.items.backfillNotes(), 1);
  assert.equal(app.items.backfillNotes(), 0, 'once is enough');
  assert.equal(app.items.forNote(n.id).kind, 'meeting');
  assert.equal(app.items.count(), 0, 'meetings are not listed under Notes & files: they have their own page');
  app.notes.remove(n.id);
  assert.equal(app.items.forNote(n.id), null, 'a deleted meeting takes its item with it');
});

test('the Sources API adds a folder, scans it as a job, finds its notes, pauses, and removes it without touching the files', async (t) => {
  const vault = tmpDir('wb-vault-');
  write(vault, 'Plans/Launch.md', '# Launch plan\nShip the mobile app in March.');
  const dataDir = tmpDir('wb-api-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  const srv = createServer(app, { uiDir: path.join(ROOT, 'ui') });
  const { port, token } = await srv.listen(0);
  t.after(async () => { await srv.close(); app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(vault, { recursive: true, force: true }); });
  const call = async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Cookie: `wb_token=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  await app.ready;

  assert.equal((await call('POST', '/api/sources/check', { path: vault, flavour: 'obsidian' })).body.files, 1);
  assert.equal((await call('POST', '/api/sources', { path: path.join(vault, 'nope') })).status, 400);
  const added = await call('POST', '/api/sources', { path: vault, flavour: 'obsidian', name: 'My vault' });
  assert.equal(added.status, 200);
  const id = added.body.id;
  assert.equal((await call('POST', '/api/sources', { path: vault })).status, 409, 'the same folder twice');
  await until(async () => (await call('GET', '/api/items?q=mobile')).body.items.length === 1);
  const found = (await call('GET', '/api/find?q=mobile&kind=all')).body.find((r) => r.kind === 'doc');
  assert.equal(found.title, 'Launch plan', 'found next to meetings in the search');
  const item = (await call('GET', `/api/items/${found.id}`)).body;
  assert.equal(item.sourceName, 'My vault');
  assert.match(item.uri, /^obsidian:\/\/open\?vault=/);
  const list = (await call('GET', '/api/sources')).body;
  assert.ok(list.find((s) => s.id === id).lastSyncAt, 'sync state is kept');
  assert.equal(list.find((s) => s.id === id).items, 1);
  assert.equal((await call('PATCH', `/api/sources/${id}`, { sensitivity: 'private' })).body.sensitivity, 'private');
  assert.equal((await call('PATCH', `/api/sources/${id}`, { sensitivity: 'secret' })).status, 400);
  assert.equal((await call('PATCH', `/api/sources/${id}`, { enabled: false })).body.enabled, false);
  assert.equal((await call('DELETE', `/api/sources/${id}`)).status, 200);
  assert.equal((await call('GET', '/api/items')).body.total, 0);
  assert.ok(fs.existsSync(path.join(vault, 'Plans/Launch.md')), 'the notes are still there');
});

test('a private source only ever reaches an AI server on this computer', () => {
  const { mayReachAi, visibleToAi } = require('../src/items/policy');
  const local = { baseUrl: 'http://127.0.0.1:11434/v1' }, remote = { baseUrl: 'https://api.example.com/v1' };
  const normal = { id: 'a', sensitivity: 'normal' }, priv = { id: 'b', sensitivity: 'private' };
  assert.equal(mayReachAi(normal, remote), true);
  assert.equal(mayReachAi(priv, remote), false);
  assert.equal(mayReachAi(priv, local), true);
  assert.equal(mayReachAi(priv, {}), true, 'no server set: nothing leaves this computer anyway (the rule of core/policy.js)');
  assert.equal(mayReachAi(null, local), false, 'an unknown source is not shown');
  const items = [{ sourceId: 'a', id: 1 }, { sourceId: 'b', id: 2 }];
  assert.deepEqual(visibleToAi(items, new Map([['a', normal], ['b', priv]]), remote).map((i) => i.id), [1]);
});

test('a scanned PDF is read by OCR where the tools exist; without them it is kept as a PDF with no text, and says so', async () => {
  const { ocrPdf, available } = require('../src/importers/ocr');
  const fsx = require('node:fs'), pathx = require('node:path');
  const dir = tmpDir('wb-ocr-t-');
  // stand-ins for pdftoppm and tesseract
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'pdftoppm') { const prefix = args.at(-1); for (const n of [1, 2]) fsx.writeFileSync(`${prefix}-${n}.png`, 'x'); return { stdout: '' }; }
    if (cmd === 'tesseract') return { stdout: `text of ${pathx.basename(args[0])} in ${args[args.indexOf('-l') + 1]}\n` };
    throw new Error('unexpected');
  };
  assert.equal(await ocrPdf(Buffer.from('%PDF-fake'), { exec, lang: 'por+eng' }), 'text of p-1.png in por+eng\n\ntext of p-2.png in por+eng');
  assert.deepEqual(calls, ['pdftoppm', 'tesseract', 'tesseract']);
  assert.deepEqual(await available(async () => ({ stdout: '' })), { available: true, reason: '' });
  const missing = await available(async (cmd) => { if (cmd === 'tesseract') throw Object.assign(new Error('x'), { code: 'ENOENT' }); return { stdout: '' }; });
  assert.deepEqual(missing, { available: false, reason: 'tesseract is not installed' });
  // through the folder connector: a PDF with no text layer
  const st = new ItemStore(open(':memory:'));
  write(dir, 'scan.pdf', '%PDF-1.4 fake');
  const noText = async () => ({ text: '' });
  const withOcr = st.addSource({ kind: 'folder', name: 'A', config: { path: dir } });
  await new FolderConnector({ source: withOcr, items: st, pdfToText: noText, ocr: async () => 'Recognised words from the scan' }).scan();
  const it = st.byExternal(withOcr.id, 'scan.pdf');
  assert.deepEqual([it.text, it.meta.ocr], ['Recognised words from the scan', true]);
  assert.equal(st.list({ q: 'recognised' }).length, 1, 'and it is searchable');
  const without = st.addSource({ kind: 'folder', name: 'B', config: { path: dir } });
  await new FolderConnector({ source: without, items: st, pdfToText: noText, ocr: async () => { throw new Error('tesseract is not installed'); } }).scan();
  assert.deepEqual([st.byExternal(without.id, 'scan.pdf').text, st.byExternal(without.id, 'scan.pdf').meta.needsOcr], ['', true]);
  fsx.rmSync(dir, { recursive: true, force: true });
});
