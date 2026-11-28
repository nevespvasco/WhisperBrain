'use strict';
// The MCP server (src/mcp/server.js): read-only, nothing private, only what was accepted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createApp } = require('../src/server/app');
const { tmpDir, ROOT } = require('./helpers');

const fakePlatform = () => ({
  id: 'fake', session: 'test', capture: { mic: 'renderer', system: 'renderer' },
  async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; },
  async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; },
  async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null,
});

// a data folder with a meeting, two folders (one private), an accepted and a suggested promise, and an accepted decision
async function makeData() {
  const dataDir = tmpDir('wb-mcp-');
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  await app.ready; await app.runner.stop();
  app.settings.update({ userName: 'Ana' });
  const n = app.notes.create({ title: 'Pricing review', status: 'done', attendees: [{ name: 'Ana', email: 'ana@x.pt' }, { name: 'Rui Costa', email: 'rui@x.pt' }] });
  app.db.prepare("INSERT INTO note_speakers (note_id, speaker_id, channel, name, count) VALUES (?, 's1', 'system', 'Rui Costa', 1)").run(n.id);
  app.notes.addSegments(n.id, [{ speaker: 'them', speakerId: 's1', text: 'We will drop the free tier from January.', startMs: 0, endMs: 4000, channel: 'system' }]);
  const open = app.items.addSource({ kind: 'folder', name: 'Open', config: { path: '/o' } });
  const secret = app.items.addSource({ kind: 'folder', name: 'Secret', sensitivity: 'private', config: { path: '/s' } });
  const a = app.items.upsert(open.id, { externalId: 'a.md', title: 'Pricing plan', text: 'The pricing plan for the free tier and the paid tiers.' }).item;
  const b = app.items.upsert(secret.id, { externalId: 'b.md', title: 'Pricing diary', text: 'My private thoughts about pricing and the free tier.' }).item;
  const yes = app.assertions.add({ kind: 'commitment', text: 'Send the pricing sheet', owner: 'Rui Costa', noteId: n.id, origin: 'user' }).item;
  app.assertions.add({ kind: 'commitment', text: 'Review the contract', owner: 'Ana', noteId: n.id, origin: 'user' });
  app.assertions.add({ kind: 'commitment', text: 'Buy a boat', owner: 'Rui Costa', quote: 'we might buy a boat one day', noteId: n.id, origin: 'ai' });   // only suggested
  app.assertions.add({ kind: 'decision', text: 'Drop the free tier from January', noteId: n.id, quote: 'We will drop the free tier from January.', origin: 'user' });
  app.chunkIndex.syncBatch(50);
  app.close(); await app.settled;
  return { dataDir, a, b, n, yes };
}

function client(dataDir) {
  const p = spawn(process.execPath, [path.join(ROOT, 'scripts/mcp-server.js'), '--data', dataDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiting = new Map();
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); waiting.get(m.id)?.(m); } });
  let id = 0, err = '';
  p.stderr.on('data', (d) => { err += d; });
  const rpc = (method, params) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
  const tool = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); return { ...r.result, data: r.result.isError ? r.result.content[0].text : JSON.parse(r.result.content[0].text) }; };
  return { rpc, tool, notify: (method) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`), raw: (s) => p.stdin.write(s), stderr: () => err, close: () => p.kill() };
}

test('MCP: the handshake, the tool list, and a search that finds meetings and notes but never a private source', async (t) => {
  const { dataDir, a, b } = await makeData();
  const c = client(dataDir);
  t.after(() => { c.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const init = await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'whisperbrain');
  assert.ok(init.result.capabilities.tools);
  c.notify('notifications/initialized');
  assert.deepEqual((await c.rpc('tools/list')).result.tools.map((x) => x.name).sort(), ['get_note', 'get_person', 'list_people', 'open_commitments', 'recent_decisions', 'search']);
  assert.deepEqual((await c.rpc('ping')).result, {});
  const s = await c.tool('search', { query: 'pricing free tier' });
  const titles = s.data.map((h) => h.title);
  assert.ok(titles.includes('Pricing plan') && titles.includes('Pricing review'));
  assert.ok(!titles.includes('Pricing diary'), 'a private source is never shared');
  assert.equal((await c.tool('get_note', { id: a.id })).data.title, 'Pricing plan');
  assert.match((await c.tool('get_note', { id: b.id })).data, /private/, 'and cannot be read by id either');
  assert.equal((await c.rpc('nope')).error.code, -32601);
  assert.equal((await c.rpc('tools/call', { name: 'delete_everything', arguments: {} })).error.code, -32602, 'there is no tool that changes anything');
  c.raw('{not json\n');
  await new Promise((r) => setTimeout(r, 100));
});

test('MCP: people, one person, accepted promises and decisions only', async (t) => {
  const { dataDir } = await makeData();
  const c = client(dataDir);
  t.after(() => { c.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await c.rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.deepEqual((await c.tool('list_people', { query: 'rui' })).data.map((p) => p.name), ['Rui Costa']);
  const p = (await c.tool('get_person', { name: 'rui costa' })).data;
  assert.deepEqual([p.name, p.emails, p.openPromises.map((x) => x.text)], ['Rui Costa', ['rui@x.pt'], ['Send the pricing sheet']]);
  assert.equal(p.recentMeetings[0].title, 'Pricing review');
  const open = (await c.tool('open_commitments')).data;
  assert.deepEqual(open.youOwe.map((x) => x.text), ['Review the contract']);
  assert.deepEqual(open.owedToYou.map((x) => x.text), ['Send the pricing sheet'], 'a suggestion nobody accepted is not shared');
  assert.deepEqual((await c.tool('recent_decisions')).data.map((x) => x.text), ['Drop the free tier from January']);
  assert.match((await c.tool('get_person', { name: 'Nobody Here' })).data, /Nobody/);
});

test('MCP: the database is opened read-only, and an old schema is refused with a clear message', async (t) => {
  const { dataDir } = await makeData();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { BrainReader } = require('../src/mcp/server');
  const r = BrainReader.open(path.join(dataDir, 'whisperbrain.sqlite'));
  assert.throws(() => r.db.exec("INSERT INTO index_meta (key, value) VALUES ('x', 'y')"), /readonly/i);
  r.db.close();
  const { DatabaseSync } = require('node:sqlite');
  const old = path.join(dataDir, 'old.sqlite');
  const d = new DatabaseSync(old); d.exec('PRAGMA user_version = 12'); d.close();
  assert.throws(() => BrainReader.open(old), /older than the brain/);
});

// ---- audit 2026-11-28 (D1-2): people, promises and decisions follow each source's MCP switch, like search does ----
test('MCP: a source with MCP off gives nothing through people, one person, promises or decisions', async (t) => {
  const dataDir = tmpDir('wb-mcp-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const app = createApp({ dataDir, platform: fakePlatform(), version: 'test' });
  await app.ready; await app.runner.stop();
  app.settings.update({ userName: 'Ana' });
  const open = app.notes.create({ title: 'Pricing review', status: 'done', attendees: [{ name: 'Ana', email: 'ana@x.pt' }, { name: 'Rui Costa', email: 'rui@x.pt' }] });
  const hidden = app.notes.create({ title: 'Board secrets', status: 'done', source: 'notion', sourceRef: 'n1', attendees: [{ name: 'Rui Costa', email: 'rui@x.pt' }, { name: 'Zed Hidden', email: 'zed@y.pt' }] });
  app.items.syncNote(open.id); app.items.syncNote(hidden.id);
  app.items.setGrant(app.items.sourceOfNote(open.id).id, { aiReach: 'any', mcp: true });
  app.items.setGrant(app.items.sourceOfNote(hidden.id).id, { aiReach: 'any', mcp: false });
  app.assertions.add({ kind: 'commitment', text: 'Send the pricing sheet', owner: 'Rui Costa', noteId: open.id, origin: 'user' });
  app.assertions.add({ kind: 'commitment', text: 'Sell the company quietly', owner: 'Rui Costa', quote: 'we sell quietly', noteId: hidden.id, origin: 'user' });
  app.assertions.add({ kind: 'decision', text: 'Drop the free tier', noteId: open.id, origin: 'user' });
  app.assertions.add({ kind: 'decision', text: 'Fire the auditors', noteId: hidden.id, origin: 'user' });
  app.close(); await app.settled;

  const { BrainReader } = require('../src/mcp/server');
  const r = BrainReader.open(path.join(dataDir, 'whisperbrain.sqlite'));
  t.after(() => r.db.close());
  const people = await r.call('list_people', {});
  assert.ok(people.some((p) => p.name === 'Rui Costa'));
  assert.ok(!people.some((p) => p.name === 'Zed Hidden'), 'somebody met only in the hidden meeting is not listed');
  assert.equal(people.find((p) => p.name === 'Rui Costa').meetings, 1, 'the hidden meeting is not counted');
  await assert.rejects(r.call('get_person', { name: 'Zed Hidden' }), /Nobody/);
  const rui = await r.call('get_person', { name: 'Rui Costa' });
  assert.deepEqual(rui.recentMeetings.map((m) => m.title), ['Pricing review']);
  assert.deepEqual(rui.openPromises.map((x) => x.text), ['Send the pricing sheet']);
  const owed = await r.call('open_commitments', {});
  assert.deepEqual([...owed.youOwe, ...owed.owedToYou].map((x) => x.text), ['Send the pricing sheet']);
  assert.deepEqual((await r.call('recent_decisions', {})).map((x) => x.text), ['Drop the free tier']);
  assert.ok(!JSON.stringify([people, rui, owed]).includes('Board secrets'));
});
