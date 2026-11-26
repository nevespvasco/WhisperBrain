'use strict';
// HTTP routes for background work (src/jobs): what is queued, running, done or failed, and retrying or cancelling one.
// The Activity page (ui/views/activity.js) reads these. Registered by http.js.

module.exports = function jobRoutes(add, app, { HttpError }) {
  const found = (j) => { if (!j) throw new HttpError(404, 'job not found'); return j; };
  // the meeting a job is about, so the page can say which one (or that it was deleted since)
  const withNote = (j) => (j.payload?.noteId ? { ...j, note: (({ id, title } = {}) => (id ? { id, title } : null))(app.notes.get(j.payload.noteId) || {}) } : j);

  add('GET', '/api/jobs', async ({ query }) => {
    const limit = Math.max(1, Math.min(500, Number(query.limit) || 100));
    return { counts: app.jobs.counts(), jobs: app.jobs.list({ state: query.state || null, limit }).map(withNote) };
  });
  add('POST', '/api/jobs/:id/retry', async ({ params }) => {
    const id = Number(params.id);
    found(app.jobs.get(id));
    try { app.jobs.retry(id); } catch (e) { throw new HttpError(409, e.message); }
    app.runner.kick();
    return withNote(app.jobs.get(id));
  });
  add('POST', '/api/jobs/:id/cancel', async ({ params }) => {
    const id = Number(params.id);
    return withNote(found(app.jobs.cancel(id)));
  });
};
