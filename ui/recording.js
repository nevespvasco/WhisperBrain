// Recording state, the floating recording bar and taking notes for a meeting.
import { S, $, api, t, esc, icon, toast, fail, go, fmtTimer } from './lib.js';
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

export function renderRecbar() {
  if (!S.rec.active) { recbar.hidden = true; return; }
  recbar.hidden = false;
  const bars = (v) => { const n = Math.min(5, Math.round(Math.sqrt(v || 0) * 14)); return `<span class="meter">${[0, 1, 2, 3, 4].map((i) => `<b style="height:${4 + i * 3}px;${i < n ? '' : 'background:var(--line-2)'}"></b>`).join('')}</span>`; };
  recbar.innerHTML = `<span class="dot-rec"></span><span class="time">${fmtTimer(S.rec.elapsedMs || 0)}</span>
    <a class="live" href="#/note/${S.rec.noteId}?tab=transcript">${S.rec.finalizing ? t('Finishing transcription…') : S.rec.paused ? t('Paused') : esc(S.liveText || t('Listening…'))}</a>
    <span class="lvl" title="${t('Microphone')}">${icon('mic', 'sm')}${bars(S.level.mic)}</span><span class="lvl" title="${t('System audio')}">${icon('waves', 'sm')}${bars(S.level.system)}</span>
    <button class="btn sm icon" data-rec="pause" ${S.rec.finalizing ? 'disabled' : ''} title="${S.rec.paused ? t('Resume') : t('Pause')}" aria-label="${S.rec.paused ? t('Resume') : t('Pause')}">${icon(S.rec.paused ? 'play' : 'pause')}</button>
    <button class="btn sm danger" data-rec="stop" ${S.rec.finalizing ? 'disabled' : ''}>${icon('stop', 'sm')} ${t('Stop')}</button>`;
}
recbar.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-rec]');
  if (!b) return;
  try { if (b.dataset.rec === 'stop') await stopRecording(); else await api('POST', `/api/recording/${S.rec.paused ? 'resume' : 'pause'}`); } catch (err) { fail(err); }
});
setInterval(() => {
  if (S.rec.active && !S.rec.paused && !S.rec.finalizing && S.rec.base) {
    S.rec.elapsedMs = (S.rec.baseMs || 0) + (Date.now() - S.rec.base);
    const el = $('.time', recbar); if (el) el.textContent = fmtTimer(S.rec.elapsedMs);
  }
}, 500);

export function syncRec(st) {
  if (st?.active) S.rec = { active: true, noteId: st.noteId, paused: st.paused, finalizing: st.finalizing, baseMs: st.elapsedMs, base: Date.now(), elapsedMs: st.elapsedMs };
  else S.rec = { active: false };
  renderRecbar(); renderTop();
}

export async function handleCaptureRequest(d) {
  if (S.state?.capture?.mic === 'native' && S.state?.capture?.system === 'native') return;
  const base = d.dictation ? '/api/dictation/pcm' : `/api/recording/pcm?noteId=${encodeURIComponent(d.noteId)}`;
  for (const ch of d.channels) {
    try { await startCapture({ key: `${d.dictation ? 'dict' : d.noteId}:${ch}`, kind: ch, url: d.dictation ? base : `${base}&ch=${ch}`, deviceId: ch === 'mic' ? S.settings.micDevice : undefined, onError: fail }); }
    catch (e) { fail(new Error(`${ch === 'mic' ? t('Microphone') : t('System audio')}: ${e.message}`)); }
  }
}

// Event handlers for the SSE stream (merged into app.js's handler table).
export function recEvents({ renderTopbar }) {
  renderTop = renderTopbar;
  return {
    'recording.started': (d) => { S.rec = { active: true, noteId: d.noteId, paused: false, baseMs: 0, base: Date.now(), elapsedMs: 0 }; S.liveText = ''; renderRecbar(); renderTopbar(); bump(); },
    'recording.paused': () => { S.rec.paused = true; S.rec.baseMs = S.rec.elapsedMs; renderRecbar(); },
    'recording.resumed': () => { S.rec.paused = false; S.rec.base = Date.now(); renderRecbar(); },
    'recording.finalizing': () => { S.rec.finalizing = true; renderRecbar(); },
    'recording.stopped': () => { S.rec = { active: false }; stopAllCapture(); renderRecbar(); renderTopbar(); bump(); },
    'recording.level': (d) => { S.level = { mic: d.mic, system: d.system }; if (S.rec.active) renderRecbar(); },
    'recording.warning': (d) => toast(d.message, { error: true }),
    'transcript.segment': (d) => { S.liveText = `${d.segment.label ? d.segment.label + ': ' : ''}${d.segment.text}`; if (S.rec.active) renderRecbar(); },
  };
}
