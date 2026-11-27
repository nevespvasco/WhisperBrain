// ⌘K: one search over meetings, what people said, topics, people, glossary, tags and action items,
// plus quick commands. Results are grouped by day; arrows + Enter navigate.
import { S, $, $$, api, t, esc, icon, go, fmtClock, dateGroup, groupBy, debounce, safeSnippet, menu, fmtDate } from './lib.js';

const KINDS = [['all', 'All'], ['meetings', 'Meetings'], ['quotes', 'Who said'], ['topics', 'Topics'], ['people', 'People'], ['glossary', 'Glossary'], ['tags', 'Tags'], ['actions', 'Actions'], ['docs', 'Notes & files']];
const KIND_ICON = { live: 'mail', livemore: 'search', meeting: 'link', quote: 'quote', topic: 'hash', person: 'user', term: 'book', tag: 'tag', action: 'checksq', doc: 'file', cmd: 'bolt' };
const DATES = [['', 'Any time'], ['1', 'Today'], ['7', 'Past week'], ['30', 'Past month'], ['365', 'Past year']];
const SORTS = [['relevance', 'Relevance'], ['newest', 'Newest first'], ['oldest', 'Oldest first']];
let dlg = null;

function href(r) {
  if (r.kind === 'meeting') return `#/note/${r.noteId}`;
  if (r.kind === 'quote') return `#/note/${r.noteId}?tab=transcript&seg=${r.segmentId}`;
  if (r.kind === 'topic') return `#/topic/${r.id}`;
  if (r.kind === 'person') return `#/person/${encodeURIComponent(r.id)}`;
  if (r.kind === 'term') return `#/term/${r.id}`;
  if (r.kind === 'tag') return `#/meetings?tag=${r.id}`;
  if (r.kind === 'action') return `#/note/${r.noteId}?tab=summary`;
  if (r.kind === 'doc') return `#/documents/${r.id}`;
  return r.href || '#/';
}

function commands(q) {
  const list = [
    { title: t('Start recording a new meeting'), run: () => window.wb.startRec?.(), kbd: 'Ctrl ⇧ R', icon: 'mic' },
    { title: t('Import files (audio, transcripts, documents)'), run: () => window.wb.openImport(), kbd: 'Ctrl I', icon: 'upload' },
    { title: t('Export meetings'), run: () => window.wb.openExport(), icon: 'download' },
    { title: t('Ask AI about anything'), href: '#/chat', icon: 'sparkles' },
    { title: t('Go to Topics'), href: '#/topics', icon: 'network', kbd: 'G T' },
    { title: t('Go to Glossary'), href: '#/glossary', icon: 'book', kbd: 'G L' },
    { title: t('Go to Action items'), href: '#/actions', icon: 'list', kbd: 'G A' },
    { title: t('Go to Calendar'), href: '#/calendar', icon: 'calendar', kbd: 'G C' },
    { title: t('Connect Google Calendar, Notion, Linear, Obsidian'), href: '#/integrations', icon: 'plug' },
    { title: t('Settings'), href: '#/settings', icon: 'settings', kbd: 'G S' },
  ];
  const f = q.toLowerCase();
  return list.filter((c) => !f || c.title.toLowerCase().includes(f)).map((c, i) => ({ ...c, kind: 'cmd', id: `cmd${i}` }));
}

export function openPalette(initial = '') {
  if (dlg) { $('input', dlg).focus(); return; }
  const st = { q: initial, kind: 'all', sort: 'relevance', days: '', results: [], active: 0, seq: 0, live: null };
  // which services may be searched live (their access allows it): known once, when the palette opens
  api('GET', '/api/access').then((o) => { st.live = o.sources.filter((x) => x.liveSearch && x.enabled && x.readLevel !== 'none' && x.readLevel !== 'metadata'); }).catch(() => { st.live = []; });
  dlg = document.createElement('dialog');
  dlg.className = 'palette';
  dlg.setAttribute('aria-label', t('Search'));
  dlg.innerHTML = `<div class="dlg">
    <div class="pal-search">${icon('search')}<input type="text" placeholder="${t('Search meetings, quotes, topics, people…')}" value="${esc(initial)}" aria-label="${t('Search')}" autocomplete="off" spellcheck="false"><button class="btn ghost icon sm" data-close aria-label="${t('Close')}">${icon('x')}</button></div>
    <div class="pal-filters"><div class="seg-ctl" role="tablist">${KINDS.map(([k, l]) => `<button type="button" role="tab" data-kind="${k}" aria-selected="${k === 'all'}">${t(l)}</button>`).join('')}</div>
      <div class="right"><button class="btn ghost sm" data-pop="sort">${icon('sort', 'sm')}<span data-lbl="sort">${t('Sort')}</span>${icon('chevdown', 'sm')}</button><button class="btn ghost sm" data-pop="date">${icon('calendar', 'sm')}<span data-lbl="date">${t('Date')}</span>${icon('chevdown', 'sm')}</button></div></div>
    <div class="pal-results" role="listbox"></div>
    <div class="pal-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> ${t('navigate')}</span><span><kbd>Enter</kbd> ${t('open')}</span><span><kbd>Tab</kbd> ${t('next filter')}</span><span><kbd>Esc</kbd> ${t('close')}</span></div></div>`;
  document.body.append(dlg);
  dlg.showModal();
  const input = $('input', dlg), box = $('.pal-results', dlg);
  input.focus();

  const KIND_TITLE = { cmd: 'Commands', meeting: 'Meetings', quote: 'Who said it', topic: 'Topics', person: 'People', term: 'Glossary', tag: 'Tags', action: 'Action items', doc: 'Notes & files', live: 'Found live in your services', livemore: 'Search your services' };
  // Groups in display order: commands first, then by kind (relevance) or by day (date sorts / empty query).
  const layout = (rows) => {
    const cmds = rows.filter((r) => r.kind === 'cmd'), rest = rows.filter((r) => r.kind !== 'cmd');
    const groups = cmds.length ? [{ title: t('Commands'), items: cmds }] : [];
    if (st.sort === 'relevance' && st.q) for (const g of groupBy(rest, (r) => r.kind)) groups.push({ title: t(KIND_TITLE[g.key]), items: g.items });
    else {
      const dated = rest.filter((r) => ['meeting', 'quote', 'action'].includes(r.kind) && r.at);
      for (const g of groupBy(dated, (r) => dateGroup(r.at))) groups.push({ title: g.key, items: g.items });
      for (const g of groupBy(rest.filter((r) => !dated.includes(r)), (r) => r.kind)) groups.push({ title: t(KIND_TITLE[g.key]), items: g.items });
    }
    return groups;
  };
  const render = () => {
    if (!st.results.length) { box.innerHTML = `<div class="empty">${icon('search')}<p>${st.q ? t('Nothing found for “{q}”.', { q: esc(st.q) }) : t('Type to search everything you have recorded or imported.')}</p></div>`; lastOrdered = []; return; }
    const groups = layout(st.results);
    lastOrdered = groups.flatMap((g) => g.items);
    let i = 0;
    box.innerHTML = groups.map((g) => `<div class="pal-group">${esc(g.title)}</div>${g.items.map((r) => item(r, i++)).join('')}`).join('');
    st.active = 0; setActive(0);
  };
  const item = (r, i) => {
    const ic = r.kind === 'tag' ? `<span class="tagdot" style="width:10px;height:10px;border-radius:50%;background:${r.color};margin:0 4px"></span>` : icon(r.icon || KIND_ICON[r.kind]);
    let title = esc(r.title || t('Untitled meeting')), sub = '';
    if (r.kind === 'meeting') sub = r.snippet ? safeSnippet(r.snippet.replace(/#{1,6}\s*|\*\*|__|- \[[ x]\]\s*/g, '')) : esc(fmtDate(r.at, { day: 'numeric', month: 'short' }));
    else if (r.kind === 'quote') { title = `${esc(r.title)} <span class="faint">${fmtClock(r.startMs)}</span>`; sub = `“${safeSnippet(r.snippet)}” · ${esc(r.noteTitle || '')}`; }
    else if (r.kind === 'topic') sub = `(${r.count} ${r.count === 1 ? t('meeting') : t('meetings')})${r.snippet ? ' ' + esc(r.snippet) : ''}`;
    else if (r.kind === 'person') sub = `(${r.count} ${r.count === 1 ? t('meeting') : t('meetings')})${r.snippet ? ' · ' + esc(r.snippet) : ''}`;
    else if (r.kind === 'tag') sub = `(${r.count} ${r.count === 1 ? t('meeting') : t('meetings')})`;
    else if (r.kind === 'term') sub = esc(r.snippet || '');
    else if (r.kind === 'doc') sub = `${r.snippet ? safeSnippet(r.snippet) : ''}${r.source ? ` · ${esc(r.source)}` : ''}`;
    else if (r.kind === 'live') sub = esc([r.who, r.snippet].filter(Boolean).join(' · '));
    else if (r.kind === 'livemore') sub = esc(r.snippet || '');
    else if (r.kind === 'action') { title = `${r.done ? '✓ ' : ''}${title}`; sub = esc([r.snippet, r.noteTitle].filter(Boolean).join(' · ')); }
    const right = r.kind === 'live' ? `<span class="badge">${esc(r.sourceName || '')}</span>` : r.kind === 'meeting' && r.tags?.length ? r.tags.slice(0, 2).map((tg) => `<span class="tagchip"><span class="dot" style="background:${tg.color}"></span>${esc(tg.name)}</span>`).join('') : r.kbd ? `<kbd>${esc(r.kbd)}</kbd>` : '';
    return `<a class="pal-item" role="option" data-i="${i}" href="${esc(href(r))}">${ic}<span class="grow"><span class="t ${r.kind === 'meeting' ? 'u' : ''}">${title}</span><span class="s">${sub}</span></span><span class="right">${right}</span></a>`;
  };
  const flat = () => $$('.pal-item', box);
  const setActive = (i) => {
    const items = flat();
    if (!items.length) return;
    st.active = (i + items.length) % items.length;
    items.forEach((el, j) => { el.classList.toggle('active', j === st.active); el.setAttribute('aria-selected', String(j === st.active)); });
    items[st.active].scrollIntoView({ block: 'nearest' });
  };
  const pick = (el) => {
    const i = Number(el.dataset.i);
    const r = allOrdered()[i];
    if (r?.kind === 'livemore') { r.run(); return; }   // the list stays open: the answers replace it
    close();
    if (r?.run) r.run(); else location.hash = href(r).slice(1) ? href(r) : '#/';
  };
  let lastOrdered = [];
  const allOrdered = () => lastOrdered;

  const search = async () => {
    const seq = ++st.seq;
    const p = new URLSearchParams({ q: st.q, kind: st.kind, sort: st.sort, limit: '40' });
    if (st.days) p.set('from', String(Date.now() - Number(st.days) * 86400000));
    let rows = [];
    try { rows = await api('GET', `/api/find?${p}`); } catch { rows = []; }
    if (seq !== st.seq) return;
    if (st.kind === 'all' && (!st.q || st.q.length < 40)) rows = [...(st.q ? commands(st.q).slice(0, 3) : commands('').slice(0, 4)), ...rows];
    // when some service allows live search, one more row asks it (never per keystroke: only when this row is chosen)
    if (st.kind === 'all' && st.q.length >= 3 && st.live?.length) rows = [...rows, { kind: 'livemore', id: 'livemore', title: t('Search {names} for “{q}”', { names: st.live.map((x) => x.name).slice(0, 3).join(', '), q: st.q }), snippet: t('Asks the service itself, so older mail is found too'), icon: 'search', run: () => liveSearch() }];
    st.results = rows;
    render();
  };
  // ask the services; the answers replace the list, each one opens where it lives
  const liveSearch = async () => {
    const q = st.q;
    box.innerHTML = `<div class="empty">${icon('search')}<p>${t('Asking {names}…', { names: st.live.map((x) => x.name).slice(0, 3).join(', ') })}</p></div>`;
    try {
      const out = await api('GET', `/api/live-search?q=${encodeURIComponent(q)}&limit=12`);
      st.results = out.results.map((r) => ({ ...r, kind: 'live', id: `${r.sourceId}|${r.externalId}`, run: () => window.open(r.uri, '_blank', 'noopener') }));
      const failed = out.searched.filter((x) => x.error);
      render();
      if (failed.length) box.insertAdjacentHTML('beforeend', `<div class="small muted" style="padding:8px 14px">${failed.map((f) => `${esc(f.source)}: ${esc(f.error)}`).join(' · ')}</div>`);
      if (!out.results.length && !failed.length) box.innerHTML = `<div class="empty">${icon('search')}<p>${t('Nothing found for “{q}” in your services.', { q: esc(q) })}</p></div>`;
    } catch (e) { box.innerHTML = `<div class="empty">${icon('alert')}<p>${esc(e.message)}</p></div>`; }
  };
  const close = () => { dlg?.close(); };
  dlg.addEventListener('close', () => { dlg.remove(); dlg = null; });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) return close();
    const k = e.target.closest('[data-kind]');
    if (k) { st.kind = k.dataset.kind; $$('[data-kind]', dlg).forEach((b) => b.setAttribute('aria-selected', String(b === k))); search(); input.focus(); return; }
    const pop = e.target.closest('[data-pop]');
    if (pop) {
      const isSort = pop.dataset.pop === 'sort';
      menu(pop, (isSort ? SORTS : DATES).map(([v, l]) => ({ label: t(l), selected: (isSort ? st.sort : st.days) === v, run: () => { if (isSort) st.sort = v; else st.days = v; $(`[data-lbl="${pop.dataset.pop}"]`, dlg).textContent = v ? t(l) : t(isSort ? 'Sort' : 'Date'); search(); input.focus(); } })), { align: 'end' });
      return;
    }
    const it = e.target.closest('.pal-item');
    if (it) { e.preventDefault(); pick(it); }
  });
  const onType = debounce(() => { if (input.value.trim() === st.q) return; st.q = input.value.trim(); search(); }, 140);
  input.addEventListener('input', onType);
  input.addEventListener('keyup', onType);
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(st.active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(st.active - 1); }
    else if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); const el = flat()[st.active]; if (el) pick(el); }
    else if (e.key === 'Tab' && document.activeElement === input) {
      e.preventDefault();
      const i = KINDS.findIndex(([k]) => k === st.kind);
      st.kind = KINDS[(i + (e.shiftKey ? KINDS.length - 1 : 1)) % KINDS.length][0];
      $$('[data-kind]', dlg).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.kind === st.kind)));
      $(`[data-kind="${st.kind}"]`, dlg).scrollIntoView({ block: 'nearest', inline: 'nearest' });
      search();
    }
  });
  search();
}
