// Settings → Meetings: the names of the voices on a call, read from the meeting window. Where the information comes
// from (the browser's accessibility tree, a browser extension, a look at the window), what each source is doing, and the
// steps each system needs. It only draws and sends; the work is in src/meet.
import { S, api, t, esc, icon, fail, done, switchEl } from '../lib.js';

const SOURCES = [
  ['a11y', 'The browser, read directly', 'Reads the Meet page through the system\'s accessibility interface. Nothing to install in the browser.'],
  ['extension', 'Browser extension', 'A small extension for Chrome, Edge or Brave that tells WhisperBrain who is speaking.'],
  ['rpc', 'Discord app (local connection)', 'Asks the Discord app on this computer which call you are in, who is in it and who speaks. Nobody joins the call.'],
  ['vision', 'A look at the window', 'Last resort: sends a picture of the meeting window to your AI model.'],
];
const STATE = { connected: ['ok', 'Working'], waiting: ['', 'Waiting'], off: ['', 'Off'], 'needs-setup': ['warn', 'Needs setup'], denied: ['warn', 'Permission needed'], error: ['danger', 'Problem'] };
const OS = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };
const meetKey = (k, v) => ({ meet: { ...S.settings.meet, [k]: v } });
const toggle = (id, on, title, sub) => `<div class="set-row"><div class="l"><b>${esc(title)}</b>${sub ? `<span>${sub}</span>` : ''}</div>${switchEl(id, on, title)}</div>`;

// One row per kind of source of one platform (st.platforms[i].sources): how it is doing and what it has said about this platform
const sourceRow = (ps) => {
  const [, name, sub] = SOURCES.find((x) => x[0] === ps.kind) || [ps.kind, ps.kind, ''];
  const [cls, label] = STATE[ps.state || 'off'] || STATE.off;
  return `<div class="set-row"><div class="l"><b>${t(name)}</b><span>${t(sub)}${ps.detail ? `<br><em>${esc(ps.detail)}</em>` : ''}</span></div><span class="badge ${cls}">${t(label)}</span></div>`;
};

const platformBlock = (p) => `<div class="platform" data-platform="${esc(p.id)}"><h5 class="mt-s">${esc(p.name)}</h5>
  ${p.sources.map(sourceRow).join('')}
  ${p.verified ? '' : `<div class="xsmall muted">${icon('alert', 'sm')} ${t('The built-in description of this page has not been checked against a real call yet. If names do not appear, see')} <code>npm run a11y:dump -- --platform ${esc(p.id)}</code>.</div>`}</div>`;

function extensionSteps(os) {
  const urls = os === 'win32' ? 'chrome://extensions · edge://extensions' : 'chrome://extensions · brave://extensions';
  return `<ol class="steps">
    <li>${t('In Chrome, Edge or Brave open')} <code>${urls}</code> ${t('and switch on “Developer mode”.')}</li>
    <li>${t('Press “Load unpacked” and pick the extension folder.')} <button class="btn xs" data-meet="reveal">${icon('folder', 'sm')} ${t('Show the folder')}</button></li>
    <li>${t('Open the extension\'s options and paste the pairing code.')}</li>
  </ol>`;
}

async function osNotes(st) {
  if (st.platform === 'linux') {
    const list = await api('GET', '/api/meet/browsers').catch(() => []);
    return `<div class="small">${t('Chrome, Edge and Brave only show the page to the system when they are started with accessibility on. This adds that switch to the launcher you click (your own copy of it; the system files are not touched), and you restart the browser once.')}</div>
      ${list.length ? `<div class="list mt-s">${list.map((b) => `<div class="li"><div class="main-t"><div class="t">${esc(b.name)}</div><div class="s">${b.state === 'on' ? t('Started with accessibility on') : b.state === 'foreign' ? t('You have your own launcher: add --force-renderer-accessibility to it') : t('Normal launcher')}</div></div><div class="side">${b.state === 'foreign' ? '' : b.state === 'on' ? `<button class="btn xs" data-meet="browser-off" data-file="${esc(b.file)}">${t('Switch off')}</button>` : `<button class="btn xs primary" data-meet="browser-on" data-file="${esc(b.file)}">${t('Switch on')}</button>`}</div></div>`).join('')}</div>` : `<div class="small muted mt-s">${t('No supported browser launcher was found.')}</div>`}
      <div class="xsmall muted mt-s">${t('A browser started from a terminal, or one that is already open, is not affected until it is restarted from this launcher. The browser keeps a little more in memory while this is on.')}</div>`;
  }
  if (st.platform === 'darwin') return `<div class="small">${t('macOS asks once, the first time you record a meeting: allow WhisperBrain under System Settings → Privacy & Security → Accessibility. Without it WhisperBrain cannot see the meeting window and falls back to the other sources.')}</div>`;
  if (st.platform === 'win32') return `<div class="small">${t('Nothing to set up: Windows lets WhisperBrain read the browser\'s page as soon as it asks.')}</div>`;
  return '';
}

export async function render() {
  const st = await api('GET', '/api/meet/status');
  const m = S.settings.meet;
  const os = st.platform;
  const pairing = m.extension && st.extension.listening ? await api('GET', '/api/meet/pairing').catch(() => null) : null;
  return `<section class="panel" id="meet-panel"><div class="panel-head"><h3>${t('Names from the meeting window')}</h3></div>
    <div class="small muted">${t('The call\'s window shows who is speaking. WhisperBrain uses that to put the right name on each voice, and the people on the call to know how many voices to expect. Everything stays on this computer.')}</div>
    ${toggle('meet-enabled', m.enabled, t('Name the voices from the meeting window'), t('Works with Google Meet in Chrome, Edge or Brave. Names you type yourself are never replaced, and a voice WhisperBrain already knows keeps its name.'))}
    ${m.enabled ? `
      ${toggle('meet-headcount', m.headcount, t('Use the people on the call as the number of voices'), t('A call of up to 6 other people. Better than the calendar guest list: it says who actually joined.'))}
      ${toggle('meet-refine', m.refine, t('Let the names fix the voices'), t('Joins one person who was heard as two voices, and splits two people who were heard as one, when the names say so clearly.'))}
      ${toggle('meet-learn', m.learnVoices, t('Remember voices the call named clearly'), t('So the next meeting recognises them without any help. Only when the name was certain and the voice does not clash with one you saved.'))}
      ${toggle('meet-captions', m.captions, t('Use the meeting\'s live captions when they are on'), t('Matches the captions with the transcript word by word: the most reliable source of who said what. Needs the extension, and captions turned on in Meet.'))}
      <h4 class="mt">${t('Where the names come from')}</h4>
      ${(st.platforms || []).map(platformBlock).join('')}

      <h4 class="mt">${t('The browser, read directly')} · ${OS[os] || os}</h4>
      ${toggle('meet-a11y', m.a11y, t('Read the meeting page through accessibility'), st.a11y.available ? t('Only while a recording is on.') : t('This build has no reader for this system.'))}
      ${m.a11y ? await osNotes(st) : ''}

      <h4 class="mt">${t('Browser extension')}</h4>
      ${toggle('meet-ext', m.extension, t('Accept the browser extension'), t('Listens on this computer only (127.0.0.1), with a secret code that only you have.'))}
      ${m.extension ? `${extensionSteps(os)}
        ${pairing ? `<div class="row"><input id="meet-code" readonly value="${esc(pairing.code)}" style="flex:1;min-width:0;font-family:var(--mono,monospace)"><button class="btn xs" data-meet="copy">${t('Copy pairing code')}</button><button class="btn xs ghost" data-meet="reset">${t('New code')}</button></div>` : `<div class="small muted">${st.extension.error ? esc(st.extension.error) : t('Starting…')}</div>`}` : ''}

      <h4 class="mt">${t('A look at the window')}</h4>
      ${toggle('meet-vision', m.vision, t('Last resort: look at the meeting window'), t('Only when nothing above is connected. Sends a picture of the window to the AI model you set in Settings → AI, so use a model that runs on this computer and can see pictures. Off by default.'))}
      ${m.vision && !st.vision.available ? `<div class="small muted">${t('This build cannot capture another window.')}</div>` : ''}
    ` : ''}</section>`;
}

export function bind(body, rerender) {
  const KEYS = { 'meet-enabled': 'enabled', 'meet-headcount': 'headcount', 'meet-refine': 'refine', 'meet-learn': 'learnVoices', 'meet-captions': 'captions', 'meet-a11y': 'a11y', 'meet-ext': 'extension', 'meet-vision': 'vision' };
  body.addEventListener('change', async (e) => {
    const k = KEYS[e.target.id];
    if (!k) return;
    try { S.settings = await api('PUT', '/api/settings', meetKey(k, e.target.checked)); done(t('Saved')); await new Promise((r) => setTimeout(r, k === 'extension' ? 400 : 0)); rerender(); } catch (err) { fail(err); }
  });
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-meet]');
    if (!b) return;
    try {
      const a = b.dataset.meet;
      if (a === 'copy') { await navigator.clipboard.writeText(document.getElementById('meet-code').value); done(t('Copied')); }
      else if (a === 'reset') { await api('POST', '/api/meet/pairing/reset'); done(t('New code made: paste it in the extension again.')); rerender(); }
      else if (a === 'reveal') { const r = await api('POST', '/api/meet/extension/reveal'); done(r.path); }
      else if (a === 'browser-on' || a === 'browser-off') { await api('POST', `/api/meet/browsers/${encodeURIComponent(b.dataset.file)}/${a === 'browser-on' ? 'enable' : 'disable'}`); done(a === 'browser-on' ? t('Done. Restart the browser from its launcher.') : t('Switched off.')); rerender(); }
    } catch (err) { fail(err); }
  });
}
