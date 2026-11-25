'use strict';
// HTTP routes for briefings (src/knowledge/briefings.js): the user's own material the meeting assistant is grounded on.
// Registered by http.js.

const MAX_IMPORT = 20 * 1024 * 1024; // project notes or an agenda, not a library

module.exports = function briefingRoutes(add, app, { HttpError, noteOr404, readBody }) {
  const store = () => app.briefings;
  // Store errors carry a status (400 bad input, 404 unknown id); anything else is a server error.
  const r = (method, pattern, fn) => add(method, pattern, async (ctx) => {
    try { return await fn(ctx); } catch (e) {
      if (e instanceof HttpError || !e.status) throw e;
      throw new HttpError(e.status, e.message, e.code);
    }
  });
  const found = (b) => { if (!b) throw new HttpError(404, 'briefing not found'); return b; };
  const object = (body) => { if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'expected a JSON object'); return body; };

  r('GET', '/api/briefings', async () => store().list());
  r('POST', '/api/briefings', async ({ body }) => { const { title, kind, text } = object(body); return store().create({ title, kind, text }); });
  r('POST', '/api/briefings/import', async ({ req, query }) => {
    const name = String(query.name || '').trim();
    if (!name) throw new HttpError(400, 'name is required (the file name, e.g. ?name=project-notes.pdf)');
    const buf = await readBody(req, MAX_IMPORT);
    return store().importFile(name, buf);
  });
  r('GET', '/api/briefings/:id', async ({ params }) => found(store().get(params.id)));
  r('PATCH', '/api/briefings/:id', async ({ params, body }) => {
    const { title, kind, text } = object(body);
    return found(store().update(params.id, { title, kind, text }));
  });
  r('DELETE', '/api/briefings/:id', async ({ params }) => { found(store().remove(params.id)); return { ok: true }; });

  r('GET', '/api/notes/:id/briefings', async ({ params }) => { noteOr404(params.id); return store().forNote(params.id); });
  r('PUT', '/api/notes/:id/briefings', async ({ params, body }) => {
    noteOr404(params.id);
    const { ids } = object(body);
    if (!Array.isArray(ids)) throw new HttpError(400, 'ids must be a list of briefing ids');
    return store().setForNote(params.id, ids);
  });
};
