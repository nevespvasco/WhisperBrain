#!/usr/bin/env node
'use strict';
// A look at the live assistant without a real call: `node scripts/assistant-demo.js [--port 3799] [--llm http://127.0.0.1:11434/v1 --model llama3.2]`
// Starts the headless server on a throw-away data folder, adds a project briefing, and plays a short client project review as if it were being
// recorded (lines from the other side and from you, through the same events the recorder publishes). Without --llm a small
// built-in stand-in streams canned answers, so the whole flow can be seen offline. Prints the URL to open.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../src/server/app');
const { createServer } = require('../src/server/http');

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const DIALOG = [
  [1500, 'them', 'Thanks for joining. Shall we start?'],
  [1800, 'me', 'Sure, happy to be here.'],
  [2500, 'them', 'Tell me about the billing migration so far.'],
  [9000, 'me', 'Billing runs on Kubernetes now, and deploys went from sixty minutes to ten.'],
  [2500, 'them', 'How did you keep the SLA during the cut-over?'],
  [9000, 'them', 'Our reporting jobs are mostly Go and gRPC on k8s.'],
  [3000, 'them', 'When can the next release go out?'],
  [9000, 'them', 'Sorry, can you repeat that?'],
];

// A stand-in OpenAI-compatible server that streams slowly, so sentences can be seen arriving.
function standIn() {
  const answer = (sys, user) => {
    // look only at what is being asked (the question tag, or the term), never at the briefing around it
    const asked = (/The question just asked:\n<transcript>\n([\s\S]*?)\n<\/transcript>/.exec(user) || [])[1] || '';
    const term = (/Term: (.*)/.exec(user) || [])[1] || '';
    if (/running summary/.test(sys)) return JSON.stringify({ summary: 'Project review with Acme: the billing migration, reliability during the cut-over, the next release date.', decisions: [], actions: [{ text: 'Send the cut-over report', owner: 'Me' }], openQuestions: ['When the reporting jobs move'] });
    if (/ONE plain sentence/.test(sys)) return { SLA: 'A service level agreement: the uptime or response time a service promises its users.', gRPC: 'A remote procedure call framework from Google that uses HTTP/2 and Protocol Buffers.', k8s: 'Short for Kubernetes, a system that runs containers across many machines.' }[term] || `A technical term used in the conversation: ${term}.`;
    if (/next release/i.test(asked)) return 'The next release can go out on the 12th, once the billing tests pass. [GAP] We could move the reporting jobs in the same window if your team agrees.';
    if (/SLA/.test(asked)) return 'We ran both billing systems side by side for two weeks and compared every invoice. Traffic moved in 10% steps behind a feature flag, so we could roll back in seconds. We kept the 99.95% SLA through the whole cut-over.';
    if (/billing migration/i.test(asked)) return 'Billing now runs on Kubernetes. Deploys went from sixty minutes to ten, and on-call pages dropped by half. The reporting jobs are the last piece, planned for May.';
    return 'They asked about the project; your briefing has the details.';
  };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'stand-in' }] })); }
      const body = JSON.parse(raw || '{}');
      const sys = body.messages?.[0]?.content || '', last = body.messages?.at(-1)?.content;
      const user = typeof last === 'string' ? last : JSON.stringify(last);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const piece of answer(sys, user).match(/[\s\S]{1,6}/g)) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`); await wait(35); }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}/v1`, close: () => srv.close() })));
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-assistant-demo-'));
  const fake = { id: 'fake', session: 'demo', capture: { mic: 'renderer', system: 'renderer' }, async capabilities() { return { platform: 'fake', mic: true, systemAudio: true, paste: false, notes: [] }; }, async listMics() { return []; }, createMicSource() { return null; }, async createSystemSource() { return null; }, async micActivity() { return { supported: false, active: false, apps: [] }; }, async paste() { return { ok: false }; }, clipboard: null };
  const app = createApp({ dataDir, platform: fake, version: 'demo' });
  await app.ready;
  const llm = arg('llm') ? { url: arg('llm'), close() {} } : await standIn();
  app.settings.update({ llm: { ...app.settings.get('llm'), baseUrl: llm.url, model: arg('model', arg('llm') ? '' : 'stand-in') }, assistant: { enabled: true, mode: 'spoken', liveSummaryMin: 1 } });
  const brief = app.briefings.create({ title: 'Acme — billing migration', kind: 'project', text: 'Billing migration for Acme. Lead: Ana Silva.\n\nDone: billing runs on Kubernetes; deploys from 60 to 10 minutes; on-call pages halved; kept the 99.95% SLA with a two-week parallel run and 10% traffic steps behind a feature flag.\n\nNext: the reporting jobs (Go, gRPC) move in May.\n\nNext release: the 12th, once the billing tests pass.' });
  const note = app.notes.create({ title: 'Acme — project review (demo)', source: 'recorded' });
  app.briefings.setForNote(note.id, [brief.id]);
  const srv = createServer(app, { uiDir: path.join(__dirname, '..', 'ui') });
  const { port, token } = await srv.listen(Number(arg('port', 3799)));
  console.log(`Open: http://127.0.0.1:${port}/?token=${token}#/note/${note.id}`);
  console.log(`(data in ${dataDir}; the dialog starts in 6 s and loops; Ctrl+C to stop)`);
  const stop = async () => { await srv.close(); app.close(); llm.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await wait(6000);
  let t = 0;
  for (;;) {
    app.bus.publish('recording.started', { noteId: note.id });
    for (const [gap, speaker, text] of DIALOG) {
      await wait(gap);
      t += gap;
      const [seg] = app.notes.addSegments(note.id, [{ speaker, startMs: t, endMs: t + 1500, text }]);
      app.bus.publish('transcript.segment', { noteId: note.id, segment: { id: seg?.id || t, speaker, label: speaker === 'me' ? 'Me' : 'Them', startMs: t, endMs: t + 1500, text } });
    }
    await app.assistant.summarize(app.assistant.live).catch(() => {});
    await wait(8000);
    app.bus.publish('recording.stopped', { noteId: note.id });
    await wait(10000);
  }
})().catch((e) => { console.error(e); process.exit(1); });
