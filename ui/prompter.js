// Teleprompter. Lives in its own always-on-top window (electron/prompter.js) while a recording runs with the assistant helping and
// Settings → Assistant → Teleprompter is on. It shows the newest suggestion in large text and scrolls it in one of two ways:
//   voice: follows what the user reads aloud (the microphone's live transcript, speaker 'me'), see prompter-track.js;
//   speed: scrolls at a steady pace in words per minute, see prompter-scroll.js.
// Like the floating recorder, it talks only to the app's local API and event stream; the native bridge moves, resizes and hides it.
import { api, events } from './api.js';
import { setLang, t } from './i18n.js';
import { esc } from './md.js';
import { icon } from './icons.js';
import { initialState, reduce } from './suggestion-state.js';
import { ReadingTracker } from './prompter-track.js';
import { pxPerSecond, readingScroll, Pacer } from './prompter-scroll.js';

const bridge = window.wbPrompter || null; // present only inside the desktop app
const root = document.getElementById('tp');
const view = root.querySelector('.tp-view');
const text = root.querySelector('.tp-text');
const statusEl = root.querySelector('.tp-status');
const toolsEl = root.querySelector('.tp-tools');
const toastEl = root.querySelector('.tp-toast');

const LEAD_IN_MS = 1500;     // speed: a moment to find the first line before the text moves
const MANUAL_MS = 4000;      // after the user scrolls by hand, leave the view alone this long
const S = {
  cfg: { enabled: true, scroll: 'voice', wpm: 140, fontSize: 34, opacity: 0.85, mirror: false },
  noteId: null,
  sug: initialState(),
  tracker: new ReadingTracker(),
  pacer: new Pacer(),
  paused: false,
  hover: false,
  manualUntil: 0,
  startedAt: 0,              // when the current suggestion's first words arrived
  seq: undefined,            // the suggestion the tracker was set up for
  cur: 0,                    // the sentence highlighted
};

// ---- settings ----
function applyCfg() {
  root.style.setProperty('--tp-size', `${S.cfg.fontSize}px`);
  root.style.setProperty('--tp-alpha', String(S.cfg.opacity));
  root.style.setProperty('--tp-flip', S.cfg.mirror ? '-1' : '1');
  root.dataset.mode = S.cfg.scroll;
  drawBar();
}
async function loadSettings() {
  try {
    const s = await api('GET', '/api/settings');
    setLang(s.language);
    S.cfg = { ...S.cfg, ...(s.teleprompter || {}), ...pending };
    applyCfg();
    draw();
  } catch { /* the server is restarting: the next settings event retries */ }
}
// Changes made here are gathered and saved together (Ctrl+wheel then Shift+wheel must keep both); until saved, they win over
// what the server says, so a settings event in between does not undo them.
let saveTimer = 0;
let pending = {};
function save(patch, { soon = false } = {}) {
  Object.assign(S.cfg, patch);
  pending = { ...pending, ...patch };
  applyCfg();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const teleprompter = pending;
    pending = {};
    api('PUT', '/api/settings', { teleprompter }).catch((e) => toast(e.message));
  }, soon ? 0 : 500);
}

let toastTimer = 0;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1400);
}

// ---- the bar ----
function drawBar() {
  const voice = S.cfg.scroll === 'voice';
  statusEl.textContent = S.paused ? t('Paused') : voice ? t('Following your voice') : t('Steady speed · {n} words/min', { n: S.cfg.wpm });
  const html = `
    <button class="tp-btn" data-act="pause" title="${esc(S.paused ? t('Resume') : t('Pause'))}">${icon(S.paused ? 'play' : 'pause')}</button>
    <button class="tp-btn ${voice ? 'on' : ''}" data-act="voice" title="${esc(t('Follow my voice'))}">${icon('mic')}</button>
    <button class="tp-btn ${voice ? '' : 'on'}" data-act="speed" title="${esc(t('Steady speed'))}">${esc(t('Speed'))}</button>
    <button class="tp-btn" data-act="slower" title="${esc(t('Slower'))}" ${voice ? 'hidden' : ''}>−</button>
    <button class="tp-btn" data-act="faster" title="${esc(t('Faster'))}" ${voice ? 'hidden' : ''}>+</button>
    <button class="tp-btn" data-act="hide" title="${esc(t('Hide until the recording ends'))}" ${bridge ? '' : 'hidden'}>${icon('x')}</button>`;
  if (toolsEl._h !== html) { toolsEl._h = html; toolsEl.innerHTML = html; }
}
toolsEl.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'pause') command('pause');
  else if (act === 'voice' || act === 'speed') { if (S.cfg.scroll !== act) save({ scroll: act }, { soon: true }); }
  else if (act === 'slower' || act === 'faster') { const wpm = Math.max(80, Math.min(220, S.cfg.wpm + (act === 'faster' ? 10 : -10))); save({ wpm }); toast(t('{n} words/min', { n: wpm })); }
  else if (act === 'hide') bridge?.hide();
});

// ---- drawing ----
// Each card is built once and its sentences are updated in place, so the scroll position and the highlight never jump.
function cardEl(c, old) {
  const el = document.createElement('div');
  el.className = `tp-card${old ? ' old' : ''}`;
  el.dataset.seq = String(c.seq);
  el.innerHTML = `<div class="tp-q"></div><div class="tp-body"></div><div class="tp-err" hidden></div><div class="tp-legend" hidden>${esc(t('Underlined: not in your briefings'))}</div>`;
  return el;
}
function fillCard(el, c, { current }) {
  el.classList.toggle('done', !!c.done);
  el.classList.toggle('bullets', c.bullets.size > 0);
  const q = el.querySelector('.tp-q');
  if (q.textContent !== c.question) q.textContent = c.question;
  const body = el.querySelector('.tp-body');
  c.sentences.forEach((s, i) => {
    let span = body.children[i];
    if (!span) { span = document.createElement('span'); span.className = 'tp-s'; body.appendChild(span); }
    const want = (s || '') + (c.bullets.has(i) ? '' : ' ');
    if (span.textContent !== want) span.textContent = want;
    span.classList.toggle('gap', c.gaps.has(i));
    span.classList.toggle('open', !c.closed[i]);
    span.classList.toggle('cur', current && i === S.cur);
    span.classList.toggle('read', current && i < S.cur);
    if (c.gaps.has(i)) span.title = t('Not in your briefings: check before you say it'); else span.removeAttribute('title');
  });
  while (body.children.length > c.sentences.length) body.lastChild.remove();
  const err = el.querySelector('.tp-err');
  err.hidden = !c.error;
  if (c.error) err.textContent = t('Could not write a suggestion: {m}', { m: c.error });
  el.querySelector('.tp-legend').hidden = !(c.done && c.gaps.size);
}

let raf = 0;
const draw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
function render() {
  const { current, previous } = S.sug;
  if (!current) {
    const html = `<div class="tp-empty">${esc(t('Waiting for a question from the other side…'))}<br>${esc(S.cfg.scroll === 'voice' ? t('Read aloud and the text follows your voice.') : t('The text scrolls at your reading speed.'))}</div>`;
    if (text._h !== html) { text._h = html; text.innerHTML = html; }
    return;
  }
  text._h = null;
  if (text.querySelector('.tp-empty')) text.innerHTML = '';
  const wanted = [...previous.slice(0, 1).reverse(), current];
  const keys = wanted.map((c) => String(c.seq));
  for (const el of [...text.children]) if (!keys.includes(el.dataset.seq)) el.remove();
  wanted.forEach((c, i) => {
    let el = [...text.children].find((x) => x.dataset.seq === String(c.seq));
    const old = c !== current;
    if (!el) { el = cardEl(c, old); text.insertBefore(el, text.children[i] || null); }
    el.classList.toggle('old', old);
    fillCard(el, c, { current: !old });
  });
}

// ---- following the suggestion ----
function onSuggestion(type, d) {
  if (d.noteId && S.noteId && d.noteId !== S.noteId) return;
  S.sug = reduce(S.sug, type, d);
  const c = S.sug.current;
  if (!c) return draw();
  if (c.seq !== S.seq) {         // a new suggestion: start reading from its top
    S.seq = c.seq;
    S.tracker.reset(c.sentences);
    S.cur = 0;
    S.startedAt = 0;
    S.manualUntil = 0;
    S.pacer.carry = 0;
    view.scrollTop = 0;
  } else S.tracker.setSentences(c.sentences);
  if (!S.startedAt && c.sentences.some(Boolean)) S.startedAt = performance.now();
  if (S.cfg.scroll === 'voice') S.cur = S.tracker.sentence;
  draw();
}

function onMicLine(noteId, speaker, line) {
  if (S.cfg.scroll !== 'voice' || S.paused || speaker !== 'me' || !S.sug.current) return;
  if (S.noteId && noteId && noteId !== S.noteId) return;
  if (S.tracker.hear(line)) { S.cur = S.tracker.sentence; S.manualUntil = 0; draw(); }
}

function command(action) {
  if (action === 'pause') { S.paused = !S.paused; S.pacer.paused = S.paused; S.manualUntil = 0; drawBar(); toast(S.paused ? t('Paused') : t('Resumed')); return; }
  if (action !== 'back' && action !== 'next') return;
  const delta = action === 'next' ? 1 : -1;
  S.manualUntil = 0;
  if (S.cfg.scroll === 'voice') { S.tracker.jump(delta); S.cur = S.tracker.sentence; }
  else {
    const n = S.sug.current?.sentences.length || 0;
    S.cur = Math.max(0, Math.min(n - 1, S.cur + delta));
    const span = currentSpans()[S.cur];
    if (span) view.scrollTop = readingScroll({ top: offsetIn(span), viewHeight: view.clientHeight, contentHeight: view.scrollHeight });
  }
  draw();
}

// ---- scrolling, every frame ----
const currentSpans = () => [...(text.querySelector('.tp-card:not(.old) .tp-body')?.children || [])];
const offsetIn = (el) => el.getBoundingClientRect().top - text.getBoundingClientRect().top + text.offsetTop;

function measure() {
  const body = text.querySelector('.tp-card:not(.old) .tp-body');
  const lineHeight = S.cfg.fontSize * 1.38;
  if (!body) return { wordsPerLine: 0, lineHeight };
  const words = (body.textContent.match(/\S+/g) || []).length;
  const lines = Math.max(1, Math.round(body.getBoundingClientRect().height / lineHeight));
  return { wordsPerLine: words / lines, lineHeight };
}

let last = performance.now();
function frame(now) {
  const dt = now - last;
  last = now;
  const c = S.sug.current;
  if (c && now >= S.manualUntil) {
    if (S.cfg.scroll === 'voice') {
      const span = currentSpans()[S.cur];
      if (span && !S.paused) {
        const target = readingScroll({ top: offsetIn(span), viewHeight: view.clientHeight, contentHeight: view.scrollHeight });
        const gap = target - view.scrollTop;
        if (Math.abs(gap) > 1) view.scrollTop += Math.sign(gap) * Math.max(1, Math.abs(gap) * 0.12);
      }
    } else if (S.startedAt && now - S.startedAt > LEAD_IN_MS) {
      S.pacer.paused = S.paused || S.hover;
      const move = S.pacer.tick(dt, pxPerSecond({ wpm: S.cfg.wpm, ...measure() }));
      if (move) {
        // never past the words written so far: the last line stays at the reading line until more arrives
        const spans = currentSpans();
        const lastSpan = spans[spans.length - 1];
        const limit = lastSpan ? readingScroll({ top: offsetIn(lastSpan) + lastSpan.getBoundingClientRect().height, viewHeight: view.clientHeight, contentHeight: view.scrollHeight }) : 0;
        view.scrollTop = Math.min(view.scrollTop + move, Math.max(view.scrollTop, limit));
      }
      // the highlighted sentence is the one at the reading line
      const line = view.scrollTop + view.clientHeight / 3;
      const spans = currentSpans();
      let cur = 0;
      spans.forEach((s, i) => { if (offsetIn(s) <= line) cur = i; });
      if (cur !== S.cur) { S.cur = cur; draw(); }
    }
  }
  requestAnimationFrame(frame);
}

// ---- the pointer: wheel to scroll, Ctrl+wheel for the text size, Shift+wheel for the background ----
view.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const fontSize = Math.max(18, Math.min(80, S.cfg.fontSize + (e.deltaY < 0 ? 2 : -2)));
    if (fontSize !== S.cfg.fontSize) { save({ fontSize }); toast(t('Text size {n}', { n: fontSize })); }
  } else if (e.shiftKey) {
    e.preventDefault();
    const opacity = Math.round(Math.max(0.2, Math.min(1, S.cfg.opacity + (e.deltaY < 0 ? 0.05 : -0.05))) * 100) / 100;
    if (opacity !== S.cfg.opacity) { save({ opacity }); toast(t('Background {n}%', { n: Math.round(opacity * 100) })); }
  } else S.manualUntil = performance.now() + (S.cfg.scroll === 'voice' ? MANUAL_MS : 0); // speed: a nudge, the pace goes on from there
}, { passive: false });
view.addEventListener('mouseenter', () => { S.hover = true; });
view.addEventListener('mouseleave', () => { S.hover = false; });

// Move by the bar, resize by the corner: the bounds at the press plus the pointer's total offset since.
function grabWith(el, move) {
  el.addEventListener('pointerdown', (e) => {
    if (!bridge || e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const x0 = e.screenX, y0 = e.screenY;
    bridge.grab();
    el.setPointerCapture(e.pointerId);
    const onMove = (ev) => move(ev.screenX - x0, ev.screenY - y0);
    const onUp = () => { el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onUp); bridge.release(); };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
}
grabWith(root.querySelector('.tp-bar'), (dx, dy) => bridge.drag(dx, dy));
grabWith(root.querySelector('.tp-resize'), (dx, dy) => bridge.resize(dx, dy));

// ---- start ----
bridge?.onCmd(command);
events({
  open: async () => { await loadSettings(); try { S.noteId = (await api('GET', '/api/recording')).noteId || null; } catch { /* retried on the next event */ } },
  settings: (d) => { if (!d?.keys || d.keys.includes('teleprompter') || d.keys.includes('language')) loadSettings(); },
  'recording.started': (d) => { S.noteId = d.noteId; },
  'assistant.question': (d) => onSuggestion('assistant.question', d),
  'assistant.sentence': (d) => onSuggestion('assistant.sentence', d),
  'assistant.flag': (d) => onSuggestion('assistant.flag', d),
  'assistant.done': (d) => onSuggestion('assistant.done', d),
  'assistant.error': (d) => { if (d.seq !== undefined) onSuggestion('assistant.error', d); },
  'assistant.repeat': (d) => onSuggestion('assistant.repeat', d),
  'transcript.partial': (d) => onMicLine(d.noteId, d.speaker, d.text),
  'transcript.segment': (d) => onMicLine(d.noteId, d.segment?.speaker, d.segment?.text),
});
applyCfg();
render();
loadSettings();
requestAnimationFrame(frame);
