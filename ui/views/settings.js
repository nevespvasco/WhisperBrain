// Settings: account (data, exports, voices, danger zone), appearance, meetings & detection, audio & models,
// AI, templates, dictation and keyboard shortcuts.
import { S, $, api, t, esc, icon, fail, done, go, modal, promptDialog, confirmDialog, switchEl, field, download } from '../lib.js';
import { listMicrophones } from '../capture.js';
import { openExport } from './transfer.js';
import * as meetPanel from './meet-panel.js';

const SECTIONS = [['account', 'Account', 'user'], ['general', 'Appearance', 'sun'], ['meetings', 'Meetings & detection', 'video'], ['audio', 'Audio & transcription', 'mic'], ['ai', 'AI', 'sparkles'], ['templates', 'Templates', 'file'], ['dictation', 'Dictation', 'waves'], ['shortcuts', 'Shortcuts', 'bolt']];
let modelListener = null; // the Audio section's download listener (see bind)
const save = async (patch) => { S.settings = await api('PUT', '/api/settings', patch); document.documentElement.dataset.theme = S.settings.theme; return S.settings; };
const row = (title, sub, control) => `<div class="set-row"><div class="l"><b>${esc(title)}</b>${sub ? `<span>${sub}</span>` : ''}</div>${control}</div>`;
const tog = (id, on, title, sub) => row(title, sub, switchEl(id, on, title));
// Live drafts need the optional streaming model; say what is missing instead of silently doing nothing.
const draftHint = () => {
  const m = (S.models || []).find((x) => x.role === 'draft');
  const base = t('Grey draft words appear within about a second while someone talks, then the accurate text replaces them. Drafts are never saved.');
  return m && !m.installed ? `${base} ${t('Needs the “{name}” download below ({mb} MB).', { name: m.name, mb: m.sizeMB })}` : `${base} ${t('Uses about 1 GB of memory and some CPU during a recording; turned off automatically on small computers.')}`;
};

// Which speech models suit this computer (from /api/state modelAdvice) and when each one is worth having.
const FIT = { best: ['ok', 'Best for this computer'], good: ['accent', 'Recommended'], optional: ['', 'Only if needed'], skip: ['', 'Not needed here'] };
const WHEN = {
  main: 'Use it for every meeting: the most accurate, and it covers Portuguese, English and 23 other European languages.',
  'main-english': 'The best fit for the memory this computer has, if your meetings are in English.',
  'main-tiny': 'This computer has little memory, so this light model is the safest choice. Expect more mistakes.',
  'low-memory': 'Needs about 1.5 GB of free memory, which this computer is short of.',
  'english-not-needed': 'Parakeet 0.6B already handles English more accurately, and this computer runs it easily.',
  'english-light': 'For English-only meetings when you want to save CPU and battery, e.g. on a laptop that is unplugged.',
  draft: 'Get it if you like to follow the words live during a call. It never changes the saved transcript.',
  'draft-small': 'Needs at least 4 cores and 8 GB of memory. Without it, each line appears when the phrase ends.',
  'other-languages': 'Only for meetings in a language Parakeet does not cover (e.g. Japanese, Chinese, Arabic, Hindi). Slower, and it can invent text during long silences.',
  'other-languages-slow': 'Too slow on this computer; for languages Parakeet does not cover, use Whisper base.',
  'other-languages-light': 'For languages Parakeet does not cover, on a slower computer. Less accurate than Whisper small.',
  'whisper-small-better': 'For languages Parakeet does not cover, Whisper small is more accurate and runs fine here.',
};
// The models the advice says to have (main + live drafts when the computer can carry them) that are not installed yet.
const missingPicks = (adv) => (S.models || []).filter((m) => !m.installed && m.downloading == null && (m.id === adv.main || (adv.draft && m.role === 'draft')));
const adviceCard = (adv) => {
  if (!adv) return '';
  const names = (S.models || []).filter((m) => m.id === adv.main || (adv.draft && m.role === 'draft')).map((m) => esc(m.name));
  const missing = missingPicks(adv);
  const mb = missing.reduce((n, m) => n + m.sizeMB, 0);
  return `<div class="banner small mt-s"><div class="grow"><b>${t('For this computer')}</b> · ${t('{cores} cores, {mem} GB memory', { cores: adv.machine.cores, mem: adv.machine.memGB })}<br>
    ${t('Recommended')}: ${names.join(' + ')}. ${t('Leave “Use” on Automatic and WhisperBrain picks the best installed model for each recording.')}</div>
    ${missing.length ? `<button class="btn sm primary" data-act="model-setup">${icon('download', 'sm')} ${t('Set up for me')} (${mb} MB)</button>` : `<span class="badge ok">${t('All set')}</span>`}</div>`;
};

const fitBadge = (id) => { const f = FIT[S.state?.modelAdvice?.models[id]?.fit]; return f ? `<span class="badge ${f[0]}">${t(f[1])}</span>` : ''; };
const whenLine = (id) => { const w = WHEN[S.state?.modelAdvice?.models[id]?.when]; return w ? `<div class="small mt-s"><b>${t('When to use')}:</b> ${t(w)}</div>` : ''; };

// How API keys and tokens rest on disk (src/core/secret-box.js). Only worth a line when the protection is weak.
// What an organisation fixed on this computer (src/core/policy.js): shown so that a setting that will not change is not a mystery.
const policyBanner = () => {
  const p = S.state?.policy;
  if (!p || (!p.managed?.length && !p.problems?.length)) return '';
  if (p.problems?.length && !p.managed?.length) return `<div class="banner warn small mb" role="alert">${icon('lock')}<div class="grow">${t('The policy file on this computer could not be used, so nothing is managed:')} ${esc(p.problems[0])}</div></div>`;
  return `<div class="banner small mb">${icon('lock')}<div class="grow">${t('Your organisation manages these settings, and they cannot be changed here:')} <b>${esc(p.managed.join(', '))}</b></div></div>`;
};

const secretsBanner = () => {
  const st = S.state?.secrets;
  if (!st || !st.warning) return '';
  if (st.warning === 'key-file') return `<div class="banner small mb">${icon('lock')}<div class="grow">${t('API keys and tokens are sealed with a key file next to your data. That keeps them out of a copied database, but anyone who can read both files can read them.')}</div></div>`;
  const why = st.warning === 'no-backend' ? t('This computer has no system keystore available to protect your API keys and tokens.') : t('The system keystore on this computer gives no real protection (it is the “basic text” fallback), so your API keys and tokens are stored as plain text.');
  if (st.needsChoice) return `<div class="banner warn small mb" role="alert">${icon('lock')}<div class="grow">${why} ${t('Choose what to do:')}</div>
    <button class="btn xs" data-act="secrets-plaintext">${t('Keep them as plain text')}</button><button class="btn xs" data-act="secrets-never">${t('Do not save them')}</button></div>`;
  return `<div class="banner small mb">${icon('lock')}<div class="grow">${why} ${st.policy === 'never' ? t('You chose not to save them: they are forgotten when the app closes.') : t('You chose to keep them as plain text.')}</div></div>`;
};

export async function render(main, { parts }) {
  const sec = SECTIONS.some(([k]) => k === parts[1]) ? parts[1] : 'account';
  const shell = (inner) => `<div class="page"><div class="page-head"><div><h1>${t('Settings')}</h1></div></div>
    ${policyBanner()}${secretsBanner()}<div class="settings-layout"><nav class="settings-nav">${SECTIONS.map(([k, l, ic]) => `<a class="navlink" href="#/settings/${k}" ${k === sec ? 'aria-current="page"' : ''}>${icon(ic)}<span class="lbl">${t(l)}</span></a>`).join('')}</nav>
    <div id="secbody" class="set-section" data-sec="${sec}">${inner}</div></div></div>`;
  // Re-rendering the section already on screen (removing a model, a download finishing…) must not jump the page:
  // build the new content first, swap it in one go, and put the scroll position back.
  const again = main.querySelector('#secbody')?.dataset.sec === sec;
  const y = main.scrollTop;
  if (!again) main.innerHTML = shell('<div class="panel"><div class="skel" style="width:40%"></div></div>');
  const html = await SECTION[sec]();
  if (again) main.innerHTML = shell(html);
  else $('#secbody', main).innerHTML = html;
  if (again) main.scrollTop = y;
  bind(main, sec, $('#secbody', main));
}

const enhanceSelect = (id, v) => `<select id="${id}">${[['auto', t('Automatic')], ['on', t('On')], ['off', t('Off')]].map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;

// What echo cancellation can do on this machine, and what it is doing in the recording that is running.
function aecHint(s, caps, rec) {
  const live = rec?.active && rec.echo?.cancellation;
  const now = !live ? '' : live.active ? ` ${t('Active in this recording.')}` : live.active === false ? ` ${t('Not active in this recording:')} ${esc(live.reason || '')}` : '';
  if (caps?.echoCancel) {
    return (caps.echoCancel.available ? t('Uses PipeWire to remove the speakers\' sound from your microphone, so the other side is not transcribed twice.') : `${t('Not available here:')} ${esc(caps.echoCancel.reason)}. ${t('The text-based echo removal still runs.')}`) + now;
  }
  return t('Uses the browser\'s echo cancellation. It only removes sound this app plays itself, so a Zoom or Teams call on your speakers may still leak in; the text-based echo removal catches most of it.') + now;
}

const SECTION = {
  async account() {
    const s = S.settings;
    const [acc, voices] = await Promise.all([api('GET', '/api/account'), api('GET', '/api/voices')]);
    const mb = (b) => `${(b / 1048576).toFixed(b > 1e8 ? 0 : 1)} MB`;
    return `<section class="panel"><div class="panel-head"><h3>${t('Account management')}</h3><span class="badge">${t('Local account')}</span></div>
        ${row(t('Your name'), t('So summaries know who “Me” is, and your lines are labelled with it.'), `<input id="set-name" value="${esc(s.userName)}" placeholder="${t('Your name')}">`)}
        ${row(t('Your email'), t('Used to tell internal from external meetings.'), `<input id="set-email" type="email" value="${esc(s.userEmail)}" placeholder="you@company.com">`)}
        ${row(t('Company domains'), t('Attendees from other domains make a meeting “External”.'), `<input id="set-domains" value="${esc(s.myDomains)}" placeholder="company.com, company.pt">`)}
      </section>
      <section class="panel"><div class="panel-head"><h3>${t('Your data')}</h3></div>
        <div class="small muted">${t('There is no cloud account: everything stays on this computer.')}</div>
        <div class="stats-row mt-s"><div class="card stat"><b>${acc.stats.notes}</b><span>${t('Meetings')}</span></div><div class="card stat"><b>${acc.stats.segments}</b><span>${t('Transcript lines')}</span></div><div class="card stat"><b>${acc.stats.topics}</b><span>${t('Topics')}</span></div><div class="card stat"><b>${acc.stats.voices}</b><span>${t('Saved voices')}</span></div></div>
        <div class="small mt-s">${t('Data')}: <code>${esc(acc.dataDir)}</code> · ${mb(acc.sizes.dataBytes)}<br>${t('Speech models')}: <code>${esc(acc.modelsDir)}</code> · ${mb(acc.sizes.modelBytes)} · v${esc(S.state?.version || '')}</div>
        <div class="row wrap mt-s"><button class="btn" data-act="exp-json">${icon('download', 'sm')} ${t('Full backup (JSON)')}</button><button class="btn" data-act="exp-md">${icon('download', 'sm')} ${t('All notes (Markdown)')}</button><button class="btn" data-act="exp-more">${icon('share', 'sm')} ${t('More export options…')}</button></div>
      </section>
      <section class="panel"><div class="panel-head"><h3>${t('Saved voices')}</h3><span class="badge">${voices.length}</span></div>
        <div class="hint mb">${t('People WhisperBrain recognises by voice. Name a speaker in a transcript and tick “remember” to add one.')}</div>
        ${voices.length ? `<div class="list">${voices.map((v) => `<div class="li"><span class="av" style="background:var(--accent)">${esc(v.name.slice(0, 2).toUpperCase())}</span><div class="main-t"><div class="t">${esc(v.name)}</div><div class="s">${v.meetings} ${t('meetings')}</div></div><div class="side"><button class="btn xs" data-voice-rename="${v.id}" data-name="${esc(v.name)}">${t('Rename')}</button><button class="btn xs danger-outline" data-voice-del="${v.id}">${t('Forget')}</button></div></div>`).join('')}</div>` : `<div class="small muted">${t('No saved voices yet.')}</div>`}
      </section>
      <section class="panel danger-zone"><div class="panel-head"><h3 style="color:var(--danger)">${icon('alert')} ${t('Danger zone')}</h3></div>
        <div class="dz-row"><div><b>${t('Delete all transcripts')}</b><div class="small muted">${t('Removes every transcript and speaker label. Notes and enhanced notes stay.')}</div></div><button class="btn danger-outline" data-dz="delete-transcripts">${t('Delete transcripts')}</button></div>
        <div class="dz-row"><div><b>${t('Forget all voices')}</b><div class="small muted">${t('Removes every saved voice profile.')}</div></div><button class="btn danger-outline" data-dz="delete-voices">${t('Forget voices')}</button></div>
        <div class="dz-row"><div><b>${t('Delete everything')}</b><div class="small muted">${t('Deletes all meetings, spaces, tags, topics, glossary, transcripts, chats, templates, voices and settings. This cannot be undone.')}</div></div><button class="btn danger" data-dz="delete-everything">${t('Delete everything')}</button></div>
      </section>`;
  },
  async general() {
    const s = S.settings;
    return `<section class="panel"><div class="panel-head"><h3>${t('Appearance')}</h3></div>
      ${row(t('Language'), '', `<select id="set-lang"><option value="en" ${s.language === 'en' ? 'selected' : ''}>English</option><option value="pt" ${s.language === 'pt' ? 'selected' : ''}>Português</option></select>`)}
      ${row(t('Theme'), '', `<div class="seg-ctl" role="tablist">${[['system', t('System'), 'settings'], ['light', t('Light'), 'sun'], ['dark', t('Dark'), 'moon']].map(([v, l, ic]) => `<button type="button" role="tab" data-theme-v="${v}" aria-selected="${s.theme === v}">${icon(ic, 'sm')}${l}</button>`).join('')}</div>`)}
      ${tog('set-collapsed', s.sidebarCollapsed, t('Compact sidebar'), t('Icons only; hover for names.'))}</section>`;
  },
  async meetings() {
    const s = S.settings;
    return `<section class="panel"><div class="panel-head"><h3>${t('When I join a meeting')}</h3></div>
      ${tog('set-detect', s.detectMeetings, t('Recognise meetings'), t('Notices when Zoom, Teams, Meet (in a browser), Slack, Discord… start using the microphone, and matches it to your calendar.'))}
      ${row(t('Then'), '', `<select id="set-autorec"><option value="ask" ${s.autoRecord === 'ask' ? 'selected' : ''}>${t('Ask me')}</option><option value="always" ${s.autoRecord === 'always' ? 'selected' : ''}>${t('Start recording automatically')}</option><option value="off" ${s.autoRecord === 'off' ? 'selected' : ''}>${t('Do nothing')}</option></select>`)}
      ${tog('set-perapp', s.perAppCapture, t('Capture only the meeting app'), t('Records the audio of the call itself, so music or a video playing next to it stays out of the transcript. If the app cannot be told, everything the computer plays is recorded.'))}
      ${tog('set-autostop', s.autoStop, t('Stop when the call ends'), t('Only for recordings that started automatically.'))}
      ${row(t('Calendar meetings'), t('Record calendar meetings when they start.'), `<select id="set-capture"><option value="off" ${s.captureCalendar === 'off' ? 'selected' : ''}>${t('Off — just remind me')}</option><option value="selected" ${s.captureCalendar === 'selected' ? 'selected' : ''}>${t('Only the ones I switch on')}</option><option value="all" ${s.captureCalendar === 'all' ? 'selected' : ''}>${t('Capture all')}</option></select>`)}
      ${row(t('Recording notice'), t('The sentence you can paste into a meeting chat so the others know it is recorded. A template, not legal advice: what you must say depends on where the people are.'), `<select id="set-consent"><option value="general" ${s.consentPreset === 'general' ? 'selected' : ''}>${t('General: say it is recorded')}</option><option value="eu" ${s.consentPreset === 'eu' ? 'selected' : ''}>${t('EU / Portugal: also say what happens to it')}</option><option value="us" ${s.consentPreset === 'us' ? 'selected' : ''}>${t('US (all-party consent): also ask them to agree by staying')}</option></select>`)}
      ${tog('set-notify', s.notifyUpcoming, t('Remind me when a calendar meeting starts'), '')}
      <div class="xsmall muted mt-s">${S.state?.capabilities?.micActivity === false ? `${icon('alert', 'sm')} ${t('Microphone-use detection is not available on this system.')}` : ''}</div></section>
      <section class="panel"><div class="panel-head"><h3>${t('After a meeting')}</h3></div>
      ${tog('set-autosum', s.autoSummarize, t('Enhance notes automatically when a recording stops'), t('Needs an AI model.'))}
      ${tog('set-insights', s.autoInsights, t('Find topics, glossary terms and action items'), t('Runs after enhancing. Without AI, topics are still found offline.'))}
      ${row(t('Default template'), '', `<select id="def-tpl">${S.templates.map((x) => `<option value="${x.id}" ${x.id === s.defaultTemplate ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`)}</section>
      ${await meetPanel.render().catch((e) => `<section class="panel"><div class="small muted">${esc(e.message)}</div></section>`)}`;
  },
  async audio() {
    const s = S.settings;
    S.models = await api('GET', '/api/models');
    const mics = S.state?.capture?.mic === 'native' ? (await api('GET', '/api/audio/devices')).mics : await listMicrophones().catch(() => []);
    const caps = S.state?.capabilities;
    return `<section class="panel"><div class="panel-head"><h3>${t('Capture')}</h3></div>
      ${tog('set-mic', s.micEnabled, t('Record my microphone'), '')}
      ${tog('set-sys', s.systemAudioEnabled, t('Record system audio'), t('The other side of the call.'))}
      ${tog('set-echo', s.echoDedupe, t('Remove echo'), t('Drops microphone text that only repeats the speakers, by matching the words and the loudness.'))}
      ${tog('set-aec', s.echoCancel, t('Cancel echo before transcribing'), aecHint(s, caps, S.state?.recording))}
      ${row(t('Noise suppression'), t('Can make speech recognition worse; off is safest unless the room is noisy. Automatic: off on Linux, on in macOS/Windows.'), enhanceSelect('set-ns', s.micNoiseSuppression))}
      ${row(t('Automatic gain'), t('Evens out the microphone level. Automatic: off on Linux, on in macOS/Windows.'), enhanceSelect('set-agc', s.micAutoGain))}
      ${tog('set-speakers', s.speakerDetection, t('Tell speakers apart'), t('Speaker 1, Speaker 2… or their names, using an on-device voice model.'))}
      ${s.speakerDetection ? tog('set-diarize', s.speakerDiarize, t('Work out who said what after recording'), t('When you stop, WhisperBrain listens to the whole meeting again and decides who spoke each word, including quick turn changes. It takes a little while on long meetings; capture is never slowed down and the audio is deleted right after.')) : ''}
      ${s.speakerDetection && s.speakerDiarize ? tog('set-counthint', s.speakerCountHint, t('Use the calendar guest list as the number of voices'), t('When a meeting comes from your calendar, WhisperBrain expects as many voices on the call as there are other guests. Exactly right, it is clearly more accurate; if some guests did not come or others joined, it can be worse. Off by default.')) : ''}
      ${s.speakerDetection ? tog('set-refine', s.speakerRefine, t('Also compare pitch and timbre'), t('An extra acoustic check after recording that merges a person the first pass split in two and fixes odd utterances. The audio is deleted right after.')) : ''}
      ${row(t('Floating recorder'), t('A small recording icon over other apps; click it to read the live transcript.'), `<select id="set-float"><option value="background" ${s.floatingRecorder === 'background' ? 'selected' : ''}>${t('When the app is in the background')}</option><option value="always" ${s.floatingRecorder === 'always' ? 'selected' : ''}>${t('Always while recording')}</option><option value="off" ${s.floatingRecorder === 'off' ? 'selected' : ''}>${t('Off')}</option></select>`)}
      ${s.speakerDetection && !S.state?.speakerModel ? `<div class="banner small">${t('Speaker recognition needs a small voice model.')}<span class="grow"></span><button class="btn sm primary" data-act="speaker-install">${t('Download')} (${S.state?.speakerModelMB || 26} MB)</button></div>` : ''}
      ${row(t('Microphone'), '', `<select id="set-device"><option value="">${t('System default')}</option>${mics.map((m) => `<option value="${esc(m.id)}" ${s.micDevice === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`)}
      ${caps?.notes?.length ? `<div class="banner warn small">${caps.notes.map(esc).join('<br>')}</div>` : ''}</section>
      <section class="panel"><div class="panel-head"><h3>${t('Speech model')}</h3></div>
      ${tog('set-hotwords', s.asrHotwords, t('Recognise names and terms from the meeting'), t('Attendees, glossary terms and saved speakers are given to the speech model as hints, so rare names are spelled right. Uses a little more CPU.'))}
      ${tog('set-livedraft', s.liveDraft, t('Show draft words while people speak'), draftHint())}
      ${adviceCard(S.state?.modelAdvice)}
      ${row(t('Use'), '', `<select id="set-asr"><option value="auto">${t('Automatic (best installed)')}</option>${S.models.filter((m) => m.installed && m.role !== 'draft').map((m) => `<option value="${m.id}" ${s.asrModel === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`)}
      <div class="stack mt-s">${S.models.map((m) => `<div class="card row"><div class="grow"><div class="row wrap" style="gap:6px"><b>${esc(m.name)}</b><span class="badge">${m.sizeMB} MB</span>${m.installed ? `<span class="badge ok">${t('installed')}</span>` : ''}${fitBadge(m.id)}</div><div class="small muted">${esc(m.note)}</div>${whenLine(m.id)}
        ${m.downloading != null ? `<div class="progress mt-s"><i data-model-progress="${m.id}" style="width:${Math.round(m.downloading * 100)}%"></i></div>` : ''}</div>
        ${m.installed ? `<button class="btn sm" data-model-remove="${m.id}">${t('Remove')}</button>` : m.downloading != null ? `<button class="btn sm" data-model-cancel="${m.id}">${t('Cancel')}</button>` : `<button class="btn sm primary" data-model-install="${m.id}">${icon('download', 'sm')} ${t('Download')}</button>`}</div>`).join('')}</div></section>`;
  },
  async ai() {
    const l = S.settings.llm;
    return `<section class="panel"><div class="panel-head"><h3>${t('AI model')}</h3></div><p class="hint" style="margin-top:0">${t('Any OpenAI-compatible server works. For Ollama keep the defaults and pick a model you have pulled (e.g. llama3.2). Only text is sent — never audio.')}</p>
      <div class="stack">${field('llm-provider', t('Provider'), `<select id="llm-provider"><option value="ollama" ${l.provider === 'ollama' ? 'selected' : ''}>Ollama (${t('local')})</option><option value="openai" ${l.provider === 'openai' ? 'selected' : ''}>OpenAI-compatible</option></select>`)}
      ${field('llm-url', t('Server URL'), `<input type="url" id="llm-url" value="${esc(l.baseUrl)}">`)}
      ${field('llm-key', t('API key'), `<input type="password" id="llm-key" value="${esc(l.apiKey)}" autocomplete="off">`)}
      ${field('llm-model', t('Model'), `<div class="row"><input id="llm-model" list="llm-models" value="${esc(l.model)}"><datalist id="llm-models"></datalist><button class="btn" data-act="llm-list">${icon('refresh', 'sm')}</button></div>`)}
      <div class="row"><button class="btn primary" data-act="llm-save">${t('Save')}</button><button class="btn" data-act="llm-test">${t('Test connection')}</button><span id="llm-result" class="small"></span></div></div></section>`;
  },
  async templates() {
    S.templates = await api('GET', '/api/templates');
    return `<section class="panel"><div class="panel-head"><h3>${t('Templates')}</h3><button class="btn sm primary" data-act="tpl-add">${icon('plus', 'sm')} ${t('New template')}</button></div>
      <div class="stack">${S.templates.map((x) => `<div class="card"><div class="row between"><b>${esc(x.name)}</b>${x.builtin ? `<span class="badge">${t('built-in')}</span>` : `<div class="row" style="gap:4px"><button class="btn xs" data-tpl-edit="${x.id}">${t('Edit')}</button><button class="btn xs danger-outline" data-tpl-del="${x.id}">${t('Delete')}</button></div>`}</div><div class="small muted" style="margin-top:6px">${esc(x.prompt)}</div></div>`).join('')}</div></section>`;
  },
  async dictation() {
    const d = S.settings.dictation;
    return `<section class="panel"><div class="panel-head"><h3>${t('Dictation')}</h3></div><p class="hint" style="margin-top:0">${t('Press the shortcut anywhere to start, press again to stop. The text is typed where your cursor is.')}</p>
      ${tog('dict-on', d.enabled, t('Enable dictation'), '')}
      ${row(t('Global shortcut'), 'e.g. CommandOrControl+Shift+Space', `<input id="dict-key" value="${esc(d.hotkey)}">`)}
      ${tog('dict-paste', d.autoPaste, t('Paste into the focused app'), t('Otherwise the text is copied.'))}
      <div class="row mt-s"><button class="btn primary" data-act="dict-save">${t('Save')}</button><button class="btn" data-act="dict-try">${icon('mic', 'sm')} ${t('Try it')}</button><span id="dict-result" class="small"></span></div>
      ${S.state?.capabilities?.paste === false ? `<div class="banner warn small mt-s">${(S.state.capabilities.notes || []).map(esc).join('<br>') || t('Auto-paste is not available here; text is copied instead.')}</div>` : ''}</section>`;
  },
  async shortcuts() {
    const mod = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
    const list = [[`${mod} K`, t('Search everything')], ['/', t('Search everything')], [`${mod} ⇧ R`, t('Start / stop recording')], [`${mod} I`, t('Import files')], ['G H', t('Go home')], ['G M', t('Go to meetings')], ['G C', t('Go to calendar')], ['G A', t('Go to action items')], ['G T', t('Go to topics')], ['G L', t('Go to glossary')], ['G P', t('Go to people')], ['G S', t('Go to settings')], ['Tab', t('In search: next filter')], [t('Drop files'), t('Import them anywhere in the app')]];
    return `<section class="panel"><div class="panel-head"><h3>${t('Keyboard shortcuts')}</h3></div><div class="list">${list.map(([k, d]) => `<div class="li"><div class="main-t">${esc(d)}</div><kbd>${esc(k)}</kbd></div>`).join('')}</div></section>`;
  },
};

function bind(main, sec, body) {
  const rerender = () => render(main, { parts: ['settings', sec] });
  const map = {
    'set-lang': (v) => ({ language: v }), 'set-detect': (v) => ({ detectMeetings: v }), 'set-autorec': (v) => ({ autoRecord: v }), 'set-autostop': (v) => ({ autoStop: v }), 'set-perapp': (v) => ({ perAppCapture: v }), 'set-capture': (v) => ({ captureCalendar: v }), 'set-consent': (v) => ({ consentPreset: v }),
    'set-notify': (v) => ({ notifyUpcoming: v }), 'set-autosum': (v) => ({ autoSummarize: v }), 'set-insights': (v) => ({ autoInsights: v }), 'def-tpl': (v) => ({ defaultTemplate: v }),
    'set-mic': (v) => ({ micEnabled: v }), 'set-sys': (v) => ({ systemAudioEnabled: v }), 'set-echo': (v) => ({ echoDedupe: v }), 'set-speakers': (v) => ({ speakerDetection: v }), 'set-refine': (v) => ({ speakerRefine: v }), 'set-counthint': (v) => ({ speakerCountHint: v }), 'set-diarize': (v) => ({ speakerDiarize: v }), 'set-float': (v) => ({ floatingRecorder: v }), 'set-device': (v) => ({ micDevice: v }), 'set-asr': (v) => ({ asrModel: v }), 'set-aec': (v) => ({ echoCancel: v }), 'set-ns': (v) => ({ micNoiseSuppression: v }), 'set-agc': (v) => ({ micAutoGain: v }), 'set-hotwords': (v) => ({ asrHotwords: v }), 'set-livedraft': (v) => ({ liveDraft: v }),
    'set-collapsed': (v) => ({ sidebarCollapsed: v }),
  };
  body.addEventListener('change', async (e) => {
    const f = map[e.target.id];
    if (!f) return;
    try { await save(f(e.target.type === 'checkbox' ? e.target.checked : e.target.value)); if (['set-lang', 'set-speakers', 'set-collapsed'].includes(e.target.id)) location.reload(); else done(t('Saved')); } catch (err) { fail(err); }
  });
  const text = { 'set-name': 'userName', 'set-email': 'userEmail', 'set-domains': 'myDomains' };
  let timer;
  body.addEventListener('input', (e) => { const k = text[e.target.id]; if (!k) return; clearTimeout(timer); timer = setTimeout(async () => { try { await save({ [k]: e.target.value.trim() }); window.dispatchEvent(new Event('wb:refresh')); } catch (err) { fail(err); } }, 600); });
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.themeV) { await save({ theme: b.dataset.themeV }); rerender(); }
      else if (b.dataset.act === 'exp-json') await download('/api/account/export');
      else if (b.dataset.act === 'exp-md') await download('/api/account/export?format=md');
      else if (b.dataset.act === 'exp-more') openExport([]);
      else if (b.dataset.act === 'speaker-install') { b.disabled = true; await api('POST', '/api/speaker-model/install'); done(t('Downloading…')); }
      else if (b.dataset.voiceRename) { const n = await promptDialog(t('Rename'), b.dataset.name); if (n) { await api('PATCH', `/api/voices/${b.dataset.voiceRename}`, { name: n }); rerender(); } }
      else if (b.dataset.voiceDel) { if (await confirmDialog(t('Forget this voice? Past transcripts keep the name you gave.'), { ok: t('Forget') })) { await api('DELETE', `/api/voices/${b.dataset.voiceDel}`); rerender(); } }
      else if (b.dataset.dz) await danger(b.dataset.dz, rerender);
      else if (b.dataset.act === 'model-setup') { // install what the advice recommends and let "auto" pick it
        const adv = S.state.modelAdvice;
        b.disabled = true;
        await save({ asrModel: 'auto', ...(adv.draft ? { liveDraft: true } : {}) });
        for (const m of missingPicks(adv)) await api('POST', `/api/models/${m.id}/install`);
        done(t('Downloading…')); rerender();
      }
      else if (b.dataset.modelInstall) { await api('POST', `/api/models/${b.dataset.modelInstall}/install`); rerender(); }
      else if (b.dataset.modelCancel) { await api('POST', `/api/models/${b.dataset.modelCancel}/cancel`); rerender(); }
      else if (b.dataset.modelRemove) { if (await confirmDialog(t('Remove this speech model? You can download it again later.'), { ok: t('Remove') })) { await api('DELETE', `/api/models/${b.dataset.modelRemove}`); rerender(); } }
      else if (b.dataset.act === 'tpl-add' || b.dataset.tplEdit) await editTemplate(S.templates.find((x) => x.id === b.dataset.tplEdit), rerender);
      else if (b.dataset.tplDel) { if (await confirmDialog(t('Delete this template?'))) { await api('DELETE', `/api/templates/${b.dataset.tplDel}`); rerender(); } }
      else if (b.dataset.act === 'secrets-plaintext') { await save({ secretStorage: 'plaintext' }); S.state = await api('GET', '/api/state'); rerender(); }
      else if (b.dataset.act === 'secrets-never') {
        if (await confirmDialog(t('Remove your saved API keys and tokens from this computer? You will need to enter them again after restarting.'), { ok: t('Do not save'), danger: false })) { await save({ secretStorage: 'never' }); S.state = await api('GET', '/api/state'); rerender(); }
      }
      else if (b.dataset.act === 'llm-save') { await save({ llm: llmForm() }); $('#llm-result').textContent = '✓'; S.state = await api('GET', '/api/state'); }
      else if (b.dataset.act === 'llm-list') { await save({ llm: llmForm() }); const r = await api('GET', '/api/llm/models'); $('#llm-models').innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join(''); $('#llm-result').textContent = t('{n} models', { n: r.models.length }); if (!$('#llm-model').value && r.models[0]) $('#llm-model').value = r.models[0]; }
      else if (b.dataset.act === 'llm-test') { await save({ llm: llmForm() }); $('#llm-result').textContent = '…'; const r = await api('POST', '/api/llm/test'); $('#llm-result').textContent = r.ok ? `✓ ${r.model}` : `✗ ${r.error}`; S.state = await api('GET', '/api/state'); }
      else if (b.dataset.act === 'dict-save') { await save({ dictation: { enabled: $('#dict-on').checked, hotkey: $('#dict-key').value.trim(), autoPaste: $('#dict-paste').checked } }); $('#dict-result').textContent = '✓'; }
      else if (b.dataset.act === 'dict-try') { const r = await api('POST', '/api/dictation/toggle'); $('#dict-result').textContent = r.state; }
    } catch (err) { fail(err); const el = $('#llm-result'); if (el && b.dataset.act?.startsWith('llm')) el.textContent = `✗ ${err.message}`; }
  });
  $('#llm-provider', body)?.addEventListener('change', (e) => { const url = $('#llm-url'); if (e.target.value === 'ollama' && !url.value) url.value = 'http://127.0.0.1:11434/v1'; });
  // One listener at a time: every render calls bind() again, and stacked listeners each re-rendering on every
  // download event snowballed until the page ran out of memory. Re-renders are coalesced for the same reason.
  if (modelListener) window.removeEventListener('wb:event', modelListener);
  modelListener = null;
  if (sec === 'meetings') meetPanel.bind(body, rerender);
  if (sec !== 'audio') return;
  let pending = 0;
  const later = (refreshState) => {
    clearTimeout(pending);
    pending = setTimeout(async () => { if (refreshState) S.state = await api('GET', '/api/state').catch(() => S.state); rerender(); }, 400);
  };
  const onEv = (ev) => {
    const { type, data } = ev.detail;
    if (S.view.name !== 'settings') { window.removeEventListener('wb:event', onEv); if (modelListener === onEv) modelListener = null; return; }
    if (type === 'model.progress') { const bar = $(`[data-model-progress="${data.id}"]`); if (bar) bar.style.width = `${Math.round(data.progress * 100)}%`; else later(false); }
    if (['model.installed', 'model.removed', 'model.error'].includes(type)) later(true);
  };
  modelListener = onEv;
  window.addEventListener('wb:event', onEv);
}
const llmForm = () => ({ provider: $('#llm-provider').value, baseUrl: $('#llm-url').value.trim(), apiKey: $('#llm-key').value, model: $('#llm-model').value.trim() });

async function danger(kind, rerender) {
  const word = kind === 'delete-everything' ? 'DELETE EVERYTHING' : 'DELETE';
  const r = await promptDialog(t(kind === 'delete-transcripts' ? 'Delete all transcripts' : kind === 'delete-voices' ? 'Forget all voices' : 'Delete everything'), '', { ok: t('Delete'), hint: t('Type {word} to confirm.', { word }), extra: kind === 'delete-everything' ? `<label class="check"><input type="checkbox" name="models"> ${t('Also delete downloaded speech models')}</label>` : ' ' });
  if (!r) return;
  if (r.value !== word) return fail(t('Type {word} to confirm.', { word }));
  await api('POST', `/api/account/${kind}`, { confirm: word, removeModels: !!r.data?.models });
  done();
  S.state = await api('GET', '/api/state');
  window.dispatchEvent(new Event('wb:refresh'));
  rerender();
}

function editTemplate(tpl, rerender) {
  return modal({
    title: tpl ? t('Edit template') : t('New template'),
    body: `${field('tpl-name', t('Name'), `<input id="tpl-name" value="${esc(tpl?.name || '')}">`)}${field('tpl-prompt', t('What should the notes contain?'), `<textarea id="tpl-prompt" style="min-height:160px">${esc(tpl?.prompt || '')}</textarea>`, t('Describe the sections, e.g. “## Decisions”, “## Risks”, “## Action items as a checklist”.'))}`,
    foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" data-ok>${t('Save')}</button>`,
    onMount: (d, close) => {
      $('[data-ok]', d).onclick = async () => {
        try {
          const body = { name: $('#tpl-name', d).value, prompt: $('#tpl-prompt', d).value };
          if (tpl) await api('PATCH', `/api/templates/${tpl.id}`, body); else await api('POST', '/api/templates', body);
          S.templates = await api('GET', '/api/templates'); close(true); rerender();
        } catch (e) { fail(e); }
      };
    },
  });
}
void go;
