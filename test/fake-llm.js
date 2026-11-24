'use strict';
// An OpenAI-compatible fake server. `respond(messages, body)` returns the text to stream back.
const http = require('node:http');

async function startFakeLlm(respond, { models = ['fake-model'], apiKey } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'bad key' } }));
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const body = JSON.parse(raw);
        requests.push(body);
        const text = respond(body.messages, body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const pieces = text.match(/[\s\S]{1,7}/g) || [];
        for (const p of pieces) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  return { url, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

module.exports = { startFakeLlm };
