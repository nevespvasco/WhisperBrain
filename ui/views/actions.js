// Every action item across meetings: filter by status/owner, group by owner or meeting, send to Linear.
import { S, $, $$, api, t, esc, icon, fail, done, toast, debounce, groupBy, empty, avatar, menu, fmtDate } from '../lib.js';
import { offerUndo } from '../task-chips.js';

let st = { status: 'open', group: 'meeting', q: '' };

export async function render(main) {
  main.innerHTML = `<div class="page narrow">
    <div class="page-head"><div><h1>${t('Action items')}</h1><div class="sub">${t('Found in your meetings automatically — tick them off, assign owners, push them to Linear.')}</div></div></div>
    <div class="toolbar">
      <div class="search-in">${icon('search', 'sm')}<input id="a-q" type="search" placeholder="${t('Filter tasks or owners…')}" value="${esc(st.q)}"></div>
      <div class="seg-ctl" role="tablist">${[['open', t('Open')], ['done', t('Done')], ['all', t('All')]].map(([v, l]) => `<button type="button" role="tab" data-st="${v}" aria-selected="${st.status === v}">${l}</button>`).join('')}</div>
      <button class="btn sm" data-act="group">${icon('layers', 'sm')} ${st.group === 'owner' ? t('By owner') : st.group === 'due' ? t('By due date') : t('By meeting')}</button>
    </div><div id="a-list"></div></div>`;
  let rows = [];
  const load = async () => {
    const p = new URLSearchParams({ limit: '1000' });
    if (st.status !== 'all') p.set('done', st.status === 'done' ? '1' : '0');
    rows = await api('GET', `/api/actions?${p}`);
    draw();
  };
  const draw = () => {
    const q = st.q.toLowerCase();
    const list = rows.filter((a) => !q || a.text.toLowerCase().includes(q) || a.owner.toLowerCase().includes(q));
    const box = $('#a-list', main);
    if (!list.length) { box.innerHTML = `<div class="panel">${empty('checksq', st.status === 'open' ? t('All caught up') : t('No action items'), t('Action items are extracted when a meeting is enhanced or analysed.'))}</div>`; return; }
    const key = st.group === 'owner' ? (a) => a.owner || t('Unassigned') : st.group === 'due' ? (a) => (a.due ? (a.due < new Date().toISOString().slice(0, 10) && !a.done ? t('Overdue') : a.due) : t('No due date')) : (a) => a.noteId;
    box.innerHTML = groupBy(list, key).map((g) => {
      const head = st.group === 'meeting' ? `<a href="#/note/${g.key}">${esc(g.items[0].noteTitle || t('Untitled meeting'))}</a> <span class="faint">· ${fmtDate(g.items[0].noteAt, { day: 'numeric', month: 'short', year: 'numeric' })}</span>` : st.group === 'owner' ? `${avatar(g.key, { cls: 'sm' })} ${esc(g.key)}` : esc(g.key);
      const linearable = g.items.some((a) => !a.done && !a.extUrl) && S.integrations?.linear?.configured && st.group === 'meeting';
      return `<div class="datagroup"><h4 class="row between"><span class="row" style="gap:8px">${head} <span class="faint">${g.items.length}</span></span>${linearable ? `<button class="btn xs ghost" data-linear="${g.key}">${icon('checksq', 'sm')} ${t('Send open items to Linear')}</button>` : ''}</h4>
        <div class="list">${g.items.map((a) => `<div class="li act-row ${a.done ? 'done' : ''}" data-aid="${a.id}" style="border-top:1px solid var(--line)"><input type="checkbox" class="cbx" ${a.done ? 'checked' : ''} aria-label="${t('Done')}">
          <div class="main-t"><div class="t" style="white-space:normal">${esc(a.text)}</div><div class="s">${[`${icon('user', 'sm')} ${a.owner ? esc(a.owner) : `<span class="faint">${t('Unassigned')}</span>`}`, a.due ? `${icon('calendar', 'sm')} ${esc(a.due)}` : '', st.group !== 'meeting' ? `<a href="#/note/${a.noteId}">${esc(a.noteTitle || t('Untitled meeting'))}</a>` : ''].filter(Boolean).join(' · ')}</div></div>
          <div class="side">${a.extUrl ? `<a class="badge accent" href="${esc(a.extUrl)}" target="_blank" rel="noopener noreferrer">${esc(a.extId || 'Linear')}</a>` : ''}<button class="btn ghost icon xs" data-del="${a.id}" aria-label="${t('Delete')}">${icon('trash', 'sm')}</button></div></div>`).join('')}</div></div>`;
    }).join('');
  };
  main.onclick = async (e) => {
    const s = e.target.closest('[data-st]');
    if (s) { st.status = s.dataset.st; $$('[data-st]', main).forEach((b) => b.setAttribute('aria-selected', String(b === s))); return load().catch(fail); }
    const g = e.target.closest('[data-act="group"]');
    if (g) return menu(g, [['meeting', t('By meeting')], ['owner', t('By owner')], ['due', t('By due date')]].map(([v, l]) => ({ label: l, selected: st.group === v, run: () => { st.group = v; render(main); } })));
    const del = e.target.closest('[data-del]');
    if (del) { try { const gone = rows.find((a) => a.id === del.dataset.del); await api('DELETE', `/api/actions/${del.dataset.del}`); rows = rows.filter((a) => a.id !== del.dataset.del); draw(); window.dispatchEvent(new Event('wb:refresh')); offerUndo(gone, () => load()); } catch (err) { fail(err); } return; }
    const lin = e.target.closest('[data-linear]');
    if (lin) { lin.disabled = true; try { const r = await api('POST', `/api/notes/${lin.dataset.linear}/send`, { target: 'linear', mode: 'actions' }); toast(t('{n} Linear issues created', { n: r.issues.length }), { ok: true }); load(); } catch (err) { fail(err); lin.disabled = false; } }
  };
  main.onchange = async (e) => {
    if (!e.target.matches('.cbx')) return;
    const row = e.target.closest('[data-aid]');
    try { await api('PATCH', `/api/actions/${row.dataset.aid}`, { done: e.target.checked }); row.classList.toggle('done', e.target.checked); const a = rows.find((x) => x.id === row.dataset.aid); if (a) a.done = e.target.checked; window.dispatchEvent(new Event('wb:refresh')); if (e.target.checked) done(t('Nice — done')); } catch (err) { fail(err); }
  };
  $('#a-q', main).addEventListener('input', debounce((e) => { st.q = e.target.value.trim(); draw(); }, 150));
  if (!S.integrations) S.integrations = await api('GET', '/api/integrations').catch(() => null);
  await load();
}
