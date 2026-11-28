// Topics across meetings. The overview offers four lenses on the same period-filtered snapshot: a map (topics
// discussed together are linked; by default only the links that hold the map together are drawn), themes
// (clusters of topics that travel together), trends (rising, new, gone quiet, and a heatmap over time) and a
// sortable list. The topic page has the meetings, who said what, related topics, activity and an AI synthesis.
import { S, $, $$, api, t, esc, icon, fail, done, go, debounce, empty, fmtDate, fmtClock, avatar, menu, promptDialog, confirmDialog, safeSnippet, plural, seg } from '../lib.js';
import { stream } from '../api.js';
import { renderMarkdown } from '../md.js';

const DAY = 86400000;
const PERIODS = { all: 0, 365: 365, 90: 90, 30: 30 };
const COLORS = ['#7c5cff', '#10b981', '#f59e0b', '#3b82f6', '#ec4899', '#14b8a6', '#f97316', '#0ea5e9', '#84cc16', '#e11d48', '#8b5cf6', '#ef6f6c'];
const LONE = '#8e8ca3';
const pref = (k, d) => { try { return localStorage.getItem(`wb.topics.${k}`) || d; } catch { return d; } };
const keep = (k, v) => { try { localStorage.setItem(`wb.topics.${k}`, v); } catch { /* private mode */ } };
const short = (s, n = 22) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const day = (ms) => fmtDate(ms, { day: 'numeric', month: 'short', year: 'numeric' });

let mode = pref('view', 'map');
if (!['map', 'themes', 'trends', 'list'].includes(mode)) mode = 'map';
let period = pref('period', 'all'), sort = pref('sort', 'count'), links = pref('links', 'key');
let selected = null, sim = null;

export async function render(main, ctx) {
  sim?.stop(); sim = null;
  const { name, parts } = ctx;
  if (name === 'topic' && parts[1]) return topicPage(main, parts[1]);
  const days = PERIODS[period] ?? 0;
  const ov = await api('GET', `/api/topics/overview?since=${days ? Date.now() - days * DAY : 0}`);
  if (ctx.alive && !ctx.alive()) return;   // the user moved on meanwhile (app.js route())
  const d = prepare(ov, days);
  const head = `<div class="page-head"><div><h1>${t('Topics')}</h1><div class="sub">${t('Subjects that come up across your meetings. Lines join topics discussed in the same meeting.')}</div></div>
    <div class="actions">${seg('mode', [['map', t('Map'), 'network'], ['themes', t('Themes'), 'layers'], ['trends', t('Trends'), 'graph'], ['list', t('List'), 'list']], mode)}</div></div>`;
  if (!d.topics.length && period === 'all') {
    main.innerHTML = `<div class="page">${head}<div class="panel">${empty('network', t('No topics yet'), t('Topics are extracted after each recording or import, and when you analyse a meeting. They connect meetings that talk about the same things.'), `<a class="btn primary" href="#/meetings">${t('Open a meeting')}</a>`)}</div></div>`;
    return;
  }
  const top = d.topics[0];
  const fresh = d.topics.filter((x) => x.firstEverAt && x.firstEverAt >= Date.now() - 30 * DAY).length;
  main.innerHTML = `<div class="page">${head}
    ${d.topics.length ? `<div class="stats-row tp-stats">
      <div class="card stat"><b>${d.topics.length}</b><span>${t('Topics')}</span></div>
      <div class="card stat"><b>${ov.meetings}</b><span>${t('Meetings with topics')}</span></div>
      <a class="card hover stat" href="#/topic/${top.id}"><b class="stat-name ellipsis" title="${esc(top.name)}">${esc(top.name)}</b><span>${t('Most discussed · {n} meetings', { n: top.notes })}</span></a>
      <div class="card stat"><b>${fresh}</b><span>${t('New in the last 30 days')}</span></div></div>` : ''}
    <div class="toolbar tp-toolbar"><div class="search-in">${icon('search', 'sm')}<input id="tp-q" type="search" placeholder="${t('Filter topics…')}"></div>
      ${seg('period', [['all', t('All time')], ['365', t('12 months')], ['90', t('90 days')], ['30', t('30 days')]], period)}
      <span class="small muted" id="tp-count"></span></div>
    <div id="tp-body"></div></div>`;
  let q = '';
  const draw = () => {
    sim?.stop(); sim = null;
    const box = $('#tp-body', main);
    const list = d.topics.filter((x) => !q || x.name.toLowerCase().includes(q) || x.theme.name.toLowerCase().includes(q));
    $('#tp-count', main).textContent = q ? t('{n} of {total}', { n: list.length, total: d.topics.length }) : t('{n} topics', { n: d.topics.length });
    if (!d.topics.length) { box.innerHTML = `<div class="panel">${empty('calendar', t('No topics in this period'), t('Try a longer period.'))}</div>`; return; }
    if (!list.length) { box.innerHTML = `<div class="panel">${empty('search', t('No topics match'))}</div>`; return; }
    if (mode === 'map') mapView(box, d, list);
    else if (mode === 'themes') themesView(box, d, list);
    else if (mode === 'trends') trendsView(box, d, list);
    else listView(box, d, list);
  };
  draw();
  main.onclick = (e) => {
    const sb = e.target.closest('[data-seg] [data-v]');
    if (sb) {
      const which = sb.closest('[data-seg]').dataset.seg, v = sb.dataset.v;
      $$('[data-v]', sb.closest('[data-seg]')).forEach((b) => b.setAttribute('aria-selected', String(b === sb)));
      if (which === 'mode') { mode = v; keep('view', v); draw(); }
      else if (which === 'period') { period = v; keep('period', v); render(main, ctx).catch(fail); }
      else if (which === 'sort') { sort = v; keep('sort', v); draw(); }
      else if (which === 'links') { links = v; keep('links', v); draw(); }
    }
  };
  $('#tp-q', main).addEventListener('input', debounce((e) => { q = e.target.value.trim().toLowerCase(); draw(); }, 200));
}

// ---------- data ----------

function prepare(ov, days) {
  const now = Date.now();
  const topics = ov.topics.map((x) => ({ ...x }));
  const byId = new Map(topics.map((x) => [x.id, x]));
  const edges = ov.edges.filter((e) => byId.has(e.source) && byId.has(e.target));
  const adj = new Map(topics.map((x) => [x.id, []]));
  for (const e of edges) { adj.get(e.source).push({ id: e.target, w: e.weight }); adj.get(e.target).push({ id: e.source, w: e.weight }); }
  for (const [id, l] of adj) { l.sort((a, b) => b.w - a.w || byId.get(b.id).notes - byId.get(a.id).notes); byId.get(id).links = l.length; }
  const firsts = topics.map((x) => x.firstAt).filter(Boolean);
  // at least eight weeks on screen so a handful of meetings still reads as a timeline
  const start = days ? now - days * DAY : Math.min(firsts.length ? Math.min(...firsts) : now, now - 56 * DAY);
  const themes = clusterize(topics, adj, byId, ov.titles || {});
  return { topics, byId, edges, adj, keyEdges: backbone(topics, edges, byId), themes, start, end: now };
}

// Label propagation over the co-occurrence graph: topics that keep turning up together end up in one theme.
function clusterize(topics, adj, byId, titles = {}) {
  const label = new Map(topics.map((x) => [x.id, x.id]));
  const order = [...topics].sort((a, b) => b.notes - a.notes || a.name.localeCompare(b.name));
  for (let it = 0; it < 15; it++) {
    let changed = false;
    for (const n of order) {
      const score = new Map();
      for (const { id, w } of adj.get(n.id)) { const l = label.get(id); score.set(l, (score.get(l) || 0) + w); }
      let best = label.get(n.id), bs = score.get(best) || 0;
      for (const [l, s] of score) if (s > bs || (s === bs && byId.get(l).notes > byId.get(best).notes)) { best = l; bs = s; }
      if (best !== label.get(n.id)) { label.set(n.id, best); changed = true; }
    }
    if (!changed) break;
  }
  const groups = new Map(), lone = [];
  for (const x of order) {
    if (!adj.get(x.id).length) { lone.push(x); continue; }
    const l = label.get(x.id);
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(x);
  }
  const themes = [...groups.values()].map((members) => ({ members }));
  if (lone.length) themes.push({ members: lone, lone: true });
  themes.sort((a, b) => (a.lone ? 1 : 0) - (b.lone ? 1 : 0) || sum(b.members) - sum(a.members));
  return themes.map((th, i) => {
    const color = th.lone ? LONE : COLORS[i % COLORS.length];
    const notes = new Set(th.members.flatMap((x) => x.noteIds));
    const out = { i, lone: !!th.lone, color, topics: th.members, meetings: notes.size, dates: [...new Set(th.members.flatMap((x) => x.dates))],
      lastAt: Math.max(0, ...th.members.map((x) => x.lastAt || 0)),
      name: th.lone ? t('Standalone topics') : themeName(th.members, notes, titles) };
    for (const x of th.members) { x.color = color; x.theme = out; }
    return out;
  });
}
const sum = (list) => list.reduce((s, x) => s + x.notes, 0);

// A theme is named after what it is about: the meeting it comes from when all its topics were raised in one meeting (and that
// meeting has a title), otherwise its two most-discussed topics, phrases ahead of single words.
function themeName(members, noteIds, titles) {
  if (noteIds.size === 1) { const ti = titles[[...noteIds][0]]; if (ti) return short(ti, 42); }
  const rank = (x) => x.notes * 10 + Math.min(3, x.name.split(/\s+/).length) * 3;
  return [...members].sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name)).slice(0, 2).map((x) => x.name).join(' · ');
}

// The links worth drawing: a maximum spanning forest (every topic hangs off its strongest partner, so the map
// stays connected without a hairball) plus any pairing that recurs across meetings.
function backbone(topics, edges, byId) {
  const parent = new Map(topics.map((x) => [x.id, x.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const mass = (e) => byId.get(e.source).notes + byId.get(e.target).notes;
  const maxW = Math.max(1, ...edges.map((e) => e.weight));
  const kept = new Set();
  for (const e of [...edges].sort((a, b) => b.weight - a.weight || mass(b) - mass(a))) {
    const a = find(e.source), b = find(e.target);
    if (a !== b) { parent.set(a, b); kept.add(e); } else if (e.weight >= 2 && e.weight >= maxW * 0.5) kept.add(e);
  }
  return edges.filter((e) => kept.has(e));
}

function counts(dates, start, end, n) {
  const span = Math.max(1, end - start), b = new Array(n).fill(0);
  for (const at of dates) if (at >= start) b[Math.min(n - 1, Math.floor(((at - start) / span) * n))]++;
  return b;
}
// Tiny bar sparkline of how often something came up between start and end.
function spark(dates, start, end, n = 12, cls = '') {
  const b = counts(dates, start, end, n), max = Math.max(...b, 1);
  return `<svg class="spark ${cls}" viewBox="0 0 ${n * 4} 20" preserveAspectRatio="none" aria-hidden="true">${b.map((c, i) => {
    const h = c ? Math.max(4, (c / max) * 20) : 1.5;
    return `<rect x="${i * 4 + 0.5}" y="${20 - h}" width="3" height="${h}" rx="0.8"${c ? '' : ' class="z"'}></rect>`;
  }).join('')}</svg>`;
}
// Rows with a bar for how often each topic shares a meeting with the current one.
function relBars(items, { href = false } = {}) {
  const max = Math.max(1, ...items.map((x) => x.w));
  return `<div class="relbars">${items.map((x) => {
    const inner = `<span class="dot" style="background:${x.color || 'var(--accent)'}"></span><span class="grow ellipsis">${esc(x.name)}</span><span class="bar"><i style="width:${Math.round((x.w / max) * 100)}%"></i></span><span class="n">${x.w}</span>`;
    return href ? `<a class="relbar" href="#/topic/${x.id}" title="${esc(t('Together in {n} meetings', { n: x.w }))}">${inner}</a>`
      : `<button type="button" class="relbar" data-select="${x.id}" title="${esc(t('Together in {n} meetings', { n: x.w }))}">${inner}</button>`;
  }).join('')}</div>`;
}

// ---------- map ----------

function mapView(box, d, list) {
  const ids = new Set(list.map((x) => x.id));
  const all = d.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const shown = links === 'all' ? all : d.keyEdges.filter((e) => ids.has(e.source) && ids.has(e.target));
  if (selected && !ids.has(selected)) selected = null;
  box.innerHTML = `<div class="tp-map">
      <div class="graph-wrap"><svg class="graph" id="graph" role="img" aria-label="${t('Topic map')}"></svg>
        <div class="graph-tools"><button type="button" class="btn icon" data-zoom="in" title="${t('Zoom in')}" aria-label="${t('Zoom in')}">${icon('plus', 'sm')}</button><button type="button" class="btn icon" data-zoom="out" title="${t('Zoom out')}" aria-label="${t('Zoom out')}"><b aria-hidden="true">−</b></button><button type="button" class="btn icon" data-zoom="fit" title="${t('Fit to view')}" aria-label="${t('Fit to view')}">${icon('refresh', 'sm')}</button></div>
        <div class="graph-foot">${seg('links', [['key', t('Key links')], ['all', t('All links')]], links)}<span class="xsmall muted hide-sm">${t('Scroll to zoom · drag to move · click a topic for details')}</span></div></div>
      <aside class="panel tp-aside" id="tp-aside"></aside></div>`;
  const aside = $('#tp-aside', box);
  let focusTheme = null;
  const paint = () => { aside.innerHTML = asideHtml(d, selected, ids, focusTheme); };
  const select = (id) => { selected = id; focusTheme = null; graph.select(id); paint(); };
  const graph = forceGraph($('#graph', box), { nodes: list, edges: shown, all, adj: d.adj }, { onSelect: select, onOpen: (id) => go(`#/topic/${id}`) });
  sim = graph;
  paint();
  if (selected) graph.select(selected);
  box.onclick = (e) => {
    const z = e.target.closest('[data-zoom]'); if (z) return graph.zoom(z.dataset.zoom);
    const s = e.target.closest('[data-select]'); if (s) return select(s.dataset.select);
    if (e.target.closest('[data-act="clear"]')) return select(null);
    const th = e.target.closest('[data-theme]');
    if (th) { const i = Number(th.dataset.theme); focusTheme = focusTheme === i ? null : i; graph.theme(focusTheme); paint(); }
  };
}

function asideHtml(d, id, ids, focusTheme) {
  const x = id && d.byId.get(id);
  if (!x) {
    const themes = d.themes.filter((th) => th.topics.some((tp) => ids.has(tp.id)));
    return `<div class="panel-head"><h3>${icon('layers')} ${t('Themes')}</h3></div>
      <p class="xsmall muted tp-hint">${t('Topics often discussed together share a colour. Pick a theme to highlight it.')}</p>
      <div class="stack tight">${themes.slice(0, 10).map((th) => `<button type="button" class="theme-row" data-theme="${th.i}" aria-pressed="${focusTheme === th.i}"><span class="dot" style="background:${th.color}"></span><span class="grow ellipsis">${esc(th.name)}</span><span class="badge">${th.topics.length}</span></button>`).join('')}</div>`;
  }
  const nb = d.adj.get(id).filter((n) => ids.has(n.id)).map((n) => ({ ...n, name: d.byId.get(n.id).name, color: d.byId.get(n.id).color }));
  return `<div class="tp-sel">
    <div class="row between"><span class="badge" style="background:${x.color}22;color:${x.color}">${esc(short(x.theme.name, 30))}</span><button type="button" class="btn ghost icon" data-act="clear" title="${t('Clear selection')}" aria-label="${t('Clear selection')}">${icon('x', 'sm')}</button></div>
    <h3>${esc(x.name)}</h3>
    <div class="xsmall muted">${plural(x.notes, 'meeting', 'meetings')}${x.firstAt ? ` · ${day(x.firstAt)}${x.lastAt !== x.firstAt ? ` → ${day(x.lastAt)}` : ''}` : ''}</div>
    ${x.description ? `<p class="small clamp3 tp-desc">${esc(x.description.replace(/[#*_`>]/g, ''))}</p>` : ''}
    <div class="tp-lbl">${t('Activity')}</div>${spark(x.dates, d.start, d.end, 24, 'lg')}
    <div class="row between xsmall faint"><span>${day(d.start)}</span><span>${t('Today')}</span></div>
    <div class="tp-lbl">${t('Often discussed with')}</div>
    ${nb.length ? relBars(nb.slice(0, 8)) : `<div class="small muted">${t('Not discussed alongside other topics yet.')}</div>`}
    <a class="btn primary tp-open" href="#/topic/${x.id}">${t('Open topic')} ${icon('arrowright', 'sm')}</a></div>`;
}

// Small force-directed layout in SVG (no library) with zoom/pan. Returns { stop, select, theme, zoom }.
function forceGraph(svg, { nodes, edges, all, adj }, { onSelect, onOpen }) {
  const W = svg.clientWidth || 800, H = svg.clientHeight || 460;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const maxN = Math.max(...nodes.map((n) => n.notes), 1);
  const labelled = new Set([...nodes].sort((a, b) => b.notes - a.notes).slice(0, 12).map((n) => n.id));
  // start each theme around its own spot on a ring so the layout settles quickly into groups
  const themeIdx = [...new Set(nodes.map((n) => n.theme.i))];
  const ring = Math.min(W, H) * 0.28;
  const N = nodes.map((n, i) => {
    const ti = themeIdx.indexOf(n.theme.i), a = (ti / Math.max(1, themeIdx.length)) * Math.PI * 2;
    const cx = themeIdx.length > 1 ? W / 2 + Math.cos(a) * ring : W / 2, cy = themeIdx.length > 1 ? H / 2 + Math.sin(a) * ring * 0.8 : H / 2;
    return { ...n, r: 5 + 10 * Math.sqrt(n.notes / maxN), x: cx + Math.cos(i * 2.4) * (12 + (i % 7) * 6), y: cy + Math.sin(i * 2.4) * (12 + (i % 5) * 6), vx: 0, vy: 0 };
  });
  const REST = Math.max(48, Math.min(140, Math.sqrt((W * H) / Math.max(nodes.length, 1)) * 0.95)), REPEL = REST * REST * 0.6;
  const idx = new Map(N.map((n, i) => [n.id, i]));
  const E = edges.map((e) => ({ s: idx.get(e.source), t: idx.get(e.target), w: e.weight }));
  const maxW = Math.max(...E.map((e) => e.w), 1);
  svg.innerHTML = `<g class="vp"><g class="edges">${E.map((e) => `<line stroke-width="${1 + 2.5 * (e.w / maxW)}"></line>`).join('')}</g><g class="focus-edges"></g>
    <g class="nodes">${N.map((n) => `<g class="node${labelled.has(n.id) ? '' : ' minor'}" data-id="${n.id}" tabindex="0" role="button" aria-label="${esc(n.name)}"><circle r="${n.r}" fill="${n.color}"></circle><text dy="${n.r + 13}" text-anchor="middle">${esc(short(n.name))}</text><title>${esc(n.name)} — ${n.notes} ${n.notes === 1 ? t('meeting') : t('meetings')}</title></g>`).join('')}</g></g>`;
  const vp = svg.querySelector('.vp'), focusG = svg.querySelector('.focus-edges');
  const lines = [...svg.querySelectorAll('.edges line')], groups = [...svg.querySelectorAll('.node')];
  const view = { k: 1, x: 0, y: 0 };
  const applyView = () => { vp.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.k})`; svg.classList.toggle('zoomed', view.k > 1.35); };
  let fitted = false, alpha = 1, raf = 0, drag = null, pan = null, moved = false, hover = null, sel = null, themeOn = null;
  const kick = (a = 0.3) => { alpha = Math.max(alpha, a); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); };
  // step(): the physics only; paint(): writes it to the SVG. The first ~1.5 s of settling runs before the map is first drawn,
  // so it appears nearly in place and only eases for a moment, instead of rewriting every node for four seconds.
  function step() {
    for (let i = 0; i < N.length; i++) {
      const a = N[i];
      for (let j = i + 1; j < N.length; j++) {
        const b = N[j];
        let dx = b.x - a.x, dy = b.y - a.y; const d2 = dx * dx + dy * dy || 1;
        const min = a.r + b.r + 26;
        const f = (REPEL / d2) * alpha * (d2 < min * min ? 3 : 1);
        const dd = Math.sqrt(d2); dx /= dd; dy /= dd;
        a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
      }
    }
    for (const e of E) {
      const a = N[e.s], b = N[e.t];
      const dx = b.x - a.x, dy = b.y - a.y, dd = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (dd - REST) * 0.012 * alpha * (0.7 + e.w / maxW);
      a.vx += (dx / dd) * f; a.vy += (dy / dd) * f; b.vx -= (dx / dd) * f; b.vy -= (dy / dd) * f;
    }
    // keep each theme together even where the drawn links are sparse
    const cent = new Map();
    for (const n of N) { if (n.theme.lone) continue; const c = cent.get(n.theme.i) || { x: 0, y: 0, k: 0 }; c.x += n.x; c.y += n.y; c.k++; cent.set(n.theme.i, c); }
    for (const n of N) {
      const c = cent.get(n.theme.i);
      if (c && c.k > 1) { n.vx += (c.x / c.k - n.x) * 0.01 * alpha; n.vy += (c.y / c.k - n.y) * 0.01 * alpha; }
      n.vx += (W / 2 - n.x) * 0.0025 * alpha; n.vy += (H / 2 - n.y) * 0.004 * alpha;
      if (n === drag) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.8; n.vy *= 0.8;
      const sp = Math.hypot(n.vx, n.vy); if (sp > 12) { n.vx *= 12 / sp; n.vy *= 12 / sp; } // no node gets flung across the map
      n.x += n.vx; n.y += n.vy;
      const x = Math.max(n.r + 30, Math.min(W - n.r - 30, n.x)), y = Math.max(n.r + 6, Math.min(H - n.r - 40, n.y));
      if (x !== n.x) { n.x = x; n.vx = 0; }
      if (y !== n.y) { n.y = y; n.vy = 0; }
    }
    alpha *= 0.982;
  }
  function paint() {
    E.forEach((e, i) => { const a = N[e.s], b = N[e.t]; lines[i].setAttribute('x1', a.x); lines[i].setAttribute('y1', a.y); lines[i].setAttribute('x2', b.x); lines[i].setAttribute('y2', b.y); });
    N.forEach((n, i) => groups[i].setAttribute('transform', `translate(${n.x},${n.y})`));
    drawFocus();
  }
  function tick() {
    step(); paint();
    if (alpha > 0.015 || drag) raf = requestAnimationFrame(tick);
    else if (!fitted) { fitted = true; fit(); }
  }
  // frame the settled layout so it fills the canvas (without zooming in far enough to reveal every label)
  function fit() {
    if (!N.length) return;
    const x0 = Math.min(...N.map((n) => n.x - n.r)) - 40, x1 = Math.max(...N.map((n) => n.x + n.r)) + 40;
    const y0 = Math.min(...N.map((n) => n.y - n.r)) - 16, y1 = Math.max(...N.map((n) => n.y + n.r)) + 30;
    const k = Math.max(0.6, Math.min(1.3, W / (x1 - x0), H / (y1 - y0)));
    view.k = k; view.x = W / 2 - ((x0 + x1) / 2) * k; view.y = H / 2 - ((y0 + y1) / 2) * k;
    vp.classList.add('fitting'); applyView(); setTimeout(() => vp.classList.remove('fitting'), 400);
  }
  // the focused topic shows every one of its links, not just the key ones
  function drawFocus() {
    const id = hover ?? sel;
    if (id == null || !idx.has(id)) { focusG.innerHTML = ''; return; }
    const a = N[idx.get(id)];
    focusG.innerHTML = adj.get(id).filter((x) => idx.has(x.id)).map((x) => { const b = N[idx.get(x.id)]; return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${1.2 + 2.5 * Math.min(1, x.w / maxW)}"></line>`; }).join('');
  }
  function emphasise() {
    const id = hover ?? sel;
    svg.classList.toggle('focus', id != null || themeOn != null);
    const near = id != null ? new Set([id, ...adj.get(id).map((x) => x.id)]) : null;
    groups.forEach((g, i) => {
      const n = N[i];
      const on = near ? near.has(n.id) : themeOn != null ? n.theme.i === themeOn : true;
      g.classList.toggle('dim', !on); g.classList.toggle('hl', !!near && on); g.classList.toggle('sel', n.id === sel);
    });
    lines.forEach((l, i) => { const e = E[i]; l.classList.toggle('dim', near ? true : themeOn != null ? !(N[e.s].theme.i === themeOn && N[e.t].theme.i === themeOn) : false); });
    drawFocus();
  }
  const pt = (ev) => { const r = svg.getBoundingClientRect(); return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H }; };
  const world = (p) => ({ x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k });
  const zoomAt = (p, f) => { const k = Math.max(0.5, Math.min(4, view.k * f)); view.x = p.x - (p.x - view.x) * (k / view.k); view.y = p.y - (p.y - view.y) * (k / view.k); view.k = k; applyView(); };
  svg.addEventListener('pointerdown', (ev) => {
    const g = ev.target.closest('.node'); moved = false; svg.setPointerCapture(ev.pointerId);
    if (g) { drag = N[groups.indexOf(g)]; kick(); } else { pan = { ...pt(ev), vx: view.x, vy: view.y }; svg.classList.add('panning'); }
  });
  svg.addEventListener('pointermove', (ev) => {
    if (drag) { const p = world(pt(ev)); if (Math.abs(p.x - drag.x) + Math.abs(p.y - drag.y) > 2) moved = true; drag.x = p.x; drag.y = p.y; }
    else if (pan) { const p = pt(ev); if (Math.abs(p.x - pan.x) + Math.abs(p.y - pan.y) > 3) moved = true; view.x = pan.vx + p.x - pan.x; view.y = pan.vy + p.y - pan.y; applyView(); }
  });
  svg.addEventListener('pointerup', () => {
    if (drag && !moved) onSelect(drag.id === sel ? null : drag.id);
    else if (pan && !moved) onSelect(null);
    drag = null; pan = null; svg.classList.remove('panning');
  });
  svg.addEventListener('dblclick', (ev) => { const g = ev.target.closest('.node'); if (g) onOpen(g.dataset.id); });
  svg.addEventListener('keydown', (ev) => { const g = ev.target.closest('.node'); if (g && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); if (g.dataset.id === sel && ev.key === 'Enter') onOpen(sel); else onSelect(g.dataset.id); } });
  svg.addEventListener('wheel', (ev) => { ev.preventDefault(); zoomAt(pt(ev), Math.exp(-ev.deltaY * 0.0015)); }, { passive: false });
  svg.addEventListener('pointerover', (ev) => { const g = ev.target.closest('.node'); const id = g?.dataset.id ?? null; if (id !== hover) { hover = id; emphasise(); } });
  svg.addEventListener('pointerleave', () => { if (hover != null) { hover = null; emphasise(); } });
  applyView();
  for (let k = 0; k < 240 && alpha > 0.03; k++) step();
  paint();
  raf = requestAnimationFrame(tick);
  return {
    stop() { cancelAnimationFrame(raf); },
    select(id) { sel = id; themeOn = null; emphasise(); },
    theme(i) { themeOn = i; sel = null; emphasise(); },
    zoom(how) { if (how === 'fit') fit(); else zoomAt({ x: W / 2, y: H / 2 }, how === 'in' ? 1.3 : 1 / 1.3); },
  };
}

// ---------- themes ----------

function themesView(box, d, list) {
  const ids = new Set(list.map((x) => x.id));
  const themes = d.themes.filter((th) => th.topics.some((x) => ids.has(x.id)));
  box.innerHTML = `<p class="small muted tp-hint">${t('Themes group topics that keep coming up in the same meetings.')}</p>
    <div class="theme-grid">${themes.map((th) => {
      const members = th.topics.filter((x) => ids.has(x.id));
      return `<section class="card theme-card" style="--c:${th.color}">
        <div class="row between"><h3 class="ellipsis"><span class="dot" style="background:${th.color}"></span><span class="ellipsis">${esc(th.name)}</span></h3><span class="badge">${plural(members.length, 'topic', 'topics')}</span></div>
        <div class="xsmall muted">${plural(th.meetings, 'meeting', 'meetings')}${th.lastAt ? ` · ${t('Last discussed {date}', { date: day(th.lastAt) })}` : ''}</div>
        ${spark(th.dates, d.start, d.end, 24, 'wide')}
        <div class="chips">${members.slice(0, 14).map((x) => `<a class="chip" href="#/topic/${x.id}">${esc(short(x.name, 28))} <span class="faint">${x.notes}</span></a>`).join('')}${members.length > 14 ? `<span class="chip static">+${members.length - 14}</span>` : ''}</div></section>`;
    }).join('')}</div>`;
}

// ---------- trends ----------

function columns(start, end) {
  const span = end - start;
  const unit = span <= 120 * DAY ? 'week' : span <= 730 * DAY ? 'month' : 'quarter';
  const s0 = new Date(start);
  let c = unit === 'week' ? new Date(s0.getFullYear(), s0.getMonth(), s0.getDate() - ((s0.getDay() + 6) % 7))
    : new Date(s0.getFullYear(), unit === 'month' ? s0.getMonth() : s0.getMonth() - (s0.getMonth() % 3), 1);
  const out = [];
  while (c.getTime() <= end) {
    const s = c.getTime(), from = c;
    c = unit === 'week' ? new Date(c.getFullYear(), c.getMonth(), c.getDate() + 7) : new Date(c.getFullYear(), c.getMonth() + (unit === 'month' ? 1 : 3), 1);
    const label = unit === 'week' ? fmtDate(s, { day: 'numeric', month: 'short' })
      : unit === 'month' ? fmtDate(s, from.getMonth() === 0 || !out.length ? { month: 'short', year: '2-digit' } : { month: 'short' })
        : t('Q{n} ’{yy}', { n: Math.floor(from.getMonth() / 3) + 1, yy: String(from.getFullYear()).slice(2) });
    out.push({ s, e: c.getTime(), label });
  }
  return out.slice(-16);
}

function trendsView(box, d, list) {
  const now = d.end, mid = d.start + (d.end - d.start) / 2;
  const rising = list.map((x) => { const late = x.dates.filter((a) => a >= mid).length; return { x, diff: late - (x.notes - late), late }; })
    .filter((r) => r.diff > 0).sort((a, b) => b.diff - a.diff || b.late - a.late).slice(0, 6).map((r) => ({ x: r.x, note: `+${r.diff}` }));
  const fresh = list.filter((x) => x.firstEverAt && x.firstEverAt >= now - 30 * DAY).sort((a, b) => b.firstEverAt - a.firstEverAt).slice(0, 6).map((x) => ({ x, note: fmtDate(x.firstEverAt, { day: 'numeric', month: 'short' }) }));
  const quiet = list.filter((x) => x.notes >= 2 && x.lastAt && x.lastAt < now - 30 * DAY).sort((a, b) => b.notes - a.notes).slice(0, 6).map((x) => ({ x, note: fmtDate(x.lastAt, { day: 'numeric', month: 'short' }) }));
  const card = (ic, title, hint, rows) => `<section class="card trend-card"><h3>${icon(ic, 'sm')} ${title}</h3><div class="xsmall muted">${hint}</div>
    ${rows.length ? `<div class="stack tight mt-s">${rows.map(({ x, note }) => `<a class="trend-row" href="#/topic/${x.id}"><span class="dot" style="background:${x.color}"></span><span class="grow ellipsis">${esc(x.name)}</span>${spark(x.dates, d.start, d.end, 10)}<span class="xsmall muted n">${note}</span></a>`).join('')}</div>` : `<div class="small muted mt-s">${t('Nothing here.')}</div>`}</section>`;
  const cols = columns(d.start, d.end);
  const rows = [...list].sort((a, b) => b.notes - a.notes).slice(0, 25).map((x) => ({ x, c: cols.map((col) => x.dates.filter((a) => a >= col.s && a < col.e).length) }));
  const max = Math.max(1, ...rows.flatMap((r) => r.c));
  box.innerHTML = `<div class="trend-cards">
      ${card('bolt', t('Rising'), t('Came up more in the second half of this period'), rising)}
      ${card('sparkles', t('New topics'), t('First came up in the last 30 days'), fresh)}
      ${card('clock', t('Gone quiet'), t('Not discussed in the last 30 days'), quiet)}</div>
    <section class="panel mt"><div class="panel-head"><h3>${icon('graph')} ${t('Over time')}</h3>${list.length > 25 ? `<span class="xsmall muted">${t('Showing the {n} most discussed', { n: 25 })}</span>` : ''}</div>
      <div class="heat-wrap"><table class="heat"><thead><tr><th></th>${cols.map((c) => `<th scope="col">${esc(c.label)}</th>`).join('')}<th scope="col">${t('Total')}</th></tr></thead>
      <tbody>${rows.map(({ x, c }) => `<tr><th scope="row"><a href="#/topic/${x.id}" title="${esc(x.name)}"><span class="dot" style="background:${x.color}"></span><span class="ellipsis">${esc(x.name)}</span></a></th>${c.map((v, i) => `<td><span class="cell" title="${esc(`${x.name} · ${cols[i].label}: ${v}`)}" style="${v ? `background:color-mix(in srgb, var(--accent) ${Math.round(18 + 72 * (v / max))}%, transparent)` : ''}">${v || ''}</span></td>`).join('')}<td class="tot">${x.notes}</td></tr>`).join('')}</tbody></table></div></section>`;
}

// ---------- list ----------

const SORTS = {
  count: (a, b) => b.notes - a.notes || (b.lastAt || 0) - (a.lastAt || 0),
  recent: (a, b) => (b.lastAt || 0) - (a.lastAt || 0) || b.notes - a.notes,
  links: (a, b) => b.links - a.links || b.notes - a.notes,
  name: (a, b) => a.name.localeCompare(b.name),
};

function listView(box, d, list) {
  const rows = [...list].sort((a, b) => b.pinned - a.pinned || (SORTS[sort] || SORTS.count)(a, b));
  box.innerHTML = `<div class="tp-sortbar">${seg('sort', [['count', t('Most discussed')], ['recent', t('Latest')], ['links', t('Most connected')], ['name', t('A–Z')]], sort)}</div>
    <div class="list">${rows.map((x) => `<a class="li" href="#/topic/${x.id}"><span class="dot lg" style="background:${x.color}"></span>
      <div class="main-t"><div class="t">${x.pinned ? `${icon('pin', 'sm')} ` : ''}${esc(x.name)}</div><div class="s">${esc((x.description || '').replace(/[#*_`>]/g, '') || x.theme.name)}</div></div>
      <div class="side">${spark(x.dates, d.start, d.end, 12)}<span class="badge">${plural(x.notes, 'meeting', 'meetings')}</span><span class="hide-sm tp-links">${t('{n} links', { n: x.links })}</span><span class="hide-sm tp-date">${x.lastAt ? fmtDate(x.lastAt, { day: 'numeric', month: 'short' }) : ''}</span></div></a>`).join('')}</div>`;
}

// ---------- one topic ----------

async function topicPage(main, id) {
  const tp = await api('GET', `/api/topics/${id}`);
  const first = tp.notes[tp.notes.length - 1], last = tp.notes[0];
  const dates = tp.notes.map((n) => n.createdAt).filter(Boolean);
  const now = Date.now(), from = Math.min(dates.length ? Math.min(...dates) : now, now - 90 * DAY);
  main.innerHTML = `<div class="page">
    <div class="note-top"><button class="btn ghost icon" data-act="back" aria-label="${t('Back')}">${icon('back')}</button>
      <div class="tt"><h1 style="font-size:26px">${icon('hash', 'lg')} ${esc(tp.name)}</h1><div class="note-meta"><span>${icon('video', 'sm')}${tp.notes.length} ${tp.notes.length === 1 ? t('meeting') : t('meetings')}</span>${first ? `<span>${icon('calendar', 'sm')}${day(first.createdAt)}${last !== first ? ` → ${day(last.createdAt)}` : ''}</span>` : ''}<span>${icon('users', 'sm')}${tp.people.length} ${t('people')}</span></div></div>
      <div class="note-actions"><button class="btn primary" data-act="brief" ${!S.state?.llmConfigured ? 'disabled title="' + t('Needs an AI model') + '"' : ''}>${icon('sparkles', 'sm')} ${t('Synthesise across meetings')}</button><button class="btn icon" data-act="more" aria-label="${t('More')}">${icon('more')}</button></div></div>
    <div class="note-grid"><div class="stack loose">
      <section class="panel" id="brief" ${tp.description ? '' : 'hidden'}><div class="panel-head"><h3>${icon('sparkles')} ${t('What has been said')}</h3></div><div class="md" id="brief-body">${tp.description ? renderMarkdown(tp.description) : ''}</div></section>
      <section class="panel"><div class="panel-head"><h3>${icon('clock')} ${t('Timeline')}</h3></div>
        ${tp.notes.length ? `<div class="stack">${tp.notes.map((n) => `<a class="card hover" href="#/note/${n.id}"><div class="row between"><b class="ellipsis">${esc(n.title || t('Untitled meeting'))}</b><span class="xsmall muted" style="flex:none">${day(n.createdAt)}</span></div>${n.topicSummary ? `<div class="small" style="margin-top:4px;color:var(--text-2)">${esc(n.topicSummary)}</div>` : `<div class="small muted clamp2" style="margin-top:4px">${esc(n.excerpt || '')}</div>`}</a>`).join('')}</div>` : `<div class="small muted">${t('No meetings.')}</div>`}
      </section>
      <section class="panel"><div class="panel-head"><h3>${icon('quote')} ${t('Who said what')}</h3><span class="badge">${tp.quotes.length}</span></div>
        ${tp.quotes.length ? `<div class="stack tight">${tp.quotes.map((q) => `<a class="quote" href="#/note/${q.noteId}?tab=transcript&seg=${q.segmentId}"><div class="src">${avatar(q.label, { cls: 'sm' })}<b>${esc(q.label)}</b> · ${esc(q.noteTitle || '')} · ${fmtDate(q.at, { day: 'numeric', month: 'short' })} ${fmtClock(q.startMs)}</div><div class="q">${safeSnippet(q.snippet)}</div></a>`).join('')}</div>` : `<div class="small muted">${t('No transcript lines mention this topic by name.')}</div>`}
      </section></div>
      <aside class="note-aside">
        <section class="panel"><div class="panel-head"><h3>${icon('graph')} ${t('Activity')}</h3></div>${spark(dates, from, now, 24, 'lg')}<div class="row between xsmall faint mt-s"><span>${day(from)}</span><span>${t('Today')}</span></div></section>
        <section class="panel"><div class="panel-head"><h3>${icon('users')} ${t('Who talks about it')}</h3></div>${tp.people.length ? `<div class="stack tight">${tp.people.slice(0, 10).map((p) => `<a class="row" href="#/person/${encodeURIComponent(p.name.toLowerCase())}" style="color:inherit">${avatar(p.name, { cls: 'sm' })}<span class="grow ellipsis small">${esc(p.name)}</span><span class="badge">${p.count}</span></a>`).join('')}</div>` : `<div class="small muted">—</div>`}</section>
        <section class="panel"><div class="panel-head"><h3>${icon('network')} ${t('Often discussed with')}</h3></div>${tp.related.length ? relBars(tp.related.map((r) => ({ id: r.id, name: r.name, w: r.shared })), { href: true }) : `<div class="small muted">${t('None yet.')}</div>`}</section>
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
}
