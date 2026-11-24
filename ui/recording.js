// Recording state, the floating recording bar and taking notes for a meeting.
import { S, $, api, t, esc, icon, toast, fail, go, fmtTimer, menu, speakerText, lineText } from './lib.js';
import { getConsent, setConsent, copyNotice } from './consent.js';
import { startCapture, stopAllCapture } from './capture.js';

const recbar = $('#recbar');
let renderTop = () => {};
const bump = () => window.dispatchEvent(new Event('wb:refresh'));

export async function startRecording(noteId, extra = {}) {
  try {
    const st = await api('POST', '/api/recording/start', noteId ? { noteId } : { templateId: S.settings.defaultTemplate, ...extra });
    S.rec = { active: true, noteId: st.noteId, paused: false, baseMs: 0, base: Date.now(), elapsedMs: 0 };
    S.liveText = '';
    renderRecbar(); renderTop(); bump();
    if (!(S.view.name === 'note' && S.view.parts[1] === st.noteId)) go(`#/note/${st.noteId}?tab=transcript`);
    return st;
  } catch (e) {
    if (e.code === 'no-model') toast(e.message, { error: true, timeout: 14000, actions: [{ label: t('Choose a speech model'), primary: true, run: () => go('#/settings/audio') }] });
    else fail(e);
    return null;
  }
}

export async function stopRecording() {
  recbar.querySelector('[data-rec="stop"]')?.setAttribute('disabled', '');
  const r = await api('POST', '/api/recording/stop');
  stopAllCapture();
  return r;
}

// Create a note for a calendar event / detected call, and optionally start recording right away.
export async function takeNotesFor(d = {}, { record = false } = {}) {
  try {
    const attendees = (d.attendees || []).map((a) => ({ name: a.name || '', email: a.email || '' }));
    if (record) return await startRecording(null, { title: d.title || '', eventUid: d.uid, eventStart: d.start, attendees, platform: d.platform || undefined });
    const n = await api('POST', '/api/notes', { title: d.title || '', eventUid: d.uid, eventStart: d.start, attendees, templateId: S.settings.defaultTemplate, platform: d.platform || undefined });
    if (d.url) api('POST', `/api/notes/${n.id}/links`, { kind: 'calendar', url: d.url, title: t('Meeting link') }).catch(() => {});
    bump();
    go(`#/note/${n.id}`);
    return n;
  } catch (e) { fail(e); return null; }
}

// The recording bar shows the newest draft line, dimmed, until its final text arrives.
function showDraft(d) {
  S.drafts = { ...S.drafts, [d.ch]: d.text ? d : null };
  const live = Object.values(S.drafts).filter(Boolean).sort((a, b) => b.startMs - a.startMs)[0];
  S.liveDraft = live ? `${speakerText({ kind: live.speaker === 'me' ? 'me' : 'them' })}: ${live.text}` : '';
}

// Were the others on the call told? Shown on the bar for the whole recording: a warning until it is dealt with.
const CONSENT_LABEL = { unknown: 'Tell the others', announced: 'Others told', declined: 'Someone objected' };
const consentChip = () => {
  const c = S.rec.consent || 'unknown';
  return `<button class="btn sm ${c === 'unknown' ? 'warn' : c === 'declined' ? 'danger' : 'ghost'}" data-rec="consent" title="${t('Were the other people on the call told this is being recorded?')}">${icon(c === 'announced' ? 'check' : 'alert', 'sm')} ${t(CONSENT_LABEL[c])}</button>`;
};
// noteId: the recording the answer is about; a late answer for a recording that is over is ignored
export function setRecConsent(consent, noteId = S.rec.noteId) { if (S.rec.active && S.rec.noteId === noteId) { S.rec.consent = consent; renderRecbar(); } }
async function loadRecConsent(noteId) { try { setRecConsent(await getConsent(noteId), noteId); } catch { /* the bar still shows the warning */ } }

export function renderRecbar() {
  if (!S.rec.active) { recbar.hidden = true; return; }
  recbar.hidden = false;
  const bars = (v) => { const n = Math.min(5, Math.round(Math.sqrt(v || 0) * 14)); return `<span class="meter">${[0, 1, 2, 3, 4].map((i) => `<b style="height:${4 + i * 3}px;${i < n ? '' : 'background:var(--line-2)'}"></b>`).join('')}</span>`; };
  recbar.innerHTML = `<span class="dot-rec"></span><span class="time">${fmtTimer(S.rec.elapsedMs || 0)}</span>
    <a class="live" href="#/note/${S.rec.noteId}?tab=transcript">${S.rec.finalizing ? (S.rec.stage === 'speakers' ? t('Identifying speakers…') : t('Finishing transcription…')) : S.rec.paused ? t('Paused') : S.liveDraft ? `<span class="draft">${esc(S.liveDraft)}</span>` : esc(S.liveText || t('Listening…'))}</a>
    <span class="lvl" title="${t('Microphone')}${S.rec.aec?.active ? ` · ${t('echo cancelled')}` : ''}">${icon('mic', 'sm')}${bars(S.level.mic)}</span><span class="lvl" title="${t('System audio')}">${icon('waves', 'sm')}${bars(S.level.system)}</span>
    <button class="btn sm icon" data-rec="pause" ${S.rec.finalizing ? 'disabled' : ''} title="${S.rec.paused ? t('Resume') : t('Pause')}" aria-label="${S.rec.paused ? t('Resume') : t('Pause')}">${icon(S.rec.paused ? 'play' : 'pause')}</button>
    ${consentChip()}
    <button class="btn sm danger" data-rec="stop" ${S.rec.finalizing ? 'disabled' : ''}>${icon('stop', 'sm')} ${t('Stop')}</button>`;
}
recbar.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-rec]');
  if (!b) return;
  if (b.dataset.rec === 'consent') { consentMenu(b); return; }
  try { if (b.dataset.rec === 'stop') await stopRecording(); else await api('POST', `/api/recording/${S.rec.paused ? 'resume' : 'pause'}`); } catch (err) { fail(err); }
});
function consentMenu(anchor) {
  const id = S.rec.noteId;
  const mark = (c) => () => setConsent(id, c).then(() => setRecConsent(c, id)).catch(fail);
  menu(anchor, [
    { label: t('Copy notice for the meeting chat'), icon: 'copy', run: () => copyNotice().then(() => toast(t('Notice copied: paste it into the meeting chat, then choose “I told them”.'), { ok: true })).catch(fail) },
    { label: t('I told them'), icon: 'check', selected: S.rec.consent === 'announced', run: mark('announced') },
    { label: t('Someone objected'), icon: 'alert', selected: S.rec.consent === 'declined', run: mark('declined') },
    'sep',
    { label: t('Stop recording'), icon: 'stop', danger: true, run: () => stopRecording().catch(fail) },
  ]);
}
setInterval(() => {
  if (S.rec.active && !S.rec.paused && !S.rec.finalizing && S.rec.base) {
    S.rec.elapsedMs = (S.rec.baseMs || 0) + (Date.now() - S.rec.base);
    const el = $('.time', recbar); if (el) el.textContent = fmtTimer(S.rec.elapsedMs);
  }
}, 500);

export function syncRec(st) {
  if (st?.active) S.rec = { consent: S.rec.noteId === st.noteId ? S.rec.consent : undefined, active: true, noteId: st.noteId, paused: st.paused, finalizing: st.finalizing, stage: st.stage || null, baseMs: st.elapsedMs, base: Date.now(), elapsedMs: st.elapsedMs, aec: st.echo?.cancellation || null };
  else S.rec = { active: false };
  renderRecbar(); renderTop();
  if (st?.active && !S.rec.consent) loadRecConsent(st.noteId);
}

export async function handleCaptureRequest(d) {
  if (S.state?.capture?.mic === 'native' && S.state?.capture?.system === 'native') return;
  const base = d.dictation ? '/api/dictation/pcm' : `/api/recording/pcm?noteId=${encodeURIComponent(d.noteId)}`;
  for (const ch of d.channels) {
    try { await startCapture({ key: `${d.dictation ? 'dict' : d.noteId}:${ch}`, kind: ch, url: d.dictation ? base : `${base}&ch=${ch}`, deviceId: ch === 'mic' ? S.settings.micDevice : undefined, settings: S.settings, onError: fail }); }
    catch (e) { fail(new Error(`${ch === 'mic' ? t('Microphone') : t('System audio')}: ${e.message}`)); }
  }
}

// Event handlers for the SSE stream (merged into app.js's handler table).
export function recEvents({ renderTopbar }) {
  renderTop = renderTopbar;
  return {
    'recording.started': (d) => { S.rec = { active: true, noteId: d.noteId, paused: false, baseMs: 0, base: Date.now(), elapsedMs: 0, aec: d.echoCancellation || null }; S.liveText = ''; S.liveDraft = ''; renderRecbar(); renderTopbar(); bump(); loadRecConsent(d.noteId); },
    'recording.paused': () => { S.liveDraft = ''; S.drafts = {}; S.rec.paused = true; S.rec.baseMs = S.rec.elapsedMs; renderRecbar(); },
    'recording.resumed': () => { S.rec.paused = false; S.rec.base = Date.now(); renderRecbar(); },
    'recording.finalizing': (d) => { S.rec.finalizing = true; S.rec.stage = d?.stage || null; renderRecbar(); },
    'recording.stopped': () => { S.autoToast?.remove(); S.autoToast = null; S.liveDraft = ''; S.drafts = {}; S.rec = { active: false }; stopAllCapture(); renderRecbar(); renderTopbar(); bump(); },
    'recording.level': (d) => { S.level = { mic: d.mic, system: d.system }; if (S.rec.active) renderRecbar(); },
    'recording.warning': (d) => toast(d.message, { error: true }),
    'transcript.segment': (d) => { S.liveText = `${lineText(d.segment)}: ${d.segment.text}`; showDraft({ ch: d.segment.speaker === 'me' ? 'mic' : 'system', text: '' }); if (S.rec.active) renderRecbar(); },
    // draft words: the bar shows the most recent draft line, dimmed, until the final text arrives
    'transcript.partial': (d) => { showDraft(d); if (S.rec.active) renderRecbar(); },
  };
}
