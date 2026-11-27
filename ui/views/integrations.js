// Connect WhisperBrain to Google Calendar, Notion, Linear, Obsidian and webhooks. Tokens stay on this device.
import { S, $, $$, api, t, esc, icon, fail, done, toast, modal, debounce, switchEl, field, confirmDialog, go } from '../lib.js';
import { openImport } from './transfer.js';

const save = async (patch) => { S.settings = await api('PUT', '/api/settings', patch); return S.settings; };
const MASK = '********';

// "In the call “Standup” · 3 people", or why not
const RPC_STATE = { off: 'Off', 'not-set-up': 'Not set up', closed: 'The Discord app is not running', connecting: 'Connecting…', 'not-authorised': 'Not authorised yet', connected: 'Connected, not in a voice call', 'in-call': 'In a voice call' };
const rpcLine = (r) => (r.call ? `${t('In the call')} “${r.call.name || t('voice channel')}” · ${r.call.people} ${t(r.call.people === 1 ? 'person' : 'people')}` : t(RPC_STATE[r.state] || r.state) + (r.state === 'closed' || r.state === 'not-authorised' || !r.detail ? '' : ` · ${r.detail}`));
const rpcLabel = (r) => (r.call ? rpcLine(r) : t(RPC_STATE[r.state] || r.state));

export async function render(main) {
  const ints = S.integrations = await api('GET', '/api/integrations');
  const tsrc = await api('GET', '/api/transcript-sources').catch(() => []);
  const s = S.settings;
  const g = ints.google;
  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>${t('Integrations')}</h1><div class="sub">${t('Bring meetings in from other tools and send notes out to them. Keys are stored only on this computer.')}</div></div></div>
    <div class="cols-2">
      ${card('google', '#4285f4', 'calendar', 'Google Calendar', g.connected ? `${t('Connected')} · ${esc(g.email || '')}` : t('See meetings, get reminded, recognise and record them'), g.connected, `
        ${g.connected ? `<div class="stack tight">${(g.calendars || []).length ? `<div class="xsmall muted strong">${t('Calendars to use')}</div><div class="picklist" style="max-height:200px">${g.calendars.map((c) => `<label><input type="checkbox" class="cbx" data-gcal="${esc(c.id)}" ${c.selected ? 'checked' : ''}><span class="dot" style="width:10px;height:10px;border-radius:50%;background:${esc(c.color || '#888')}"></span><span class="grow ellipsis">${esc(c.summary)}</span>${c.primary ? `<span class="badge">${t('primary')}</span>` : ''}</label>`).join('')}</div>` : ''}
          <div class="field"><label for="g-detail">${t('What WhisperBrain sees of each event')}</label><select id="g-detail"><option value="full" ${(S.settings.google.calendarDetail || 'full') === 'full' ? 'selected' : ''}>${t('Everything: title, people, notes and join links')}</option><option value="busy" ${S.settings.google.calendarDetail === 'busy' ? 'selected' : ''}>${t('Only when I am busy')}</option></select><div class="hint">${t('“Only when I am busy” hides titles, people and links. Meetings can then no longer be recognised by their invitation.')}</div></div>
          <div class="row"><button class="btn sm" data-act="g-refresh">${icon('refresh', 'sm')} ${t('Refresh list')}</button><button class="btn sm danger-outline" data-act="g-disconnect">${t('Disconnect')}</button></div></div>` : `
        <div class="seg-ctl full" role="tablist"><button type="button" role="tab" data-gmode="oauth" aria-selected="true">${t('Sign in with Google')}</button><button type="button" role="tab" data-gmode="ical" aria-selected="false">${t('Secret iCal link')}</button></div>
        <div data-gpane="oauth" class="stack">
          ${g.builtIn ? `<p class="hint" style="margin:0">${t('Your browser opens so you can approve read-only access. There is nothing to copy or paste.')}</p>
          <div class="xsmall muted">${t('This only reads your calendar. To read mail, add a mailbox under Folders & vaults: you choose there what is read and what Google is asked for.')} <a href="#/sources">${t('Folders & vaults')}</a></div>
          <div class="row"><button class="btn primary" data-act="g-connect">${icon('lock', 'sm')} ${t('Sign in with Google')}</button><span class="small muted" id="g-status"></span></div>
          <details><summary class="small muted" style="cursor:pointer">${t('Use my own Google client instead')}</summary><div class="stack" style="margin-top:8px">` : ''}
          <ol class="steps"><li>${t('In Google Cloud Console create a project and enable the')} <b>Google Calendar API</b>.</li><li>${t('Credentials → Create credentials → OAuth client ID → type')} <b>${t('Desktop app')}</b>.</li><li>${t('Paste the client ID and secret here and press Connect. Your browser opens to approve read-only access.')}</li></ol>
          ${field('g-id', t('Client ID'), `<input id="g-id" value="${esc(s.google.clientId)}" placeholder="…apps.googleusercontent.com" autocomplete="off">`)}
          ${field('g-secret', t('Client secret'), `<input id="g-secret" type="password" value="${s.google.clientSecret ? MASK : ''}" autocomplete="off">`)}
          ${g.builtIn ? '</div></details>' : `<div class="row"><button class="btn primary" data-act="g-connect">${icon('lock', 'sm')} ${t('Connect')}</button><span class="small muted" id="g-status"></span></div>`}</div>
        <div data-gpane="ical" class="stack" hidden>
          <ol class="steps"><li>${t('Google Calendar → Settings → your calendar → Integrate calendar.')}</li><li>${t('Copy the “Secret address in iCal format” and paste it here.')}</li></ol>
          ${field('cal-url', t('Calendar feed URL (iCal / webcal)'), '<input id="cal-url" type="url" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics">', t('Works for Outlook, iCloud and Fastmail too.'))}
          <div class="row"><button class="btn primary" data-act="cal-add">${t('Add calendar')}</button><span class="small" id="cal-result"></span></div></div>`}
        ${s.calendar.sources.length ? `<div class="divider"></div><div class="xsmall muted strong">${t('iCal feeds')}</div>${s.calendar.sources.map((c) => `<div class="row"><span class="srcicon">${icon('calendar')}</span><span class="grow ellipsis small">${esc(c.name)}</span><button class="btn ghost xs" data-cal-del="${c.id}">${t('Remove')}</button></div>`).join('')}` : ''}`)}

      ${card('notion', '#111', 'doc', 'Notion', ints.notion.configured ? (ints.notion.parentTitle ? `${t('Exports into')} “${esc(ints.notion.parentTitle)}”` : t('Connected — choose where notes go')) : t('Export meeting notes as pages; import pages as meetings'), ints.notion.configured, `
        <ol class="steps"><li>${t('Create an internal integration at')} <a href="https://www.notion.so/my-integrations" target="_blank" rel="noopener noreferrer">notion.so/my-integrations</a>.</li><li>${t('In Notion, open the page or database for meeting notes → ••• → Connections → add your integration.')}</li><li>${t('Paste the secret, then pick that page below.')}</li></ol>
        ${field('n-token', t('Integration secret'), `<input id="n-token" type="password" value="${ints.notion.configured ? MASK : ''}" placeholder="ntn_… / secret_…" autocomplete="off">`)}
        ${ints.notion.configured ? `<div class="field"><span class="lbl">${t('Export into')}</span><div class="row"><span class="grow small ellipsis">${ints.notion.parentTitle ? `${icon(ints.notion.parentKind === 'database' ? 'layers' : 'doc', 'sm')} ${esc(ints.notion.parentTitle)}` : `<span class="muted">${t('Not chosen yet')}</span>`}</span><button class="btn sm" data-act="n-pick">${t('Choose…')}</button></div></div>
          <label class="row between"><span class="small">${t('Export automatically after enhancing a meeting')}</span>${switchEl('n-auto', ints.notion.autoExport)}</label>` : ''}
        <div class="row"><button class="btn primary" data-act="n-save">${t('Save & test')}</button>${ints.notion.configured ? `<button class="btn" data-act="import-notion">${icon('download', 'sm')} ${t('Import pages')}</button><button class="btn ghost sm" data-act="n-remove">${t('Disconnect')}</button>` : ''}<span class="small" id="n-status"></span></div>`)}

      ${card('linear', '#5e6ad2', 'checksq', 'Linear', ints.linear.configured ? (ints.linear.teamName ? `${t('Team')} ${esc(ints.linear.teamName)}` : t('Connected — choose a team')) : t('Turn action items into issues; link and import issues'), ints.linear.configured, `
        <ol class="steps"><li>${t('Linear → Settings → Security & access → Personal API keys → New key.')}</li><li>${t('Paste it here and choose the team new issues go to.')}</li></ol>
        ${field('l-key', t('Personal API key'), `<input id="l-key" type="password" value="${ints.linear.configured ? MASK : ''}" placeholder="lin_api_…" autocomplete="off">`)}
        ${ints.linear.configured ? field('l-team', t('Team for new issues'), `<select id="l-team"><option value="">${t('Loading…')}</option></select>`) : ''}
        <div class="row"><button class="btn primary" data-act="l-save">${t('Save & test')}</button>${ints.linear.configured ? `<button class="btn" data-act="import-linear">${icon('download', 'sm')} ${t('Import issues')}</button><button class="btn ghost sm" data-act="l-remove">${t('Disconnect')}</button>` : ''}<span class="small" id="l-status"></span></div>`)}

      ${card('obsidian', '#7c3aed', 'book', 'Obsidian', ints.obsidian.configured ? esc(ints.obsidian.vaultPath) : t('Write meetings into your vault with [[links]] to people and topics'), ints.obsidian.configured, `
        ${field('o-path', t('Vault folder'), `<input id="o-path" value="${esc(s.obsidian.vaultPath)}" placeholder="/home/you/Documents/MyVault">`, t('The folder that contains your vault’s .obsidian directory.'))}
        ${field('o-folder', t('Folder inside the vault'), `<input id="o-folder" value="${esc(s.obsidian.folder)}" placeholder="Meetings">`)}
        <label class="row between"><span class="small">${t('Include the transcript')}</span>${switchEl('o-tr', s.obsidian.transcript)}</label>
        <label class="row between"><span class="small">${t('Export automatically after enhancing a meeting')}</span>${switchEl('o-auto', s.obsidian.autoExport)}</label>
        <div class="row"><button class="btn primary" data-act="o-save">${t('Save & test')}</button>${ints.obsidian.configured ? `<button class="btn" data-act="import-obsidian">${icon('download', 'sm')} ${t('Import notes')}</button><button class="btn" data-act="o-all">${icon('upload', 'sm')} ${t('Export all meetings')}</button>` : ''}<span class="small" id="o-status"></span></div>`)}

      ${card('discord-rpc', '#5865f2', 'users', t('Discord, without a bot'), ints.discordRpc.configured ? (ints.discordRpc.enabled ? rpcLabel(ints.discordRpc) : t('Set up — switched off')) : t('Know who is in your Discord call and who speaks, with nobody joining'), ints.discordRpc.configured && ints.discordRpc.enabled, `
        <div class="small muted">${t('The Discord app on this computer tells WhisperBrain which voice call you are in, who is in it and when each person speaks. No bot joins and nobody else sees anything. It gives no audio per person: voices are still told apart from the recording, and these names are put on them afterwards.')}</div>
        <ol class="steps"><li>${t('Open the')} <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">${t('Discord Developer Portal')}</a> → <b>New Application</b> (your own; you are its tester).</li><li>${t('OAuth2 → Redirects → add')} <code>http://localhost</code>. ${t('Copy the Client ID and the Client Secret below.')}</li><li>${t('Switch it on, save, then press Authorise and accept in the Discord app (Discord must be running).')}</li></ol>
        ${field('r-id', t('Client ID'), `<input id="r-id" value="${esc(ints.discordRpc.clientId)}" inputmode="numeric" placeholder="123456789012345678" autocomplete="off">`)}
        ${field('r-secret', t('Client secret'), `<input id="r-secret" type="password" value="${ints.discordRpc.configured ? MASK : ''}" autocomplete="off">`)}
        <label class="row between"><span class="small">${t('Follow my Discord calls')}</span>${switchEl('r-on', ints.discordRpc.enabled)}</label>
        <div class="row"><button class="btn primary" data-act="r-save">${t('Save')}</button><button class="btn" data-act="r-auth" ${ints.discordRpc.configured ? '' : 'disabled'}>${t('Authorise in Discord')}</button>${ints.discordRpc.authorised ? `<button class="btn ghost sm" data-act="r-remove">${t('Disconnect')}</button>` : ''}<span class="small" id="r-status">${esc(rpcLine(ints.discordRpc))}</span></div>
        <div class="xsmall muted mt-s">${t('Limits: until Discord approves an application only its testers (up to 50) can use it, which is enough for your own use. Discord recommends its Social SDK for new projects, so this connection may stop working one day. The old WebSocket version of this connection is not used. It is not known yet whether private and group calls report people and speaking the same way as server channels: if a call shows nobody, that is why.')}</div>`)}

      ${card('discord', '#5865f2', 'users', 'Discord', ints.discord.configured ? (ints.discord.enabled ? t('The bot joins your voice call when you record') : t('Connected — switched off')) : t('A bot that hears each person in a call separately'), ints.discord.configured && ints.discord.enabled, `
        <div class="small muted">${t('On a Discord call the computer only plays one mixed sound, so people who talk at the same time blur together. With a bot in the call, Discord hands over every person on their own, so each line has the right name and overlapping speech is kept. Everyone in the call can see the bot; tell them you are recording.')}</div>
        <ol class="steps"><li>${t('Open the')} <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">${t('Discord Developer Portal')}</a> → <b>New Application</b>.</li><li>${t('Bot tab → Reset Token → copy the token and paste it below. No other switches (intents) are needed.')}</li><li>${t('Add the bot to your server: press Test below, then open the invite link it shows (or OAuth2 → URL Generator → scope bot → View Channel + Connect).')}</li><li>${t('In Discord: Settings → Advanced → Developer Mode on. Then right-click your own name → Copy User ID and paste it below.')}</li></ol>
        ${field('d-token', t('Bot token'), `<input id="d-token" type="password" value="${ints.discord.configured ? MASK : ''}" placeholder="MTI3…" autocomplete="off">`)}
        ${field('d-user', t('Your Discord user ID'), `<input id="d-user" value="${esc(ints.discord.userId)}" inputmode="numeric" placeholder="123456789012345678" autocomplete="off">`, t('The bot joins the voice channel you are in, and leaves your own voice to the microphone.'))}
        ${field('d-channel', t('Always join this voice channel (optional)'), `<input id="d-channel" value="${esc(ints.discord.channelId)}" inputmode="numeric" placeholder="${t('Channel ID, empty = the one you are in')}" autocomplete="off">`)}
        <label class="row between"><span class="small">${t('Join my call when I record')}</span>${switchEl('d-on', ints.discord.enabled)}</label>
        <div class="row"><button class="btn primary" data-act="d-save">${t('Save & test')}</button>${ints.discord.configured ? `<button class="btn ghost sm" data-act="d-remove">${t('Disconnect')}</button>` : ''}<span class="small" id="d-status"></span></div>
        <div class="small" id="d-result"></div>
        ${ints.discord.configured ? `<div class="card mt-s" style="padding:12px 14px"><div class="strong">${icon('mic')} ${t('Speaker test recording')}</div>
          <div class="xsmall muted">${t('Helps tune who-is-who for your own calls. The bot hears each person on their own while the computer records the mixed sound of the same call; both are kept on this computer (not transcribed twice) so the mixed sound can be scored against who really spoke. Join a voice channel with 2 or more people, ask them first, talk normally for 5-10 minutes, then Stop.')}</div>
          <div class="row mt-s"><button class="btn sm" data-act="d-speaker-test">${t('Start a speaker test')}</button></div></div>` : ''}`)}

      ${card('webhook', '#0ea5e9', 'webhook', t('Webhooks'), t('Send meetings anywhere: Zapier, Make, n8n, Slack, your own server'), ints.webhooks.length > 0, `
        <div class="stack tight">${ints.webhooks.map((w) => `<div class="row card" style="padding:10px 12px"><div class="grow"><div class="strong ellipsis">${esc(w.name)}</div><div class="xsmall muted ellipsis">${esc(w.url)}</div></div>${switchEl('', w.auto, t('Send automatically')).replace('id=""', `data-hook-auto="${w.id}"`)}<button class="btn ghost xs" data-hook-test="${w.id}">${t('Test')}</button><button class="btn ghost icon xs" data-hook-del="${w.id}" aria-label="${t('Remove')}">${icon('trash', 'sm')}</button></div>`).join('')}</div>
        <div class="hint">${t('Each POST carries the meeting as JSON (summary, notes, action items, topics, transcript, Markdown). With a secret, it is signed in X-WhisperBrain-Signature (HMAC-SHA256).')}</div>
        <div class="row"><button class="btn" data-act="hook-add">${icon('plus', 'sm')} ${t('Add webhook')}</button></div>`)}

      ${tsrc.map((x) => transcriptCard(x, s)).join('')}

      ${card('files', '#10b981', 'upload', t('Files'), t('Audio, video, transcripts (VTT, SRT, TXT, JSON), documents (Markdown, DOCX, HTML, CSV)'), true, `
        <div class="small muted">${t('Zoom, Teams and Meet transcript exports, Otter and other tools’ text exports, Whisper/AssemblyAI/Deepgram JSON and WhisperBrain backups are recognised with their speakers. Imported meetings are kept apart under “From outside”.')}</div>
        <div class="row"><button class="btn primary" data-act="import-files">${icon('upload', 'sm')} ${t('Import files')}</button></div>`)}
    </div></div>`;
  bind(main, ints);
  if (ints.linear.configured) loadTeams(ints).catch((e) => { const st = $('#l-status'); if (st) st.textContent = `✗ ${e.message}`; });
}

// The meeting platforms' own transcripts (Teams, Meet, Zoom): the app each person registered with the platform, then Sign in. Each one
// reads only the transcript of a meeting you ask for; it is never read in the background unless you set that in Meetings & detection.
const TS = {
  teams: { color: '#5059c9', ic: 'video', setting: 'microsoft', hint: 'Register an app in Microsoft Entra (Azure) with the delegated permissions OnlineMeetings.Read and OnlineMeetingTranscript.Read.All, redirect http://localhost, and paste its id here. Some organisations need an admin to agree to these permissions.', tenant: true },
  meet: { color: '#00897b', ic: 'video', setting: 'googleMeet', hint: 'In Google Cloud, enable the Google Meet API and make a Desktop-app OAuth client with the scope meetings.space.readonly. Paste its id and secret here.' },
  zoom: { color: '#2d8cff', ic: 'video', setting: 'zoom', hint: 'Make a user-managed OAuth app at marketplace.zoom.us (cloud recording transcripts) and paste its id and secret here.' },
};
function transcriptCard(x, s) {
  const d = TS[x.id]; if (!d) return '';
  const c = s[d.setting] || {};
  return card(`ts-${x.id}`, d.color, d.ic, `${x.label} ${t('transcripts')}`, x.connected ? t('Connected') : x.configured ? t('Set up — sign in to connect') : t('Fetch the platform’s own transcript of a meeting, with the names of who spoke'), x.connected, `
    <div class="small muted">${t(d.hint)}</div>
    ${field(`ts-id-${x.id}`, t('Client ID'), `<input id="ts-id-${x.id}" value="${esc(c.clientId || '')}" autocomplete="off" spellcheck="false">`)}
    ${x.id !== 'teams' ? field(`ts-secret-${x.id}`, t('Client secret'), `<input id="ts-secret-${x.id}" type="password" value="${c.clientSecret ? MASK : ''}" autocomplete="off">`) : field('ts-tenant-teams', t('Tenant (organizations, common or an id)'), `<input id="ts-tenant-teams" value="${esc(c.tenant || 'organizations')}" autocomplete="off">`)}
    <div class="row"><button class="btn primary" data-ts="save" data-id="${x.id}">${t('Save & sign in')}</button>${x.connected ? `<button class="btn" data-ts="off" data-id="${x.id}">${t('Disconnect')}</button>` : ''}<span class="small" id="ts-status-${x.id}"></span></div>
    <div class="xsmall muted">${t('Experimental: not yet tried against the real platform. It reads the transcript of a meeting only when you ask for it.')}</div>`);
}

function card(key, color, ic, title, sub, connected, body) {
  return `<section class="panel int-card" data-int="${key}"><div class="head"><span class="int-logo" style="background:${color}">${icon(ic)}</span><div class="grow"><h3 style="font-size:16px">${esc(title)}</h3><div class="small muted">${sub}</div></div>${connected ? `<span class="badge ok">${icon('check', 'sm')} ${t('On')}</span>` : ''}</div>${body}</section>`;
}

async function loadTeams(ints) {
  const sel = $('#l-team');
  if (!sel) return;
  const teams = await api('GET', '/api/integrations/linear/teams');
  sel.innerHTML = `<option value="">${t('Choose a team')}</option>${teams.map((tm) => `<option value="${tm.id}" data-name="${esc(tm.name)}" ${tm.id === ints.linear.teamId ? 'selected' : ''}>${esc(tm.name)} (${esc(tm.key)})</option>`).join('')}`;
}

let rpcPoll = null;   // the Discord card shows which call you are in, live
function bind(main, ints) {
  clearInterval(rpcPoll);
  rpcPoll = setInterval(async () => {
    const el = $('#r-status');
    if (!el) { clearInterval(rpcPoll); return; }   // the page was left
    try { el.textContent = rpcLine(await api('GET', '/api/integrations/discord-rpc/status')); } catch { /* the app is busy: the next one */ }
  }, 3000);
  const status = (id, ok, msg) => { const el = $(id, main); if (el) { el.textContent = `${ok ? '✓' : '✗'} ${msg}`; el.style.color = ok ? 'var(--ok)' : 'var(--danger)'; } };
  main.onclick = async (e) => {
    const gm = e.target.closest('[data-gmode]');
    if (gm) { $$('[data-gmode]', main).forEach((b) => b.setAttribute('aria-selected', String(b === gm))); $$('[data-gpane]', main).forEach((p) => { p.hidden = p.dataset.gpane !== gm.dataset.gmode; }); return; }
    const b = e.target.closest('button');
    if (!b) return;
    const a = b.dataset.act;
    if (b.dataset.ts) {
      const id = b.dataset.id, setting = TS[id].setting, say = (msg, ok) => { const el = $(`#ts-status-${id}`); if (el) { el.textContent = msg; el.style.color = ok ? 'var(--ok)' : 'var(--danger)'; } };
      try {
        if (b.dataset.ts === 'off') { await api('DELETE', `/api/transcript-sources/${id}`); render(main); return; }
        const patch = { clientId: $(`#ts-id-${id}`).value.trim() };
        const sec = $(`#ts-secret-${id}`)?.value; if (sec && sec !== MASK) patch.clientSecret = sec.trim();
        if (id === 'teams') patch.tenant = $('#ts-tenant-teams').value.trim() || 'organizations';
        await save({ [setting]: { ...S.settings[setting], ...patch } });
        const r = await api('POST', `/api/transcript-sources/${id}/connect`);
        say(t('Waiting for you to approve in the browser…'), true);
        if (r.authUrl) window.open(r.authUrl, '_blank', 'noopener');
        const onEv = (ev) => { if (['transcript-source.connected', 'transcript-source.error'].includes(ev.detail.type) && ev.detail.data?.id === id) { window.removeEventListener('wb:event', onEv); render(main); } };
        window.addEventListener('wb:event', onEv);
      } catch (err) { say(err.message, false); }
      return;
    }
    try {
      if (a === 'g-connect') {
        b.disabled = true;
        const r = await api('POST', '/api/google/connect', { clientId: $('#g-id').value.trim(), clientSecret: $('#g-secret').value.trim(), gmail: false });
        $('#g-status').innerHTML = `${t('Waiting for you to approve in the browser…')} ${r.opened ? '' : `<a href="${esc(r.authUrl)}" target="_blank" rel="noopener noreferrer">${t('Open the Google sign-in page')}</a>`}`;
        if (!r.opened) window.open(r.authUrl, '_blank', 'noopener');
        const onEv = (ev) => { if (ev.detail.type === 'google.connected' || ev.detail.type === 'google.error') { window.removeEventListener('wb:event', onEv); render(main); } };
        window.addEventListener('wb:event', onEv);
      } else if (a === 'g-disconnect') { if (await confirmDialog(t('Disconnect Google Calendar? Meetings you already recorded are kept.'), { ok: t('Disconnect') })) { await api('POST', '/api/google/disconnect'); S.settings = await api('GET', '/api/settings'); render(main); } }
      else if (a === 'g-refresh') { await api('GET', '/api/google/calendars'); S.settings = await api('GET', '/api/settings'); render(main); }
      else if (b.dataset.calDel) { await api('DELETE', `/api/calendar/sources/${b.dataset.calDel}`); S.settings = await api('GET', '/api/settings'); render(main); }
      else if (a === 'cal-add') {
        const url = $('#cal-url').value.trim();
        if (!url) return;
        await api('POST', '/api/calendar/sources', { kind: 'url', location: url });
        S.settings = await api('GET', '/api/settings');
        const r = await api('GET', '/api/calendar/events?refresh=1');
        if (r.errors.length) toast(r.errors[0].error, { error: true }); else done(t('{n} upcoming events found', { n: r.events.length }));
        render(main);
      } else if (a === 'n-save') {
        const token = $('#n-token').value.trim();
        await save({ notion: { token } });
        const r = await api('POST', '/api/integrations/notion/test');
        status('#n-status', true, `${r.name || 'OK'}${r.workspace ? ' · ' + r.workspace : ''}`);
        setTimeout(() => render(main), 900);
      } else if (a === 'n-pick') await pickNotionParent(main);
      else if (a === 'n-remove') { await save({ notion: { token: '', parentId: '', parentTitle: '', autoExport: false } }); render(main); }
      else if (a === 'l-save') {
        await save({ linear: { apiKey: $('#l-key').value.trim() } });
        const r = await api('POST', '/api/integrations/linear/test');
        status('#l-status', true, `${r.viewer.name} · ${r.teams.length} ${t('teams')}`);
        if (!S.settings.linear.teamId && r.teams.length === 1) await save({ linear: { teamId: r.teams[0].id, teamName: r.teams[0].name } });
        setTimeout(() => render(main), 900);
      } else if (a === 'l-remove') { await save({ linear: { apiKey: '', teamId: '', teamName: '' } }); render(main); }
      else if (a === 'd-save') {
        await save({ discord: { token: $('#d-token').value.trim(), userId: $('#d-user').value.trim(), channelId: $('#d-channel').value.trim(), enabled: $('#d-on').checked } });
        $('#d-status').textContent = t('Joining your call for a few seconds — say something…');
        b.disabled = true;
        const r = await api('POST', '/api/integrations/discord/test');
        b.disabled = false;
        status('#d-status', !!r.call && /works/.test(r.verdict || ''), r.verdict || r.note || t('Bot is ready'));
        const bits = [`${t('Bot')}: ${esc(r.bot.name)}`];
        if (r.call) bits.push(`${esc(r.call.server)} › ${esc(r.call.channel)}`, `${t('heard')}: ${r.call.heard.length ? r.call.heard.map(esc).join(', ') : t('nobody')}`, r.call.dave ? t('end-to-end encryption: on') : t('end-to-end encryption: off'));
        $('#d-result').innerHTML = `${bits.join(' · ')}<br><a href="${esc(r.inviteUrl)}" target="_blank" rel="noopener noreferrer">${t('Invite link: add the bot to a server')}</a>`;
      } else if (a === 'd-speaker-test') {
        b.disabled = true;
        try {
          const r = await api('POST', '/api/recording/start', { speakerTest: true, title: t('Speaker test') });
          go(`#/note/${r.noteId}?tab=transcript`);
        } catch (e) { fail(e); } finally { b.disabled = false; }
      } else if (a === 'd-remove') { await save({ discord: { token: '', enabled: false, channelId: '' } }); render(main); }
      else if (a === 'r-save') {
        const secret = $('#r-secret').value.trim();
        await save({ discordRpc: { clientId: $('#r-id').value.trim(), ...(secret && secret !== MASK ? { clientSecret: secret } : {}), enabled: $('#r-on').checked } });
        done(t('Saved')); render(main);
      } else if (a === 'r-auth') {
        b.disabled = true; $('#r-status').textContent = t('Accept in the Discord app…');
        try { const r = await api('POST', '/api/integrations/discord-rpc/authorise'); status('#r-status', true, rpcLine(r)); setTimeout(() => render(main), 900); } catch (e) { status('#r-status', false, e.message); } finally { b.disabled = false; }
      } else if (a === 'r-remove') { await api('POST', '/api/integrations/discord-rpc/disconnect'); render(main); }
      else if (a === 'o-save') {
        await save({ obsidian: { vaultPath: $('#o-path').value.trim(), folder: $('#o-folder').value.trim() || 'Meetings', transcript: $('#o-tr').checked, autoExport: $('#o-auto').checked } });
        const r = await api('POST', '/api/integrations/obsidian/test');
        status('#o-status', true, `${r.isVault ? t('Obsidian vault') : t('Folder (no .obsidian found)')} · ${r.notes} ${t('notes')}`);
        setTimeout(() => render(main), 1200);
      } else if (a === 'o-all') {
        if (!(await confirmDialog(t('Write every meeting into your Obsidian vault? Existing exports are updated in place.'), { ok: t('Export'), danger: false }))) return;
        const ids = (await api('GET', '/api/meetings?limit=5000')).map((n) => n.id);
        b.disabled = true;
        const r = await api('POST', '/api/send', { ids, target: 'obsidian' });
        const ok = r.results.filter((x) => x.ok).length;
        toast(t('{ok} of {n} exported', { ok, n: r.results.length }), { ok: ok === r.results.length, error: ok < r.results.length });
        b.disabled = false;
      } else if (a === 'hook-add') await addHook(main);
      else if (b.dataset.hookTest) { const r = await api('POST', `/api/integrations/webhooks/${b.dataset.hookTest}/test`); done(t('Delivered (HTTP {s})', { s: r.status })); }
      else if (b.dataset.hookDel) { await save({ webhooks: S.settings.webhooks.filter((w) => w.id !== b.dataset.hookDel) }); render(main); }
      else if (a === 'import-notion') openImport({ tab: 'notion' });
      else if (a === 'import-linear') openImport({ tab: 'linear' });
      else if (a === 'import-obsidian') openImport({ tab: 'obsidian' });
      else if (a === 'import-files') openImport();
    } catch (err) {
      fail(err); b.disabled = false;
      const map = { 'n-save': '#n-status', 'l-save': '#l-status', 'o-save': '#o-status', 'g-connect': '#g-status', 'd-save': '#d-status', 'r-save': '#r-status', 'r-auth': '#r-status' };
      if (map[a]) status(map[a], false, err.message);
    }
  };
  main.onchange = async (e) => {
    try {
      if (e.target.dataset.gcal !== undefined) { const sel = $$('[data-gcal]', main).filter((x) => x.checked).map((x) => x.dataset.gcal); await api('PUT', '/api/google/calendars', { selected: sel }); S.settings = await api('GET', '/api/settings'); done(); }
      else if (e.target.id === 'g-detail') { await save({ google: { calendarDetail: e.target.value } }); await api('GET', '/api/calendar/events?refresh=1').catch(() => {}); done(); }
      else if (e.target.id === 'n-auto') { await save({ notion: { autoExport: e.target.checked } }); done(); }
      else if (e.target.id === 'l-team') { const o = e.target.selectedOptions[0]; await save({ linear: { teamId: e.target.value, teamName: o?.dataset.name || '' } }); done(); }
      else if (e.target.dataset.hookAuto) { await save({ webhooks: S.settings.webhooks.map((w) => (w.id === e.target.dataset.hookAuto ? { ...w, auto: e.target.checked } : w)) }); done(); }
    } catch (err) { fail(err); }
  };
  void ints;
}

function pickNotionParent(main) {
  return modal({
    title: t('Where should meeting notes go?'),
    body: `<div class="hint">${t('Only pages and databases shared with your integration appear here.')}</div><div class="search-in" style="max-width:none">${icon('search', 'sm')}<input id="np-q" placeholder="${t('Search Notion…')}"></div><div class="picklist" id="np-list"><div class="empty"><div class="skel" style="width:50%"></div></div></div>`,
    onMount: (d, close) => {
      const list = $('#np-list', d);
      const load = debounce(async (q) => {
        try {
          const items = await api('GET', `/api/integrations/notion/search?q=${encodeURIComponent(q)}`);
          list.innerHTML = items.map((it, i) => `<label data-i="${i}">${icon(it.kind === 'database' ? 'layers' : 'doc')}<span class="grow ellipsis">${esc(it.title || t('Untitled'))}</span><span class="badge">${it.kind === 'database' ? t('database') : t('page')}</span></label>`).join('') || `<div class="empty"><p>${t('Nothing shared with the integration yet.')}</p></div>`;
          list.onclick = async (ev) => {
            const row = ev.target.closest('[data-i]'); if (!row) return;
            const it = items[Number(row.dataset.i)];
            await save({ notion: { parentId: it.id, parentKind: it.kind, parentTitle: it.title || 'Untitled' } });
            done(); close(); render(main);
          };
        } catch (e) { list.innerHTML = `<div class="banner danger">${esc(e.message)}</div>`; }
      }, 250);
      $('#np-q', d).addEventListener('input', (e) => load(e.target.value.trim()));
      load('');
    },
  });
}

function addHook(main) {
  return modal({
    title: t('Add a webhook'),
    body: `${field('wh-name', t('Name'), '<input id="wh-name" placeholder="Zapier">')}${field('wh-url', 'URL', '<input id="wh-url" type="url" placeholder="https://hooks.zapier.com/…">')}${field('wh-secret', t('Signing secret (optional)'), '<input id="wh-secret" autocomplete="off">')}
      <label class="check"><input type="checkbox" id="wh-auto"> ${t('Send every meeting automatically after it is enhanced')}</label>`,
    foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" data-ok>${t('Add')}</button>`,
    onMount: (d, close) => {
      $('[data-ok]', d).onclick = async () => {
        try { await save({ webhooks: [...S.settings.webhooks, { name: $('#wh-name', d).value, url: $('#wh-url', d).value.trim(), secret: $('#wh-secret', d).value, auto: $('#wh-auto', d).checked }] }); close(true); render(main); } catch (e) { fail(e); }
      };
    },
  });
}
