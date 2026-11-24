// All meetings with filters (source, tag, space, internal/external), sort, card/list views and bulk actions.
import { S, $, $$, api, t, esc, icon, fail, go, meetingCard, meetingRow, dateGroup, groupBy, debounce, menu, promptDialog, confirmDialog, done, empty, SOURCES, avatarStack, fmtDur, fmtHour, srcIcon } from '../lib.js';
import { openImport, openExport } from './transfer.js';

let viewMode = localStorage.getItem('wb.meetings.view') || 'grid';

export async function render(main, { params }) {
  const f = { q: params.get('q') || '', source: params.get('source') || '', tag: params.get('tag') || '', space: params.get('space') || '', external: params.get('external') || '', sort: params.get('sort') || 'newest' };
  const space = S.spaces.find((s) => s.id === f.space), tag = S.tags.find((x) => x.id === f.tag);
  const title = space ? space.name : tag ? `#${tag.name}` : f.external === '1' ? t('External meetings') : f.source === 'imported' ? t('From outside') : f.source === 'local' ? t('Recorded here') : f.source ? t(SOURCES[f.source]?.label || f.source) : t('Meetings');
  const sub = space ? t('Space') : tag ? t('Tag') : f.external === '1' ? t('Meetings with people outside your organisation') : f.source === 'imported' ? t('Imported files, Notion pages, Obsidian notes and Linear issues — kept apart from your own recordings') : t('Everything you recorded or imported');
  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>${tag ? `<span class="tagdot" style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${tag.color};margin-right:8px"></span>${esc(tag.name)}` : esc(title)}</h1><div class="sub">${esc(sub)}</div></div>
      <div class="actions">${space ? `<button class="btn" data-act="space-menu">${icon('more')}</button>` : ''}<button class="btn" data-act="export-all">${icon('download', 'sm')} ${t('Export')}</button><button class="btn" data-act="import">${icon('upload', 'sm')} ${t('Import')}</button></div></div>
    <div class="toolbar">
      <div class="search-in">${icon('search', 'sm')}<input id="m-q" type="search" placeholder="${t('Filter meetings…')}" value="${esc(f.q)}"></div>
      <div class="seg-ctl" role="tablist" aria-label="${t('Source')}">${[['', t('All')], ['local', t('Recorded here')], ['imported', t('From outside')]].map(([v, l]) => `<button type="button" role="tab" data-src="${v}" aria-selected="${(f.source === v) || (v === 'imported' && !['', 'local', 'imported'].includes(f.source))}">${l}</button>`).join('')}</div>
      <button class="btn sm" data-act="more-filters">${icon('filter', 'sm')} ${t('Filters')}${[f.tag, f.space, f.external, !['', 'local', 'imported'].includes(f.source) ? f.source : ''].filter(Boolean).length ? ` <span class="badge accent">${[f.tag, f.space, f.external, !['', 'local', 'imported'].includes(f.source) ? f.source : ''].filter(Boolean).length}</span>` : ''}</button>
      <button class="btn sm" data-act="sort">${icon('sort', 'sm')} ${{ newest: t('Newest'), oldest: t('Oldest'), title: t('Title') }[f.sort]}</button>
      <span class="grow"></span>
      <button class="btn sm ghost" data-act="select">${icon('checksq', 'sm')} ${t('Select')}</button>
      <div class="seg-ctl" role="tablist" aria-label="${t('View')}"><button type="button" role="tab" data-viewm="grid" aria-selected="${viewMode === 'grid'}" title="${t('Cards')}" aria-label="${t('Cards')}">${icon('layers', 'sm')}</button><button type="button" role="tab" data-viewm="list" aria-selected="${viewMode === 'list'}" title="${t('List')}" aria-label="${t('List')}">${icon('list', 'sm')}</button></div>
    </div>
    <div id="bulk" class="banner mb" hidden></div>
    <div id="m-list"><div class="cards">${'<div class="card"><div class="skel" style="width:70%"></div><div class="skel mt-s"></div><div class="skel mt-s" style="width:40%"></div></div>'.repeat(3)}</div></div></div>`;

  const setParam = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); go(`#/meetings${p.toString() ? '?' + p : ''}`); };
  let rows = [];
  const selected = new Set();
  let selecting = false;
  const load = async () => {
    const q = new URLSearchParams();
    for (const k of ['q', 'source', 'tag', 'space', 'external', 'sort']) if (f[k]) q.set(k, f[k]);
    rows = await api('GET', `/api/meetings?${q}`);
    draw();
  };
  const draw = () => {
    const box = $('#m-list', main);
    if (!rows.length) {
      box.innerHTML = `<div class="panel">${empty(f.source === 'imported' ? 'inbox' : 'video', f.q ? t('No meetings match') : t('Nothing here yet'), f.source === 'imported' ? t('Import audio, transcripts, documents, Notion pages, Obsidian notes or Linear issues.') : t('Record a meeting or import one to get started.'), `<button class="btn primary" data-act="import">${icon('upload', 'sm')} ${t('Import')}</button>`)}</div>`;
      return;
    }
    const groups = f.sort === 'title' ? [{ key: '', items: rows }] : groupBy(rows.filter((r) => !r.pinned || f.sort !== 'newest'), (r) => dateGroup(r.createdAt));
    const pinned = f.sort === 'newest' ? rows.filter((r) => r.pinned) : [];
    if (pinned.length) groups.unshift({ key: t('Pinned'), items: pinned });
    const card = (n) => (selecting ? `<div class="sel-wrap" style="position:relative"><input type="checkbox" class="cbx" data-sel="${n.id}" ${selected.has(n.id) ? 'checked' : ''} style="position:absolute;top:12px;left:12px;z-index:2" aria-label="${t('Select')}">${(viewMode === 'grid' ? meetingCard(n) : meetingRow(n, { snippet: n.snippet })).replace('<a ', '<a style="padding-left:40px" ')}</div>` : viewMode === 'grid' ? meetingCard(n) : meetingRow(n, { snippet: n.snippet }));
    box.innerHTML = groups.map((g) => `<div class="datagroup">${g.key ? `<h4>${esc(g.key)} <span class="faint">· ${g.items.length}</span></h4>` : ''}${viewMode === 'grid' ? `<div class="cards">${g.items.map(card).join('')}</div>` : `<div class="list">${g.items.map(card).join('')}</div>`}</div>`).join('');
  };
  const bulkBar = () => {
    const b = $('#bulk', main);
    b.hidden = !selecting;
    if (!selecting) return;
    b.innerHTML = `${icon('checksq')}<div class="grow"><b>${t('{n} selected', { n: selected.size })}</b> <button class="linkish small muted" data-act="sel-all">${t('Select all')}</button></div>
      <button class="btn sm" data-act="b-export" ${selected.size ? '' : 'disabled'}>${icon('share', 'sm')} ${t('Export')}</button>
      <button class="btn sm" data-act="b-tag" ${selected.size ? '' : 'disabled'}>${icon('tag', 'sm')} ${t('Tag')}</button>
      <button class="btn sm" data-act="b-space" ${selected.size ? '' : 'disabled'}>${icon('folder', 'sm')} ${t('Move')}</button>
      <button class="btn sm danger-outline" data-act="b-delete" ${selected.size ? '' : 'disabled'}>${icon('trash', 'sm')} ${t('Delete')}</button>
      <button class="btn sm ghost" data-act="select">${t('Done')}</button>`;
  };

  main.onclick = async (e) => {
    const sel = e.target.closest('[data-sel]');
    if (sel) { e.stopPropagation(); if (sel.checked) selected.add(sel.dataset.sel); else selected.delete(sel.dataset.sel); bulkBar(); return; }
    if (selecting && e.target.closest('.sel-wrap a')) { e.preventDefault(); const cb = e.target.closest('.sel-wrap').querySelector('.cbx'); cb.checked = !cb.checked; if (cb.checked) selected.add(cb.dataset.sel); else selected.delete(cb.dataset.sel); bulkBar(); return; }
    const src = e.target.closest('[data-src]');
    if (src) return setParam('source', src.dataset.src);
    const vm = e.target.closest('[data-viewm]');
    if (vm) { viewMode = vm.dataset.viewm; localStorage.setItem('wb.meetings.view', viewMode); $$('[data-viewm]', main).forEach((b) => b.setAttribute('aria-selected', String(b === vm))); draw(); return; }
    const btn = e.target.closest('[data-act]');
    const a = btn?.dataset.act;
    if (!a) return;
    try {
      if (a === 'import') openImport({ space: f.space });
      else if (a === 'export-all') openExport(rows.map((r) => r.id));
      else if (a === 'select') { selecting = !selecting; selected.clear(); bulkBar(); draw(); }
      else if (a === 'sel-all') { rows.forEach((r) => selected.add(r.id)); bulkBar(); draw(); }
      else if (a === 'sort') menu(btn, [['newest', t('Newest first')], ['oldest', t('Oldest first')], ['title', t('Title A–Z')]].map(([v, l]) => ({ label: l, selected: f.sort === v, run: () => setParam('sort', v === 'newest' ? '' : v) })));
      else if (a === 'more-filters') {
        menu(btn, [
          { header: t('Source') },
          ...Object.entries(SOURCES).map(([k, s]) => ({ label: t(s.label), icon: s.icon, selected: f.source === k, run: () => setParam('source', f.source === k ? '' : k) })),
          'sep', { header: t('Participants') },
          { label: t('External (outside your organisation)'), icon: 'globe', selected: f.external === '1', run: () => setParam('external', f.external === '1' ? '' : '1') },
          { label: t('Internal only'), icon: 'building', selected: f.external === '0', run: () => setParam('external', f.external === '0' ? '' : '0') },
          ...(S.tags.length ? ['sep', { header: t('Tag') }, ...S.tags.map((tg) => ({ label: tg.name, icon: 'tag', selected: f.tag === tg.id, run: () => setParam('tag', f.tag === tg.id ? '' : tg.id) }))] : []),
          ...(S.spaces.length ? ['sep', { header: t('Space') }, ...S.spaces.map((s) => ({ label: s.name, icon: 'folder', selected: f.space === s.id, run: () => setParam('space', f.space === s.id ? '' : s.id) }))] : []),
          ...([f.tag, f.space, f.external, f.source].some(Boolean) ? ['sep', { label: t('Clear filters'), icon: 'x', run: () => go('#/meetings') }] : []),
        ]);
      } else if (a === 'space-menu') {
        menu(btn, [
          { label: t('Rename space'), icon: 'edit', run: async () => { const n = await promptDialog(t('Rename space'), space.name); if (n) { await api('PATCH', `/api/spaces/${space.id}`, { name: n }); window.dispatchEvent(new Event('wb:refresh')); setTimeout(() => render(main, { params }), 300); } } },
          { label: t('Delete space'), icon: 'trash', danger: true, run: async () => { if (await confirmDialog(t('Delete this space? Its meetings are kept and moved out of it.'))) { await api('DELETE', `/api/spaces/${space.id}`); window.dispatchEvent(new Event('wb:refresh')); go('#/meetings'); } } },
        ], { align: 'end' });
      } else if (a === 'b-export') openExport([...selected]);
      else if (a === 'b-tag') {
        const r = await promptDialog(t('Add tags to {n} meetings', { n: selected.size }), '', { placeholder: t('Comma-separated, e.g. customer, Q3'), hint: S.tags.length ? t('Existing: {list}', { list: S.tags.map((x) => x.name).join(', ') }) : '' });
        if (!r) return;
        const add = r.split(',').map((s) => s.trim()).filter(Boolean);
        for (const id of selected) { const cur = rows.find((x) => x.id === id)?.tags.map((x) => x.name) || []; await api('PUT', `/api/notes/${id}/tags`, { tags: [...cur, ...add] }); }
        done(); window.dispatchEvent(new Event('wb:refresh')); load();
      } else if (a === 'b-space') {
        menu(btn, [{ label: t('No space'), icon: 'x', run: () => move(null) }, ...S.spaces.map((s) => ({ label: s.name, icon: 'folder', run: () => move(s.id) }))]);
      } else if (a === 'b-delete') {
        if (!(await confirmDialog(t('Delete {n} meetings and their transcripts? This cannot be undone.', { n: selected.size })))) return;
        for (const id of selected) await api('DELETE', `/api/notes/${id}`).catch(fail);
        selected.clear(); done(); window.dispatchEvent(new Event('wb:refresh')); load(); bulkBar();
      }
    } catch (err) { fail(err); }
  };
  const move = async (folderId) => { for (const id of selected) await api('PATCH', `/api/notes/${id}`, { folderId }); done(); window.dispatchEvent(new Event('wb:refresh')); load(); };
  $('#m-q', main).addEventListener('input', debounce((e) => { f.q = e.target.value.trim(); load().catch(fail); }, 250));
  await load();
  void avatarStack; void fmtDur; void fmtHour; void srcIcon;
}
