// Recording state, the floating recording bar and taking notes for a meeting.
import { S, $, api, t, esc, icon, toast, fail, go, fmtTimer, menu, modal, speakerText, lineText, PLATFORMS } from './lib.js';
import { getConsent, setConsent, copyNotice } from './consent.js';
import { startCapture, stopAllCapture } from './capture.js';
import { translateChip, translateMenu } from './translate-chip.js';

const recbar = $('#recbar');
let renderTop = () => {};
const bump = () => window.dispatchEvent(new Event('wb:refresh'));

export async function startRecording(noteId, extra = {}) {
  try {
    // Several calls live at once (Zoom and Discord): whatever button started this, the person says which audio to record.
    const ids = S.detector?.active ? S.detector.platforms || [] : [];
    if (extra.calls === undefined && extra.system !== false && S.settings.systemAudioEnabled !== false && ids.length > 1) {
      const chosen = await chooseCalls(ids);
      if (!chosen) return null;
      extra = { ...extra, calls: chosen };
    }
    const st = await api('POST', '/api/recording/start', noteId ? { noteId, calls: extra.calls } : { templateId: S.settings.defaultTemplate, ...extra });
    S.rec = { active: true, noteId: st.noteId, paused: false, baseMs: 0, base: Date.now(), elapsedMs: 0, micMuted: false, micAvailable: st.micAvailable !== false };
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
// calls: the live calls to record when there is more than one (ids such as 'zoom'); without it the system audio is followed as usual
export async function takeNotesFor(d = {}, { record = false, calls } = {}) {
  try {
    const attendees = (d.attendees || []).map((a) => ({ name: a.name || '', email: a.email || '' }));
    if (record) return await startRecording(null, { title: d.title || '', eventUid: d.uid, eventStart: d.start, attendees, platform: d.platform || undefined, calls });
    const n = await api('POST', '/api/notes', { title: d.title || '', eventUid: d.uid, eventStart: d.start, attendees, templateId: S.settings.defaultTemplate, platform: d.platform || undefined });
    if (d.url) api('POST', `/api/notes/${n.id}/links`, { kind: 'calendar', url: d.url, title: t('Meeting link') }).catch(() => {});
    bump();
    go(`#/note/${n.id}`);
    return n;
  } catch (e) { fail(e); return null; }
}

// Which audio should be recorded while several calls are live? One choice: a single call, or everything the computer plays
// (which is how to record all the calls). -> [id] for one call, [] for everything, or undefined when the person backed out.
export function chooseCalls(platforms) {
  const label = (id) => PLATFORMS[id] || id;
  const opt = (value, text, checked) => `<label class="row" style="gap:10px;align-items:center"><input type="radio" name="call" value="${esc(value)}" ${checked ? 'checked' : ''}> <span>${text}</span></label>`;
  return modal({
    title: t('What do you want to record?'),
    body: `<p class="muted" style="margin:0 0 10px">${t('These calls are live right now. Choose one to record only its audio, or record everything this computer plays.')}</p>
      <div class="stack tight">${platforms.map((id, i) => opt(id, esc(label(id)), i === 0)).join('')}
        <hr style="border:0;border-top:1px solid var(--line);margin:6px 0">
        ${opt('', t('Everything this computer plays'), false)}</div>`,
    foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" data-ok>${icon('mic', 'sm')} ${t('Record')}</button>`,
    onMount: (d, close) => {
      const ok = $('[data-ok]', d);
      ok.onclick = () => { const v = d.querySelector('input[name=call]:checked')?.value; close(v ? [v] : []); };
      ok.focus();
    },
  });
}

// "Take notes" for the call(s) the detector sees. d: the detector status or its event ({ platforms, platform, apps, event, title }).
// With several calls live the person chooses which to record.
export async function recordDetected(d = S.detector) {
  if (S.rec.active) return null;   // already recording: nothing to start
  const ids = d.platforms || [];
  let calls;
  if (ids.length > 1) {
    const chosen = await chooseCalls(ids);
    if (!chosen) return null;
    calls = chosen;   // [id] = only that call's audio; [] = everything the computer plays (startRecording does not ask again)
  }
  const e = d.event;
  return takeNotesFor(e ? { title: e.summary, uid: e.uid, start: e.start, attendees: e.attendees, platform: d.platform } : { platform: d.platform, title: d.title || '' }, { record: true, calls });
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
  patchChildren(recbar, `<span class="dot-rec"></span><span class="time">${fmtTimer(S.rec.elapsedMs || 0)}</span>
    <a class="live" href="#/note/${S.rec.noteId}?tab=transcript">${S.rec.finalizing ? `<span class="spinner" aria-hidden="true"></span> ${S.rec.stage === 'speakers' ? t('Identifying speakers…') : t('Finishing transcription…')}` : S.rec.paused ? t('Paused') : S.liveDraft ? `<span class="draft">${esc(S.liveDraft)}</span>` : esc(S.liveText || t('Listening…'))}</a>
    ${S.rec.micMuted ? `<span class="lvl muted" title="${esc(t('Your microphone is muted: nothing you say is recorded'))}">${icon('micoff', 'sm')}<b class="xsmall">${t('Muted')}</b></span>` : `<span class="lvl" title="${t('Microphone')}${S.rec.aec?.active ? ` · ${t('echo cancelled')}` : ''}">${icon('mic', 'sm')}${bars(S.level.mic)}</span>`}<span class="lvl" title="${t('System audio')}">${icon('waves', 'sm')}${bars(S.level.system)}</span>
    ${S.rec.micAvailable === false ? '' : `<button class="btn sm icon ${S.rec.micMuted ? 'danger' : ''}" data-rec="mute" ${S.rec.finalizing ? 'disabled' : ''} aria-pressed="${!!S.rec.micMuted}" title="${esc(S.rec.micMuted ? t('Unmute my microphone') : t('Mute my microphone: nothing I say is recorded'))}" aria-label="${esc(S.rec.micMuted ? t('Unmute my microphone') : t('Mute my microphone'))}">${icon(S.rec.micMuted ? 'micoff' : 'mic')}</button>`}
    <button class="btn sm icon" data-rec="pause" ${S.rec.finalizing ? 'disabled' : ''} title="${S.rec.paused ? t('Resume') : t('Pause')}" aria-label="${S.rec.paused ? t('Resume') : t('Pause')}">${icon(S.rec.paused ? 'play' : 'pause')}</button>
    ${translateChip('data-rec="translate"')}
    ${consentChip()}
    <button class="btn sm danger" data-rec="stop" ${S.rec.finalizing ? 'disabled' : ''}>${icon('stop', 'sm')} ${t('Stop')}</button>`);
}
// The bar is redrawn many times a second (audio levels, draft text, the clock). Replacing its whole HTML each time destroyed the
// button under the pointer mid-hover (flicker, lost clicks), so only the children that actually changed are swapped.
function patchChildren(el, html) {
  const next = document.createElement('div');
  next.innerHTML = html;
  const cur = el.childNodes, nxt = next.childNodes;
  if (cur.length !== nxt.length) { el.replaceChildren(...nxt); return; }
  for (let i = cur.length - 1; i >= 0; i--) if (!cur[i].isEqualNode(nxt[i])) cur[i].replaceWith(nxt[i]);
}
recbar.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-rec]');
  if (!b) return;
  if (b.dataset.rec === 'consent') { consentMenu(b); return; }
  if (b.dataset.rec === 'translate') { translateMenu(b); return; }
  if (b.dataset.rec === 'mute') { api('POST', '/api/recording/mic-mute', { muted: !S.rec.micMuted }).catch(fail); return; }
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
  if (st?.active) S.rec = { consent: S.rec.noteId === st.noteId ? S.rec.consent : undefined, active: true, noteId: st.noteId, paused: st.paused, finalizing: st.finalizing, stage: st.stage || null, micMuted: !!st.micMuted, micAvailable: st.micAvailable !== false, baseMs: st.elapsedMs, base: Date.now(), elapsedMs: st.elapsedMs, aec: st.echo?.cancellation || null };
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
    'recording.started': (d) => { S.detectToast?.remove(); S.detectToast = null; S.startingToast?.remove(); S.startingToast = null; S.rec = { micMuted: false, micAvailable: !(d.channels && !d.channels.includes('mic')), active: true, noteId: d.noteId, paused: false, baseMs: 0, base: Date.now(), elapsedMs: 0, aec: d.echoCancellation || null }; S.liveText = ''; S.liveDraft = ''; renderRecbar(); renderTopbar(); bump(); loadRecConsent(d.noteId); },
    'recording.mic-muted': (d) => { if (S.rec.active && S.rec.noteId === d.noteId) { S.rec.micMuted = d.muted; renderRecbar(); } },
    'recording.paused': () => { S.liveDraft = ''; S.drafts = {}; S.rec.paused = true; S.rec.baseMs = S.rec.elapsedMs; renderRecbar(); },
    'recording.resumed': () => { S.rec.paused = false; S.rec.base = Date.now(); renderRecbar(); },
    'recording.finalizing': (d) => { S.rec.finalizing = true; S.rec.stage = d?.stage || null; renderRecbar(); },
    'recording.stopped': (d) => {
      const finished = S.rec.finalizing && d?.noteId;
      S.autoToast?.remove(); S.autoToast = null; S.liveDraft = ''; S.drafts = {}; S.rec = { active: false }; stopAllCapture(); renderRecbar(); renderTopbar(); bump();
      // finished in the background while the person was elsewhere in the app: say so, with the way back
      if (finished && !(S.view.name === 'note' && S.view.parts[1] === d.noteId)) toast(t('The transcript is ready.'), { ok: true, timeout: 12000, actions: [{ label: t('Open'), primary: true, run: () => go(`#/note/${d.noteId}?tab=transcript`) }] });
    },
    'recording.level': (d) => { S.level = { mic: d.mic, system: d.system }; if (S.rec.active) renderRecbar(); },
    'recording.warning': (d) => toast(d.message, { error: true }),
    'transcript.segment': (d) => { S.liveText = `${lineText(d.segment)}: ${d.segment.text}`; showDraft({ ch: d.segment.speaker === 'me' ? 'mic' : 'system', text: '' }); if (S.rec.active) renderRecbar(); },
    // draft words: the bar shows the most recent draft line, dimmed, until the final text arrives
    'transcript.partial': (d) => { showDraft(d); if (S.rec.active) renderRecbar(); },
  };
}
