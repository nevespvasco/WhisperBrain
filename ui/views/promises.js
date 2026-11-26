// Promises: what you owe, what others owe you, and what was decided: only what a person accepted. Each line opens the words it came from.
import { S, api, t, esc, icon, fail, done, empty, fmtDate, fmtClock, menu } from '../lib.js';

let tab = 'mine';
const day = (ms) => fmtDate(ms, { day: 'numeric', month: 'short' });
const src = (a) => `<a class="quote-src" href="#/note/${a.noteId}?tab=transcript${a.segmentId ? `&seg=${a.segmentId}` : ''}" title="${esc(a.quote || '')}">${icon('quote', 'sm')} ${a.startMs != null ? fmtClock(a.startMs) : t('meeting')}</a>`;

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
        <div class="formgrid"><div class="field"><label for="pm-text">${t('What')}</label><input id="pm-text" placeholder="${t('Send the contract to Rui')}"></div><div class="field"><label for="pm-owner">${t('Who')}</label><input id="pm-owner" value="${esc(S.settings.userName || '')}"></div>
        <div class="field"><label for="pm-due">${t('By')} <span class="faint">(${t('optional')})</span></label><input id="pm-due" placeholder="${t('Friday, tomorrow, 2026-12-04…')}"></div></div>
        <div class="row"><button class="btn primary" data-add>${t('Add')}</button></div></section></div>`;
  };
  await draw();
  main.onclick = async (e) => {
    const tb = e.target.closest('[data-tab]'); if (tb) { tab = tb.dataset.tab; return draw(); }
    const lb = e.target.closest('[data-send]');
    if (lb) {
      const propose = async (kind) => { try { await api('POST', '/api/outbound', { kind, assertionId: lb.dataset.send }); done(t('Proposed. Approve it in the Inbox to send it.')); window.dispatchEvent(new Event('wb:refresh')); } catch (err) { fail(err); } };
      menu(lb, lb.dataset.kinds.split(',').map((x) => { const [kind, label] = x.split('|'); return { label: ({ 'linear.issue': t('A Linear issue'), 'webhook.post': t('A webhook'), 'obsidian.note': t('A note in Obsidian') })[kind] || label, run: () => propose(kind) }; }));
      return;
    }
    if (e.target.closest('[data-add]')) {
      const text = main.querySelector('#pm-text').value.trim(); if (!text) return;
      try { await api('POST', '/api/assertions', { kind: 'commitment', text, owner: main.querySelector('#pm-owner').value.trim(), dueText: main.querySelector('#pm-due').value.trim() }); done(t('Added')); await draw(); window.dispatchEvent(new Event('wb:refresh')); } catch (err) { fail(err); }
    }
  };
  main.onchange = async (e) => {
    if (!e.target.matches('[data-done]')) return;
    try { await api('POST', `/api/assertions/${e.target.closest('.promise').dataset.id}/done`); await draw(); window.dispatchEvent(new Event('wb:refresh')); } catch (err) { fail(err); }
  };
}
