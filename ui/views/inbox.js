// Inbox: everything that wants a decision, in one list. What the AI found in a meeting is only a suggestion: it shows the exact words
// it rests on and where they were said, and nothing counts until you accept it. Also: promises that are overdue (yours, and others'
// to you), reminders that came due, and people who may be the same.
import { S, $, $$, api, t, esc, icon, fail, done, modal, empty, fmtDate, fmtClock, go } from '../lib.js';
import { composeMail } from '../compose.js';

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
  if (c.type === 'action') {
    const a = c.args || {};
    // what exactly will happen: a message (to, subject, text), a change to many threads, or the plain text the other services take
    const shown = a.body !== undefined && a.to ? `To: ${(a.to || []).join(', ')}${a.cc?.length ? `\nCc: ${a.cc.join(', ')}` : ''}\nSubject: ${a.subject || ''}\n\n${a.body}`
      : a.threads ? `${a.add?.length ? `Add: ${a.add.join(', ')}${a.create ? ' (creates the label if it is missing)' : ''}\n` : ''}${a.remove?.length ? `Remove: ${a.remove.join(', ')}\n` : ''}\n${a.threads.slice(0, 30).map((x) => `• ${x.title}`).join('\n')}${a.threads.length > 30 ? `\n… ${a.threads.length - 30} more` : ''}`
      : `${a.title || ''}${a.description ? `\n\n${a.description}` : a.text ? `\n\n${a.text}` : a.payload ? `\n\n${JSON.stringify(a.payload, null, 2)}` : ''}`;
    const verbOk = c.kind === 'gmail.send' ? t('Approve and send') : c.kind === 'gmail.draft' ? t('Approve and save the draft') : t('Approve and do it');
    return `<div class="card inbox-card" data-id="${c.id}" data-type="action"><div class="xsmall muted">${icon('external', 'sm')} ${t('Waiting for your approval')} · ${t('nothing has been sent')}${c.expiresAt ? ` · ${t('expires {d}', { d: day(c.expiresAt) })}` : ''}</div>
      <div class="strong" style="margin:4px 0">${esc(c.title)}</div>
      ${(c.flags || []).length ? `<div class="banner ${c.needsSecondYes ? 'danger' : 'warn'} small" style="margin:6px 0" role="alert">${icon('alert')}<div class="grow">${c.flags.map((f) => `<div>${esc(f.text)}</div>`).join('')}</div></div>` : ''}
      <pre class="small" style="white-space:pre-wrap;margin:6px 0;padding:8px 10px;background:var(--sunken);border:1px solid var(--line);border-radius:10px">${esc(shown)}</pre>
      <div class="xsmall muted">${t('This is exactly what will be done.')}</div>
      ${c.needsSecondYes ? `<label class="row small" style="gap:8px;margin-top:8px"><input type="checkbox" data-second> ${t('I have read the warnings and still want this.')}</label>` : ''}
      <div class="row" style="gap:8px;margin-top:10px"><button class="btn sm primary" data-do="approve" ${c.needsSecondYes ? 'disabled' : ''}>${verbOk}</button><button class="btn sm ghost" data-do="reject-action">${t('Do not do it')}</button></div></div>`;
  }
  if (c.type === 'supersede') {
    return `<div class="card inbox-card" data-id="${esc(c.id)}" data-type="supersede"><div class="xsmall muted">${icon('merge', 'sm')} ${t('Does this replace an earlier decision?')}</div>
      <div class="small" style="margin:6px 0"><span class="muted">${day(c.older.at)}</span> <s>${esc(c.older.text)}</s></div><div class="small"><span class="muted">${day(c.newer.at)}</span> <b>${esc(c.newer.text)}</b></div>
      <div class="xsmall muted" style="margin-top:4px">${t('Words in common')}: ${esc(c.shared.join(', '))}</div>
      <div class="row" style="gap:8px;margin-top:10px"><button class="btn sm primary" data-do="sup-yes">${t('Yes, it replaces it')}</button><button class="btn sm ghost" data-do="sup-no">${t('Not related')}</button></div></div>`;
  }
  if (c.type === 'idle') {
    return `<div class="card inbox-card" data-id="${c.id}" data-type="idle"><div class="xsmall muted">${icon('layers', 'sm')} ${t('Quiet project')}</div>
      <div class="strong" style="margin:4px 0">${esc(c.name)}</div><div class="small muted">${t('Nothing new for {n} days, and {m} promises are still open.', { n: c.days, m: c.open })}</div>
      <div class="row" style="gap:8px;margin-top:10px"><a class="btn sm primary" href="#/project/${c.id}">${t('Open the project')}</a><button class="btn sm ghost" data-do="idle-no">${t('Not needed')}</button></div></div>`;
  }
  if (c.type === 'noreply') {
    return `<div class="card inbox-card" data-id="${c.id}" data-type="noreply"><div class="xsmall muted">${icon('mail', 'sm')} ${t('No reply yet')}</div>
      <div class="strong" style="margin:4px 0">${esc(c.title)}</div><div class="small muted">${t('You asked {who} {n} days ago and nobody has answered.', { who: esc((c.to || []).join(', ') || t('them')), n: c.days })}</div>
      <div class="row" style="gap:8px;margin-top:10px">${c.uri ? `<a class="btn sm primary" href="${esc(c.uri)}" target="_blank" rel="noopener noreferrer">${t('Open the thread')}</a>` : ''}<button class="btn sm" data-do="followup">${t('Draft a follow-up')}</button><button class="btn sm" data-do="remind">${t('Remind me tomorrow')}</button><button class="btn sm ghost" data-do="nodismiss">${t('Not needed')}</button></div></div>`;
  }
  if (c.type === 'access-review') {
    return `<div class="card inbox-card" data-id="${c.id}" data-type="access-review"><div class="xsmall muted">${icon('shield', 'sm')} ${t('Access to review')}</div>
      <div class="strong" style="margin:4px 0">${esc(c.name)}</div><div class="small muted">${t('Nobody has looked at what this may do for {n} days. Is it still what you want?', { n: c.days })}</div>
      <div class="row" style="gap:8px;margin-top:10px"><a class="btn sm primary" href="#/access">${t('Review it')}</a><button class="btn sm ghost" data-do="review-ok">${t('It is right')}</button></div></div>`;
  }
  if (c.type === 'merge') {
    return `<div class="card inbox-card" data-type="merge"><div class="xsmall muted">${icon('users', 'sm')} ${t('Same person?')}</div>
      <div class="strong" style="margin:4px 0">${esc(c.a.name)} · ${esc(c.b.name)}</div><div class="small muted">${t('Decide on the People page; nothing is merged unless you say so.')}</div>
      <div class="row" style="margin-top:10px"><a class="btn sm" href="#/people">${t('Review')}</a></div></div>`;
  }
  return '';
};

export async function render(main, { alive = () => true, signal = S.route.signal } = {}) {
  const draw = async () => {
    const { counts, cards } = await api('GET', '/api/inbox');
    if (!alive()) return;   // the user moved on meanwhile (app.js route())
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
      else if (what === 'approve') {
        const confirmRisky = !!el.querySelector('[data-second]')?.checked;
        const r = await api('POST', `/api/outbound/${id}/approve`, { confirmRisky });
        if (r.state === 'done') done(`${t('Done')}${r.result?.identifier ? `: ${r.result.identifier}` : ''}`); else fail(new Error(r.error || t('It could not be done.')));
      }
      else if (what === 'review-ok') await api('POST', `/api/inbox/access-review/${id}/dismiss`);
      else if (what === 'followup') { await composeMail({ itemId: id, title: t('Follow up'), body: '' }); }
      else if (what === 'reject-action') await api('POST', `/api/outbound/${id}/reject`);
      else if (what === 'sup-yes' || what === 'sup-no') { const [o, n] = id.split(':'); await api('POST', `/api/inbox/supersede/${o}/${n}/${what === 'sup-yes' ? 'confirm' : 'reject'}`); }
      else if (what === 'idle-no') await api('POST', `/api/inbox/idle/${id}/dismiss`);
      else if (what === 'nodismiss') await api('POST', `/api/inbox/noreply/${id}/dismiss`);
      else if (what === 'remind') { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); await api('POST', '/api/reminders', { text: `${t('Follow up')}: ${el.querySelector('.strong')?.textContent || ''}`, dueAt: d.getTime() }); await api('POST', `/api/inbox/noreply/${id}/dismiss`); done(t('I will remind you tomorrow morning')); }
      await draw();
    } catch (e) { fail(e); }
  };
  main.onclick = (e) => { const b = e.target.closest('[data-do]'); if (b) act(b.closest('.inbox-card'), b.dataset.do); };
  main.onchange = (e) => { if (e.target.matches('[data-second]')) { const card = e.target.closest('.inbox-card'); card.querySelector('[data-do="approve"]').disabled = !e.target.checked; } };
  const keys = (e) => {
    if (S.view.name !== 'inbox') { document.removeEventListener('keydown', keys); return; }
    if (e.target.closest('input,textarea,select,dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
    const first = $('.inbox-card[data-type="suggestion"]', main);
    if (!first) return;
    const k = e.key.toLowerCase();
    if (k === 'a') act(first, 'accept'); else if (k === 'd') act(first, 'dismiss'); else if (k === 'e') act(first, 'edit');
  };
  document.addEventListener('keydown', keys, { signal });   // gone with the page: opening the Inbox again used to add a second one (A accepted twice)
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
