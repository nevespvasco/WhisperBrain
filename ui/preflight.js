// "Before you record": only what decides what gets captured. Space, tags and internal/external are filed afterwards, so Record stays
// one click. Microphone, system audio and language are remembered settings (the same ones as Settings → Audio); the number of other
// voices belongs to this meeting.
import { S, api, t, esc, icon, pickFrom, done, fail } from './lib.js';

let mics = [];   // the last list the system gave, so a chip can name the chosen device
const micName = (id) => mics.find((m) => m.id === id)?.name;
const MAX_OTHERS = 12;

// Shown on a meeting that is empty and could be recorded now (not while any recording runs, not on an imported meeting)
export const preflightOn = (note, segs) => !S.rec.active && !segs.length && ['manual', 'recorded'].includes(note.source);

// the devices and languages a chip lists: fetched when the card is about to be drawn, never needed otherwise
export async function warmPreflight() {
  const [m, l] = await Promise.all([api('GET', '/api/audio/devices').catch(() => null), S.languages ? S.languages : api('GET', '/api/languages').catch(() => [])]);
  if (m) mics = m.mics || [];
  S.languages = l;
}

// speech models take a two-letter hint, so regional variants (pt-PT) fold into their language
const asrLanguages = () => (S.languages || []).filter((l) => !l.code.includes('-'));
const micValue = () => (S.settings.micEnabled === false ? t('Off') : S.settings.micDevice ? micName(S.settings.micDevice) || t('Chosen device') : t('Default'));
const langValue = () => (S.settings.asrLanguage && S.settings.asrLanguage !== 'auto' ? asrLanguages().find((l) => l.code === S.settings.asrLanguage)?.name || S.settings.asrLanguage : t('Auto-detect'));
const othersValue = (note) => (note.speakerCount ? String(note.speakerCount) : t('Auto'));

const chip = (act, ic, key, value, { off = false, tip = '', pressed } = {}) =>
  `<button type="button" class="pf-chip ${off ? 'off' : ''}" data-act="${act}" ${pressed === undefined ? '' : `aria-pressed="${pressed}"`} title="${esc(tip)}">${icon(ic, 'sm')}<span class="pf-k">${esc(key)}</span><b class="pf-v">${esc(value)}</b></button>`;

export function preflightHtml(note) {
  const sys = S.settings.systemAudioEnabled !== false, mic = S.settings.micEnabled !== false;
  return `<div class="preflight">
    <span class="pf-mark">${icon('mic', 'lg')}</span>
    <h3>${t('Ready when you are')}</h3>
    <p class="muted">${t('Check what will be captured, then press Record. Space, tags and internal/external can wait until the meeting is over.')}</p>
    <div class="pf-chips" role="group" aria-label="${esc(t('What will be recorded'))}">
      ${chip('pf-mic', mic ? 'mic' : 'micoff', t('Microphone'), micValue(), { off: !mic, tip: t('Your own voice. Choose the device, or turn it off.') })}
      ${chip('pf-sys', 'waves', t('System audio'), sys ? t('On') : t('Off'), { off: !sys, pressed: sys, tip: t('The other side of the call: whatever this computer plays.') })}
      ${chip('pf-lang', 'globe', t('Language'), langValue(), { tip: t('The language people speak. Auto-detect is right for most meetings.') })}
      ${sys ? chip('pf-others', 'users', t('Others on the call'), othersValue(note), { tip: t('How many other people talk on the call (not counting you). Leave it on Auto if you are not sure: you can set it again before you press Stop.') }) : ''}
    </div>
    <button class="btn primary pf-go" data-act="record" ${mic || sys ? '' : 'disabled'}>${icon('mic', 'sm')} ${t('Record')}</button>
    ${mic || sys ? '' : `<p class="xsmall pf-warn">${t('Turn on the microphone or system audio to record.')}</p>`}
    <p class="xsmall faint">${t('Remembered for next time.')} <label class="pf-link" for="importfile">${t('Or add an audio file')}</label></p>
  </div>`;
}

const save = async (patch) => { S.settings = await api('PUT', '/api/settings', patch); };

// act: the data-act of the chip pressed. ctx: { note, repaint(), aside() } from the meeting page.
export async function preflightAct(act, btn, { note, repaint, aside }) {
  try {
    if (act === 'pf-sys') await save({ systemAudioEnabled: S.settings.systemAudioEnabled === false });
    else if (act === 'pf-mic') {
      const m = await api('GET', '/api/audio/devices').catch(() => null);
      if (m) mics = m.mics || [];
      const cur = S.settings.micEnabled === false ? '__off' : S.settings.micDevice || '';
      const v = await pickFrom(btn, [{ value: '', label: t('System default') }, ...mics.map((x) => ({ value: x.id, label: x.name })), { value: '__off', label: t('Off: do not record my voice') }], { current: cur, search: false });
      if (v === undefined) return;
      await save(v === '__off' ? { micEnabled: false } : { micEnabled: true, micDevice: v });
    } else if (act === 'pf-lang') {
      const v = await pickFrom(btn, [{ value: 'auto', label: t('Auto-detect') }, ...asrLanguages().map((l) => ({ value: l.code, label: l.name, hint: l.native !== l.name ? l.native : '' }))], { current: S.settings.asrLanguage || 'auto', placeholder: t('Search languages…'), search: true });
      if (v === undefined) return;
      await save({ asrLanguage: v });
    } else if (act === 'pf-others') {
      const v = await pickFrom(btn, [{ value: '', label: t('Auto') }, ...Array.from({ length: MAX_OTHERS }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))], { current: note.speakerCount ? String(note.speakerCount) : '', search: false });
      if (v === undefined) return;
      const n = v ? Number(v) : null;
      await api('PATCH', `/api/notes/${note.id}`, { speakerCount: n });
      note.speakerCount = n;
      aside?.();
    } else return;
    repaint();
    if (act === 'pf-lang' && S.settings.asrLanguage !== 'auto') done(t('Language set. It applies to the next recording.'));
  } catch (e) { fail(e); }
}
