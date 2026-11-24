// People: everyone who spoke in (or was invited to) your meetings — what they said, which topics they care
// about, how much they talk, and the action items they own.
import { $, api, t, esc, icon, go, debounce, empty, fmtDate, fmtClock, fmtDur, avatar, meetingRow } from '../lib.js';

export async function render(main, { name, parts }) {
  if (name === 'person' && parts[1]) return personPage(main, parts[1]);
  const people = await api('GET', '/api/people');
  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>${t('People')}</h1><div class="sub">${t('Named speakers and meeting attendees. Name a speaker in a transcript to see who said what across meetings.')}</div></div></div>
    <div class="toolbar"><div class="search-in">${icon('search', 'sm')}<input id="p-q" type="search" placeholder="${t('Find a person or email…')}"></div><span class="small muted">${t('{n} people', { n: people.length })}</span></div>
    <div id="p-list"></div></div>`;
  let q = '';
  const draw = () => {
    const list = people.filter((p) => !q || p.name.toLowerCase().includes(q) || p.emails.some((e) => e.includes(q)));
    $('#p-list', main).innerHTML = list.length ? `<div class="cards">${list.map((p) => `<a class="card hover row" href="#/person/${encodeURIComponent(p.key)}">${avatar(p.name, { cls: 'lg' })}<div class="grow"><div class="strong ellipsis">${esc(p.name)}${p.isMe ? ` <span class="badge accent">${t('You')}</span>` : ''}</div><div class="xsmall muted ellipsis">${esc(p.emails[0] || '')}</div><div class="xsmall muted">${p.meetings} ${p.meetings === 1 ? t('meeting') : t('meetings')}${p.talkMs ? ` · ${fmtDur(p.talkMs)} ${t('talking')}` : ''}${p.lastAt ? ` · ${fmtDate(p.lastAt, { day: 'numeric', month: 'short' })}` : ''}</div></div></a>`).join('')}</div>`
      : `<div class="panel">${empty('users', people.length ? t('Nobody matches') : t('No people yet'), t('People appear when you name speakers in a transcript, or when meetings have attendees from your calendar.'))}</div>`;
  };
  draw();
  $('#p-q', main).addEventListener('input', debounce((e) => { q = e.target.value.trim().toLowerCase(); draw(); }, 150));
}

async function personPage(main, key) {
  const p = await api('GET', `/api/people/${encodeURIComponent(key)}`);
  main.innerHTML = `<div class="page">
    <div class="note-top"><button class="btn ghost icon" data-act="back" aria-label="${t('Back')}">${icon('back')}</button>${avatar(p.name, { cls: 'xl' })}
      <div class="tt"><h1 style="font-size:26px">${esc(p.name)}${p.isMe ? ` <span class="badge accent">${t('You')}</span>` : ''}</h1><div class="note-meta">${p.emails.map((e) => `<span>${icon('mail', 'sm')}<a href="mailto:${esc(e)}">${esc(e)}</a></span>`).join('')}<span>${icon('video', 'sm')}${p.meetings} ${p.meetings === 1 ? t('meeting') : t('meetings')}</span>${p.talkMs ? `<span>${icon('mic', 'sm')}${fmtDur(p.talkMs)} ${t('talking')}</span>` : ''}</div></div>
      <div class="note-actions"><button class="btn" data-act="search">${icon('search', 'sm')} ${t('Search what they said')}</button></div></div>
    <div class="note-grid"><div class="stack loose">
      <section class="panel"><div class="panel-head"><h3>${icon('quote')} ${t('What they said')}</h3></div>${p.quotes.length ? `<div class="stack tight">${p.quotes.map((q) => `<a class="quote" href="#/note/${q.noteId}?tab=transcript&seg=${q.segmentId}"><div class="q">“${esc(q.text)}”</div><div class="src">${esc(q.noteTitle || t('Untitled meeting'))} · ${fmtDate(q.at, { day: 'numeric', month: 'short' })} ${fmtClock(q.startMs)}</div></a>`).join('')}</div>` : `<div class="small muted">${t('No named transcript lines yet.')}</div>`}</section>
      <section class="panel"><div class="panel-head"><h3>${icon('video')} ${t('Meetings')}</h3></div>${p.notes.length ? `<div class="list">${p.notes.map((n) => meetingRow(n)).join('')}</div>` : `<div class="small muted">—</div>`}</section></div>
      <aside class="note-aside">
        <section class="panel"><div class="panel-head"><h3>${icon('network')} ${t('Topics')}</h3></div>${p.topics.length ? `<div class="chips">${p.topics.map((x) => `<a class="chip" href="#/topic/${x.id}">${esc(x.name)} <span class="faint">${x.count}</span></a>`).join('')}</div>` : `<div class="small muted">${t('None yet.')}</div>`}</section>
        <section class="panel"><div class="panel-head"><h3>${icon('checksq')} ${t('Action items')}</h3></div>${p.actions.length ? `<div class="stack tight">${p.actions.slice(0, 15).map((a) => `<a class="quote" href="#/note/${a.noteId}?tab=summary"><div class="q small">${a.done ? '✓ ' : ''}${esc(a.text)}</div><div class="src">${esc(a.noteTitle || '')}${a.due ? ` · ${esc(a.due)}` : ''}</div></a>`).join('')}</div>` : `<div class="small muted">${t('None assigned.')}</div>`}</section>
      </aside></div></div>`;
  main.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (b?.dataset.act === 'back') history.length > 1 ? history.back() : go('#/people');
    if (b?.dataset.act === 'search') window.wb.openPalette(p.name);
  };
}
