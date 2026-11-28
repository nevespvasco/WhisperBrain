// Activity: the work WhisperBrain does in the background (src/jobs). What is waiting, running, done or failed, which meeting
// it is for, and a way to run a failed step again. Lives under the Setup door.
import { S, api, t, esc, icon, fail, debounce, empty, fmtDate } from '../lib.js';

let onEvent = null;   // the live listener of the page on screen (one at a time)

// What each kind of job does, in words a person understands
const KIND = {
  'note.names': 'Names from the conversation',
  'note.summarize': 'Summary',
  'note.insights': 'Topics, glossary and action items',
  'items.backfill': 'Listing your meetings in the library',
  'entities.backfill': 'Finding the people in your meetings',
  'source.sync': 'Reading a folder of notes',
};
// which part of the app asked the AI
const LANE = { assistant: 'Live assistant', chat: 'Questions and notes', summary: 'Summaries', translation: 'Translation', background: 'Topics, names and more' };
const STATE = {
  queued: ['', 'Waiting'], running: ['accent', 'Running'], done: ['ok', 'Done'], failed: ['danger', 'Failed'], cancelled: ['', 'Cancelled'],
};
const when = (ms) => (ms ? fmtDate(ms, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export async function render(main, { alive = () => true } = {}) {
  const draw = async () => {
    const [{ counts, jobs }, ledger] = await Promise.all([api('GET', '/api/jobs?limit=200'), api('GET', '/api/ai-runs?limit=15&days=30').catch(() => null)]);
    if (!alive()) return;   // the user moved on meanwhile (app.js route())
    const busy = counts.queued + counts.running;
    main.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>${t('Activity')}</h1><div class="sub">${t('What WhisperBrain does in the background after a meeting. If the app closes in the middle, it carries on the next time it opens.')}</div></div></div>
      <div class="stats-row">${[['running', counts.running], ['queued', counts.queued], ['failed', counts.failed], ['done', counts.done]].map(([k, n]) => `<div class="card stat"><b>${n}</b><span>${t(STATE[k][1])}</span></div>`).join('')}</div>
      ${counts.failed ? `<div class="banner warn mt">${icon('alert')}<div class="grow">${t('Some steps failed. Open the meeting to see what is missing, or run the step again.')}</div></div>` : ''}
      <section class="panel mt">${jobs.length ? `<div class="stack tight">${jobs.map(row).join('')}</div>`
        : empty('refresh', t('Nothing yet'), t('When a recording ends, its summary, topics and action items are prepared here.'))}</section>
      ${busy ? '' : '<div class="xsmall muted mt-s">' + esc(t('Finished steps are kept for two weeks.')) + '</div>'}
      ${ledger ? aiCalls(ledger) : ''}</div>`;
  };
  // What was asked of an AI server, and whether it left this computer. Never the text itself.
  const aiCalls = ({ summary, runs }) => `<section class="panel mt"><div class="panel-head"><h3>${icon('sparkles')} ${t('AI calls')}</h3><span class="badge ${summary.remote ? 'accent' : 'ok'}">${summary.remote ? t('{n} left this computer', { n: summary.remote }) : t('Nothing left this computer')}</span></div>
    <div class="small muted" style="margin-bottom:8px">${t('{n} calls in the last 30 days. Only the size of what was sent is kept, never the text.', { n: summary.total })}${summary.remote ? ` ${t('{n} characters went to a server that is not on this computer.', { n: summary.remoteChars })}` : ''}</div>
    ${runs.length ? `<div class="stack tight">${runs.map((r) => `<div class="row small" style="gap:10px;align-items:center"><span class="muted" style="width:92px">${esc(when(r.at))}</span><span class="grow ellipsis">${esc(t(LANE[r.lane] || r.lane))} · <span class="muted">${esc(r.model || '')}</span></span><span class="muted ellipsis" style="max-width:160px">${esc(r.host)}</span><span class="badge ${r.local ? 'ok' : 'accent'}">${r.local ? t('On this computer') : t('Left this computer')}</span>${r.ok ? '' : `<span class="badge danger" title="${esc(r.error || '')}">${t('Failed')}</span>`}</div>`).join('')}</div>` : `<div class="small muted">${t('No AI calls yet.')}</div>`}</section>`;
  const row = (j) => {
    const [cls, label] = STATE[j.state] || ['', j.state];
    const what = t(KIND[j.kind] || j.kind);
    const meeting = j.payload?.noteId ? (j.note ? `<a href="#/note/${esc(j.note.id)}">${esc(j.note.title || t('Untitled meeting'))}</a>` : `<span class="faint">${t('Deleted meeting')}</span>`) : '';
    return `<div class="card row" data-job="${j.id}" style="align-items:center;gap:12px">
      <div class="grow"><div class="strong">${esc(what)}</div>
        <div class="xsmall muted">${meeting}${meeting ? ' · ' : ''}${esc(when(j.updatedAt))}${j.attempts > 1 ? ` · ${t('attempt {n}', { n: j.attempts })}` : ''}</div>
        ${j.error && j.state !== 'done' ? `<div class="xsmall" style="color:var(--danger)">${esc(j.error)}</div>` : ''}</div>
      <span class="badge ${cls}">${t(label)}</span>
      ${j.state === 'failed' || j.state === 'cancelled' ? `<button class="btn sm" data-retry="${j.id}">${icon('refresh', 'sm')} ${t('Run again')}</button>` : ''}
      ${j.state === 'queued' ? `<button class="btn sm ghost" data-cancel="${j.id}">${t('Cancel')}</button>` : ''}</div>`;
  };
  await draw();
  main.onclick = async (e) => {
    const r = e.target.closest('[data-retry]'), c = e.target.closest('[data-cancel]');
    try {
      if (r) { await api('POST', `/api/jobs/${r.dataset.retry}/retry`); await draw(); }
      if (c) { await api('POST', `/api/jobs/${c.dataset.cancel}/cancel`); await draw(); }
    } catch (err) { fail(err); }
  };
  // live: redraw while this page is open; the listener goes away with the page
  const redraw = debounce(() => { if (S.view.name === 'activity') draw().catch(() => {}); }, 300);
  if (onEvent) window.removeEventListener('wb:event', onEvent);
  onEvent = (e) => {
    if (S.view.name !== 'activity') { window.removeEventListener('wb:event', onEvent); onEvent = null; return; }
    if (e.detail?.type === 'job.changed') redraw();
  };
  window.addEventListener('wb:event', onEvent, { signal: S.route.signal });   // and gone with the page (app.js route())
}
