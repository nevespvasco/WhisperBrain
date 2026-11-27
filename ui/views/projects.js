// Projects: a name and the words that belong to it. Meetings, notes, decisions and promises that mention them are gathered here by themselves.
import { S, $, api, t, esc, icon, fail, done, empty, fmtDate, fmtClock, go, confirmDialog, promptDialog } from '../lib.js';

const day = (ms) => fmtDate(ms, { day: 'numeric', month: 'short', year: 'numeric' });
const link = (a) => `<a href="#/note/${a.noteId}?tab=transcript${a.segmentId ? `&seg=${a.segmentId}` : ''}">${icon('quote', 'sm')}${a.startMs != null ? ` ${fmtClock(a.startMs)}` : ''}</a>`;

export async function render(main, { name, parts }) {
  if (name === 'project' && parts[1]) return page(main, parts[1]);
  const projects = await api('GET', '/api/projects');
  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>${t('Projects')}</h1><div class="sub">${t('A project is a name and the words that belong to it. Meetings, notes, decisions and promises that mention them are gathered here by themselves.')}</div></div></div>
    <section class="panel mb"><div class="panel-head"><h3>${icon('plus')} ${t('New project')}</h3></div>
      <form id="pj-form" class="formgrid" style="grid-template-columns:repeat(2,minmax(0,1fr))"><div class="field"><label for="pj-name">${t('Name')}</label><input id="pj-name" autocomplete="off" placeholder="${t('e.g. {x}', { x: 'Orion' })}"></div><div class="field"><label for="pj-kw">${t('Words that belong to it')} <span class="faint">(${t('optional')})</span></label><input id="pj-kw" autocomplete="off" placeholder="${t('e.g. {x}', { x: 'orion, launch plan' })}"><div class="hint">${t('Separated by commas. If you leave it empty, the name is used.')}</div></div></form>
      <div class="row mt-s" style="justify-content:flex-end"><button class="btn primary" data-add disabled>${icon('plus', 'sm')} ${t('Create')}</button></div></section>
    ${projects.length ? `<div class="cards">${projects.map((p) => `<a class="card hover" href="#/project/${p.id}"><div class="strong">${icon('layers')} ${esc(p.name)}</div><div class="small muted">${p.meetings} ${p.meetings === 1 ? t('meeting') : t('meetings')} · ${p.docs} ${t('notes')}${p.openPromises ? ` · ${p.openPromises} ${t('open promises')}` : ''}</div>${p.lastAt ? `<div class="xsmall muted">${t('Last activity')}: ${day(p.lastAt)}</div>` : ''}</a>`).join('')}</div>`
      : `<div class="panel">${empty('layers', t('No projects yet'), t('Make one for something you work on, and everything about it is gathered in one place.'))}</div>`}</div>`;
  // Create is enabled once there is a name; Enter in either field creates it
  main.oninput = (e) => { if (e.target.id === 'pj-name') $('[data-add]', main).disabled = !e.target.value.trim(); };
  // (two text fields and no submit button: the browser would not submit on Enter by itself)
  main.onkeydown = (e) => { if (e.key === 'Enter' && e.target.closest('#pj-form')) { e.preventDefault(); $('[data-add]', main).click(); } };
  main.onclick = async (e) => {
    if (!e.target.closest('[data-add]')) return;
    if (!$('#pj-name', main).value.trim()) { $('#pj-name', main).focus(); return; }
    try { const p = await api('POST', '/api/projects', { name: $('#pj-name', main).value, keywords: $('#pj-kw', main).value }); go(`#/project/${p.id}`); } catch (err) { fail(err); }
  };
}

async function page(main, id) {
  const p = await api('GET', `/api/projects/${id}`);
  main.innerHTML = `<div class="page">
    <div class="note-top"><button class="btn ghost icon" data-act="back" aria-label="${t('Back')}">${icon('back')}</button><div class="tt"><h1 style="font-size:26px">${esc(p.name)}</h1>
      <div class="note-meta"><span>${icon('hash', 'sm')}${p.keywords.map(esc).join(', ')}</span>${p.lastAt ? `<span>${icon('clock', 'sm')}${t('Last activity')}: ${day(p.lastAt)}</span>` : ''}</div></div>
      <div class="note-actions"><button class="btn" data-act="edit">${icon('edit', 'sm')} ${t('Words')}</button><button class="btn" data-act="archive">${t('Archive')}</button><button class="btn ghost" data-act="delete">${icon('trash', 'sm')}</button></div></div>
    <div class="note-grid"><div class="stack loose">
      <section class="panel"><div class="panel-head"><h3>${icon('check')} ${t('Open promises')}</h3></div>${p.promises.length ? `<ul class="list">${p.promises.map((a) => `<li>${esc(a.text)} <span class="muted">${a.owner.name ? `· ${esc(a.owner.name)} ` : ''}${a.dueAt ? `· ${t('by')} ${fmtDate(a.dueAt, { day: 'numeric', month: 'short' })}` : ''}</span> ${link(a)}</li>`).join('')}</ul>` : `<div class="small muted">${t('None.')}</div>`}</section>
      <section class="panel"><div class="panel-head"><h3>${icon('layers')} ${t('Decisions')}</h3></div>${p.decisions.length ? `<ul class="list">${p.decisions.map((a) => `<li class="${a.state === 'superseded' ? 'muted' : ''}">${a.state === 'superseded' ? `<s>${esc(a.text)}</s>` : esc(a.text)} ${link(a)}</li>`).join('')}</ul>` : `<div class="small muted">${t('None.')}</div>`}</section>
      <section class="panel"><div class="panel-head"><h3>${icon('video')} ${t('Meetings')}</h3></div>${p.meetings.length ? `<ul class="list">${p.meetings.map((n) => `<li><a href="#/note/${n.id}">${esc(n.title || t('Untitled meeting'))}</a> <span class="muted">· ${day(n.startedAt || n.createdAt)}</span></li>`).join('')}</ul>` : `<div class="small muted">${t('None yet.')}</div>`}</section></div>
      <aside class="note-aside"><section class="panel"><div class="panel-head"><h3>${icon('file')} ${t('Notes & files')}</h3></div>${p.docs.length ? `<ul class="list">${p.docs.map((d) => `<li><a href="#/documents/${d.id}">${esc(d.title || t('Untitled'))}</a></li>`).join('')}</ul>` : `<div class="small muted">${t('None yet.')}</div>`}</section></aside></div></div>`;
  main.onclick = async (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act; if (!a) return;
    try {
      if (a === 'back') history.length > 1 ? history.back() : go('#/projects');
      else if (a === 'edit') { const v = await promptDialog(t('Words that belong to it'), p.keywords.join(', '), { hint: t('Separated by commas.') }); if (v != null) { await api('PATCH', `/api/projects/${id}`, { keywords: v }); await page(main, id); } }
      else if (a === 'archive') { await api('PATCH', `/api/projects/${id}`, { archived: true }); done(t('Archived')); go('#/projects'); }
      else if (a === 'delete' && await confirmDialog(t('Delete this project? Your meetings and notes are not touched.'))) { await api('DELETE', `/api/projects/${id}`); go('#/projects'); }
    } catch (err) { fail(err); }
  };
}
