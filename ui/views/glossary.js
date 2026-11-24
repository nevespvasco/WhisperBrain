// Glossary: terms, acronyms and jargon from your meetings (found by the AI or added by you), each with
// where it was said. Terms are underlined in transcripts with their definition.
import { S, $, api, t, esc, icon, fail, done, go, debounce, empty, modal, confirmDialog, fmtDate, fmtClock, avatar, safeSnippet, meetingRow } from '../lib.js';

export async function render(main, { name, parts }) {
  if (name === 'term' && parts[1]) return termPage(main, parts[1]);
  const terms = await api('GET', '/api/glossary');
  const KINDS = [['all', t('All'), () => true], ['auto', t('Found by AI'), (g) => g.auto], ['mine', t('Added by you'), (g) => !g.auto], ['undef', t('Needs a definition'), (g) => !g.definition]];
  main.innerHTML = `<div class="page narrow">
    <div class="page-head"><div><h1>${t('Glossary')}</h1><div class="sub">${t('The words, acronyms and product names your meetings use — so newcomers (and future you) can follow along.')}</div></div>
      <div class="actions"><button class="btn primary" data-act="add">${icon('plus', 'sm')} ${t('Add term')}</button></div></div>
    <div class="toolbar"><div class="search-in">${icon('search', 'sm')}<input id="g-q" type="search" placeholder="${t('Search terms and definitions…')}"></div>
      <div class="seg-ctl" role="tablist">${KINDS.map(([v, l, f]) => `<button type="button" role="tab" data-kind="${v}" aria-selected="${v === 'all'}">${l} <span class="faint">${terms.filter(f).length}</span></button>`).join('')}</div></div>
    <div class="gl-az" id="g-az" aria-label="${t('Jump to letter')}"></div>
    <div id="g-list"></div></div>`;
  let q = '', kind = 'all';
  const letterOf = (g) => { const L = (g.term[0] || '#').toUpperCase().normalize('NFD').replace(/\p{M}/gu, ''); return /\p{L}/u.test(L) ? L : '#'; };
  const draw = () => {
    const keep = KINDS.find(([v]) => v === kind)[2];
    const list = terms.filter((g) => keep(g) && (!q || [g.term, g.definition, ...g.aliases].join(' ').toLowerCase().includes(q)))
      .sort((x, y) => (letterOf(x) === '#') - (letterOf(y) === '#') || x.term.localeCompare(y.term, undefined, { sensitivity: 'base', numeric: true }));
    const box = $('#g-list', main);
    const letters = new Map();
    for (const g of list) { const L = letterOf(g); if (!letters.has(L)) letters.set(L, []); letters.get(L).push(g); }
    // a short glossary is one grid; letters (and the A–Z bar) only once there is enough to look things up in
    const byLetter = list.length > 12;
    $('#g-az', main).innerHTML = byLetter ? [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'].map((L) => `<button type="button" data-jump="${L}" ${letters.has(L) ? '' : 'disabled'}>${L}</button>`).join('') : '';
    if (!list.length) { box.innerHTML = `<div class="panel">${empty('book', terms.length ? t('No terms match') : t('Your glossary is empty'), t('When a meeting is enhanced, unfamiliar terms are collected here with a definition. You can add your own too.'))}</div>`; return; }
    const card = (g) => `<article class="gl-card" data-id="${g.id}">
      <div class="gl-top"><a class="term-name" href="#/term/${g.id}">${esc(g.term)}</a>${g.auto ? `<span class="gl-auto" title="${t('Found by AI')}">${icon('sparkles', 'sm')}</span>` : ''}
        <span class="gl-tools"><button class="btn ghost icon xs" data-edit="${g.id}" aria-label="${t('Edit')}" title="${t('Edit')}">${icon('edit', 'sm')}</button><button class="btn ghost icon xs" data-del="${g.id}" aria-label="${t('Delete')}" title="${t('Delete')}">${icon('trash', 'sm')}</button></span></div>
      ${g.aliases.length ? `<div class="gl-aliases">${g.aliases.map((a) => `<span>${esc(a)}</span>`).join('')}</div>` : ''}
      <p class="gl-def">${esc(g.definition) || `<button type="button" class="linkish" data-edit="${g.id}">${icon('plus', 'sm')} ${t('Add a definition')}</button>`}</p>
      ${g.noteTitle ? `<div class="gl-src">${icon('video', 'sm')}<span>${t('First seen in')}</span> <a href="#/note/${g.noteId}" class="ellipsis">${esc(g.noteTitle)}</a></div>` : ''}</article>`;
    box.innerHTML = !byLetter ? `<div class="gl-grid">${list.map(card).join('')}</div>`
      : [...letters.entries()].map(([L, items]) => `<section class="gl-sec" id="gl-${L === '#' ? 'num' : L}"><div class="gl-letter"><span>${esc(L)}</span><i></i><span class="faint">${items.length}</span></div><div class="gl-grid">${items.map(card).join('')}</div></section>`).join('');
  };
  draw();
  $('#g-q', main).addEventListener('input', debounce((e) => { q = e.target.value.trim().toLowerCase(); draw(); }, 150));
  main.onclick = async (e) => {
    try {
      const k = e.target.closest('[data-kind]');
      if (k) { kind = k.dataset.kind; main.querySelectorAll('[data-kind]').forEach((b) => b.setAttribute('aria-selected', String(b === k))); draw(); return; }
      const j = e.target.closest('[data-jump]');
      if (j) { $(`#gl-${j.dataset.jump === '#' ? 'num' : j.dataset.jump}`, main)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      if (e.target.closest('[data-act="add"]')) { if (await editTerm()) render(main, { name, parts }); return; }
      const ed = e.target.closest('[data-edit]');
      if (ed) { if (await editTerm(terms.find((g) => g.id === ed.dataset.edit))) render(main, { name, parts }); return; }
      const del = e.target.closest('[data-del]');
      if (del) { const g = terms.find((x) => x.id === del.dataset.del); if (await confirmDialog(t('Remove “{term}” from the glossary?', { term: g.term }))) { await api('DELETE', `/api/glossary/${g.id}`); terms.splice(terms.indexOf(g), 1); draw(); window.dispatchEvent(new Event('wb:refresh')); } return; }
      // the whole card opens the term, links and buttons inside keep their own job
      const card = e.target.closest('.gl-card');
      if (card && !e.target.closest('a, button') && !getSelection().toString()) go(`#/term/${card.dataset.id}`);
    } catch (err) { fail(err); }
  };
}

export function editTerm(g = null) {
  return modal({
    title: g ? t('Edit term') : t('Add a term'),
    body: `<div class="field"><label for="gt-term">${t('Term')}</label><input id="gt-term" value="${esc(g?.term || '')}" placeholder="${t('e.g. ARR, Project Atlas')}"></div>
      <div class="field"><label for="gt-def">${t('Definition')}</label><textarea id="gt-def" placeholder="${t('What it means here')}">${esc(g?.definition || '')}</textarea></div>
      <div class="field"><label for="gt-al">${t('Also written as')}</label><input id="gt-al" value="${esc((g?.aliases || []).join(', '))}" placeholder="${t('Comma-separated spellings')}"></div>`,
    foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" data-ok>${t('Save')}</button>`,
    onMount: (d, close) => {
      $('#gt-term', d).focus();
      $('[data-ok]', d).onclick = async () => {
        const body = { term: $('#gt-term', d).value.trim(), definition: $('#gt-def', d).value.trim(), aliases: $('#gt-al', d).value.split(',').map((s) => s.trim()).filter(Boolean) };
        try { const r = g ? await api('PATCH', `/api/glossary/${g.id}`, body) : await api('POST', '/api/glossary', body); window.dispatchEvent(new Event('wb:refresh')); done(); close(r); } catch (e) { fail(e); }
      };
    },
  });
}

async function termPage(main, id) {
  const g = await api('GET', `/api/glossary/${id}`);
  main.innerHTML = `<div class="page narrow">
    <div class="note-top"><button class="btn ghost icon" data-act="back" aria-label="${t('Back')}">${icon('back')}</button>
      <div class="tt"><h1 style="font-size:26px">${esc(g.term)}</h1><div class="note-meta">${g.aliases.length ? `<span>${t('Also')}: ${esc(g.aliases.join(', '))}</span>` : ''}<span>${icon('video', 'sm')}${g.notes.length} ${g.notes.length === 1 ? t('meeting') : t('meetings')}</span></div></div>
      <div class="note-actions"><button class="btn" data-act="edit">${icon('edit', 'sm')} ${t('Edit')}</button></div></div>
    <section class="panel mb"><div class="md">${esc(g.definition) || `<span class="muted">${t('No definition yet — add one so everyone knows what it means.')}</span>`}</div></section>
    <section class="panel mb"><div class="panel-head"><h3>${icon('quote')} ${t('Where it was said')}</h3><span class="badge">${g.quotes.length}</span></div>
      ${g.quotes.length ? `<div class="stack tight">${g.quotes.map((q) => `<a class="quote" href="#/note/${q.noteId}?tab=transcript&seg=${q.segmentId}"><div class="src">${avatar(q.label, { cls: 'sm' })}<b>${esc(q.label)}</b> · ${esc(q.noteTitle || '')} · ${fmtDate(q.at, { day: 'numeric', month: 'short' })} ${fmtClock(q.startMs)}</div><div class="q">${safeSnippet(q.snippet)}</div></a>`).join('')}</div>` : `<div class="small muted">${t('Not found in any transcript yet.')}</div>`}</section>
    ${g.notes.length ? `<section class="panel"><div class="panel-head"><h3>${icon('video')} ${t('Meetings')}</h3></div><div class="list">${g.notes.map((n) => meetingRow(n)).join('')}</div></section>` : ''}</div>`;
  main.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (b?.dataset.act === 'back') history.length > 1 ? history.back() : go('#/glossary');
    if (b?.dataset.act === 'edit') { if (await editTerm(g)) termPage(main, id); }
  };
  void S;
}
