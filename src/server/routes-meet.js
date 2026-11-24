'use strict';
// HTTP routes for the meeting window readers (who is speaking, who is on the call). Registered by http.js.
const { pathToFileURL } = require('node:url');
const { SignalError } = require('../meet/protocol');

module.exports = function meetRoutes(add, app, { HttpError }) {
  const meet = app.meet;
  add('GET', '/api/meet/status', async () => meet.status());
  // The pairing code for the browser extension. Only while the extension is switched on (the door is open).
  add('GET', '/api/meet/pairing', async () => {
    const p = meet.pairing();
    if (!p) throw new HttpError(409, 'Switch the browser extension on first.');
    return p;
  });
  add('POST', '/api/meet/pairing/reset', async () => { const p = meet.resetToken(); if (!p) throw new HttpError(409, 'Switch the browser extension on first.'); return p; });
  // Opens the folder of the browser extension in the file manager, to pick it in "Load unpacked"
  add('POST', '/api/meet/extension/reveal', async () => {
    const dir = meet.extensionDir();
    if (!dir) throw new HttpError(404, 'The extension folder was not found.');
    if (!app.openExternal) throw new HttpError(409, `Open this folder yourself: ${dir}`);
    await app.openExternal(pathToFileURL(dir).href);
    return { path: dir };
  });
  // Linux: browsers that must be started with accessibility on for the page to be readable, and the switch for each
  const FILE = /^[\w.@-]+\.desktop$/;
  add('GET', '/api/meet/browsers', async () => meet.browsers());
  add('POST', '/api/meet/browsers/:file/enable', async ({ params }) => {
    if (!FILE.test(params.file)) throw new HttpError(400, 'bad launcher name');
    try { return meet.enableBrowser(params.file); } catch (e) { throw new HttpError(409, e.message); }
  });
  add('POST', '/api/meet/browsers/:file/disable', async ({ params }) => {
    if (!FILE.test(params.file)) throw new HttpError(400, 'bad launcher name');
    try { return { removed: meet.disableBrowser(params.file) }; } catch (e) { throw new HttpError(409, e.message); }
  });
  // Signals can also be sent straight to the app (tests, scripts, a reader that is not a browser extension).
  // body: { source?: string, kind?: 'extension'|'a11y'|'vision'|'captions', messages: [...] } or one message.
  add('POST', '/api/meet/signals', async ({ body }) => {
    const list = Array.isArray(body.messages) ? body.messages : [body.message || body];
    if (list.length > 200) throw new HttpError(413, 'too many messages');
    const source = String(body.source || 'api').replace(/[^\w-]/g, '').slice(0, 24) || 'api';
    let accepted = 0;
    for (const m of list) {
      try { meet.hub.ingest(m, { source, kind: body.kind || null }); accepted++; } catch (e) { if (e instanceof SignalError) throw new HttpError(400, e.message); throw e; }
    }
    return { accepted };
  });
};
