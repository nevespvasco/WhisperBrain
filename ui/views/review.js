// The weekly review: what happened this week and what is still open, from facts only. Every line opens its source.
import { api, t, esc, icon, fmtDate, fmtClock } from '../lib.js';

const day = (ms) => fmtDate(ms, { day: 'numeric', month: 'short' });
const hours = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
const link = (a) => `<a href="#/note/${a.noteId}?tab=transcript${a.segmentId ? `&seg=${a.segmentId}` : ''}">${icon('quote', 'sm')}</a>`;
const list = (rows, f) => (rows.length ? `<ul class="list">${rows.map(f).join('')}</ul>` : `<div class="small muted">${t('Nothing.')}</div>`);

export async function render(main, { params }) {
  const weeks = Math.max(0, Number(params.get('weeks')) || 0);
  const r = await api('GET', `/api/review?weeks=${weeks}`);
  const sec = (title, body) => `<section class="panel"><div class="panel-head"><h3>${title}</h3></div>${body}</section>`;
  main.innerHTML = `<div class="page narrow">
    <div class="page-head"><div><h1>${t('Weekly review')}</h1><div class="sub">${day(r.from)} – ${day(r.to - 86400000)} · ${weeks ? t('{n} weeks ago', { n: weeks }) : t('This week')}</div></div>
      <div class="row" style="gap:6px"><a class="btn sm" href="#/review?weeks=${weeks + 1}">${icon('chevleft', 'sm')} ${t('Earlier')}</a>${weeks ? `<a class="btn sm" href="#/review?weeks=${weeks - 1}">${t('Later')} ${icon('chevright', 'sm')}</a>` : ''}</div></div>
    <div class="stats-row mb"><div class="card stat"><b>${r.meetings.length}</b><span>${t('Meetings')}</span></div><div class="card stat"><b>${r.minutes ? hours(r.minutes) : '—'}</b><span>${t('In meetings')}</span></div><div class="card stat"><b>${r.decisions.length}</b><span>${t('Decisions')}</span></div><div class="card stat"><b>${r.kept.length}</b><span>${t('Promises kept')}</span></div></div>
    <div class="stack loose">
      ${sec(t('Who you met'), r.people.length ? `<div class="chips">${r.people.map((p) => `<a class="chip" href="#/person/${encodeURIComponent(p.key)}">${esc(p.name)} <span class="faint">${p.meetings}</span></a>`).join('')}</div>` : `<div class="small muted">${t('Nobody yet.')}</div>`)}
      ${sec(t('Decided'), list(r.decisions, (a) => `<li>${esc(a.text)} ${link(a)}</li>`))}
      ${sec(t('Promises kept'), list(r.kept, (a) => `<li>${esc(a.text)}${a.owner ? ` <span class="muted">· ${esc(a.owner)}</span>` : ''} ${link(a)}</li>`))}
      ${sec(t('Late: yours'), list(r.lateMine, (a) => `<li>${esc(a.text)} <span class="muted">· ${t('by')} ${day(a.dueAt)}</span> ${link(a)}</li>`))}
      ${sec(t('Late: owed to you'), list(r.lateTheirs, (a) => `<li>${esc(a.text)} <span class="muted">· ${esc(a.owner.name)} · ${t('by')} ${day(a.dueAt)}</span> ${link(a)}</li>`))}
      ${sec(t('Still open'), `<div class="small">${t('I owe')} <b>${r.openMine}</b> · ${t('Owed to me')} <b>${r.openTheirs}</b> · <a href="#/promises">${t('Promises')}</a>${r.toReview ? ` · <a href="#/inbox">${t('{n} suggestions to review', { n: r.toReview })}</a>` : ''}${r.noReply ? ` · ${t('{n} e-mails without an answer', { n: r.noReply })}` : ''}${r.newNotes ? ` · ${t('{n} new notes read', { n: r.newNotes })}` : ''}</div>`)}
    </div></div>`;
}
