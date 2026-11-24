// Floating recorder. Lives in its own small always-on-top window while a recording runs and the app is not in
// front: a pill (pulsing dot + timer) that opens into the live transcript, like a glance at the meeting notes.
// It talks to the same local API as the main window; the only native help it needs is move / resize / "open app".
import { api, events } from './api.js';
import { setLang, t } from './i18n.js';
import { esc } from './md.js';
import { icon } from './icons.js';
import { speakerColor, fmtTimer, speakerText, lineText } from './lib.js';
import { getConsent, setConsent, copyNotice } from './consent.js';
import { follow } from './follow.js';

const root = document.getElementById('w');
const bridge = window.wbWidget || null; // present only inside the desktop app
const MAX_LINES = 80;

const S = { rec: { active: false }, expanded: false, lines: [], drafts: {}, level: { mic: 0, system: 0 }, saved: false };
// Live translation (Settings → Translation): when it is on, each line is shown with its translation into the first language chosen.
// tx: { lang, view } or null; tr: line id -> translation. The map, not the lines, holds what arrived, so a reload of the lines or a
// translation that comes before its line loses nothing.
S.tx = null;
S.tr = new Map();
let savedTimer = 0;

const stateOf = () => (S.saved ? 'saved' : !S.rec.active ? 'idle' : S.rec.finalizing ? 'finalizing' : S.rec.paused ? 'paused' : 'recording');
const statusText = () => {
  const s = stateOf();
  if (s === 'saved') return t('Notes saved');
  if (s === 'finalizing') return S.rec.stage === 'speakers' ? t('Identifying speakers…') : t('Finishing transcription…');
  if (s === 'paused') return t('Paused');
  return t('Recording');
};

// The widget redraws on every partial transcript and level tick, so nothing here rebuilds the DOM wholesale:
// the shell is built once per mode, each piece is only written when its HTML changed, and the transcript is
// reconciled line by line. That keeps scroll, text selection, the drag handle and button presses stable.
const put = (el, html) => { if (el && el._h !== html) { el._h = html; el.innerHTML = html; } };
const meterHtml = () => `<span class="meter">${[0, 1, 2, 3, 4].map((i) => `<b style="height:${4 + i * 3}px"></b>`).join('')}</span>`;
function paintMeters() {
  const n = Math.min(5, Math.round(Math.sqrt(Math.max(S.level.mic, S.level.system) || 0) * 14));
  for (const m of root.querySelectorAll('.meter')) [...m.children].forEach((b, i) => b.classList.toggle('off', i >= n));
}

function lineItems() {
  const items = S.lines.map((l) => ({ key: `s${l.id}`, label: l.label, speakerId: l.speakerId, text: l.text, tr: S.tr.get(l.id) }));
  const open = Object.entries(S.drafts).filter(([, d]) => d).sort((a, b) => a[1].startMs - b[1].startMs);
  for (const [ch, d] of open) items.push({ key: `d${ch}`, draft: true, label: speakerText({ kind: d.speaker === 'me' ? 'me' : 'them' }), speakerId: null, text: d.text });
  return items;
}

function syncLines(box) {
  const items = lineItems();
  const empty = box.querySelector(':scope > .empty');
  if (!items.length) {
    for (const el of [...box.querySelectorAll(':scope > .line')]) el.remove();
    if (!empty) box.insertAdjacentHTML('beforeend', `<div class="empty">${meterHtml()}<div></div></div>`);
    put(box.querySelector('.empty > div'), S.rec.finalizing ? esc(statusText()) : esc(t('Listening…')));
    return;
  }
  empty?.remove();
  const have = new Map([...box.querySelectorAll(':scope > .line')].map((el) => [el.dataset.key, el]));
  const keep = new Set(items.map((i) => i.key));
  for (const [k, el] of have) if (!keep.has(k)) el.remove();
  let prev = null;
  items.forEach((it, i) => {
    let el = have.get(it.key);
    if (!el) { el = document.createElement('div'); el.dataset.key = it.key; }
    el.className = `line${it.draft ? ' draft' : ''}`;
    const head = it.label !== prev ? `<div class="who" style="color:${speakerColor(it.speakerId, it.label)}">${esc(it.label)}</div>` : '';
    prev = it.label;
    // the translation under the words, or in their place when the settings ask to see the translation
    const words = it.tr && S.tx?.view === 'translation' ? `<div class="txt">${esc(it.tr)}</div>` : `<div class="txt">${esc(it.text)}</div>${it.tr ? `<div class="txt tr-line">${esc(it.tr)}</div>` : ''}`;
    put(el, `${head}${words}`);
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
  });
}

// Were the others on the call told it is recorded? A strip in the card (and a mark on the pill) until it is dealt with.
const consentUnknown = () => S.rec.active && (S.rec.consent || 'unknown') === 'unknown';
function consentStrip() {
  if (!S.rec.active || S.rec.finalizing) return '';
  const c = S.rec.consent || 'unknown';
  if (c === 'announced') return `<div class="consent ok" data-drag>${icon('check', 'sm')} ${esc(t('Others told'))}</div>`;
  if (c === 'declined') return `<div class="consent bad" data-drag>${icon('alert', 'sm')} ${esc(t('Someone objected'))}</div>`;
  return `<div class="consent ask" data-drag>
    <div class="ask-text">${icon('alert', 'sm')}<span>${esc(t('Do the others on the call know?'))}</span></div>
    <div class="ask-actions"><button class="btn sm" data-act="copy-notice">${icon('copy', 'sm')} ${esc(S.noticeCopied ? t('Copied') : t('Copy notice'))}</button><button class="btn sm ghost" data-act="told">${esc(t('I told them'))}</button><button class="btn sm ghost" data-act="objected" title="${esc(t('Someone objected'))}" aria-label="${esc(t('Someone objected'))}">${icon('alert', 'sm')}</button></div>
    ${S.consentError ? `<div class="ask-error">${esc(S.consentError)}</div>` : ''}</div>`;
}
async function loadConsent() {
  const id = S.rec.noteId;
  if (!S.rec.active || !id) return;
  try { const c = await getConsent(id); if (S.rec.noteId === id) { S.rec.consent = c; draw(); } } catch { /* shows the warning */ }
}

let mode = null; // 'pill' | 'card': which shell is in the DOM
function buildShell(want) {
  mode = want;
  if (want === 'pill') {
    root.innerHTML = `<div class="pill" data-drag data-act="expand" role="button" tabindex="0" aria-label="${esc(t('Show live transcript'))}" title="${esc(t('Show live transcript'))}">
      <span class="dot"></span><span class="time"></span><span class="mid"></span><span class="warn"></span><span class="grow"></span><span class="chev">${icon('chevdown', 'sm')}</span></div>`;
    return;
  }
  root.innerHTML = `<section class="card">
    <header data-drag><span class="title"><span class="dot"></span><span class="time"></span><span class="sub"></span></span>
      <button class="btn sm icon ghost" data-act="open" title="${esc(t('Open WhisperBrain'))}" aria-label="${esc(t('Open WhisperBrain'))}">${icon('external', 'sm')}</button>
      <button class="btn sm icon ghost" data-act="collapse" title="${esc(t('Minimise'))}" aria-label="${esc(t('Minimise'))}">${icon('chevdown', 'sm')}</button></header>
    <div class="lines-wrap"><div class="lines" tabindex="0"></div><button type="button" class="jump-latest" hidden title="${esc(t('Back to the live transcript'))}" aria-label="${esc(t('Back to the live transcript'))}">${icon('chevdown', 'sm')}<span>${esc(t('Latest'))}</span></button></div>
    <div class="slot-consent"></div>
    <footer data-drag></footer></section>`;
}

function render() {
  const state = stateOf();
  root.dataset.state = state;
  const want = S.expanded ? 'card' : 'pill';
  if (mode !== want) buildShell(want);
  for (const el of root.querySelectorAll('.time')) el.textContent = fmtTimer(S.rec.elapsedMs || 0);
  if (want === 'pill') {
    put(root.querySelector('.mid'), state === 'recording' ? meterHtml() : `<span class="state">${esc(statusText())}</span>`);
    put(root.querySelector('.warn'), consentUnknown() ? `<span class="warnmark" title="${esc(t('Were the other people on the call told this is being recorded?'))}">${icon('alert', 'sm')}</span>` : '');
  } else {
    const busy = state === 'finalizing' || state === 'saved';
    put(root.querySelector('.sub'), esc(statusText()));
    const box = root.querySelector('.lines');
    // follows the newest line; scrolling up stops that and shows the arrow back (ui/follow.js)
    if (!box.follow) box.follow = follow(box, root.querySelector('.jump-latest'));
    syncLines(box);
    box.follow.update();
    put(root.querySelector('.slot-consent'), consentStrip());
    put(root.querySelector('footer'), `${S.rec.micAvailable === false ? '' : `<button class="btn sm ${S.rec.micMuted ? 'danger' : ''}" data-act="mute" ${busy ? 'disabled' : ''} aria-pressed="${!!S.rec.micMuted}" title="${esc(S.rec.micMuted ? t('Unmute my microphone') : t('Mute my microphone: nothing I say is recorded'))}">${icon(S.rec.micMuted ? 'micoff' : 'mic', 'sm')} ${S.rec.micMuted ? t('Unmute') : t('Mute')}</button>`}<button class="btn sm" data-act="pause" ${busy ? 'disabled' : ''}>${icon(S.rec.paused ? 'play' : 'pause', 'sm')} ${S.rec.paused ? t('Resume') : t('Pause')}</button>
      <button class="btn sm stop" data-act="stop" ${busy ? 'disabled' : ''}>${icon('stop', 'sm')} ${t('Stop')}</button>`);
  }
  paintMeters();
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
    const lang = S.tx?.lang;
    const segs = await api('GET', `/api/notes/${encodeURIComponent(S.rec.noteId)}/transcript${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`);
    S.lines = segs.slice(-MAX_LINES).map((x) => ({ id: x.id, label: lineText(x), speakerId: x.speakerId, text: x.text }));
    for (const x of segs) if (x.translation) S.tr.set(x.id, x.translation);
    draw();
  } catch { /* the server is restarting */ }
}
let relabel = 0;
const relabelSoon = () => { clearTimeout(relabel); relabel = setTimeout(loadLines, 400); };

function setRec(st) {
  clearTimeout(savedTimer);
  S.saved = false;
  if (st?.active) S.rec = { active: true, noteId: st.noteId, paused: !!st.paused, finalizing: !!st.finalizing, stage: st.stage || null, micMuted: !!st.micMuted, micAvailable: st.micAvailable !== false, baseMs: st.elapsedMs || 0, base: Date.now(), elapsedMs: st.elapsedMs || 0 };
  else S.rec = { active: false };
}

async function sync() {
  try {
    setRec(await api('GET', '/api/recording'));
    if (S.rec.active) { await loadLines(); loadConsent(); } else S.lines = [];
    draw();
  } catch { /* the server is restarting */ }
}

events({
  open: sync,
  'recording.started': (d) => { setRec({ active: true, noteId: d.noteId, elapsedMs: 0, micAvailable: d.channels ? d.channels.includes('mic') : true }); S.lines = []; S.tr.clear(); S.drafts = {}; draw(); loadConsent(); },
  'recording.mic-muted': (d) => { if (S.rec.active && S.rec.noteId === d.noteId) { S.rec.micMuted = d.muted; draw(); } },
  'recording.paused': () => { S.drafts = {}; S.rec.paused = true; S.rec.baseMs = S.rec.elapsedMs; draw(); },
  'recording.resumed': () => { S.rec.paused = false; S.rec.base = Date.now(); draw(); },
  'recording.finalizing': (d) => { S.rec.finalizing = true; S.rec.stage = d.stage || null; draw(); },
  'recording.stopped': () => {
    S.rec = { ...S.rec, active: false, finalizing: false };
    S.drafts = {};
    S.saved = true;
    draw();
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { S.saved = false; S.lines = []; S.tr.clear(); S.rec = { active: false }; draw(); }, 4000);
  },
  'recording.level': (d) => { S.level = { mic: d.mic, system: d.system }; paintMeters(); },
  'transcript.segment': (d) => {
    const s = d.segment;
    S.lines.push({ id: s.id, label: lineText(s), speakerId: s.speakerId, text: s.text });
    if (S.lines.length > MAX_LINES) S.lines.splice(0, S.lines.length - MAX_LINES);
    S.drafts = { ...S.drafts, [s.speaker === 'me' ? 'mic' : 'system']: null }; // the final text takes the draft's place
    draw();
  },
  'transcript.partial': (d) => { S.drafts = { ...S.drafts, [d.ch]: d.text ? d : null }; draw(); },
  // only the language live translation writes: a translation started by hand into another language elsewhere is not for this window
  'translation.segment': (d) => { if (S.tx && d.lang === S.tx.lang && d.noteId === S.rec.noteId) { S.tr.set(d.segmentId, d.text); draw(); } },
  'transcript.removed': (d) => { const gone = new Set(d.ids); S.lines = S.lines.filter((l) => !gone.has(l.id)); for (const id of gone) S.tr.delete(id); draw(); },
  'speakers.updated': relabelSoon,
  settings: () => applySettings(),
});

async function applySettings() {
  try {
    const s = await api('GET', '/api/settings');
    setLang(s.language);
    document.documentElement.dataset.theme = s.theme || 'system';
    const tr = s.translation;
    const was = S.tx?.lang;
    S.tx = tr?.enabled && tr.live && tr.targets?.length ? { lang: tr.targets[0], view: tr.view } : null;
    if (!S.tx) S.tr.clear();
    else if (S.tx.lang !== was && S.rec.active) { S.tr.clear(); loadLines(); }   // another language: fetch what is there
    draw();
  } catch { /* fall back to defaults */ }
}

setInterval(() => {
  if (S.rec.active && !S.rec.paused && !S.rec.finalizing && S.rec.base) {
    S.rec.elapsedMs = (S.rec.baseMs || 0) + (Date.now() - S.rec.base);
    for (const el of root.querySelectorAll('.time')) el.textContent = fmtTimer(S.rec.elapsedMs);
  }
}, 500);

// ---- interaction: click the pill to open it; drag the pill, title bar, or any bare part of the card to move it ----
// The drag is tracked on `window` (not on the handle) and sent as an offset from where it started, so it keeps
// following the pointer even if the element under it is redrawn, and the main process never drifts or lags behind.
let drag = null;
root.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const handle = e.target.closest('[data-drag]');
  if (!handle || e.target.closest('button, a, input, textarea')) return;
  drag = { x: e.screenX, y: e.screenY, moved: false, expand: handle.dataset.act === 'expand', id: e.pointerId };
  try { root.setPointerCapture(e.pointerId); } catch { /* the drag still works while the pointer stays inside */ }
});
window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    bridge?.dragStart();
    document.body.classList.add('dragging');
  }
  bridge?.dragMove(dx, dy);
});
const endDrag = (e) => {
  const d = drag;
  if (!d || (e && e.pointerId !== d.id)) return;
  drag = null;
  document.body.classList.remove('dragging');
  if (d.moved) bridge?.dragEnd(); else if (d.expand && e?.type === 'pointerup') setExpanded(true);
};
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', () => endDrag());
root.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.act === 'expand') { e.preventDefault(); setExpanded(true); } });
root.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  try {
    if (b.dataset.act === 'collapse') setExpanded(false);
    else if (b.dataset.act === 'open') { if (bridge) bridge.openApp(S.rec.noteId || ''); else window.open(`/#/note/${S.rec.noteId || ''}`, '_blank'); }
    else if (b.dataset.act === 'copy-notice') {
      S.consentError = '';
      try { await copyNotice(); S.noticeCopied = true; } catch { S.consentError = t('Could not copy here. Open WhisperBrain and copy the notice from the recording bar.'); }
      draw();
    }
    else if (b.dataset.act === 'told' || b.dataset.act === 'objected') {
      const id = S.rec.noteId, c = b.dataset.act === 'told' ? 'announced' : 'declined';
      await setConsent(id, c);
      if (S.rec.noteId === id) { S.rec.consent = c; S.noticeCopied = false; S.consentError = ''; draw(); }
    }
    else if (b.dataset.act === 'pause') await api('POST', `/api/recording/${S.rec.paused ? 'resume' : 'pause'}`);
    else if (b.dataset.act === 'mute') await api('POST', '/api/recording/mic-mute', { muted: !S.rec.micMuted });
    else if (b.dataset.act === 'stop') { b.disabled = true; await api('POST', '/api/recording/stop'); }
  } catch { b.disabled = false; }
});

applySettings().then(sync);
