// Promises: what you owe, what others owe you, and what was decided: only what a person accepted. Each line opens the words it came from.
import { S, api, t, esc, icon, fail, done, empty, fmtDate, fmtClock, menu, pickFrom } from '../lib.js';
import { todayIso, dueChip, ownerChip, dueClick, setDue } from '../task-chips.js';

let tab = 'mine';
const day = (ms) => fmtDate(ms, { day: 'numeric', month: 'short' });
const src = (a) => (!a.noteId ? t('added by you') : `<a class="quote-src" href="#/note/${a.noteId}?tab=transcript${a.segmentId ? `&seg=${a.segmentId}` : ''}" title="${esc(a.quote || '')}">${icon('quote', 'sm')} ${a.startMs != null ? fmtClock(a.startMs) : t('meeting')}</a>`);

export async function render(main) {
  const draw = async () => {
    const [open, decisions, finished, acts] = await Promise.all([api('GET', '/api/commitments'), api('GET', '/api/assertions?state=accepted,superseded&kind=decision&limit=100'), api('GET', '/api/assertions?state=done&kind=commitment&limit=50'), api('GET', '/api/outbound').catch(() => ({ kinds: [] }))]);
    const ready = acts.kinds.filter((k) => k.ready);
    const lists = { mine: open.mine, theirs: open.theirs, decisions, finished };
    const rows = lists[tab] || [];
    const row = (a) => `<div class="row promise ${a.state === 'done' ? 'done' : ''}" data-id="${a.id}" style="gap:12px;align-items:flex-start;padding:10px 4px;border-top:1px solid var(--line)">
      ${a.kind === 'commitment' && a.state !== 'done' ? `<input type="checkbox" class="cbx" data-done aria-label="${t('Done')}">` : `<span style="width:18px;color:var(--ok)">${a.state === 'done' ? icon('check', 'sm') : icon('layers', 'sm')}</span>`}
      <div class="grow"><div class="${a.state === 'superseded' ? 'muted' : ''}" style="${a.state === 'superseded' ? 'text-decoration:line-through' : ''}">${esc(a.text)}</div>
        <div class="xsmall muted">${[a.owner.name && esc(a.owner.name), a.to.name && `→ ${esc(a.to.name)}`, a.dueAt && `${icon('clock', 'sm')} ${day(a.dueAt)}${a.dueAt < Date.now() && a.state === 'accepted' ? ` <span style="color:var(--danger)">${t('late')}</span>` : ''}`, a.state === 'superseded' && t('replaced by a later decision'), a.origin === 'ai' && `<span class="ai-mark">✦</span> ${t('found by AI, accepted by you')}`].filter(Boolean).join(' · ')} · ${src(a)}</div></div>${ready.length && a.kind === 'commitment' && a.state === 'accepted' ? `<button class="btn xs ghost" data-send="${a.id}" data-kinds="${esc(ready.map((k) => `${k.kind}|${k.label}`).join(','))}" title="${esc(t('Proposes it. Nothing is sent until you approve it in the Inbox.'))}">${icon('external', 'sm')} ${t('Send to…')}</button>` : ''}</div>`;
    main.innerHTML = `<div class="page narrow">
      <div class="page-head"><div><h1>${t('Promises')}</h1><div class="sub">${t('What you owe, what others owe you, and what was decided. Only what you accepted is here.')}</div></div></div>
      <div class="seg-ctl mb" role="tablist">${[['mine', t('I owe'), open.mine.length], ['theirs', t('Owed to me'), open.theirs.length], ['decisions', t('Decisions'), decisions.length], ['finished', t('Done'), finished.length]].map(([k, l, n]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${tab === k}">${l}${n ? ` <span class="faint">${n}</span>` : ''}</button>`).join('')}</div>
      <section class="panel">${rows.length ? rows.map(row).join('') : empty('check', t('Nothing here'), tab === 'decisions' ? t('Decisions you accept from the Inbox are listed here.') : t('Promises you accept from the Inbox appear here.'))}</section>
      <section class="panel mt"><div class="panel-head"><h3>${icon('plus')} ${t('Add one yourself')}</h3></div>
        <form class="act-add" id="pm-add">
          <input id="pm-text" autocomplete="off" placeholder="${t('Send the contract to Rui')}" aria-label="${t('What')}">
          <div class="act-add-bar">${ownerChip('pm-owner', owner)}${dueChip('pm-due', due)}<span class="spacer"></span>
            <button class="btn sm primary" data-add disabled>${icon('plus', 'sm')} ${t('Add')}</button></div>
        </form></section></div>`;
  };
  // who and when stay chosen between redraws and for the next promise, like a meeting's action items
  let owner = S.settings.userName || '', due = '';
  await draw();
  main.oninput = (e) => { if (e.target.id === 'pm-text') main.querySelector('[data-add]').disabled = !e.target.value.trim(); };
  main.onsubmit = (e) => { if (e.target.id === 'pm-add') { e.preventDefault(); main.querySelector('[data-add]').click(); } };
  main.onclick = async (e) => {
    const tb = e.target.closest('[data-tab]'); if (tb) { tab = tb.dataset.tab; return draw(); }
    const dc = e.target.closest('.act-due'); if (dc) { dueClick(e, dc); return; }
    const oc = e.target.closest('[data-act="pm-owner"]');
    if (oc) {
      const people = await api('GET', '/api/people').catch(() => []);
      const me = S.settings.userName || '';
      const seen = new Set(me ? [me.toLowerCase()] : []);
      const items = [{ value: '', label: t('Unassigned') }, ...(me ? [{ value: me, label: me, hint: t('Me'), avatar: me }] : []),
        ...(Array.isArray(people) ? people : people.people || []).map((p) => String(p.name || '').trim()).filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase())).map((n) => ({ value: n, label: n, avatar: n }))];
      const v = await pickFrom(oc, items, { current: owner, placeholder: t('Search people or type a name…'), custom: t('Assign to “{name}”'), search: true, width: 280 });
      if (v != null) { owner = v.trim(); oc.outerHTML = ownerChip('pm-owner', owner); }
      return;
    }
    const lb = e.target.closest('[data-send]');
    if (lb) {
      const propose = async (kind) => { try { await api('POST', '/api/outbound', { kind, assertionId: lb.dataset.send }); done(t('Proposed. Approve it in the Inbox to send it.')); window.dispatchEvent(new Event('wb:refresh')); } catch (err) { fail(err); } };
      menu(lb, lb.dataset.kinds.split(',').map((x) => { const [kind, label] = x.split('|'); return { label: ({ 'linear.issue': t('A Linear issue'), 'webhook.post': t('A webhook'), 'obsidian.note': t('A note in Obsidian') })[kind] || label, run: () => propose(kind) }; }));
      return;
    }
    if (e.target.closest('[data-add]')) {
      const input = main.querySelector('#pm-text'), text = input.value.trim();
      if (!text) { input.focus(); return; }
      // the date chip gives a day; it is due by the end of that day
      try { await api('POST', '/api/assertions', { kind: 'commitment', text, owner, dueText: due, dueAt: due ? new Date(`${due}T23:59:59`).getTime() : null }); done(t('Added')); await draw(); window.dispatchEvent(new Event('wb:refresh')); } catch (err) { fail(err); }
    }
  };
  main.onchange = async (e) => {
    if (e.target.id === 'pm-due') { due = e.target.value && e.target.value >= todayIso() ? e.target.value : ''; setDue(e.target); return; }
    if (!e.target.matches('[data-done]')) return;
    try { await api('POST', `/api/assertions/${e.target.closest('.promise').dataset.id}/done`); await draw(); window.dispatchEvent(new Event('wb:refresh')); } catch (err) { fail(err); }
  };
}
