// One meeting: summary (overview, key points, decisions, action items), transcript (who said what), notes,
// snippets and chat; the side column has speaker analytics, topics, glossary terms, links and related meetings.
import { S, $, $$, api, t, esc, icon, toast, fail, done, go, menu, modal, promptDialog, confirmDialog, fmtDate, fmtHour, fmtClock, fmtDur, avatar, speakerColor, speakerText, lineText, speakerEntryText, debounce, empty, tagChip, srcIcon, SOURCES, PLATFORMS, meetingRow } from '../lib.js';
import { stream } from '../api.js';
import { renderMarkdown } from '../md.js';
import { startRecording, stopRecording } from '../recording.js';
import { openExport } from './transfer.js';
import { renderChat } from './chat.js';

const TABS = [['summary', 'Summary', 'sparkles'], ['transcript', 'Transcript', 'waves'], ['notes', 'Notes', 'edit'], ['snippets', 'Snippets', 'star'], ['chat', 'Chat', 'chat']];
let N = null; // the open meeting's state
let offEvents = null;

export async function render(main, { parts, params }) {
  const id = parts[1];
  offEvents?.();
  const [ov, segs, speakers, chat, ints] = await Promise.all([api('GET', `/api/notes/${id}/overview`), api('GET', `/api/notes/${id}/transcript`), api('GET', `/api/notes/${id}/speakers`), api('GET', `/api/chat?noteId=${id}`), api('GET', '/api/integrations').catch(() => null)]);
  if (ints) S.integrations = ints;
  N = { id, ...ov, segs, speakers, chat, tab: params.get('tab') || (ov.note.summary || ov.note.insights ? 'summary' : segs.length ? 'transcript' : 'notes'), seg: params.get('seg'), trq: '', drafts: {} };
  if (S.rec.active && S.rec.noteId === id && !params.get('tab')) N.tab = 'transcript';
  await trInit();
  main.innerHTML = `<div class="page">${header()}<div class="note-grid"><div class="tabcard"><div class="tabs" role="tablist">${TABS.map(([k, l, ic]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${N.tab === k}">${icon(ic, 'sm')}${t(l)}<span class="badge" data-count="${k}">${count(k)}</span></button>`).join('')}</div><div class="tabbody" id="tabbody"></div></div><aside class="note-aside" id="aside"></aside></div></div>`;
  $$('[data-count]', main).forEach((b) => { if (!b.textContent) b.hidden = true; });
  renderTab(); renderAside();
  bind(main);
  const onEvent = (e) => handleEvent(main, e.detail.type, e.detail.data);
  window.addEventListener('wb:event', onEvent);
  offEvents = () => window.removeEventListener('wb:event', onEvent);
  window.addEventListener('hashchange', () => { if (!location.hash.startsWith(`#/note/${id}`)) { offEvents?.(); offEvents = null; } }, { once: true });
}

const count = (k) => ({ transcript: N.segs.length || '', snippets: N.snippets.length || '', summary: N.actions.filter((a) => !a.done).length || '' }[k] || '');
const recHere = () => S.rec.active && S.rec.noteId === N.id;
const label = lineText;
// Where a speaker's name came from (the evidence recorded with it) and how sure that was, for the chip's tooltip and the rename dialog.
const WHY = {
  user: 'You named this speaker.',
  'transcript:llm': 'Guessed from what people said. Keep it or turn it down.',
  voice: 'Recognised from a saved voice.',
  stream: 'The Discord bot knows who was speaking.',
  'meeting:highlight': 'Who was highlighted in the meeting window while this voice spoke.',
  'meeting:caption': 'The meeting’s live captions: their words matched what this voice said.',
  'meeting:roster': 'The only other person on the call.',
  transcript: 'The platform’s own transcript: its words matched what this voice said.',
};
const whyName = (x) => {
  const w = WHY[x.nameSource];
  if (!w) return '';
  const base = x.nameConfidence != null && x.nameSource !== 'user' ? `${t(w)} ${t('{n}% sure', { n: Math.round(x.nameConfidence * 100) })}` : t(w);
  return x.evidenceQuote ? `${base}\n${fmtClock(x.evidenceMs)} “${x.evidenceQuote}”` : base; // the line the name was read from
};
const guessed = (x) => /^transcript:/.test(x.nameSource || '');
// Voices of other people with no name yet: there is something for the AI to find
const unnamed = (x) => x.speakerId !== 'm1' && !x.name && !x.voiceName;
const spLabel = speakerEntryText;

// ---------- translation (src/llm/translate.js) ----------
// Off until Settings → Translation is on. A meeting then offers a language menu: the lines are shown beside their translation as it
// arrives (live while recording, or on demand), and the summary can be read in another language.
const trOn = () => !!S.settings?.translation?.enabled;
const langName = (c) => S.languages?.find((l) => l.code === c)?.name || c;
async function trInit() {
  const cfg = S.settings?.translation;
  N.tr = { lang: '', view: cfg?.view || 'original', text: new Map(), info: { languages: [], running: [] }, job: null, sumLang: '', summary: '' };
  if (!trOn()) return;
  try {
    S.languages ||= await api('GET', '/api/languages');
    N.tr.info = await api('GET', `/api/notes/${N.id}/translations`);
    const job = N.tr.info.running[0];
    if (job) N.tr.job = job;
    // while recording with live translation on, the first language is what is being written; otherwise the language the settings
    // ask to see first, if the meeting already has it
    const have = N.tr.info.languages.map((l) => l.lang);
    const first = recHere() && cfg.live ? cfg.targets[0] : cfg.view !== 'original' ? cfg.targets.find((c) => have.includes(c)) || have[0] : '';
    if (first) { N.tr.lang = first; if (N.tr.view === 'original') N.tr.view = 'both'; await trLoad(first); }
  } catch { N.tr.lang = ''; }
}
async function trLoad(lang) {
  N.tr.text = new Map();
  if (!lang) return;
  for (const s of await api('GET', `/api/notes/${N.id}/transcript?lang=${encodeURIComponent(lang)}`)) if (s.translation) N.tr.text.set(s.id, s.translation);
}
async function trStart(lang) {
  const r = await api('POST', `/api/notes/${N.id}/translate`, { lang });
  if (r.started || r.running) N.tr.job = { lang, done: 0, total: r.total };
}
async function trSelect(lang) {
  N.tr.lang = lang;
  try {
    await trLoad(lang);
    if (lang && N.tr.view === 'original') N.tr.view = 'both';
    if (lang && !N.tr.info.running.some((r) => r.lang === lang) && N.segs.some((s) => /\p{L}/u.test(s.text) && !N.tr.text.has(s.id))) await trStart(lang);
  } catch (e) { fail(e); }
  if (N.tab === 'transcript') renderTab();
}
const trProgress = () => (N.tr.job ? `<span class="xsmall muted" id="tr-progress">${esc(t('Translating {done} of {total}…', { done: N.tr.job.done, total: N.tr.job.total }))}</span><button class="btn xs ghost" data-tr-cancel>${t('Stop')}</button>` : '');
// The languages to pick from: the ones chosen in settings and the ones this meeting has, then the rest
function trOptions(selected) {
  const have = N.tr.info.languages.map((l) => l.lang);
  const first = [...new Set([...S.settings.translation.targets, ...have])];
  const rest = (S.languages || []).map((l) => l.code).filter((c) => !first.includes(c));
  const opt = (c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${esc(langName(c))}${have.includes(c) ? ' ✓' : ''}</option>`;
  return `${first.length ? `<optgroup label="${esc(t('Translate to'))}">${first.map(opt).join('')}</optgroup>` : ''}${rest.length ? `<optgroup label="${esc(t('Other languages'))}">${rest.map(opt).join('')}</optgroup>` : ''}`;
}
function trControls() {
  if (!trOn() || (!N.segs.length && !recHere())) return '';
  const tr = N.tr, pick = (v, label) => `<button class="btn xs ${tr.view === v || (v === 'both' && tr.view === 'original') ? 'primary' : 'ghost'}" data-tr-view="${v}" aria-pressed="${tr.view === v}">${t(label)}</button>`;
  return `<select id="tr-lang" aria-label="${esc(t('Language'))}" title="${esc(t('Show this meeting translated'))}" style="width:auto"><option value="">${t('Original')}</option>${trOptions(tr.lang)}</select>
    ${tr.lang ? `<span class="row" style="gap:2px" role="group" aria-label="${esc(t('Show'))}">${pick('translation', 'Translation')}${pick('both', 'Both')}</span>` : ''}${trProgress()}`;
}
function trEvent(type, d) {
  const tr = N.tr;
  if (!tr) return;
  if (type === 'translation.started') { if (!tr.job || d.lang === tr.lang) tr.job = { lang: d.lang, done: 0, total: d.total }; }
  else if (type === 'translation.segment') {
    if (d.lang !== tr.lang) return;
    tr.text.set(d.segmentId, d.text);
    const seg = N.segs.find((x) => x.id === d.segmentId), el = seg && $(`.seg[data-id="${seg.id}"]`);
    if (el) el.outerHTML = segHtml(seg);   // the line, now with its translation
    return;
  } else if (type === 'translation.progress') {
    if (tr.job?.lang === d.lang) tr.job = { lang: d.lang, done: d.done, total: d.total };
    const el = $('#tr-progress');
    if (el) el.textContent = t('Translating {done} of {total}…', { done: d.done, total: d.total });
    return;
  } else if (type === 'translation.done') {
    if (tr.job?.lang === d.lang) tr.job = null;
    if (d.failed) toast(t('{n} lines could not be translated.', { n: d.failed }), { error: true });
    api('GET', `/api/notes/${N.id}/translations`).then((info) => { tr.info = info; if (N.tab === 'transcript') renderTab(); }).catch(() => {});
    return;
  } else if (type === 'translation.failed') { if (tr.job?.lang === d.lang) tr.job = null; fail(new Error(d.message)); }
  if (N.tab === 'transcript') renderTab();
}
async function sumSelect(lang) {
  const tr = N.tr;
  tr.sumLang = lang; tr.summary = '';
  if (lang) {
    try {
      let r = await api('GET', `/api/notes/${N.id}/summary-translation?lang=${encodeURIComponent(lang)}`);
      if (r.text === null) { toast(t('Translating the notes…')); r = await api('POST', `/api/notes/${N.id}/summary-translation`, { lang }); }
      tr.summary = r.text || '';
      tr.sumFor = N.note.summary;   // the notes it is the translation of: once they change, it is not shown
    } catch (e) { fail(e); tr.sumLang = ''; }
  }
  if (N.tab === 'summary') renderTab();
}

// ---------- header ----------
function header() {
  const n = N.note, c = N.card;
  const range = n.startedAt && n.endedAt ? `${fmtHour(n.startedAt)} – ${fmtHour(n.endedAt)}` : fmtHour(n.createdAt);
  return `<div class="note-top">
    <button class="btn ghost icon" data-act="back" title="${t('Back')}" aria-label="${t('Back')}">${icon('back')}</button>
    <div class="tt">
      <div class="row wrap" style="gap:10px"><input class="title-input grow" value="${esc(n.title)}" placeholder="${t('Untitled meeting')}" aria-label="${t('Title')}" style="min-width:200px"></div>
      <div class="note-meta">
        <span>${icon('calendar', 'sm')}${fmtDate(n.createdAt)}</span><span>${icon('clock', 'sm')}${range}${c.durationMs ? ` (${fmtDur(c.durationMs)})` : ''}</span>
        ${n.platform ? `<span>${icon('video', 'sm')}${esc(PLATFORMS[n.platform] || n.platform)}</span>` : ''}
        <span title="${t('Source')}">${icon(SOURCES[n.source]?.icon || 'file', 'sm')}${t(SOURCES[n.source]?.label || n.source)}</span>
        ${c.external != null ? `<button class="badge ${c.external ? 'info' : ''}" data-act="external" title="${t('Click to change')}">${c.external ? t('External') : t('Internal')}</button>` : `<button class="badge unset" data-act="external" title="${t('Mark as internal or external')}">${icon('globe', 'sm')}${t('Internal / external?')}</button>`}
        <select id="note-space" aria-label="${t('Space')}"><option value="">${t('No space')}</option>${S.spaces.map((x) => `<option value="${x.id}" ${x.id === n.folderId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <span class="row wrap" style="gap:6px" id="tagrow">${N.tags.map((tg) => `<span class="tagchip"><span class="dot" style="background:${tg.color}"></span>${esc(tg.name)}<button class="linkish x" data-untag="${esc(tg.name)}" aria-label="${t('Remove')}">${icon('x', 'sm')}</button></span>`).join('')}<button class="btn xs ghost" data-act="add-tag">${icon('tag', 'sm')} ${t('Tag')}</button></span>
      </div>
    </div>
    <div class="note-actions">
      ${finishing() ? `<button class="btn" disabled>${spinner()} ${t('Finishing…')}</button>` : recHere() ? `<button class="btn danger" data-act="stop">${icon('stop', 'sm')} ${t('Stop')}</button>` : `<button class="btn" data-act="record" ${S.rec.active ? `disabled title="${esc(S.rec.finalizing ? t('Wait for the last recording to finish') : t('Another meeting is being recorded'))}"` : ''}>${icon('mic', 'sm')} ${N.segs.length ? t('Resume recording') : t('Record')}</button>`}
      <button class="btn" data-act="share">${icon('share', 'sm')} ${t('Share')}</button>
      <button class="btn icon" data-act="more" aria-label="${t('More')}">${icon('more')}</button>
    </div></div>`;
}
const refreshHeader = (main) => { const top = $('.note-top', main); if (top && !top.contains(document.activeElement)) top.outerHTML = header(); };

// ---------- tabs ----------
function renderTab() {
  const body = $('#tabbody');
  if (!body) return;
  $$('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === N.tab)));
  ({ summary: summaryTab, transcript: transcriptTab, notes: notesTab, snippets: snippetsTab, chat: chatTab })[N.tab](body);
  fitLive();
}

function summaryTab(body) {
  const n = N.note, ins = n.insights;
  const tpl = `<select id="tpl" aria-label="${t('Template')}" style="width:auto">${S.templates.map((x) => `<option value="${x.id}" ${x.id === (n.templateId || S.settings.defaultTemplate) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;
  const streaming = S.streaming?.noteId === N.id;
  const nothing = !n.body.trim() && !N.segs.length;
  body.innerHTML = `<div class="tb">${tpl}<button class="btn primary sm" data-act="enhance" ${streaming || nothing ? 'disabled' : ''}>${icon('sparkles', 'sm')} ${n.summary ? t('Regenerate') : t('Enhance notes')}</button>
      <button class="btn sm" data-act="insights" ${nothing && !n.summary ? 'disabled' : ''} title="${t('Extract topics, glossary terms and action items')}">${icon('wand', 'sm')} ${ins ? t('Re-analyse') : t('Analyse')}</button>
      ${trOn() && n.summary && !streaming ? `<select id="sum-lang" aria-label="${esc(t('Read the notes in'))}" title="${esc(t('Read the notes in another language'))}" style="width:auto"><option value="">${t('Original')}</option>${trOptions(N.tr.sumLang)}</select>` : ''}
      <span class="spacer"></span>${n.summary ? `<button class="btn ghost sm" data-act="copy-summary">${icon('copy', 'sm')} ${t('Copy')}</button><button class="btn ghost sm" data-act="edit-summary">${icon('edit', 'sm')} ${t('Edit')}</button>` : ''}</div>
    ${!S.state?.llmConfigured ? `<div class="banner mb small">${icon('sparkles')}<div class="grow">${t('Enhancing uses your AI model. Without one, “Analyse” still finds topics offline.')}</div><a class="btn xs" href="#/settings/ai">${t('Set up AI')}</a></div>` : ''}
    ${ins?.overview ? section('overview', 'Overview', 'file', `<p style="margin:0">${esc(ins.overview)}</p>`) : ''}
    ${ins?.keyPoints?.length ? section('kp', 'Key points', 'pin', `<div class="kp-grid">${ins.keyPoints.map((k) => `<div class="kp"><h4>${esc(k.title)}</h4><ul>${k.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>`).join('')}</div>`) : ''}
    ${ins?.decisions?.length ? section('dec', 'Decisions', 'ok', `<ul class="md" style="margin:0">${ins.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`) : ''}
    ${section('actions', 'Action items', 'checksq', actionsHtml(), N.actions.length ? `<span class="badge">${N.actions.filter((a) => !a.done).length}/${N.actions.length}</span>` : '')}
    ${ins?.nextSteps?.length ? section('next', 'Next steps', 'arrowright', `<ul class="md" style="margin:0">${ins.nextSteps.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`) : ''}
    ${section('enhanced', 'Enhanced notes', 'sparkles', `<div id="summary" class="md">${streaming ? streamingHtml() : n.summary ? renderMarkdown(N.tr?.sumLang && N.tr.summary && N.tr.sumFor === n.summary ? N.tr.summary : n.summary) : `<div class="muted small">${nothing ? t('Type notes or record the meeting first, then enhance them into a structured summary.') : t('No enhanced notes yet. Pick a template and press “Enhance notes”.')}</div>`}</div>`)}`;
}
const section = (k, title, ic, html, extra = '') => `<details class="section-card" open data-sec="${k}"><summary>${icon(ic)}${t(title)} ${extra}${icon('chevdown', 'sm chev')}</summary><div class="sb">${html}</div></details>`;
const streamingHtml = () => `<div class="typing">${renderMarkdown(S.streaming.text) || `<span class="muted">${S.streaming.stage || t('Writing…')}</span>`}</div>`;

function actionsHtml() {
  const rows = N.actions.map((a) => `<div class="act-row ${a.done ? 'done' : ''}" data-aid="${a.id}">
    <input type="checkbox" class="cbx" ${a.done ? 'checked' : ''} aria-label="${t('Done')}">
    <div class="txt"><div class="t" contenteditable="true" spellcheck="true" data-field="text">${esc(a.text)}</div>
      <div class="meta"><button class="linkish" data-act="a-owner">${icon('user', 'sm')} ${a.owner ? esc(a.owner) : `<span class="faint">${t('Owner')}</span>`}</button>
      <label class="row" style="gap:4px;cursor:pointer">${icon('calendar', 'sm')}<input type="date" required value="${esc(a.due)}" data-field="due" title="${t('Due date')}" style="height:22px;padding:0 4px;border:0;background:transparent;width:auto;font-size:12px;color:inherit"></label>
      ${a.extUrl ? `<a href="${esc(a.extUrl)}" target="_blank" rel="noopener noreferrer" class="badge accent">${icon('link', 'sm')} ${esc(a.extId || 'Linear')}</a>` : ''}</div></div>
    <div class="tools">${!a.extUrl && S.integrations?.linear?.configured ? `<button class="btn ghost icon xs" data-act="a-linear" title="${t('Create a Linear issue')}">${icon('checksq', 'sm')}</button>` : ''}<button class="btn ghost icon xs" data-act="a-del" title="${t('Delete')}">${icon('trash', 'sm')}</button></div></div>`).join('');
  return `<div id="actlist">${rows || `<div class="muted small" style="padding:4px 0 8px">${t('No action items yet. Enhancing or analysing the meeting finds them; you can also add your own.')}</div>`}</div>
    <form class="row mt-s" id="a-add"><input id="a-new" placeholder="${t('Add an action item…')}" aria-label="${t('Add an action item… (use @name for the owner)')}" title="${t('Add an action item… (use @name for the owner)')}"><button class="btn icon soft" aria-label="${t('Add')}">${icon('plus', 'sm')}</button></form>`;
}

function transcriptTab(body) {
  const total = N.analytics.durationMs || 1;
  // drawn again (a speaker renamed, the voices relabelled after Stop): stay where the reader was, unless following the newest line
  const prev = $('#segs');
  N.restoreTop = !prev ? null : prev.classList.contains('live') && N.follow !== false ? 'end' : prev.scrollTop;
  body.innerHTML = `<div class="tb">${recControls()}
      <div class="tr-search">${icon('search', 'sm')}<input type="search" id="tr-q" placeholder="${t('Find in transcript')}" value="${esc(N.trq)}"></div>
      ${trControls()}
      <span class="spacer"></span>
      ${!S.rec.active && N.segs.length ? `<label class="btn sm ghost" title="${t('Name the speakers from a Teams, Zoom or Meet transcript file (.vtt, .srt, .docx) of this meeting')}">${icon('users', 'sm')} ${t('Attach platform transcript')}<input type="file" id="attachtranscript" accept=".vtt,.srt,.docx,.txt,.md,.json,.html" hidden></label>` : ''}
      ${!S.rec.active ? `<label class="btn sm ghost" title="${t('Add audio to this meeting')}">${icon('upload', 'sm')} ${t('Add audio')}<input type="file" id="importfile" accept="audio/*,video/*" hidden></label>` : ''}
      ${N.segs.length ? `<button class="btn sm ghost" data-act="copy-transcript">${icon('copy', 'sm')} ${t('Copy')}</button>` : ''}</div>
    ${N.speakers.length ? `<div class="chips mb">${N.speakers.map((x) => `<button class="chip" data-rename="${x.speakerId}" title="${esc(whyName(x) || t('Name this speaker'))}"><span class="dot" style="background:${speakerColor(x.speakerId)}"></span>${esc(spLabel(x))}${x.voiceId ? ` ${icon('check', 'sm')}` : ''}${guessed(x) ? ` <span title="${esc(t('from the conversation'))}">${icon('sparkles', 'sm')}</span>` : ''}</button>${guessed(x) ? `<button class="btn xs ghost icon" data-confirm-name="${x.speakerId}" title="${esc(t('Keep this name'))}" aria-label="${esc(t('Keep this name'))}">${icon('check', 'sm')}</button><button class="btn xs ghost icon" data-reject-name="${x.speakerId}" title="${esc(t('Not this name'))}" aria-label="${esc(t('Not this name'))}">${icon('x', 'sm')}</button>` : ''}`).join('')}${N.speakers.some(unnamed) && S.settings?.llm?.baseUrl ? `<button class="btn xs ghost" data-guess-names title="${esc(t('Ask your AI who they are, from what they say: "I\'m Maria", "Thanks, George".'))}">${icon('sparkles', 'sm')}${t('Guess names')}</button>` : ''}${N.speakers.length > 1 ? `<button class="btn xs ghost" data-merge-speakers title="${t('Two names for the same person? Join them.')}">${icon('users', 'sm')}${t('Merge speakers')}</button>` : ''}<span class="xsmall muted" style="align-self:center">${t('Click a name to rename; names can be remembered by voice.')}</span></div>` : N.segs.length && !S.state?.speakerModel ? `<div class="banner small mb">${icon('users')}<div class="grow">${t('Telling speakers apart needs a small voice model.')}</div><a class="btn xs" href="#/settings/audio">${t('Get it')}</a></div>` : ''}
    ${N.analytics.timeline.length > 1 ? `<div class="timeline" title="${t('Who spoke when')}">${N.analytics.timeline.map((s) => `<i style="left:${(s.startMs / total) * 100}%;width:${Math.max(0.3, ((s.endMs - s.startMs) / total) * 100)}%;background:${speakerColor(s.speakerId, s.speakerId)}"></i>`).join('')}</div><div class="timeline-legend mb"><span>0:00</span><span>${fmtClock(total)}</span></div>` : ''}
    ${finBanner()}<div class="segs-wrap"><div class="segs boxed${recHere() ? ' live' : ''}" id="segs">${N.segs.length || draftsHtml() ? N.segs.map(segHtml).join('') + draftsHtml() : empty('waves', t('No transcript yet'), recHere() ? t('Listening… lines appear here as people speak.') : t('Press Record to capture the meeting, or add an audio file.'))}</div><button type="button" class="btn sm jump-latest" id="jump-latest" hidden>${icon('chevdown', 'sm')} ${t('Latest')}</button></div>`;
  if (N.trq) filterTranscript();
  if (N.seg) { const el = $(`.seg[data-id="${N.seg}"]`); if (el) { el.classList.add('hl'); N.restoreTop = null; setTimeout(() => centreLine(el), 60); } N.seg = null; }
  else if (recHere() && N.restoreTop === null) requestAnimationFrame(() => scrollLatest());
  wireLiveBox(N.restoreTop !== null);
}
// Scroll the transcript box (never the page) so a line sits in its middle
function centreLine(el) { const box = $('#segs'); if (box) box.scrollTop = el.offsetTop - (box.clientHeight - el.offsetHeight) / 2; }
// After Stop the recording is finished in the background (the last words, then who spoke when): the app stays usable meanwhile.
const finishing = () => recHere() && !!S.rec.finalizing;
const spinner = () => '<span class="spinner" aria-hidden="true"></span>';
const finStage = () => (S.rec.stage === 'speakers' ? t('Identifying speakers…') : t('Finishing transcription…'));
const finBanner = () => (finishing() ? `<div class="banner small mb" id="fin-banner" role="status">${spinner()}<div class="grow"><b>${finStage()}</b><div class="muted">${t('This runs in the background: you can keep using the app. The transcript and speakers update here when it is done.')}</div></div></div>` : '');
function syncFinishing() {
  const wrap = $('.segs-wrap');
  if (!wrap) return;
  $('#fin-banner')?.remove();
  wrap.insertAdjacentHTML('beforebegin', finBanner());
  fitLive();
}
const muteBtn = () => (S.rec.micAvailable === false ? '' : `<button class="btn sm ${S.rec.micMuted ? 'danger' : ''}" data-act="mute" aria-pressed="${!!S.rec.micMuted}" title="${esc(S.rec.micMuted ? t('Unmute my microphone') : t('Mute my microphone: nothing I say is recorded'))}">${icon(S.rec.micMuted ? 'micoff' : 'mic', 'sm')} ${S.rec.micMuted ? t('Unmute') : t('Mute')}</button>`);
const recControls = () => (finishing() ? `<button class="btn sm" data-act="finishing" disabled>${spinner()} ${t('Finishing…')}</button>` : recHere() ? `${muteBtn()}<button class="btn sm" data-act="pause">${icon(S.rec.paused ? 'play' : 'pause', 'sm')} ${S.rec.paused ? t('Resume') : t('Pause')}</button><button class="btn sm danger" data-act="stop">${icon('stop', 'sm')} ${t('Stop')}</button>` : `<button class="btn sm primary" data-act="record" ${S.rec.active ? 'disabled' : ''}>${icon('mic', 'sm')} ${t('Record')}</button>`);

function highlightTerms(text) {
  let html = esc(text);
  for (const g of N.glossary) {
    for (const term of [g.term, ...(g.aliases || [])].filter((x) => x && x.length > 1)) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${esc(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[^\\p{L}\\p{N}])`, 'giu');
      html = html.replace(re, (m, pre, w) => `${pre}<span class="term" title="${esc(g.definition)}">${w}</span>`);
    }
  }
  return html;
}
// The words of a line: as said, with the translation beneath ('both') or in their place ('translation'), when there is one
function lineBody(s) {
  const tr = N.tr?.lang && N.tr.view !== 'original' ? N.tr.text.get(s.id) : '';
  if (!tr) return `<div class="txt${N.tr?.lang && N.tr.view === 'translation' && /\p{L}/u.test(s.text) ? ' untranslated' : ''}">${highlightTerms(s.text)}</div>`;
  return N.tr.view === 'translation' ? `<div class="txt">${highlightTerms(tr)}</div>` : `<div class="txt">${highlightTerms(s.text)}</div><div class="txt tr-line">${highlightTerms(tr)}</div>`;
}
function segHtml(s) {
  const name = label(s);
  const starred = N.snippets.some((x) => x.segmentId === s.id);
  return `<div class="seg ${starred ? 'starred' : ''}" data-id="${s.id}">${avatar(name, { color: speakerColor(s.speakerId, name) })}
    <div><div class="who"><button class="linkish" data-rename="${esc(s.speakerId || '')}" style="color:${speakerColor(s.speakerId, name)}">${esc(name)}</button><span class="ts">${fmtClock(s.startMs)}</span>${s.overlap ? `<span class="overlap" title="${esc(t('Somebody else was talking at the same time here: some words may be less reliable, and they are not used to learn a voice.'))}">${icon('users', 'sm')} ${t('overlap')}</span>` : ''}</div>
    ${lineBody(s)}</div>
    <div class="tools"><button class="btn ghost icon xs star-btn" data-act="star" title="${starred ? t('Remove from snippets') : t('Save as snippet')}" aria-label="${t('Save as snippet')}">${icon('star', 'sm')}</button>
      ${N.speakers.length > 1 && s.speakerId ? `<select class="seg-reassign" data-seg="${s.id}" aria-label="${t('Change who said this')}" title="${t('Change who said this')}">${N.speakers.map((x) => `<option value="${x.speakerId}" ${x.speakerId === s.speakerId ? 'selected' : ''}>${esc(spLabel(x))}</option>`).join('')}</select>` : ''}
      <button class="btn ghost icon xs" data-act="copy-seg" title="${t('Copy')}" aria-label="${t('Copy')}">${icon('copy', 'sm')}</button></div></div>`;
}
// Draft words of the utterance someone is saying right now (dimmed; the final line replaces them). Never saved.
function draftHtml(d) {
  const name = speakerText({ kind: d.speaker === 'me' ? 'me' : 'them' });
  return `<div class="seg draft" data-draft="${esc(d.ch)}">${avatar(name, { color: speakerColor(null, name) })}
    <div><div class="who"><span style="color:${speakerColor(null, name)}">${esc(name)}</span><span class="ts">${fmtClock(d.startMs)}</span></div><div class="txt">${esc(d.text)}</div></div></div>`;
}
const draftsHtml = () => Object.values(N.drafts).filter(Boolean).map(draftHtml).join('');
const speakerChannel = (speaker) => (speaker === 'me' ? 'mic' : 'system');
function showDraft(d) {
  N.drafts[d.ch] = d.text ? d : null;
  if (N.tab !== 'transcript') return;
  const box = $('#segs');
  if (!box) return;
  const el = $(`.seg.draft[data-draft="${d.ch}"]`, box);
  if (!d.text) { el?.remove(); return; }
  if (el) { $('.txt', el).textContent = d.text; return; }
  if (!$('.seg', box)) box.innerHTML = ''; // the "no transcript yet" placeholder
  box.insertAdjacentHTML('beforeend', draftHtml(d));
  keepInView();
}
// The transcript is a fixed-height box with its own scrollbar, while recording and after. While recording here it follows the
// newest line: scrolling up to re-read pauses the following (and offers "Latest"); reaching the bottom again, or pressing it,
// resumes it. No scrolling of the whole page.
const nearEnd = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 80;
function scrollLatest() { const box = $('#segs'); if (!box) return; box.scrollTop = box.scrollHeight; N.follow = true; const j = $('#jump-latest'); if (j) j.hidden = true; }
// On the transcript tab the page itself does not scroll: the transcript box is sized to end above the bottom of the window (and
// the recording bar while it shows) and the side cards scroll inside their own column, so there is exactly one scrollbar for the
// lines. Any other tab leaves the page to scroll as usual.
const BAR_CLEARANCE = 100;   // the floating recording bar (20px off the bottom, ~46px tall) plus the card's own padding
const EDGE_CLEARANCE = 30;   // no recording bar: the card's own padding and a little air
function fitLive() {
  const main = $('#main'), box = $('#segs'), aside = $('#aside');
  if (!main) return;
  const fit = !!N && N.tab === 'transcript' && !!box;
  const grid = $('.note-grid'), sideBySide = !!grid && getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length > 1;
  main.classList.toggle('fit', fit && sideBySide);   // stacked (narrow window): the side cards come below, so the page must scroll to reach them
  if (box) box.style.height = '';
  if (aside) aside.style.maxHeight = '';
  if (!fit) return;
  if (sideBySide) main.scrollTop = 0;
  const top = (el) => el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
  box.style.height = `${Math.max(140, main.clientHeight - top(box) - (S.rec.active ? BAR_CLEARANCE : EDGE_CLEARANCE))}px`;
  if (aside && sideBySide) aside.style.maxHeight = `${Math.max(200, main.clientHeight - top(aside) - 40)}px`;
  if (N.restoreTop != null) { box.scrollTop = N.restoreTop === 'end' ? box.scrollHeight : N.restoreTop; N.restoreTop = null; }
  else if (box.classList.contains('live') && N.follow !== false) box.scrollTop = box.scrollHeight;
}
let fitWired = false;
// restoring: the box was drawn again where the reader had scrolled to, so whether it follows the newest line is kept as it was
function wireLiveBox(restoring = false) {
  if (!fitWired) { fitWired = true; window.addEventListener('resize', () => { if ($('#segs')) fitLive(); }); }
  const box = $('#segs'), jump = $('#jump-latest');
  if (!box || !jump) return;
  if (!restoring) N.follow = true;
  jump.hidden = !box.classList.contains('live') || N.follow !== false;
  box.addEventListener('scroll', () => { if (!box.classList.contains('live')) return; N.follow = nearEnd(box); jump.hidden = N.follow; }, { passive: true });
  jump.addEventListener('click', scrollLatest);
}
function syncLiveBox() {
  const box = $('#segs');
  if (!box) { fitLive(); return; }
  const live = !!N && recHere();
  const was = box.classList.contains('live');
  box.classList.toggle('live', live);
  fitLive();
  if (live && !was) scrollLatest(); else if (!live) { const j = $('#jump-latest'); if (j) j.hidden = true; }
}
function keepInView() {
  const box = $('#segs');
  if (!box) return;
  if (box.classList.contains('live') ? N.follow !== false : nearEnd(box)) box.scrollTop = box.scrollHeight;
}
function filterTranscript() {
  const q = N.trq.toLowerCase();
  let hits = 0;
  $$('.seg:not(.draft)', $('#segs')).forEach((el) => {
    const s = N.segs.find((x) => x.id === Number(el.dataset.id));
    const match = !q || s.text.toLowerCase().includes(q) || label(s).toLowerCase().includes(q);
    el.hidden = !match;
    if (match && q) hits++;
    const txt = $('.txt', el);
    txt.innerHTML = q && match ? highlightTerms(s.text).replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![^<]*>)`, 'gi'), '<mark>$1</mark>') : highlightTerms(s.text);
  });
  return hits;
}

function notesTab(body) {
  body.innerHTML = `<div class="tb">${recControls()}<span class="spacer"></span><span class="xsmall faint">${t('Markdown supported · saved automatically')}</span></div>
    <textarea class="editor" placeholder="${t('Type your own notes here. They stay the backbone of the enhanced summary.')}" aria-label="${t('Notes')}">${esc(N.note.body)}</textarea>`;
  const ta = $('.editor', body);
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
}

function snippetsTab(body) {
  body.innerHTML = N.snippets.length ? `<div class="stack">${N.snippets.map((s) => `<div class="quote" data-snip="${s.id}"><div class="row between"><div class="src">${avatar(s.speaker || '?', { cls: 'sm' })}<b>${esc(s.speaker || '')}</b>${fmtClock(s.startMs)}${s.label ? ` · <span class="badge accent">${esc(s.label)}</span>` : ''}</div>
      <div class="row" style="gap:2px"><button class="btn ghost icon xs" data-act="snip-go" title="${t('Show in transcript')}">${icon('arrowright', 'sm')}</button><button class="btn ghost icon xs" data-act="snip-label" title="${t('Label')}">${icon('tag', 'sm')}</button><button class="btn ghost icon xs" data-act="snip-del" title="${t('Remove')}">${icon('trash', 'sm')}</button></div></div>
      <div class="q">“${esc(s.text)}”</div></div>`).join('')}</div>`
    : empty('star', t('No snippets yet'), t('Hover over a transcript line and press the star to keep the moments that matter.'));
}

function chatTab(body) {
  renderChat(body, N.chat, { noteId: N.id, suggestions: [t('Summarise in 3 bullets'), t('List the action items with owners'), t('What was decided?'), t('Draft a follow-up email'), t('What did each person care about?')], placeholder: t('Ask about this meeting…') });
}

// ---------- aside ----------
function renderAside() {
  const box = $('#aside');
  if (!box) return;
  const sp = N.analytics.speakers;
  const attendees = N.note.attendees || [];
  // How many other people are on the call: the speaker pass at Stop splits the call audio into exactly that many voices.
  const count = N.note.source === 'recorded' ? `<div class="row" style="gap:8px;margin:0 0 10px" title="${t('How many other people talk on the call (not counting you). Set it before you press Stop: who said what is worked out when the recording ends.')}">
      <label class="xsmall muted grow" for="sp-count">${t('Others on the call')}</label>
      <select id="sp-count" style="width:auto"><option value="">${t('Auto')}</option>${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${N.note.speakerCount === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></div>` : '';
  box.innerHTML = `
    <section class="panel"><div class="panel-head"><h3>${icon('users')} ${t('Speakers')} <span class="badge">${sp.length}</span></h3></div>
      ${count}
      ${sp.length ? `<table class="sp-table"><thead><tr><th>${t('Participant')}</th><th title="${t('Words per minute')}">WPM</th><th>${t('Talk')}</th><th>${t('Talk / listen')}</th></tr></thead><tbody>${sp.map((s) => `<tr>
        <td><div class="sp-name">${avatar(s.label, { cls: 'sm', color: speakerColor(s.speakerId, s.label) })}<div style="min-width:0"><b>${esc(s.label)}</b><span class="xsmall muted">${s.turns} ${t('turns')}${s.questions ? ` · ${s.questions} ?` : ''}</span></div></div></td>
        <td>${s.wpm || '—'}</td><td>${fmtDur(s.talkMs)}</td>
        <td><div class="ratio" title="${s.talkPct}% / ${s.listenPct}%"><i style="width:${s.talkPct}%;background:var(--accent)"></i><i style="width:${s.listenPct}%;background:var(--accent-line)"></i></div><span class="xsmall muted">${s.talkPct}%</span></td></tr>`).join('')}</tbody></table>`
      : `<div class="small muted">${t('Speaker statistics appear once there is a transcript.')}</div>`}
      ${attendees.length ? `<div class="divider"></div><div class="xsmall muted strong" style="margin-bottom:6px">${t('Invited')}</div><div class="chips">${attendees.slice(0, 12).map((a) => `<a class="chip" href="#/person/${encodeURIComponent((a.name || a.email || '').toLowerCase())}">${avatar(a.name || a.email, { cls: 'sm' })}<span class="ellipsis">${esc(a.name || a.email)}</span></a>`).join('')}</div>` : ''}
    </section>
    <section class="panel"><div class="panel-head"><h3>${icon('network')} ${t('Topics')}</h3><button class="btn ghost icon xs" data-act="add-topic" title="${t('Add topic')}" aria-label="${t('Add topic')}">${icon('plus', 'sm')}</button></div>
      ${N.topics.length ? `<div class="stack">${N.topics.map((tp) => `<div><div class="row"><a class="chip" href="#/topic/${tp.id}">${icon('hash', 'sm')}<span class="ellipsis">${esc(tp.name)}</span></a><span class="grow"></span>${tp.auto ? '' : `<span class="badge" title="${t('Added by you')}">${icon('user', 'sm')}</span>`}<button class="btn ghost icon xs" data-untopic="${tp.id}" aria-label="${t('Remove')}">${icon('x', 'sm')}</button></div>${tp.summary ? `<div class="xsmall muted" style="margin:4px 0 0 4px">${esc(tp.summary)}</div>` : ''}</div>`).join('')}</div>` : `<div class="small muted">${t('Topics are found automatically after a recording or import. Press “Analyse” to refresh them.')}</div>`}
    </section>
    ${N.glossary.length ? `<section class="panel"><div class="panel-head"><h3>${icon('book')} ${t('Glossary')}</h3><a class="link" href="#/glossary">${t('All')}</a></div><div class="stack tight">${N.glossary.slice(0, 8).map((g) => `<a class="quote" href="#/term/${g.id}"><b>${esc(g.term)}</b><span class="xsmall muted clamp2">${esc(g.definition || t('No definition yet'))}</span></a>`).join('')}</div></section>` : ''}
    <section class="panel"><div class="panel-head"><h3>${icon('link')} ${t('Linked')}</h3><button class="btn ghost icon xs" data-act="add-link" title="${t('Link to…')}" aria-label="${t('Link to…')}">${icon('plus', 'sm')}</button></div>
      ${N.links.length ? `<div class="stack tight">${N.links.map((l) => `<div class="row"><span class="srcicon">${icon({ notion: 'doc', linear: 'checksq', obsidian: 'book', calendar: 'video', webhook: 'webhook' }[l.kind] || 'link')}</span><a class="grow ellipsis small" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title || l.url)}</a><button class="btn ghost icon xs" data-unlink="${l.id}" aria-label="${t('Remove')}">${icon('x', 'sm')}</button></div>`).join('')}</div>` : `<div class="small muted">${t('Export to Notion, Obsidian or Linear — or link an issue — and it shows up here.')}</div>`}
    </section>
    ${N.related.length ? `<section class="panel"><div class="panel-head"><h3>${icon('layers')} ${t('Related meetings')}</h3></div><div class="list">${N.related.map((r) => meetingRow(r, { snippet: esc(r.reasons.join(' · ')) })).join('')}</div></section>` : ''}`;
  fitLive();
}

// ---------- actions ----------
function bind(main) {
  const saveNote = debounce(async (patch) => { try { await api('PATCH', `/api/notes/${N.id}`, patch); window.dispatchEvent(new Event('wb:refresh')); } catch (e) { fail(e); } }, 600);
  main.oninput = (e) => {
    if (e.target.matches('.title-input')) { N.note.title = e.target.value; saveNote({ title: e.target.value }); }
    else if (e.target.matches('.editor')) { N.note.body = e.target.value; saveNote({ body: e.target.value }); }
    else if (e.target.matches('#summary-edit')) { N.note.summary = e.target.value; saveNote({ summary: e.target.value }); }
    else if (e.target.matches('#tr-q')) { N.trq = e.target.value.trim(); filterTranscript(); }
  };
  main.onchange = async (e) => {
    try {
      if (e.target.matches('#tpl')) { N.note.templateId = e.target.value; await api('PATCH', `/api/notes/${N.id}`, { templateId: e.target.value }); }
      else if (e.target.matches('#note-space')) { await api('PATCH', `/api/notes/${N.id}`, { folderId: e.target.value || null }); N.note.folderId = e.target.value || null; window.dispatchEvent(new Event('wb:refresh')); done(t('Moved')); }
      else if (e.target.matches('#sp-count')) { const v = e.target.value ? Number(e.target.value) : null; await api('PATCH', `/api/notes/${N.id}`, { speakerCount: v }); N.note.speakerCount = v; done(v ? t('Speakers will be split into {n} voices when the recording stops', { n: v }) : t('Saved')); }
      else if (e.target.matches('#tr-lang')) await trSelect(e.target.value);
      else if (e.target.matches('#sum-lang')) await sumSelect(e.target.value);
      else if (e.target.matches('#importfile')) await importAudio(e.target.files[0]);
      else if (e.target.matches('#attachtranscript')) { await attachTranscript(e.target.files[0]); e.target.value = ''; }
      else if (e.target.matches('.seg-reassign')) { await api('POST', `/api/notes/${N.id}/segments/${e.target.dataset.seg}/speaker`, { speakerId: e.target.value }); await reloadTranscript(); }
      else if (e.target.matches('.act-row .cbx')) { const row = e.target.closest('.act-row'); await api('PATCH', `/api/actions/${row.dataset.aid}`, { done: e.target.checked }); row.classList.toggle('done', e.target.checked); const a = N.actions.find((x) => x.id === row.dataset.aid); if (a) a.done = e.target.checked; window.dispatchEvent(new Event('wb:refresh')); }
      else if (e.target.matches('.act-row [data-field="due"]')) { const row = e.target.closest('.act-row'); await api('PATCH', `/api/actions/${row.dataset.aid}`, { due: e.target.value }); }
    } catch (err) { fail(err); }
  };
  main.addEventListener('focusout', async (e) => {
    if (!e.target.matches?.('.act-row [data-field="text"]')) return;
    const row = e.target.closest('.act-row'), a = N.actions.find((x) => x.id === row.dataset.aid);
    const text = e.target.textContent.trim();
    if (!a || text === a.text) return;
    if (!text) { e.target.textContent = a.text; return; }
    try { await api('PATCH', `/api/actions/${a.id}`, { text }); a.text = text; } catch (err) { fail(err); }
  });
  main.addEventListener('keydown', (e) => { if (e.target.matches?.('.act-row [data-field="text"]') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
  main.addEventListener('submit', async (e) => {
    if (e.target.id !== 'a-add') return;
    e.preventDefault();
    const raw = $('#a-new').value.trim();
    if (!raw) return;
    const owner = /@([\p{L}][\p{L}.-]*(?:\s[\p{Lu}][\p{L}.-]*)?)/u.exec(raw)?.[1] || '';
    try { const a = await api('POST', `/api/notes/${N.id}/actions`, { text: raw.replace(/@\S+(\s\p{Lu}\S*)?/u, '').trim() || raw, owner }); N.actions.push(a); rerenderActions(); $('#a-new')?.focus(); window.dispatchEvent(new Event('wb:refresh')); } catch (err) { fail(err); }
  });
  main.onclick = async (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { N.tab = tab.dataset.tab; history.replaceState(null, '', `#/note/${N.id}?tab=${N.tab}`); renderTab(); return; }
    if (e.target.closest('[data-merge-speakers]')) { mergeSpeakers(); return; }
    const tv = e.target.closest('[data-tr-view]');
    if (tv) { N.tr.view = tv.dataset.trView; renderTab(); return; }
    if (e.target.closest('[data-tr-cancel]')) { const j = N.tr.job; N.tr.job = null; if (j) await api('POST', `/api/notes/${N.id}/translate/cancel`, { lang: j.lang }).catch(() => {}); renderTab(); return; }
    const gn = e.target.closest('[data-guess-names]');
    if (gn) { guessNames(gn); return; }
    const cn = e.target.closest('[data-confirm-name]');
    if (cn) { await keepGuess(cn.dataset.confirmName); return; }
    const rn = e.target.closest('[data-reject-name]');
    if (rn) { await dropGuess(rn.dataset.rejectName); return; }
    const ren = e.target.closest('[data-rename]');
    if (ren) { if (ren.dataset.rename) renameSpeaker(ren.dataset.rename); return; }
    const un = e.target.closest('[data-untag]');
    if (un) { e.preventDefault(); await setTags(N.tags.map((x) => x.name).filter((x) => x !== un.dataset.untag)); return; }
    const ut = e.target.closest('[data-untopic]');
    if (ut) { N.topics = await api('DELETE', `/api/notes/${N.id}/topics/${ut.dataset.untopic}`); renderAside(); window.dispatchEvent(new Event('wb:refresh')); return; }
    const ul = e.target.closest('[data-unlink]');
    if (ul) { await api('DELETE', `/api/links/${ul.dataset.unlink}`); N.links = N.links.filter((l) => l.id !== ul.dataset.unlink); renderAside(); return; }
    const btn = e.target.closest('[data-act]');
    const a = btn?.dataset.act;
    if (!a) return;
    try {
      if (a === 'back') history.length > 1 ? history.back() : go('#/meetings');
      else if (a === 'record') await startRecording(N.id);
      else if (a === 'stop') await stopRecording();
      else if (a === 'pause') await api('POST', `/api/recording/${S.rec.paused ? 'resume' : 'pause'}`);
      else if (a === 'mute') await api('POST', '/api/recording/mic-mute', { muted: !S.rec.micMuted });
      else if (a === 'share') openExport(N.id);
      else if (a === 'more') moreMenu(btn, main);
      else if (a === 'add-tag') addTag();
      else if (a === 'external') { const next = N.card.external === true ? false : N.card.external === false ? null : true; await api('PATCH', `/api/notes/${N.id}`, { external: next }); N.card.external = next === null ? null : next; refreshHeader(main); }
      else if (a === 'enhance') await enhance();
      else if (a === 'insights') await analyse(btn);
      else if (a === 'copy-summary') { await navigator.clipboard.writeText(N.note.summary); done(t('Copied')); }
      else if (a === 'edit-summary') { $('#summary').innerHTML = `<textarea id="summary-edit" class="editor" style="min-height:40vh">${esc(N.note.summary)}</textarea>`; btn.outerHTML = `<button class="btn sm" data-act="done-edit">${icon('check', 'sm')} ${t('Done')}</button>`; $('#summary-edit').focus(); }
      else if (a === 'done-edit') renderTab();
      else if (a === 'copy-transcript') { await navigator.clipboard.writeText(N.segs.map((s) => `${label(s)} [${fmtClock(s.startMs)}] ${s.text}`).join('\n')); done(t('Copied')); }
      else if (a === 'copy-seg') { const s = N.segs.find((x) => x.id === Number(btn.closest('.seg').dataset.id)); await navigator.clipboard.writeText(`“${s.text}” — ${label(s)}`); done(t('Copied')); }
      else if (a === 'star') await toggleStar(btn.closest('.seg'));
      else if (a === 'a-del') { const id = btn.closest('.act-row').dataset.aid; await api('DELETE', `/api/actions/${id}`); N.actions = N.actions.filter((x) => x.id !== id); rerenderActions(); window.dispatchEvent(new Event('wb:refresh')); }
      else if (a === 'a-owner') { const row = btn.closest('.act-row'), it = N.actions.find((x) => x.id === row.dataset.aid); const people = [...new Set([...N.analytics.speakers.map((s) => s.label), ...(N.note.attendees || []).map((x) => x.name).filter(Boolean)])]; const r = await promptDialog(t('Who owns this?'), it.owner, { extra: people.length ? `<div class="chips">${people.map((p) => `<button type="button" class="chip" data-suggest="${esc(p)}">${esc(p)}</button>`).join('')}</div>` : '' }); const v = typeof r === 'string' ? r : r?.value; if (v !== undefined && v !== null) { Object.assign(it, await api('PATCH', `/api/actions/${it.id}`, { owner: v })); rerenderActions(); } }
      else if (a === 'a-linear') { btn.disabled = true; const id = btn.closest('.act-row').dataset.aid; const r = await api('POST', `/api/notes/${N.id}/send`, { target: 'linear', mode: 'actions', itemIds: [id] }); toast(t('Created {id}', { id: r.issues[0].identifier }), { ok: true }); await reloadOverview(main); }
      else if (a === 'add-topic') { const name = await promptDialog(t('Add a topic'), '', { placeholder: t('e.g. Pricing') }); if (name) { N.topics = await api('POST', `/api/notes/${N.id}/topics`, { name }); renderAside(); window.dispatchEvent(new Event('wb:refresh')); } }
      else if (a === 'add-link') await addLink();
      else if (a === 'snip-del') { const id = btn.closest('[data-snip]').dataset.snip; await api('DELETE', `/api/snippets/${id}`); N.snippets = N.snippets.filter((s) => s.id !== id); renderTab(); updateCounts(); }
      else if (a === 'snip-label') { const id = btn.closest('[data-snip]').dataset.snip; const s = N.snippets.find((x) => x.id === id); const v = await promptDialog(t('Label this snippet'), s.label, { placeholder: t('e.g. Pricing objection') }); if (v !== null && v !== undefined) { await api('PATCH', `/api/snippets/${id}`, { label: v }); s.label = v; renderTab(); } }
      else if (a === 'snip-go') { const s = N.snippets.find((x) => x.id === btn.closest('[data-snip]').dataset.snip); N.tab = 'transcript'; N.seg = s.segmentId; renderTab(); }
    } catch (err) { fail(err); }
  };
}

function moreMenu(btn, main) {
  const n = N.note;
  menu(btn, [
    { label: n.pinned ? t('Unpin') : t('Pin to top'), icon: 'pin', run: async () => { n.pinned = !n.pinned; await api('PATCH', `/api/notes/${N.id}`, { pinned: n.pinned }); window.dispatchEvent(new Event('wb:refresh')); done(); } },
    { label: t('Generate a title'), icon: 'wand', disabled: !S.state?.llmConfigured, run: async () => { const r = await api('POST', `/api/notes/${N.id}/title`); N.note.title = r.title; $('.title-input', main).value = r.title; window.dispatchEvent(new Event('wb:refresh')); } },
    { label: t('Analyse offline (no AI)'), icon: 'network', run: () => analyse(null, true) },
    { label: t('Copy link to this meeting'), icon: 'link', run: async () => { await navigator.clipboard.writeText(`whisperbrain://note/${N.id}`); done(t('Copied')); } },
    'sep',
    { label: t('Export & share…'), icon: 'share', run: () => openExport(N.id) },
    { label: t('Download Markdown'), icon: 'download', href: `/api/notes/${N.id}/export?format=md`, download: true },
    'sep',
    { label: t('Delete transcript only'), icon: 'x', danger: true, disabled: !N.segs.length || recHere(), run: async () => { if (await confirmDialog(t('Delete this transcript and its speaker labels? Your notes and summary stay.'))) { await api('DELETE', `/api/notes/${N.id}/transcript`); go(`#/note/${N.id}`); } } },
    { label: t('Delete meeting'), icon: 'trash', danger: true, run: async () => { if (await confirmDialog(t('Delete this meeting and its transcript? This cannot be undone.'))) { await api('DELETE', `/api/notes/${N.id}`); window.dispatchEvent(new Event('wb:refresh')); go('#/meetings'); } } },
  ], { align: 'end' });
}

async function setTags(names) {
  N.tags = await api('PUT', `/api/notes/${N.id}/tags`, { tags: names });
  refreshHeader($('#main'));
  window.dispatchEvent(new Event('wb:refresh'));
}
async function addTag() {
  const current = new Set(N.tags.map((x) => x.name.toLowerCase()));
  const others = S.tags.filter((x) => !current.has(x.name.toLowerCase()));
  const r = await promptDialog(t('Add tag'), '', { placeholder: t('Type a new tag or pick one'), extra: others.length ? `<div class="chips">${others.map((tg) => `<button type="button" class="chip" data-suggest="${esc(tg.name)}"><span class="dot" style="background:${tg.color}"></span>${esc(tg.name)}</button>`).join('')}</div>` : '' });
  const v = typeof r === 'string' ? r : r?.value;
  if (v) await setTags([...N.tags.map((x) => x.name), ...v.split(',').map((s) => s.trim()).filter(Boolean)]);
}

async function addLink() {
  const ints = S.integrations || (S.integrations = await api('GET', '/api/integrations'));
  await modal({
    title: t('Link to…'),
    body: `<div class="seg-ctl full" role="tablist"><button type="button" role="tab" data-lk="url" aria-selected="true">${icon('link', 'sm')} URL</button>${ints.linear?.configured ? `<button type="button" role="tab" data-lk="linear" aria-selected="false">${icon('checksq', 'sm')} Linear</button>` : ''}${ints.notion?.configured ? `<button type="button" role="tab" data-lk="notion" aria-selected="false">${icon('doc', 'sm')} Notion</button>` : ''}${ints.obsidian?.configured ? `<button type="button" role="tab" data-lk="obsidian" aria-selected="false">${icon('book', 'sm')} Obsidian</button>` : ''}</div><div id="lk-body"></div>`,
    onMount: (d, close) => {
      const body = $('#lk-body', d);
      const show = (k) => {
        $$('[data-lk]', d).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.lk === k)));
        if (k === 'url') {
          body.innerHTML = `<div class="field"><label for="lk-u">URL</label><input id="lk-u" type="url" placeholder="https://…"></div><div class="field"><label for="lk-t">${t('Title')}</label><input id="lk-t"></div><div class="row" style="justify-content:flex-end"><button class="btn primary" id="lk-go">${t('Add link')}</button></div>`;
          $('#lk-go', d).onclick = async () => { try { N.links.push(await api('POST', `/api/notes/${N.id}/links`, { kind: 'url', url: $('#lk-u', d).value.trim(), title: $('#lk-t', d).value.trim() })); renderAside(); close(); } catch (e) { fail(e); } };
          return;
        }
        body.innerHTML = `<div class="search-in" style="max-width:none">${icon('search', 'sm')}<input id="lk-q" placeholder="${t('Search…')}"></div><div class="picklist" id="lk-list"></div>`;
        const list = $('#lk-list', body);
        const search = debounce(async (q) => {
          try {
            const items = k === 'linear' ? await api('GET', `/api/integrations/linear/search?q=${encodeURIComponent(q)}`) : k === 'notion' ? await api('GET', `/api/integrations/notion/search?q=${encodeURIComponent(q)}`) : await api('GET', `/api/integrations/obsidian/notes?q=${encodeURIComponent(q)}`);
            list.innerHTML = items.slice(0, 30).map((it, i) => `<label data-i="${i}"><span class="grow ellipsis">${esc(k === 'linear' ? `${it.identifier} ${it.title}` : it.title || it.relPath)}</span>${icon('plus', 'sm')}</label>`).join('') || `<div class="empty"><p>${t('Nothing found.')}</p></div>`;
            list.onclick = async (ev) => {
              const row = ev.target.closest('[data-i]'); if (!row) return;
              const it = items[Number(row.dataset.i)];
              const vault = encodeURIComponent((S.settings.obsidian.vaultPath || '').split(/[\\/]/).filter(Boolean).pop() || '');
              const link = k === 'linear' ? { kind: 'linear', ref: it.identifier, url: it.url, title: `${it.identifier} ${it.title}` } : k === 'notion' ? { kind: 'notion', ref: it.id, url: it.url, title: it.title } : { kind: 'obsidian', ref: it.relPath, url: `obsidian://open?vault=${vault}&file=${encodeURIComponent(it.relPath.replace(/\.md$/, ''))}`, title: it.relPath };
              try { N.links.push(await api('POST', `/api/notes/${N.id}/links`, link)); renderAside(); close(); } catch (e) { fail(e); }
            };
          } catch (e) { list.innerHTML = `<div class="banner danger">${esc(e.message)}</div>`; }
        }, 300);
        $('#lk-q', body).addEventListener('input', (ev) => search(ev.target.value.trim()));
        search('');
      };
      d.addEventListener('click', (e) => { const b = e.target.closest('[data-lk]'); if (b) show(b.dataset.lk); });
      show('url');
    },
  });
}

// A Teams / Zoom / Meet transcript of this meeting names the voices: the server matches it to the recording by what was said.
async function attachTranscript(file) {
  if (!file) return;
  try {
    const r = await api('POST', `/api/notes/${N.id}/attach-transcript?filename=${encodeURIComponent(file.name)}`, file);
    await reloadTranscript();
    toast(r.named.length ? t('Named {n} speaker(s) from the transcript.', { n: r.named.length }) + (r.kept.length ? ` ${t('{n} already named were left as they are.', { n: r.kept.length })}` : '') : t('The transcript matched, but it names nobody new.'), { ok: true });
  } catch (e) { fail(e); }
}

// One person heard as two voices: fold one speaker into another (the server refuses voices that clearly differ).
async function mergeSpeakers() {
  const options = (selected) => N.speakers.map((x, i) => `<option value="${esc(x.speakerId)}" ${i === selected ? 'selected' : ''}>${esc(spLabel(x))}</option>`).join('');
  const r = await modal({
    title: t('Merge speakers'),
    body: `<div class="stack"><label class="field"><span>${t('This speaker')}</span><select name="from">${options(1)}</select></label>
      <label class="field"><span>${t('is the same person as')}</span><select name="into">${options(0)}</select></label>
      <div class="hint">${t('Their lines are joined under the second name. This cannot be split again automatically.')}</div></div>`,
    foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" data-ok>${t('Merge')}</button>`,
    onMount: (d, close) => { $('[data-ok]', d).onclick = () => close({ from: $('[name=from]', d).value, into: $('[name=into]', d).value }); },
  });
  if (!r) return;
  if (r.from === r.into) { toast(t('Pick two different speakers.')); return; }
  try { await api('POST', `/api/notes/${N.id}/speakers/${r.from}/merge`, { into: r.into }); await reloadTranscript(); done(); } catch (e) { fail(e); }
}

// Names from what people say (src/speakers/transcript-names.js): ask, keep one (it becomes the person's own name), or turn one down
async function guessNames(btn) {
  btn.disabled = true;
  try {
    const r = await api('POST', `/api/notes/${N.id}/speakers/guess-names`);
    toast(r.named.length ? t('Names found: {n}', { n: r.named.length }) : t('Nobody could be named: the conversation does not say who they are.'));
    await reloadTranscript();
  } catch (e) { fail(e); btn.disabled = false; }
}
async function keepGuess(speakerId) {
  const sp = N.speakers.find((x) => x.speakerId === speakerId);
  if (!sp?.name) return;
  try { await api('PATCH', `/api/notes/${N.id}/speakers/${speakerId}`, { name: sp.name }); await reloadTranscript(); } catch (e) { fail(e); }
}
async function dropGuess(speakerId) {
  try { await api('POST', `/api/notes/${N.id}/speakers/${speakerId}/reject-name`); await reloadTranscript(); } catch (e) { fail(e); }
}
async function renameSpeaker(speakerId) {
  const sp = N.speakers.find((x) => x.speakerId === speakerId);
  if (!sp) return;
  const voices = await api('GET', '/api/voices').catch(() => []);
  const suggestions = [...new Set([...(N.note.attendees || []).map((a) => a.name).filter(Boolean), ...voices.map((v) => v.name)])];
  const r = await promptDialog(t('Name this speaker'), sp.name || sp.voiceName || '', {
    hint: sp.name || sp.voiceName ? whyName(sp) : '',
    extra: `<label class="check"><input type="checkbox" name="remember"> ${t('Remember this voice and recognise this person in future meetings')}</label>
      ${suggestions.length ? `<div class="chips">${suggestions.map((n) => `<button type="button" class="chip" data-suggest="${esc(n)}">${avatar(n, { cls: 'sm' })}${esc(n)}</button>`).join('')}</div>` : ''}
      <div class="hint">${t('Voices are compared on this device only.')}</div>`,
  });
  if (!r?.value) return;
  try { await api('PATCH', `/api/notes/${N.id}/speakers/${speakerId}`, { name: r.value, remember: !!r.data.remember }); await reloadTranscript(); done(); } catch (e) { fail(e); }
}

async function toggleStar(el) {
  const segId = Number(el.dataset.id);
  const ex = N.snippets.find((s) => s.segmentId === segId);
  if (ex) { await api('DELETE', `/api/snippets/${ex.id}`); N.snippets = N.snippets.filter((s) => s !== ex); el.classList.remove('starred'); }
  else { N.snippets.push(await api('POST', `/api/notes/${N.id}/snippets`, { segmentId: segId })); el.classList.add('starred'); done(t('Saved to snippets')); }
  updateCounts();
}

async function enhance() {
  const n = N.note, id = N.id;
  S.streaming = { noteId: id, text: '', stage: '' };
  renderTab();
  try {
    const result = await stream(`/api/notes/${id}/summarize`, { templateId: $('#tpl')?.value }, {
      onDelta: (d) => { S.streaming.text += d; if (N?.id === id && N.tab === 'summary' && $('#summary')) $('#summary').innerHTML = streamingHtml(); },
      onStage: (s) => { S.streaming.stage = s.stage === 'reduce' ? `${t('Reading the transcript…')} ${s.index}/${s.total}` : t('Writing…'); if ($('#summary')) $('#summary').innerHTML = streamingHtml(); },
    });
    if (N?.id === id) Object.assign(n, result);
    S.streaming = null;
    if (S.settings.autoInsights) { toast(t('Finding topics, glossary terms and action items…'), { iconName: 'wand', timeout: 4000 }); await api('POST', `/api/notes/${id}/insights`, {}).catch((e) => toast(e.message, { error: true })); }
  } catch (e) { fail(e); } finally { S.streaming = null; if (N?.id === id) await reloadOverview($('#main')); window.dispatchEvent(new Event('wb:refresh')); }
}

async function analyse(btn, local = false) {
  if (btn) { btn.disabled = true; btn.innerHTML = `${icon('wand', 'sm')} ${t('Analysing…')}`; }
  try {
    const r = await api('POST', `/api/notes/${N.id}/insights`, { local });
    if (r.warning) toast(r.warning, { error: true });
    done(r.mode === 'llm' ? t('Topics, glossary and action items updated') : t('Topics updated (offline)'));
    await reloadOverview($('#main'));
    window.dispatchEvent(new Event('wb:refresh'));
  } catch (e) { fail(e); if (btn) { btn.disabled = false; btn.innerHTML = `${icon('wand', 'sm')} ${t('Analyse')}`; } }
}

async function importAudio(file) {
  if (!file) return;
  const tst = toast(t('Transcribing {name}…', { name: file.name }), { timeout: 0, iconName: 'waves' });
  try {
    const r = await fetch(`/api/notes/${N.id}/import-audio?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    await api('POST', `/api/notes/${N.id}/insights`, { local: true }).catch(() => {});
    await reloadOverview($('#main')); await reloadTranscript();
    done(t('{n} lines transcribed', { n: d.segments }));
  } catch (e) { fail(e); } finally { tst.remove(); }
}

async function reloadTranscript() {
  [N.segs, N.speakers, N.analytics] = await Promise.all([api('GET', `/api/notes/${N.id}/transcript`), api('GET', `/api/notes/${N.id}/speakers`), api('GET', `/api/notes/${N.id}/analytics`)]);
  if (N.tab === 'transcript') renderTab();
  renderAside(); updateCounts();
}
async function reloadOverview(main) {
  const id = N.id;
  const ov = await api('GET', `/api/notes/${id}/overview`);
  if (N?.id !== id) return;
  Object.assign(N, ov);
  refreshHeader(main);
  if (!(N.tab === 'notes' && document.activeElement?.matches('.editor'))) renderTab();
  renderAside(); updateCounts();
}
function rerenderActions() { const sec = $('[data-sec="actions"] .sb'); if (sec) sec.innerHTML = actionsHtml(); updateCounts(); }
function updateCounts() { $$('[data-count]').forEach((b) => { const c = count(b.dataset.count); b.textContent = c; b.hidden = !c; }); }

// ---------- live events ----------
function handleEvent(main, type, d) {
  if (!N) return;
  const mine = (x) => x === N.id;
  if (type.startsWith('recording.')) requestAnimationFrame(syncLiveBox);
  if (type === 'recording.stopped' || type === 'recording.paused') { N.drafts = {}; $$('.seg.draft').forEach((el) => el.remove()); } // nothing is being said any more
  if (type === 'transcript.partial' && mine(d.noteId)) {
    showDraft(d);
  } else if (type === 'transcript.segment' && mine(d.noteId)) {
    N.segs.push(d.segment);
    N.drafts[speakerChannel(d.segment.speaker)] = null; // the final text takes the draft's place
    if (N.tab === 'transcript') {
      const box = $('#segs');
      if (box) {
        $(`.seg.draft[data-draft="${speakerChannel(d.segment.speaker)}"]`, box)?.remove();
        if (!$('.seg', box)) box.innerHTML = '';
        const html = segHtml(d.segment).replace('class="seg ', 'class="seg new ');
        const open = $('.seg.draft', box); // lines still being spoken stay below the finished ones
        if (open) open.insertAdjacentHTML('beforebegin', html); else box.insertAdjacentHTML('beforeend', html);
        keepInView();
      }
    }
    updateCounts();
  } else if (type.startsWith('translation.') && mine(d.noteId)) {
    trEvent(type, d);
  } else if (type === 'transcript.removed' && mine(d.noteId)) {
    N.segs = N.segs.filter((s) => !d.ids.includes(s.id));
    $$('.seg').forEach((el) => { if (d.ids.includes(Number(el.dataset.id))) el.remove(); });
  } else if (['recording.started', 'recording.stopped', 'recording.paused', 'recording.resumed', 'recording.mic-muted', 'recording.finalizing'].includes(type) && (mine(d.noteId) || type !== 'recording.started')) {
    if (type === 'recording.finalizing' || type === 'recording.stopped') syncFinishing();
    if (type === 'recording.stopped' && mine(d.noteId)) { reloadOverview(main).then(reloadTranscript); }
    else { refreshHeader(main); if (['transcript', 'notes'].includes(N.tab)) { const tb = $('.tb', main); if (tb) { const first = tb.querySelector('[data-act="record"], [data-act="mute"], [data-act="pause"], [data-act="finishing"]'); if (first) { const wrap = document.createElement('span'); wrap.innerHTML = recControls(); tb.querySelectorAll('[data-act="record"],[data-act="mute"],[data-act="pause"],[data-act="stop"],[data-act="finishing"]').forEach((x) => x.remove()); tb.prepend(...wrap.childNodes); } } } }
  } else if (type === 'speakers.updated' && mine(d.noteId)) {
    debouncedSpeakers();
  } else if (['note.insights', 'import.done'].includes(type) && mine(d.id || d.noteId)) {
    reloadOverview(main).then(() => type === 'import.done' && reloadTranscript());
  } else if (type === 'note.updated' && mine(d.id) && !S.streaming && !main.contains(document.activeElement)) {
    api('GET', `/api/notes/${N.id}`).then((n) => { const keep = N.note.body; Object.assign(N.note, n, { body: N.tab === 'notes' ? keep : n.body }); if (N.tab === 'summary') renderTab(); const ti = $('.title-input', main); if (ti && document.activeElement !== ti) ti.value = n.title; });
  } else if (type === 'knowledge.changed' && (d.what === 'glossary') ) {
    api('GET', `/api/notes/${N.id}/overview`).then((ov) => { N.glossary = ov.glossary; renderAside(); });
  }
}
const debouncedSpeakers = debounce(async () => { if (!N) return; N.speakers = await api('GET', `/api/notes/${N.id}/speakers`); if (!recHere()) { await reloadTranscript(); } else { [N.segs, N.analytics] = await Promise.all([api('GET', `/api/notes/${N.id}/transcript`), api('GET', `/api/notes/${N.id}/analytics`)]); if (N.tab === 'transcript') renderTab(); renderAside(); } }, 400); // while recording, a voice coming on show renames the lines already drawn
void tagChip; void srcIcon;
