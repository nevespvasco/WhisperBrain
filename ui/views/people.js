// People: everyone who spoke in (or was invited to) your meetings — what they said, which topics they care
// about, how much they talk, and the action items they own.
import { $, api, t, esc, icon, go, debounce, empty, fmtDate, fmtClock, fmtDur, avatar, meetingRow, modal, fail, done } from '../lib.js';

// why two people are proposed for a merge, in words (the server sends a short code-like reason)
const REASON = {
  'the same voice under two names': 'The same voice was named differently in different meetings.',
  'same name, different e-mail': 'The same name, but with different e-mail addresses. Not merged on their own.',
  'same name, different people on record': 'The same name is on record for two different people.',
  'a first name that matches': 'One of them is just a first name that matches the other.',
};

export async function render(main, { name, parts }) {
  if (name === 'person' && parts[1]) return personPage(main, parts[1]);
  const [people, proposals] = await Promise.all([api('GET', '/api/people'), api('GET', '/api/people/proposals').catch(() => [])]);
  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>${t('People')}</h1><div class="sub">${t('Named speakers and meeting attendees. Name a speaker in a transcript to see who said what across meetings.')}</div></div></div>
    ${proposals.length ? `<div class="banner mb">${icon('users')}<div class="grow"><b>${proposals.length === 1 ? t('1 possible duplicate') : t('{n} possible duplicates', { n: proposals.length })}</b><div class="small muted">${t('The same person may appear under two names. Nothing is merged unless you say so.')}</div></div><button class="btn sm primary" data-act="review">${t('Review')}</button></div>` : ''}
    <div class="toolbar"><div class="search-in">${icon('search', 'sm')}<input id="p-q" type="search" placeholder="${t('Find a person or email…')}"></div><span class="small muted">${t('{n} people', { n: people.length })}</span></div>
    <div id="p-list"></div></div>`;
  let q = '';
  const draw = () => {
    const list = people.filter((p) => !q || p.name.toLowerCase().includes(q) || p.emails.some((e) => e.includes(q)));
    $('#p-list', main).innerHTML = list.length ? `<div class="cards">${list.map((p) => `<a class="card hover row" href="#/person/${encodeURIComponent(p.key)}">${avatar(p.name, { cls: 'lg' })}<div class="grow"><div class="strong ellipsis">${esc(p.name)}${p.isMe ? ` <span class="badge accent">${t('You')}</span>` : ''}</div><div class="xsmall muted ellipsis">${esc(p.emails[0] || '')}</div><div class="xsmall muted">${p.meetings} ${p.meetings === 1 ? t('meeting') : t('meetings')}${p.talkMs ? ` · ${fmtDur(p.talkMs)} ${t('talking')}` : ''}${p.lastAt ? ` · ${fmtDate(p.lastAt, { day: 'numeric', month: 'short' })}` : ''}</div></div></a>`).join('')}</div>`
      : `<div class="panel">${empty('users', people.length ? t('Nobody matches') : t('No people yet'), t('People appear when you name speakers in a transcript, or when meetings have attendees from your calendar.'))}</div>`;
  };
  draw();
  main.onclick = (e) => { if (e.target.closest('[data-act="review"]')) reviewProposals(proposals, () => go('#/people')); };
  $('#p-q', main).addEventListener('input', debounce((e) => { q = e.target.value.trim().toLowerCase(); draw(); }, 150));
}

async function personPage(main, key) {
  const p = await api('GET', `/api/people/${encodeURIComponent(key)}`);
  main.innerHTML = `<div class="page">
    <div class="note-top"><button class="btn ghost icon" data-act="back" aria-label="${t('Back')}">${icon('back')}</button>${avatar(p.name, { cls: 'xl' })}
      <div class="tt"><h1 style="font-size:26px">${esc(p.name)}${p.isMe ? ` <span class="badge accent">${t('You')}</span>` : ''}</h1><div class="note-meta">${p.emails.map((e) => `<span>${icon('mail', 'sm')}<a href="mailto:${esc(e)}">${esc(e)}</a></span>`).join('')}<span>${icon('video', 'sm')}${p.meetings} ${p.meetings === 1 ? t('meeting') : t('meetings')}</span>${p.talkMs ? `<span>${icon('mic', 'sm')}${fmtDur(p.talkMs)} ${t('talking')}</span>` : ''}</div></div>
      <div class="note-actions"><button class="btn" data-act="search">${icon('search', 'sm')} ${t('Search what they said')}</button><button class="btn" data-act="merge" title="${esc(t('They are the same person as someone else in the list'))}">${icon('merge', 'sm')} ${t('Merge with…')}</button></div></div>
    ${identitiesHtml(p)}
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
    if (b?.dataset.act === 'merge') mergeDialog(p);
    const u = e.target.closest('[data-unmerge]');
    if (u) undo(u.dataset.unmerge, p);
  };
}

// who this person is known as: names, e-mail addresses, saved voices; and who was merged into them (with the way back)
const identitiesHtml = (p) => {
  const ids = p.identities || [];
  const names = ids.filter((i) => i.kind === 'name').map((i) => i.value), voices = ids.filter((i) => i.kind === 'voice').length;
  const merged = p.merged || [];
  if (names.length < 2 && !voices && !merged.length) return '';
  return `<div class="panel mb small"><div class="row" style="gap:8px;flex-wrap:wrap;align-items:center"><span class="muted">${t('Also known as')}</span>${names.map((n) => `<span class="chip">${esc(n)}</span>`).join('')}${voices ? `<span class="chip">${icon('mic', 'sm')} ${voices === 1 ? t('a saved voice') : t('{n} saved voices', { n: voices })}</span>` : ''}</div>
    ${merged.map((m) => `<div class="row between" style="margin-top:8px"><span>${t('Merged in:')} <b>${esc(m.name)}</b></span><button class="btn xs" data-unmerge="${m.id}">${icon('back', 'sm')} ${t('Undo merge')}</button></div>`).join('')}</div>`;
};

async function undo(fromId, p) {
  try { await api('POST', `/api/entities/${fromId}/unmerge`); done(t('Merge undone')); go(`#/person/${encodeURIComponent(p.key)}`); window.dispatchEvent(new Event('hashchange')); } catch (e) { fail(e); }
}

// Choose who this person is the same as. The one in more meetings stays; the other can be split off again from the page.
async function mergeDialog(p) {
  const people = (await api('GET', '/api/people')).filter((x) => x.id !== p.id);
  if (!people.length) { done(t('There is nobody else to merge with.')); return; }
  const dlg = modal({ title: t('Merge {name} with…', { name: p.name }), body: `<p class="muted" style="margin:0 0 10px">${t('Pick the same person under another name. Their meetings and e-mail addresses join, and you can undo it from the person page.')}</p>
    <select id="mg-into" style="width:100%">${people.map((x) => `<option value="${x.id}">${esc(x.name)}${x.emails[0] ? ` · ${esc(x.emails[0])}` : ''} (${x.meetings})</option>`).join('')}</select>`,
    foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" data-ok>${t('Merge')}</button>`,
    onMount: (d, close) => { d.querySelector('[data-ok]').onclick = async () => { try { const into = d.querySelector('#mg-into').value; await api('POST', `/api/entities/${p.id}/merge`, { into }); close(true); done(t('Merged')); const to = people.find((x) => x.id === into); go(`#/person/${encodeURIComponent(to.key)}`); window.dispatchEvent(new Event('hashchange')); } catch (e) { fail(e); } }; } });
  return dlg;
}

// "Same person?" cards: merge, or say they are not (and never be asked again)
function reviewProposals(list, after) {
  const card = (pr) => `<div class="card" data-p="${pr.id}" style="margin-bottom:10px"><div class="row" style="gap:12px;align-items:center">${[pr.a, pr.b].map((x) => `<div class="grow" style="min-width:0"><div class="strong ellipsis">${esc(x.name)}</div><div class="xsmall muted ellipsis">${esc(x.emails[0] || t('no e-mail'))}</div><div class="xsmall muted">${x.meetings} ${x.meetings === 1 ? t('meeting') : t('meetings')}</div></div>`).join(`<span class="muted">${icon('merge')}</span>`)}</div>
    <div class="xsmall muted" style="margin:8px 0">${esc(t(REASON[pr.reason] || pr.reason))}</div>
    <div class="row" style="gap:8px"><button class="btn sm primary" data-decide="accept">${t('Same person')}</button><button class="btn sm" data-decide="reject">${t('Not the same')}</button></div></div>`;
  modal({ title: t('Possible duplicates'), wide: true, body: `<div id="pr-list">${list.map(card).join('')}</div>`, foot: `<button class="btn" data-close>${t('Close')}</button>`,
    onMount: (d, close) => {
      d.querySelector('#pr-list').onclick = async (e) => {
        const b = e.target.closest('[data-decide]'); if (!b) return;
        const el = b.closest('[data-p]');
        try { await api('POST', `/api/people/proposals/${el.dataset.p}/${b.dataset.decide}`); el.remove(); if (!d.querySelector('[data-p]')) { close(); after?.(); window.dispatchEvent(new Event('hashchange')); } } catch (err) { fail(err); }
      };
    } });
}
