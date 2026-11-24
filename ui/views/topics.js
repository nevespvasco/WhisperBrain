// Topics across meetings: a correlation graph (topics discussed together are linked), a list, and a topic page
// with the meetings, who said what about it, related topics and an AI synthesis across meetings.
import { S, $, $$, api, t, esc, icon, fail, done, go, debounce, empty, fmtDate, fmtClock, avatar, menu, promptDialog, confirmDialog, safeSnippet, hashColor, meetingRow } from '../lib.js';
import { stream } from '../api.js';
import { renderMarkdown } from '../md.js';

let mode = localStorage.getItem('wb.topics.view') || 'graph';
let sim = null;

export async function render(main, { name, parts }) {
  sim?.stop(); sim = null;
  if (name === 'topic' && parts[1]) return topicPage(main, parts[1]);
  const [topics, graph] = await Promise.all([api('GET', '/api/topics'), api('GET', '/api/topics/graph?limit=70')]);
  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>${t('Topics')}</h1><div class="sub">${t('Subjects that come up across your meetings. Lines join topics discussed in the same meeting.')}</div></div>
      <div class="actions"><div class="seg-ctl" role="tablist"><button type="button" role="tab" data-mode="graph" aria-selected="${mode === 'graph'}">${icon('network', 'sm')} ${t('Map')}</button><button type="button" role="tab" data-mode="list" aria-selected="${mode === 'list'}">${icon('list', 'sm')} ${t('List')}</button></div></div></div>
    ${topics.length ? `<div class="toolbar"><div class="search-in">${icon('search', 'sm')}<input id="tp-q" type="search" placeholder="${t('Filter topics…')}"></div><span class="small muted">${t('{n} topics', { n: topics.length })}</span></div><div id="tp-body"></div>`
      : `<div class="panel">${empty('network', t('No topics yet'), t('Topics are extracted after each recording or import, and when you analyse a meeting. They connect meetings that talk about the same things.'), `<a class="btn primary" href="#/meetings">${t('Open a meeting')}</a>`)}</div>`}
  </div>`;
  if (!topics.length) return;
  let q = '';
  const draw = () => {
    const box = $('#tp-body', main);
    const list = topics.filter((x) => !q || x.name.toLowerCase().includes(q));
    sim?.stop(); sim = null;
    if (mode === 'graph') {
      box.innerHTML = `<svg class="graph" id="graph" role="img" aria-label="${t('Topic map')}"></svg><div class="xsmall muted mt-s">${t('Drag to rearrange · click a topic to open it · bigger = more meetings')}</div>`;
      const ids = new Set(list.map((x) => x.id));
      sim = forceGraph($('#graph', box), { nodes: graph.nodes.filter((n) => ids.has(n.id)), edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) }, (id) => go(`#/topic/${id}`));
    } else {
      box.innerHTML = `<div class="list">${list.map((x) => `<a class="li" href="#/topic/${x.id}"><span class="srcicon" style="background:${hashColor(x.name)}22;color:${hashColor(x.name)}">${icon('hash')}</span><div class="main-t"><div class="t">${x.pinned ? '📌 ' : ''}${esc(x.name)}</div><div class="s">${esc(x.description || '')}</div></div><div class="side"><span class="badge">${x.notes} ${x.notes === 1 ? t('meeting') : t('meetings')}</span><span class="hide-sm">${x.lastAt ? fmtDate(x.lastAt, { day: 'numeric', month: 'short' }) : ''}</span></div></a>`).join('')}</div>`;
    }
  };
  draw();
  main.onclick = (e) => { const m = e.target.closest('[data-mode]'); if (m) { mode = m.dataset.mode; localStorage.setItem('wb.topics.view', mode); $$('[data-mode]', main).forEach((b) => b.setAttribute('aria-selected', String(b === m))); draw(); } };
  $('#tp-q', main).addEventListener('input', debounce((e) => { q = e.target.value.trim().toLowerCase(); draw(); }, 200));
}

// Small force-directed layout in SVG (no library). Returns { stop }.
function forceGraph(svg, { nodes, edges }, onOpen) {
  const W = svg.clientWidth || 800, H = svg.clientHeight || 440;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (!nodes.length) { svg.outerHTML = empty('network', t('No topics match')); return { stop() {} }; }
  const maxN = Math.max(...nodes.map((n) => n.notes), 1);
  const N = nodes.map((n, i) => ({ ...n, r: 10 + 18 * Math.sqrt(n.notes / maxN), x: W / 2 + Math.cos(i * 2.4) * (60 + i * 10), y: H / 2 + Math.sin(i * 2.4) * (60 + i * 8), vx: 0, vy: 0 }));
  // spacing scales with the canvas and with how many topics there are
  const REST = Math.max(90, Math.min(W, H * 1.6) / (1.2 + Math.sqrt(nodes.length) * 0.55)), REPEL = REST * REST * 0.9;
  const idx = new Map(N.map((n, i) => [n.id, i]));
  const E = edges.map((e) => ({ s: idx.get(e.source), t: idx.get(e.target), w: e.weight }));
  const maxW = Math.max(...E.map((e) => e.w), 1);
  svg.innerHTML = `<g class="edges">${E.map((e) => `<line stroke-width="${1 + 3 * (e.w / maxW)}" stroke-opacity="${0.35 + 0.5 * (e.w / maxW)}"></line>`).join('')}</g>
    <g class="nodes">${N.map((n) => `<g class="node" data-id="${n.id}" tabindex="0" role="link" aria-label="${esc(n.name)}"><circle r="${n.r}" fill="${hashColor(n.name)}"></circle><text dy="${n.r + 14}" text-anchor="middle">${esc(n.name.length > 26 ? n.name.slice(0, 25) + '…' : n.name)}</text><title>${esc(n.name)} — ${n.notes} ${n.notes === 1 ? t('meeting') : t('meetings')}</title></g>`).join('')}</g>`;
  const lines = [...svg.querySelectorAll('line')], groups = [...svg.querySelectorAll('.node')];
  let alpha = 1, raf = 0, drag = null, moved = false;
  const tick = () => {
    for (let i = 0; i < N.length; i++) {
      const a = N[i];
      for (let j = i + 1; j < N.length; j++) {
        const b = N[j];
        let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy || 1;
        const min = a.r + b.r + 30;
        const f = (REPEL / d2) * alpha * (d2 < min * min ? 3 : 1);
        const d = Math.sqrt(d2); dx /= d; dy /= d;
        a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
      }
    }
    for (const e of E) {
      const a = N[e.s], b = N[e.t];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - REST) * 0.01 * alpha * (0.6 + e.w / maxW);
      a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (const n of N) {
      n.vx += (W / 2 - n.x) * 0.0025 * alpha; n.vy += (H / 2 - n.y) * 0.004 * alpha;
      if (n === drag) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.82; n.vy *= 0.82; n.x += n.vx; n.y += n.vy;
      n.x = Math.max(n.r + 4, Math.min(W - n.r - 4, n.x)); n.y = Math.max(n.r + 4, Math.min(H - n.r - 18, n.y));
    }
    E.forEach((e, i) => { const a = N[e.s], b = N[e.t]; lines[i].setAttribute('x1', a.x); lines[i].setAttribute('y1', a.y); lines[i].setAttribute('x2', b.x); lines[i].setAttribute('y2', b.y); });
    N.forEach((n, i) => groups[i].setAttribute('transform', `translate(${n.x},${n.y})`));
    alpha *= 0.985;
    if (alpha > 0.02 || drag) raf = requestAnimationFrame(tick);
  };
  const pt = (ev) => { const r = svg.getBoundingClientRect(); return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H }; };
  svg.addEventListener('pointerdown', (ev) => { const g = ev.target.closest('.node'); if (!g) return; drag = N[groups.indexOf(g)]; moved = false; svg.setPointerCapture(ev.pointerId); alpha = Math.max(alpha, 0.3); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); });
  svg.addEventListener('pointermove', (ev) => { if (!drag) return; const p = pt(ev); if (Math.abs(p.x - drag.x) + Math.abs(p.y - drag.y) > 2) moved = true; drag.x = p.x; drag.y = p.y; });
  svg.addEventListener('pointerup', () => { if (drag && !moved) onOpen(drag.id); drag = null; });
  svg.addEventListener('keydown', (ev) => { const g = ev.target.closest('.node'); if (g && ev.key === 'Enter') onOpen(g.dataset.id); });
  // highlight neighbours on hover
  svg.addEventListener('pointerover', (ev) => {
    const g = ev.target.closest('.node');
    const id = g ? idx.get(g.dataset.id) : null;
    lines.forEach((l, i) => { l.style.opacity = id == null || E[i].s === id || E[i].t === id ? '' : '.12'; });
    groups.forEach((x, i) => { x.style.opacity = id == null || i === id || E.some((e) => (e.s === id && e.t === i) || (e.t === id && e.s === i)) ? '' : '.35'; });
  });
  raf = requestAnimationFrame(tick);
  return { stop() { cancelAnimationFrame(raf); } };
}

async function topicPage(main, id) {
  const tp = await api('GET', `/api/topics/${id}`);
  const first = tp.notes[tp.notes.length - 1], last = tp.notes[0];
  main.innerHTML = `<div class="page">
    <div class="note-top"><button class="btn ghost icon" data-act="back" aria-label="${t('Back')}">${icon('back')}</button>
      <div class="tt"><h1 style="font-size:26px">${icon('hash', 'lg')} ${esc(tp.name)}</h1><div class="note-meta"><span>${icon('video', 'sm')}${tp.notes.length} ${tp.notes.length === 1 ? t('meeting') : t('meetings')}</span>${first ? `<span>${icon('calendar', 'sm')}${fmtDate(first.createdAt, { day: 'numeric', month: 'short', year: 'numeric' })}${last !== first ? ` → ${fmtDate(last.createdAt, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</span>` : ''}<span>${icon('users', 'sm')}${tp.people.length} ${t('people')}</span></div></div>
      <div class="note-actions"><button class="btn primary" data-act="brief" ${!S.state?.llmConfigured ? 'disabled title="' + t('Needs an AI model') + '"' : ''}>${icon('sparkles', 'sm')} ${t('Synthesise across meetings')}</button><button class="btn icon" data-act="more" aria-label="${t('More')}">${icon('more')}</button></div></div>
    <div class="note-grid"><div class="stack loose">
      <section class="panel" id="brief" ${tp.description ? '' : 'hidden'}><div class="panel-head"><h3>${icon('sparkles')} ${t('What has been said')}</h3></div><div class="md" id="brief-body">${tp.description ? renderMarkdown(tp.description) : ''}</div></section>
      <section class="panel"><div class="panel-head"><h3>${icon('clock')} ${t('Timeline')}</h3></div>
        ${tp.notes.length ? `<div class="stack">${tp.notes.map((n) => `<a class="card hover" href="#/note/${n.id}"><div class="row between"><b class="ellipsis">${esc(n.title || t('Untitled meeting'))}</b><span class="xsmall muted" style="flex:none">${fmtDate(n.createdAt, { day: 'numeric', month: 'short', year: 'numeric' })}</span></div>${n.topicSummary ? `<div class="small" style="margin-top:4px;color:var(--text-2)">${esc(n.topicSummary)}</div>` : `<div class="small muted clamp2" style="margin-top:4px">${esc(n.excerpt || '')}</div>`}</a>`).join('')}</div>` : `<div class="small muted">${t('No meetings.')}</div>`}
      </section>
      <section class="panel"><div class="panel-head"><h3>${icon('quote')} ${t('Who said what')}</h3><span class="badge">${tp.quotes.length}</span></div>
        ${tp.quotes.length ? `<div class="stack tight">${tp.quotes.map((q) => `<a class="quote" href="#/note/${q.noteId}?tab=transcript&seg=${q.segmentId}"><div class="src">${avatar(q.label, { cls: 'sm' })}<b>${esc(q.label)}</b> · ${esc(q.noteTitle || '')} · ${fmtDate(q.at, { day: 'numeric', month: 'short' })} ${fmtClock(q.startMs)}</div><div class="q">${safeSnippet(q.snippet)}</div></a>`).join('')}</div>` : `<div class="small muted">${t('No transcript lines mention this topic by name.')}</div>`}
      </section></div>
      <aside class="note-aside">
        <section class="panel"><div class="panel-head"><h3>${icon('users')} ${t('Who talks about it')}</h3></div>${tp.people.length ? `<div class="stack tight">${tp.people.slice(0, 10).map((p) => `<a class="row" href="#/person/${encodeURIComponent(p.name.toLowerCase())}" style="color:inherit">${avatar(p.name, { cls: 'sm' })}<span class="grow ellipsis small">${esc(p.name)}</span><span class="badge">${p.count}</span></a>`).join('')}</div>` : `<div class="small muted">—</div>`}</section>
        <section class="panel"><div class="panel-head"><h3>${icon('network')} ${t('Related topics')}</h3></div>${tp.related.length ? `<div class="chips">${tp.related.map((r) => `<a class="chip" href="#/topic/${r.id}">${esc(r.name)} <span class="faint">${r.shared}</span></a>`).join('')}</div>` : `<div class="small muted">${t('None yet.')}</div>`}</section>
        ${tp.glossary.length ? `<section class="panel"><div class="panel-head"><h3>${icon('book')} ${t('Glossary')}</h3></div><div class="stack tight">${tp.glossary.map((g) => `<a class="quote" href="#/term/${g.id}"><b>${esc(g.term)}</b><span class="xsmall muted clamp2">${esc(g.definition)}</span></a>`).join('')}</div></section>` : ''}
      </aside></div></div>`;
  main.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    try {
      if (b.dataset.act === 'back') history.length > 1 ? history.back() : go('#/topics');
      else if (b.dataset.act === 'brief') {
        b.disabled = true;
        const box = $('#brief', main), out = $('#brief-body', main);
        box.hidden = false; out.innerHTML = `<span class="muted">${t('Reading {n} meetings…', { n: tp.notes.length })}</span>`;
        let text = '';
        await stream(`/api/topics/${id}/brief`, {}, { onDelta: (d) => { text += d; out.innerHTML = renderMarkdown(text); } });
        b.disabled = false;
      } else if (b.dataset.act === 'more') {
        menu(b, [
          { label: t('Rename'), icon: 'edit', run: async () => { const n = await promptDialog(t('Rename topic'), tp.name, { hint: t('Renaming onto an existing topic merges the two.') }); if (n) { const r = await api('PATCH', `/api/topics/${id}`, { name: n }); window.dispatchEvent(new Event('wb:refresh')); go(`#/topic/${r.id}`); } } },
          { label: t('Merge into…'), icon: 'merge', run: async () => { const all = (await api('GET', '/api/topics')).filter((x) => x.id !== id); const n = await promptDialog(t('Merge “{name}” into', { name: tp.name }), '', { extra: `<div class="chips" style="max-height:200px;overflow:auto">${all.slice(0, 60).map((x) => `<button type="button" class="chip" data-suggest="${esc(x.name)}">${esc(x.name)}</button>`).join('')}</div>` }); const target = all.find((x) => x.name.toLowerCase() === (n?.value || '').toLowerCase()); if (target) { await api('POST', `/api/topics/${id}/merge`, { into: target.id }); window.dispatchEvent(new Event('wb:refresh')); go(`#/topic/${target.id}`); } } },
          { label: tp.pinned ? t('Unpin') : t('Pin (keep even when unused)'), icon: 'pin', run: async () => { await api('PATCH', `/api/topics/${id}`, { pinned: !tp.pinned }); done(); topicPage(main, id); } },
          { label: t('Hide this topic'), icon: 'eyeoff', run: async () => { await api('PATCH', `/api/topics/${id}`, { hidden: true }); window.dispatchEvent(new Event('wb:refresh')); go('#/topics'); } },
          'sep',
          { label: t('Delete topic'), icon: 'trash', danger: true, run: async () => { if (await confirmDialog(t('Delete the topic “{name}”? Meetings are not affected.', { name: tp.name }))) { await api('DELETE', `/api/topics/${id}`); window.dispatchEvent(new Event('wb:refresh')); go('#/topics'); } } },
        ], { align: 'end' });
      }
    } catch (err) { fail(err); b.disabled = false; }
  };
  void meetingRow;
}
