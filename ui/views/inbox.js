// Inbox: everything that wants a decision, in one list. What the AI found in a meeting is only a suggestion: it shows the exact words
// it rests on and where they were said, and nothing counts until you accept it. Also: promises that are overdue (yours, and others'
// to you), reminders that came due, and people who may be the same.
import { S, $, $$, api, t, esc, icon, fail, done, modal, empty, fmtDate, fmtClock, go } from '../lib.js';

const KIND = { decision: 'Possible decision', commitment: 'Possible promise' };
const day = (ms) => fmtDate(ms, { day: 'numeric', month: 'short' });
const link = (src) => (src?.noteId ? `<a class="quote-src" href="#/note/${src.noteId}?tab=transcript${src.segmentId ? `&seg=${src.segmentId}` : ''}">${esc(src.title || t('Untitled meeting'))}${src.startMs != null ? ` · ${fmtClock(src.startMs)}` : ''}</a>` : '');
const who = (c) => [c.owner && `<b>${esc(c.owner)}</b>`, c.to && `→ ${esc(c.to)}`, (c.dueAt || c.dueText) && `${icon('clock', 'sm')} ${c.dueAt ? day(c.dueAt) : ''}${c.dueText ? ` <span class="faint">“${esc(c.dueText)}”</span>` : ''}`].filter(Boolean).join(' · ');

const card = (c) => {
  if (c.type === 'suggestion') {
    return `<div class="card inbox-card ai" data-id="${c.id}" data-type="suggestion"><div class="xsmall muted"><span class="ai-mark">✦</span> ${t(KIND[c.kind])}</div>
      <div class="strong" style="margin:4px 0">${esc(c.text)}</div>
      ${who(c) ? `<div class="small muted">${who(c)}</div>` : ''}
      ${c.quote ? `<blockquote class="quote-block">“${esc(c.quote)}”<div class="xsmall muted">${c.speaker ? `${esc(c.speaker)} · ` : ''}${link(c.source)}</div></blockquote>` : ''}
      <div class="row" style="gap:8px;margin-top:10px"><button class="btn sm primary" data-do="accept">${t('Accept')}</button><button class="btn sm" data-do="edit">${t('Edit')}</button><button class="btn sm ghost" data-do="dismiss">${t('Dismiss')}</button></div></div>`;
  }
  if (c.type === 'overdue' || c.type === 'waiting') {
    return `<div class="card inbox-card" data-id="${c.id}" data-type="${c.type}"><div class="xsmall muted">${icon('clock', 'sm')} ${c.type === 'overdue' ? t('You promised, and it is late') : t('Waiting on someone, and it is late')}</div>
      <div class="strong" style="margin:4px 0">${esc(c.text)}</div><div class="small muted">${who(c)} · ${link(c.source)}</div>
      <div class="row" style="gap:8px;margin-top:10px"><button class="btn sm primary" data-do="done">${c.type === 'overdue' ? t('Done') : t('They did it')}</button><button class="btn sm" data-do="later">${t('Move the date')}</button></div></div>`;
  }
  if (c.type === 'reminder') {
    return `<div class="card inbox-card" data-id="${c.id}" data-type="reminder"><div class="xsmall muted">${icon('bell', 'sm')} ${t('Reminder')} · ${day(c.dueAt)}</div>
      <div class="strong" style="margin:4px 0">${esc(c.text)}</div>
      <div class="row" style="gap:8px;margin-top:10px"><button class="btn sm primary" data-do="rdone">${t('Done')}</button><button class="btn sm" data-do="snooze">${t('Tomorrow')}</button><button class="btn sm ghost" data-do="rdismiss">${t('Dismiss')}</button></div></div>`;
  }
  if (c.type === 'merge') {
    return `<div class="card inbox-card" data-type="merge"><div class="xsmall muted">${icon('users', 'sm')} ${t('Same person?')}</div>
      <div class="strong" style="margin:4px 0">${esc(c.a.name)} · ${esc(c.b.name)}</div><div class="small muted">${t('Decide on the People page; nothing is merged unless you say so.')}</div>
      <div class="row" style="margin-top:10px"><a class="btn sm" href="#/people">${t('Review')}</a></div></div>`;
  }
  return '';
};

export async function render(main) {
  const draw = async () => {
    const { counts, cards } = await api('GET', '/api/inbox');
    main.innerHTML = `<div class="page narrow">
      <div class="page-head"><div><h1>${t('Inbox')}</h1><div class="sub">${t('What needs a decision from you. The AI only suggests: each suggestion shows the words it rests on, and nothing counts until you accept it.')}</div></div></div>
      ${cards.length ? `<div class="stack">${cards.map(card).join('')}</div>` : `<div class="panel">${empty('inbox', t('All clear'), t('Nothing needs you. Decisions and promises found in your meetings appear here for you to accept.'))}</div>`}
      ${counts.total ? `<div class="xsmall muted mt-s">${t('Keys: A accept · D dismiss · E edit')}</div>` : ''}</div>`;
    window.dispatchEvent(new Event('wb:refresh'));
  };
  await draw();

  const act = async (el, what) => {
    const id = el.dataset.id, type = el.dataset.type;
    try {
      if (what === 'accept' || what === 'dismiss') await api('POST', `/api/assertions/${id}/${what}`);
      else if (what === 'done') await api('POST', `/api/assertions/${id}/done`);
      else if (what === 'rdone') await api('POST', `/api/reminders/${id}/done`);
      else if (what === 'rdismiss') await api('POST', `/api/reminders/${id}/dismiss`);
      else if (what === 'snooze') await api('POST', `/api/reminders/${id}/snooze`, { ms: 24 * 3600_000 });
      else if (what === 'later') { const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(18, 0, 0, 0); await api('PATCH', `/api/assertions/${id}`, { dueAt: d.getTime() }); done(t('Moved a week')); }
      else if (what === 'edit') { await editDialog(id, type); }
      await draw();
    } catch (e) { fail(e); }
  };
  main.onclick = (e) => { const b = e.target.closest('[data-do]'); if (b) act(b.closest('.inbox-card'), b.dataset.do); };
  const keys = (e) => {
    if (S.view.name !== 'inbox') { document.removeEventListener('keydown', keys); return; }
    if (e.target.closest('input,textarea,select,dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
    const first = $('.inbox-card[data-type="suggestion"]', main);
    if (!first) return;
    const k = e.key.toLowerCase();
    if (k === 'a') act(first, 'accept'); else if (k === 'd') act(first, 'dismiss'); else if (k === 'e') act(first, 'edit');
  };
  document.addEventListener('keydown', keys);
}

// Fix what the AI got wrong: the words and where they were said stay as they were
async function editDialog(id) {
  const a = (await api('GET', '/api/assertions?state=suggested,accepted&limit=500')).find((x) => x.id === id);
  if (!a) return;
  const date = a.dueAt ? new Date(a.dueAt).toISOString().slice(0, 10) : '';
  await modal({ title: t('Edit'), body: `<div class="stack"><div class="field"><label for="ed-text">${t('What')}</label><input id="ed-text" value="${esc(a.text)}"></div>
    ${a.kind === 'commitment' ? `<div class="formgrid"><div class="field"><label for="ed-owner">${t('Who')}</label><input id="ed-owner" value="${esc(a.owner.name)}"></div><div class="field"><label for="ed-to">${t('For')}</label><input id="ed-to" value="${esc(a.to.name)}"></div><div class="field"><label for="ed-due">${t('By')}</label><input id="ed-due" type="date" value="${date}"></div></div>` : ''}</div>`,
    foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" data-ok>${t('Save')}</button>`,
    onMount: (d, close) => { d.querySelector('[data-ok]').onclick = async () => {
      const patch = { text: d.querySelector('#ed-text').value };
      if (a.kind === 'commitment') { patch.owner = d.querySelector('#ed-owner').value.trim(); patch.to = d.querySelector('#ed-to').value.trim(); const v = d.querySelector('#ed-due').value; patch.dueAt = v ? new Date(`${v}T18:00:00`).getTime() : null; }
      try { await api('PATCH', `/api/assertions/${id}`, patch); close(true); } catch (e) { fail(e); }
    }; } });
}
