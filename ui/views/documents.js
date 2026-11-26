// Notes & files: everything read from folders and Obsidian vaults (Setup › Sources), searchable, each opening in its own app.
// Meetings are not listed here; they have their own page.
import { S, $, api, t, esc, icon, fail, debounce, empty, fmtDate, safeSnippet, go } from '../lib.js';
import { renderMarkdown } from '../md.js';

export async function render(main, { parts, params }) {
  if (parts[1]) return detail(main, parts[1]);
  let q = params.get('q') || '', source = params.get('source') || '';
  const sources = (await api('GET', '/api/sources')).filter((s) => !s.config?.imported && s.items);
  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>${t('Notes & files')}</h1><div class="sub">${t('Notes and files read from your folders and vaults. They stay where they are; open one to go to its own app.')}</div></div><a class="btn" href="#/sources">${icon('plug', 'sm')} ${t('Folders & vaults')}</a></div>
    <div class="toolbar"><div class="search-in">${icon('search', 'sm')}<input id="d-q" type="search" value="${esc(q)}" placeholder="${t('Search your notes…')}" aria-label="${t('Search your notes…')}"></div>
      ${sources.length > 1 ? `<select id="d-src" aria-label="${t('Source')}"><option value="">${t('All sources')}</option>${sources.map((s) => `<option value="${s.id}" ${s.id === source ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>` : ''}
      <span class="small muted" id="d-count"></span></div>
    <div id="d-list"></div></div>`;
  const list = $('#d-list', main);
  let seq = 0;
  const load = async () => {
    const my = ++seq;
    const r = await api('GET', `/api/items?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}${source ? `&source=${encodeURIComponent(source)}` : ''}`);
    if (my !== seq) return;
    $('#d-count', main).textContent = t('{n} notes', { n: r.items.length < 100 ? r.items.length : `${r.items.length}+` });
    list.innerHTML = r.items.length ? `<div class="panel" style="padding:6px"><div class="list">${r.items.map(row).join('')}</div></div>`
      : `<div class="panel">${q ? empty('search', t('Nothing found'), t('Try other words. Search ignores accents and matches the start of a word.')) : sources.length || r.total ? empty('file', t('No notes here'), '') : empty('folder', t('No notes yet'), t('Add your Obsidian vault or a folder of notes and they show up here.'), `<a class="btn primary" href="#/sources">${icon('plus', 'sm')} ${t('Add a folder')}</a>`)}</div>`;
  };
  const row = (it) => `<a class="row hover" style="padding:10px 12px;gap:12px;align-items:flex-start;text-decoration:none;color:inherit" href="#/documents/${it.id}">
    <span style="color:var(--accent);margin-top:2px">${icon(it.path?.toLowerCase().endsWith('.pdf') ? 'doc' : 'file')}</span>
    <span class="grow" style="min-width:0"><span class="strong ellipsis" style="display:block">${esc(it.title || t('Untitled'))}</span>
      <span class="small muted" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${it.snippet ? safeSnippet(it.snippet) : esc(it.preview.replace(/\s+/g, ' ').replace(/^#+\s*/, ''))}</span></span>
    <span class="xsmall muted" style="white-space:nowrap;text-align:right">${esc(it.sourceName)}<br>${fmtDate(it.occurredAt, { day: 'numeric', month: 'short', year: 'numeric' })}</span></a>`;
  $('#d-q', main).addEventListener('input', debounce((e) => { q = e.target.value.trim(); load().catch(fail); }, 200));
  $('#d-src', main)?.addEventListener('change', (e) => { source = e.target.value; load().catch(fail); });
  await load();
}

async function detail(main, id) {
  const it = await api('GET', `/api/items/${encodeURIComponent(id)}`);
  const m = it.meta || {};
  const md = /\.(md|markdown)$/i.test(it.externalId) || it.kind === 'note' && !/\.txt$/i.test(it.externalId);
  const body = it.text.slice(0, 40000);
  main.innerHTML = `<div class="page">
    <div class="note-top"><button class="btn ghost icon" data-act="back" aria-label="${t('Back')}">${icon('back')}</button>
      <div class="tt"><h1 style="font-size:26px">${esc(it.title || t('Untitled'))}</h1>
        <div class="note-meta"><span>${icon('folder', 'sm')}${esc(it.sourceName)}</span><span>${icon('clock', 'sm')}${fmtDate(it.occurredAt)}</span>${it.path ? `<span class="ellipsis" title="${esc(it.path)}">${icon('file', 'sm')}${esc(it.externalId)}</span>` : ''}</div></div>
      <div class="note-actions">${it.uri ? `<a class="btn primary" href="${esc(it.uri)}">${icon('external', 'sm')} ${t('Open in Obsidian')}</a>` : ''}</div></div>
    <div class="banner small mb">${icon('info')}<div class="grow">${t('This is a copy of the text so it can be searched. The original stays where it is, and nothing here changes it.')}</div></div>
    ${(m.tags || []).length || (m.links || []).length ? `<div class="chips mb">${(m.tags || []).map((x) => `<span class="chip">#${esc(x)}</span>`).join('')}${(m.links || []).slice(0, 12).map((x) => `<span class="chip">[[${esc(x)}]]</span>`).join('')}</div>` : ''}
    <section class="panel">${body ? (md ? `<div class="md">${renderMarkdown(body)}</div>` : `<pre style="white-space:pre-wrap;margin:0;font:inherit">${esc(body)}</pre>`) : `<div class="small muted">${m.unreadable ? t('This PDF has no text that could be read (a scanned PDF needs OCR first).') : t('Empty.')}</div>`}
      ${it.text.length > 40000 ? `<div class="xsmall muted mt-s">${t('Only the start is shown.')}</div>` : ''}</section></div>`;
  main.onclick = (e) => { if (e.target.closest('[data-act="back"]')) history.length > 1 ? history.back() : go('#/documents'); };
}
