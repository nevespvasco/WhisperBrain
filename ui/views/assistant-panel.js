// The live meeting assistant on the meeting page (src/assistant/service.js): a panel at the top of the side column. While the
// meeting records it shows the question the other side just asked and the suggestion as it is written ([GAP] lines marked), an
// "ask about this call" box, the live summary and term cards; afterwards, what the assistant showed. The panel element is kept
// across the side column's redraws (note.js puts the same node back), so a suggestion being written is never lost.
import { api, t, esc, icon, fail, done, switchEl, pickFrom } from '../lib.js';
import { stream } from '../api.js';
import { openSetup } from './setup.js';

const panels = new Map();   // noteId -> panel state (one live panel per meeting page)

export function assistantSlot(noteId) {
  let p = panels.get(noteId);
  if (!p) {
    p = { noteId, el: document.createElement('div'), state: null, card: null, cards: [], summary: null, terms: [], history: [], briefings: [], all: [], ask: { busy: false, q: '', a: '' } };
    p.el.id = 'assistant-slot';
    panels.set(noteId, p);
    build(p);
    load(p);
  }
  return p.el;
}

// Forget panels of meetings that are no longer on screen (called when the meeting page goes away)
export function dropAssistant(noteId) { panels.delete(noteId); }

async function load(p) {
  try {
    const [state, history, briefings, all] = await Promise.all([
      api('GET', `/api/assistant/state?noteId=${encodeURIComponent(p.noteId)}`),
      api('GET', `/api/notes/${encodeURIComponent(p.noteId)}/assistant`),
      api('GET', `/api/notes/${encodeURIComponent(p.noteId)}/briefings`).catch(() => []),
      api('GET', '/api/briefings').catch(() => []),
    ]);
    Object.assign(p, { state, history, briefings, all });
    if (state.summary) p.summary = state.summary;
    if (!p.summary) { const last = [...history].reverse().find((h) => h.kind === 'summary'); if (last) p.summary = last.meta; }
    p.terms = history.filter((h) => h.kind === 'term').slice(-6).reverse().map((h) => ({ term: h.question, definition: h.text, ai: h.meta?.ai }));
    draw(p);
  } catch (e) { p.el.querySelector('.as-body').innerHTML = `<div class="small muted">${esc(e.message)}</div>`; }
}

const recording = (p) => !!p.state?.recording;
const blockedText = (why) => ({
  'no-llm': t('Set up an AI server under Settings → AI first.'),
  remote: t('Your AI server is not on this computer. Allow it in Settings → Assistant to use the assistant with it.'),
  consent: t('Somebody on this call objected to the recording, so the assistant is off.'),
}[why] || '');

function build(p) {
  p.el.innerHTML = `<section class="panel assistant" aria-live="polite">
    <div class="panel-head"><h3>${icon('wand')} ${t('Assistant')}</h3><span class="as-switch"></span></div>
    <div class="as-body"><div class="small muted">${t('Loading…')}</div></div></section>`;
  p.el.addEventListener('change', async (e) => {
    if (e.target.id !== `as-on-${p.noteId}`) return;
    try { p.state = await api('POST', '/api/assistant/toggle', { noteId: p.noteId, enabled: e.target.checked }); draw(p); } catch (err) { fail(err); e.target.checked = !e.target.checked; }
  });
  p.el.addEventListener('click', (e) => onClick(p, e));
  p.el.addEventListener('submit', (e) => { e.preventDefault(); askNow(p); });
}

function draw(p) {
  const st = p.state;
  if (!st) return;
  p.el.querySelector('.as-switch').innerHTML = switchEl(`as-on-${p.noteId}`, st.enabled, t('Assistant for this meeting'));
  const body = p.el.querySelector('.as-body');
  const blocked = st.enabled && st.blocked ? `<div class="banner small warn">${icon('alert')}<div class="grow">${esc(blockedText(st.blocked))}</div><a class="btn xs" href="#/settings/${st.blocked === 'no-llm' ? 'ai' : 'assistant'}">${t('Settings')}</a></div>` : '';
  const intro = !st.enabled ? `<div class="small muted">${recording(p) ? t('Switch it on to get suggestions when somebody asks a question.') : t('Switch it on and record: when somebody on the call asks a question, a short suggestion from your briefings appears here.')}</div>` : '';
  body.innerHTML = `${blocked}${intro}
    <div class="as-current"></div>
    ${recording(p) && st.enabled && !st.blocked ? `<div class="row as-actions">
      <button class="btn sm primary" data-as="answer" title="${esc(t('Prepare a suggestion for what was just said'))}">${icon('zap', 'sm')} ${t('Answer now')}</button>
      <button class="btn sm" data-as="regenerate">${icon('refresh', 'sm')} ${t('Another angle')}</button>
      <button class="btn sm ghost" data-as="summary">${icon('list', 'sm')} ${t('Update summary')}</button></div>` : ''}
    ${st.enabled && !st.blocked ? `<form class="as-ask row"><input name="q" placeholder="${esc(t('Ask about this call…'))}" autocomplete="off" aria-label="${esc(t('Ask about this call'))}"><button class="btn sm" type="submit">${icon('sparkles', 'sm')}</button></form><div class="as-answer"></div>` : ''}
    <div class="as-summary"></div>
    <div class="as-terms"></div>
    <div class="as-briefings"></div>
    ${!recording(p) ? '<div class="as-history"></div>' : ''}`;
  drawCurrent(p); drawAnswer(p); drawSummary(p); drawTerms(p); drawBriefings(p); drawHistory(p);
}

function cardHtml(c) {
  const lines = [...c.sentences.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
  const sentence = (s) => `<${s.bullet ? 'li' : 'span'} class="as-s${s.gap ? ' gap' : ''}" ${s.gap ? `title="${esc(t('Not in your briefings: check before you say it'))}"` : ''}>${esc(s.text)}</${s.bullet ? 'li' : 'span'}>`;
  const bullets = lines.filter((s) => s.bullet), prose = lines.filter((s) => !s.bullet);
  const open = c.open && !c.done ? `<span class="as-s open">${esc(c.open)}</span>` : '';
  return `<div class="as-card${c.done ? ' done' : ''}${c.error ? ' failed' : ''}">
    <div class="as-q">${c.repeat ? `<span class="badge">${t('Again')}</span> ` : ''}${c.kind === 'screen' ? icon('eye', 'sm') : icon('quote', 'sm')} <span>${esc(c.question)}</span></div>
    ${prose.length || (open && !bullets.length) ? `<p class="as-text">${prose.map(sentence).join(' ')} ${bullets.length ? '' : open}</p>` : ''}
    ${bullets.length ? `<ul class="as-list">${bullets.map(sentence).join('')}${open ? `<li class="as-s open">${esc(c.open)}</li>` : ''}</ul>` : ''}
    ${!c.done && !c.error && !lines.length && !c.open ? `<div class="xsmall muted">${t('Writing a suggestion…')}</div>` : ''}
    ${c.error ? `<div class="xsmall danger">${esc(c.error)}${/reach the LLM server|no models/i.test(c.error) ? ` <a href="#/settings/ai" data-setup-open>${t('Open Setup check')}</a>` : ''}</div>` : ''}
    ${c.done && c.text ? `<div class="row as-card-foot"><button class="btn xs ghost" data-as-copy="${c.key}">${icon('copy', 'sm')} ${t('Copy')}</button>${c.gaps ? `<span class="xsmall muted">${t('Underlined: not in your briefings')}</span>` : ''}</div>` : ''}
  </div>`;
}

function drawCurrent(p) {
  const box = p.el.querySelector('.as-current');
  if (!box) return;
  box.innerHTML = p.card ? cardHtml(p.card) : recording(p) && p.state?.enabled && !p.state?.blocked ? `<div class="xsmall muted">${p.state.trigger === 'manual' ? t('Press “Answer now” after a question.') : t('Listening for questions…')}</div>` : '';
}

function drawAnswer(p) {
  const box = p.el.querySelector('.as-answer');
  if (!box) return;
  box.innerHTML = p.ask.q ? `<div class="as-card"><div class="as-q">${icon('user', 'sm')} <span>${esc(p.ask.q)}</span></div><p class="as-text">${esc(p.ask.a || (p.ask.busy ? t('Thinking…') : ''))}</p></div>` : '';
}

function drawSummary(p) {
  const box = p.el.querySelector('.as-summary');
  if (!box) return;
  const s = p.summary;
  if (!s || !s.summary) { box.innerHTML = ''; return; }
  const list = (title, items, fmt = esc) => (items?.length ? `<div class="xsmall muted strong">${title}</div><ul class="as-list">${items.map((x) => `<li>${fmt(x)}</li>`).join('')}</ul>` : '');
  box.innerHTML = `<div class="divider"></div><div class="xsmall muted strong">${t('Live summary')}</div><p class="small" style="margin:4px 0 8px">${esc(s.summary)}</p>
    ${list(t('Decisions'), s.decisions)}${list(t('Action items'), s.actions, (a) => `${esc(a.text)}${a.owner ? ` <span class="muted">— ${esc(a.owner)}</span>` : ''}`)}${list(t('Open questions'), s.openQuestions)}`;
}

function drawTerms(p) {
  const box = p.el.querySelector('.as-terms');
  if (!box) return;
  box.innerHTML = p.terms.length ? `<div class="divider"></div><div class="xsmall muted strong">${t('Terms')}</div><div class="stack tight">${p.terms.slice(0, 6).map((x) => `<div class="quote"><b>${esc(x.term)}</b><span class="xsmall muted">${esc(x.definition)}</span></div>`).join('')}</div>` : '';
}

function drawBriefings(p) {
  const box = p.el.querySelector('.as-briefings');
  if (!box) return;
  box.innerHTML = `<div class="divider"></div><div class="row"><span class="xsmall muted strong grow">${t('Briefings for this meeting')}</span><button class="btn xs ghost" data-as="attach">${icon('plus', 'sm')} ${t('Attach')}</button><a class="btn xs ghost" href="#/briefings">${t('Manage')}</a></div>
    <div class="chips">${p.briefings.length ? p.briefings.map((b) => `<span class="chip">${icon('doc', 'sm')}<span class="ellipsis">${esc(b.title || t('Untitled'))}</span><button class="btn xs ghost icon" data-as-detach="${esc(b.id)}" aria-label="${esc(t('Remove'))}">${icon('x', 'sm')}</button></span>`).join('') : `<span class="xsmall muted">${t('None: suggestions use only the conversation and your notes.')}</span>`}</div>`;
}

function drawHistory(p) {
  const box = p.el.querySelector('.as-history');
  if (!box) return;
  const shown = p.history.filter((h) => h.kind === 'suggestion' || h.kind === 'ask');
  box.innerHTML = shown.length ? `<div class="divider"></div><div class="row"><span class="xsmall muted strong grow">${t('What the assistant showed')} <span class="badge">${shown.length}</span></span><button class="btn xs ghost" data-as="clear">${t('Clear')}</button></div>
    <div class="stack tight">${shown.slice(-20).reverse().map((h) => `<details class="as-hist"><summary>${icon(h.kind === 'ask' ? 'user' : 'quote', 'sm')} ${esc(h.question)}</summary><div class="small" style="white-space:pre-wrap">${esc(h.text)}</div></details>`).join('')}</div>` : '';
}

async function onClick(p, e) {
  if (e.target.closest('[data-setup-open]')) { e.preventDefault(); openSetup(); return; }
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.as === 'answer' || b.dataset.as === 'regenerate' || b.dataset.as === 'summary') await api('POST', '/api/assistant/action', { noteId: p.noteId, action: b.dataset.as });
    else if (b.dataset.asCopy) {
      const c = [p.card, ...p.cards].find((x) => x && String(x.key) === b.dataset.asCopy);
      if (c?.text) { await navigator.clipboard.writeText(c.text); done(t('Copied')); }
    } else if (b.dataset.as === 'attach') {
      const have = new Set(p.briefings.map((x) => x.id));
      const items = p.all.filter((x) => !have.has(x.id)).map((x) => ({ value: x.id, label: x.title || t('Untitled'), hint: x.kind }));
      if (!items.length) { location.hash = '#/briefings'; return; }
      const id = await pickFrom(b, items, { placeholder: t('Find a briefing…') });
      if (!id) return;
      p.briefings = await api('PUT', `/api/notes/${encodeURIComponent(p.noteId)}/briefings`, { ids: [...have, id] });
      drawBriefings(p);
    } else if (b.dataset.asDetach) {
      p.briefings = await api('PUT', `/api/notes/${encodeURIComponent(p.noteId)}/briefings`, { ids: p.briefings.map((x) => x.id).filter((x) => x !== b.dataset.asDetach) });
      drawBriefings(p);
    } else if (b.dataset.as === 'clear') {
      await api('DELETE', `/api/notes/${encodeURIComponent(p.noteId)}/assistant`);
      p.history = []; drawHistory(p);
    }
  } catch (err) { fail(err); }
}

async function askNow(p) {
  const input = p.el.querySelector('.as-ask input');
  const q = input?.value.trim();
  if (!q || p.ask.busy) return;
  p.ask = { busy: true, q, a: '' };
  input.value = '';
  drawAnswer(p);
  try {
    await stream('/api/assistant/ask', { noteId: p.noteId, question: q }, { onDelta: (d) => { p.ask.a += d; drawAnswer(p); } });
  } catch (e) { p.ask.a = e.message; }
  p.ask.busy = false;
  drawAnswer(p);
}

// ---- live events (app.js forwards every server event as 'wb:event') ----
window.addEventListener('wb:event', (e) => {
  const { type, data } = e.detail;
  if (type === 'recording.started' || type === 'recording.stopped') { for (const p of panels.values()) if (p.noteId === data.noteId) load(p); return; }
  if (type === 'briefings.changed') { for (const p of panels.values()) load(p); return; }
  if (!type.startsWith('assistant.')) return;
  const p = panels.get(data?.noteId);
  if (!p) return;
  if (type === 'assistant.state') { p.state = data; if (data.summary) p.summary = data.summary; draw(p); return; }
  if (type === 'assistant.question') {
    if (p.card) { p.cards.unshift(p.card); p.cards.length = Math.min(p.cards.length, 5); }
    p.card = { key: `${data.seq}`, seq: data.seq, question: data.question, kind: data.kind, sentences: new Map(), open: '', done: false };
  } else if (type === 'assistant.repeat') {
    p.card = { key: `r${Date.now()}`, question: data.question, repeat: true, sentences: new Map([[0, { text: data.text }]]), done: true, text: data.text };
  } else if (type === 'assistant.summary') { p.summary = data; drawSummary(p); return; }
  else if (type === 'assistant.term') { p.terms.unshift({ term: data.term, definition: data.definition, ai: data.ai }); p.terms.length = Math.min(p.terms.length, 6); drawTerms(p); return; }
  else {
    const c = p.card;
    if (!c || String(c.seq) !== String(data.seq)) return;
    if (type === 'assistant.sentence') {
      if (data.closed) { c.sentences.set(data.index, { text: data.text, gap: !!data.gap, bullet: !!data.bullet }); c.open = ''; } else c.open = data.text;
    } else if (type === 'assistant.flag') { const s = c.sentences.get(data.index); if (s) s.gap = true; }
    else if (type === 'assistant.done') { c.done = true; c.text = data.text; c.gaps = (data.gaps || []).length; c.open = ''; p.history.push({ kind: 'suggestion', question: c.question, text: data.text }); }
    else if (type === 'assistant.error') { c.error = data.message; }
  }
  drawCurrent(p);
});

