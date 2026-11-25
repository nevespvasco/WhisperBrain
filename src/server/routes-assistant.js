'use strict';
// HTTP routes for the live meeting assistant (src/assistant/service.js). Registered by http.js.
const MAX_PICTURE = 8 * 1024 * 1024;

module.exports = function assistantRoutes(add, app, { HttpError, noteOr404, readBody }) {
  const wrap = (fn) => async (ctx) => {
    try { return await fn(ctx); } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(e.status || 502, e.message, e.code);
    }
  };
  const r = (method, pattern, fn) => add(method, pattern, wrap(fn));
  const a = () => app.assistant;

  r('GET', '/api/assistant/state', async ({ query }) => { noteOr404(query.noteId); return a().state(query.noteId); });
  r('POST', '/api/assistant/toggle', async ({ body }) => { noteOr404(body.noteId); return a().toggle(body.noteId, body.enabled !== false); });
  r('POST', '/api/assistant/action', async ({ body }) => {
    noteOr404(body.noteId);
    if (!['answer', 'regenerate', 'dismiss', 'summary'].includes(body.action)) throw new HttpError(400, 'action must be answer, regenerate, dismiss or summary');
    return a().action(body.noteId, body.action);
  });
  // Streamed: events `delta`, then `done` { id, text } or `error`
  r('POST', '/api/assistant/ask', async ({ body }) => {
    noteOr404(body.noteId);
    if (typeof body.question !== 'string' || !body.question.trim()) throw new HttpError(400, 'question is required');
    return { stream: (sse) => a().ask(body.noteId, body.question.slice(0, 2000), { signal: sse.signal, onDelta: (d) => sse.send('delta', { text: d }) }) };
  });
  // A picture of the screen (JPEG or PNG bytes): the question on it is answered as a suggestion card. The picture is not kept.
  r('POST', '/api/assistant/screenshot', async ({ req, query }) => {
    noteOr404(query.noteId);
    const buf = await readBody(req, MAX_PICTURE);
    const mime = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : null;
    if (!mime) throw new HttpError(400, 'send a JPEG or PNG picture');
    return a().screenshot(query.noteId, buf, { mime });
  });
  r('GET', '/api/notes/:id/assistant', async ({ params }) => { noteOr404(params.id); return a().history(params.id); });
  r('DELETE', '/api/notes/:id/assistant', async ({ params }) => { noteOr404(params.id); a().clearHistory(params.id); return { ok: true }; });
};
