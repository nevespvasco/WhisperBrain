// Floating recorder. Lives in its own small always-on-top window while a recording runs and the app is not in
// front: a pill (pulsing dot + timer) that opens into the live transcript, like a glance at the meeting notes.
// It talks to the same local API as the main window; the only native help it needs is move / resize / "open app".
import { api, events } from './api.js';
import { setLang, t } from './i18n.js';
import { esc } from './md.js';
import { icon } from './icons.js';
import { speakerColor, fmtTimer } from './lib.js';

const root = document.getElementById('w');
const bridge = window.wbWidget || null; // present only inside the desktop app
const MAX_LINES = 80;

const S = { rec: { active: false }, expanded: false, lines: [], drafts: {}, level: { mic: 0, system: 0 }, saved: false };
let savedTimer = 0;

const stateOf = () => (S.saved ? 'saved' : !S.rec.active ? 'idle' : S.rec.finalizing ? 'finalizing' : S.rec.paused ? 'paused' : 'recording');
const statusText = () => {
  const s = stateOf();
  if (s === 'saved') return t('Notes saved');
  if (s === 'finalizing') return S.rec.stage === 'speakers' ? t('Identifying speakers…') : t('Finishing transcription…');
  if (s === 'paused') return t('Paused');
  return t('Recording');
};

function bars(v) {
  const n = Math.min(5, Math.round(Math.sqrt(v || 0) * 14));
  return `<span class="meter">${[0, 1, 2, 3, 4].map((i) => `<b style="height:${4 + i * 3}px;${i < n ? '' : 'background:var(--line-2)'}"></b>`).join('')}</span>`;
}

function linesHtml() {
  const open = Object.values(S.drafts).filter(Boolean).sort((a, b) => a.startMs - b.startMs).map((d) => ({ draft: true, label: d.speaker === 'me' ? t('Me') : t('Them'), speakerId: null, text: d.text }));
  const all = [...S.lines, ...open];
  if (!all.length) return `<div class="empty">${bars(Math.max(S.level.mic, S.level.system))}<div>${S.rec.finalizing ? esc(statusText()) : t('Listening…')}</div></div>`;
  let prev = null;
  return all.map((l) => {
    const head = l.label !== prev ? `<div class="who" style="color:${speakerColor(l.speakerId, l.label)}">${esc(l.label)}</div>` : '';
    prev = l.label;
    return `<div class="line${l.draft ? ' draft' : ''}">${head}<div class="txt">${esc(l.text)}</div></div>`;
  }).join('');
}

function render() {
  const state = stateOf();
  root.dataset.state = state;
  if (!S.expanded) {
    root.innerHTML = `<div class="pill" data-drag data-act="expand" role="button" tabindex="0" aria-label="${esc(t('Show live transcript'))}" title="${esc(t('Show live transcript'))}">
      <span class="dot"></span><span class="time">${fmtTimer(S.rec.elapsedMs || 0)}</span>
      ${state === 'recording' ? bars(Math.max(S.level.mic, S.level.system)) : `<span class="state">${esc(statusText())}</span>`}
      <span class="grow"></span><span class="chev">${icon('chevdown', 'sm')}</span></div>`;
    return;
  }
  const old = root.querySelector('.lines');
  const stick = !old || old.scrollHeight - old.scrollTop - old.clientHeight < 40;
  const busy = state === 'finalizing' || state === 'saved';
  root.innerHTML = `<section class="card">
    <header data-drag><span class="title"><span class="dot"></span><span class="time">${fmtTimer(S.rec.elapsedMs || 0)}</span><span class="sub">${esc(statusText())}</span></span>
      <button class="btn sm icon ghost" data-act="open" title="${esc(t('Open WhisperBrain'))}" aria-label="${esc(t('Open WhisperBrain'))}">${icon('external', 'sm')}</button>
      <button class="btn sm icon ghost" data-act="collapse" title="${esc(t('Minimise'))}" aria-label="${esc(t('Minimise'))}">${icon('chevdown', 'sm')}</button></header>
    <div class="lines">${linesHtml()}</div>
    <footer>
      <button class="btn sm" data-act="pause" ${busy ? 'disabled' : ''}>${icon(S.rec.paused ? 'play' : 'pause', 'sm')} ${S.rec.paused ? t('Resume') : t('Pause')}</button>
      <button class="btn sm stop" data-act="stop" ${busy ? 'disabled' : ''}>${icon('stop', 'sm')} ${t('Stop')}</button>
    </footer></section>`;
  const lines = root.querySelector('.lines');
  if (stick) lines.scrollTop = lines.scrollHeight; else if (old) lines.scrollTop = old.scrollTop;
}

let raf = 0;
const draw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };

function setExpanded(v) {
  S.expanded = v;
  bridge?.setExpanded(v);
  render();
}

async function loadLines() {
  if (!S.rec.active || !S.rec.noteId) return;
  try {
    const segs = await api('GET', `/api/notes/${encodeURIComponent(S.rec.noteId)}/transcript`);
    S.lines = segs.slice(-MAX_LINES).map((x) => ({ id: x.id, label: x.label, speakerId: x.speakerId, text: x.text }));
    draw();
  } catch { /* the server is restarting */ }
}
let relabel = 0;
const relabelSoon = () => { clearTimeout(relabel); relabel = setTimeout(loadLines, 400); };

function setRec(st) {
  clearTimeout(savedTimer);
  S.saved = false;
  if (st?.active) S.rec = { active: true, noteId: st.noteId, paused: !!st.paused, finalizing: !!st.finalizing, stage: st.stage || null, baseMs: st.elapsedMs || 0, base: Date.now(), elapsedMs: st.elapsedMs || 0 };
  else S.rec = { active: false };
}

async function sync() {
  try {
    setRec(await api('GET', '/api/recording'));
    if (S.rec.active) await loadLines(); else S.lines = [];
    draw();
  } catch { /* the server is restarting */ }
}

events({
  open: sync,
  'recording.started': (d) => { setRec({ active: true, noteId: d.noteId, elapsedMs: 0 }); S.lines = []; S.drafts = {}; draw(); },
  'recording.paused': () => { S.drafts = {}; S.rec.paused = true; S.rec.baseMs = S.rec.elapsedMs; draw(); },
  'recording.resumed': () => { S.rec.paused = false; S.rec.base = Date.now(); draw(); },
  'recording.finalizing': (d) => { S.rec.finalizing = true; S.rec.stage = d.stage || null; draw(); },
  'recording.stopped': () => {
    S.rec = { ...S.rec, active: false, finalizing: false };
    S.drafts = {};
    S.saved = true;
    draw();
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { S.saved = false; S.lines = []; S.rec = { active: false }; draw(); }, 4000);
  },
  'recording.level': (d) => { S.level = { mic: d.mic, system: d.system }; if (!S.expanded || !S.lines.length) draw(); },
  'transcript.segment': (d) => {
    const s = d.segment;
    S.lines.push({ id: s.id, label: s.label || (s.speaker === 'me' ? t('Me') : t('Them')), speakerId: s.speakerId, text: s.text });
    if (S.lines.length > MAX_LINES) S.lines.splice(0, S.lines.length - MAX_LINES);
    S.drafts = { ...S.drafts, [s.speaker === 'me' ? 'mic' : 'system']: null }; // the final text takes the draft's place
    draw();
  },
  'transcript.partial': (d) => { S.drafts = { ...S.drafts, [d.ch]: d.text ? d : null }; draw(); },
  'transcript.removed': (d) => { const gone = new Set(d.ids); S.lines = S.lines.filter((l) => !gone.has(l.id)); draw(); },
  'speakers.updated': relabelSoon,
  settings: () => applySettings(),
});

async function applySettings() {
  try {
    const s = await api('GET', '/api/settings');
    setLang(s.language);
    document.documentElement.dataset.theme = s.theme || 'system';
    draw();
  } catch { /* fall back to defaults */ }
}

setInterval(() => {
  if (S.rec.active && !S.rec.paused && !S.rec.finalizing && S.rec.base) {
    S.rec.elapsedMs = (S.rec.baseMs || 0) + (Date.now() - S.rec.base);
    for (const el of root.querySelectorAll('.time')) el.textContent = fmtTimer(S.rec.elapsedMs);
  }
}, 500);

// ---- interaction: click the pill to open it; drag it (or the card's title bar) to move it ----
let drag = null;
root.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('[data-drag]');
  if (!handle || e.target.closest('button')) return;
  drag = { x: e.screenX, y: e.screenY, moved: false, handle };
  handle.setPointerCapture?.(e.pointerId);
});
root.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  drag.x = e.screenX; drag.y = e.screenY;
  bridge?.move(dx, dy);
});
root.addEventListener('pointerup', (e) => {
  const d = drag;
  drag = null;
  if (d && !d.moved && d.handle.dataset.act === 'expand') setExpanded(true);
  d?.handle.releasePointerCapture?.(e.pointerId);
});
root.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.act === 'expand') { e.preventDefault(); setExpanded(true); } });
root.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  try {
    if (b.dataset.act === 'collapse') setExpanded(false);
    else if (b.dataset.act === 'open') { if (bridge) bridge.openApp(S.rec.noteId || ''); else window.open(`/#/note/${S.rec.noteId || ''}`, '_blank'); }
    else if (b.dataset.act === 'pause') await api('POST', `/api/recording/${S.rec.paused ? 'resume' : 'pause'}`);
    else if (b.dataset.act === 'stop') { b.disabled = true; await api('POST', '/api/recording/stop'); }
  } catch { b.disabled = false; }
});

applySettings().then(sync);
