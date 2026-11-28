// Sources: where WhisperBrain reads from besides the recorder: folders and Obsidian vaults. The files stay where they are
// ("read in place"): only the path, a fingerprint and the text, so the notes can be found, are kept. Lives under the Setup door.
import { S, $, api, t, esc, icon, fail, done, debounce, empty, confirmDialog, fmtDate, modal } from '../lib.js';
import { openAccessSheet, grantSummary, connectGoogle } from '../access-sheet.js';

let onEvent = null;   // the live listener of the page on screen (one at a time)

// What each service asks for. The token lives in Settings (sealed); what is added as a source is what to read.
const SERVICES = {
  github: { name: 'GitHub', ic: 'proj', token: { key: 'github', field: 'token', label: 'Personal access token', ph: 'github_pat_…', hint: 'Create one at github.com → Settings → Developer settings, with read-only access to the repositories you want.' }, field: { key: 'repos', label: 'Repositories', ph: 'owner/name, owner/other' }, what: 'Issues and pull requests, with their comments' },
  slack: { name: 'Slack', ic: 'hash', token: { key: 'slack', field: 'token', label: 'Token of your own Slack app', ph: 'xoxp-…', hint: 'Make a Slack app in your own workspace and give it read-only scopes: channels:history, channels:read, users:read (and groups:history for private channels). An app of your own is not under the limits Slack put on shared apps.' }, field: { key: 'channels', label: 'Channels', ph: 'general, atlas' }, what: 'Channel messages, one item per channel per day', token2: { key: 'slack', field: 'userToken', label: 'User token for live search (optional)', ph: 'xoxp-…', hint: 'Needs the search:read scope. Without it Slack is only searched in the copy kept here.' } },
  discord: { name: 'Discord', ic: 'users', token: { key: 'discord', field: 'token', label: 'Bot token', ph: 'MTI3…', hint: 'Your own bot, added to your own server, with View Channel and Read Message History, and the Message Content switch on in the developer portal. Your personal account is never used.' }, field: { key: 'channels', label: 'Channel ids', ph: '123456789012345678, …' }, what: 'Channel messages, one item per channel per day' },
  gmail: { name: 'Gmail', ic: 'mail', google: true, field: { key: 'query', label: 'Which mail', ph: 'newer_than:90d', value: 'newer_than:90d' }, what: 'Mail threads. You choose how much is read, and whether it may also draft, label or send (each only after you approve it)' },
  outlook: { name: 'Outlook / Microsoft 365', ic: 'mail', outlook: true, what: 'Mail from Outlook.com or Microsoft 365, through your own Microsoft app. You choose how much is read' },
  imap: { name: 'E-mail (IMAP)', ic: 'mail', imap: true, what: 'Any mailbox that speaks IMAP (Fastmail, iCloud, your own server). You choose how much is read' },
  notion: { name: 'Notion', ic: 'doc', poll: true, what: 'Keeps the pages you imported up to date' },
  linear: { name: 'Linear', ic: 'checksq', poll: true, what: 'Keeps the issues you imported up to date' },
};
const NO_TOKEN_NOTE = { notion: 'Connect Notion in Integrations first.', linear: 'Connect Linear in Integrations first.' };

const ago = (ms) => {
  if (!ms) return t('not read yet');
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return t('just now');
  if (m < 60) return t('{n} min ago', { n: m });
  const h = Math.round(m / 60);
  return h < 24 ? t('{n} h ago', { n: h }) : fmtDate(ms, { day: 'numeric', month: 'short' });
};

export async function render(main, { alive = () => true } = {}) {
  let draft = { path: '', flavour: 'obsidian', check: null, busy: false, error: '', svc: null };
  const draw = async () => {
    const [sources, services] = await Promise.all([api('GET', '/api/sources'), api('GET', '/api/services').catch(() => [])]);
    if (!alive()) return;   // the user moved on meanwhile (app.js route())
    main._sources = sources;
    const folders = sources.filter((s) => !s.config?.imported);
    const meetings = sources.filter((s) => s.config?.imported && s.items);
    const vault = S.settings?.obsidian?.vaultPath;
    const vaultTaken = vault && folders.some((s) => s.config.path === vault);
    main.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>${t('Folders & vaults')}</h1><div class="sub">${t('Where WhisperBrain reads from, besides what you record. Your files stay exactly where they are: only their path, a fingerprint and the text (so you can search them) are kept here. Nothing is ever written to them.')}</div></div></div>
      <section class="panel mb">
        <div class="panel-head"><h3>${icon('folder')} ${t('Add notes from this computer')}</h3></div>
        ${vault && !vaultTaken ? `<div class="banner mb">${icon('book')}<div class="grow"><b>${t('Your Obsidian vault')}</b><div class="small muted">${esc(vault)}</div></div><button class="btn sm primary" data-act="use-vault">${t('Read its notes')}</button></div>` : ''}
        <div class="row" style="gap:10px;flex-wrap:wrap;align-items:end">
          <div class="field grow" style="min-width:260px;margin:0"><label for="src-path">${t('Folder')}</label><input id="src-path" value="${esc(draft.path)}" placeholder="/home/you/Documents/Notes" autocomplete="off" spellcheck="false"></div>
          <div class="field" style="margin:0"><label for="src-kind">${t('It is')}</label><select id="src-kind"><option value="obsidian" ${draft.flavour === 'obsidian' ? 'selected' : ''}>${t('An Obsidian vault')}</option><option value="folder" ${draft.flavour === 'folder' ? 'selected' : ''}>${t('A plain folder')}</option></select></div>
          <button class="btn" data-act="check" ${draft.busy ? 'disabled' : ''}>${t('Check')}</button>
          <button class="btn primary" data-act="add" ${draft.check?.ok ? '' : 'disabled'}>${icon('plus', 'sm')} ${t('Add')}</button>
        </div>
        ${draft.check?.ok ? `<div class="small mt-s" style="color:var(--ok)">${icon('ok', 'sm')} ${t('{n} notes and files can be read here.', { n: draft.check.files })}${draft.check.isVault && draft.flavour !== 'obsidian' ? ` ${t('This looks like an Obsidian vault.')}` : ''}</div>` : ''}
        ${draft.error ? `<div class="small mt-s" style="color:var(--danger)">${icon('alert', 'sm')} ${esc(draft.error)}</div>` : ''}
        <div class="xsmall muted mt-s">${t('Markdown, text and PDF files are read. Folders named like .obsidian or .git are skipped, and so are meetings that WhisperBrain itself wrote into the vault.')}</div>
      </section>
      <section class="panel mb"><div class="panel-head"><h3>${icon('plug')} ${t('Connect a service')}</h3></div>
        <div class="small muted" style="margin-bottom:10px">${t('Mail and chat are private by default: only an AI on this computer may ever read them. For each one you choose what may be read and what it may propose to do; the keys stay on this computer.')}</div>
        <div class="stack tight">${services.filter((v) => SERVICES[v.kind]).map((v) => serviceCard(v, folders)).join('')}</div>
        <div class="card mt-s" style="padding:12px 14px"><div class="strong">${icon('users')} ${t('Discord data package')}</div><div class="xsmall muted">${t('Discord → Settings → Privacy & Safety → Request all of my data. Import the ZIP it sends you: the messages you wrote, one item per channel per day.')}</div>
          <div class="row mt-s"><input type="file" accept=".zip" data-discord-pkg></div><div class="small mt-s" id="dpk-msg"></div></div>
        <div class="card mt-s" style="padding:12px 14px"><div class="strong">${icon('mail')} ${t('A mail file (.mbox)')}</div><div class="xsmall muted">${t('Google Takeout gives you your Gmail as an .mbox file; most mail programs can export one. It is read in place, here, with the access you choose.')}</div>
          <div class="row mt-s" style="gap:8px;flex-wrap:wrap;align-items:end"><div class="field grow" style="margin:0;min-width:240px"><label for="mbox-path">${t('File on this computer')}</label><input id="mbox-path" placeholder="/home/you/Takeout/Mail/All mail.mbox" autocomplete="off" spellcheck="false"></div><button class="btn sm primary" data-act="mbox-add">${t('Import…')}</button></div><div class="small mt-s" id="mbox-msg"></div></div></section>
      ${folders.length ? `<div class="stack loose">${folders.map(card).join('')}</div>` : `<section class="panel">${empty('folder', t('No folders yet'), t('Add your Obsidian vault or any folder of notes, and everything in it becomes searchable here and in the search (Ctrl K).'))}</section>`}
      ${meetings.length ? `<section class="panel mt"><div class="panel-head"><h3>${icon('video')} ${t('Meetings by origin')}</h3><a class="link" href="#/meetings">${t('Go to Meetings')} ${icon('chevright', 'sm')}</a></div>
        <div class="stack tight">${meetings.map((s) => `<div class="row between small"><span>${esc(label(s))}</span><span class="muted">${s.items} ${s.items === 1 ? t('meeting') : t('meetings')}</span></div>`).join('')}</div></section>` : ''}
    </div>`;
  };
  const serviceCard = (v, folders) => {
    const d = SERVICES[v.kind], st = draft.svc?.kind === v.kind ? draft.svc : {};
    const have = folders.filter((f) => f.kind === v.kind);
    const tokenOk = d.google ? !!(S.settings.google?.gmail && S.settings.google?.refreshToken) : v.ready;
    return `<div class="card" data-svc="${v.kind}" style="padding:12px 14px"><div class="row between"><div class="strong">${icon(d.ic)} ${d.name}${have.length ? ` <span class="badge ok">${have.length}</span>` : ''}</div><span class="small ${tokenOk ? '' : 'muted'}">${tokenOk ? `${icon('ok', 'sm')} ${t('Connected')}` : t('Not connected')}</span></div>
      <div class="xsmall muted">${t(d.what)}</div>
      ${d.token && !tokenOk ? `<div class="field mt-s"><label>${t(d.token.label)}</label><input type="password" data-token="${v.kind}" placeholder="${esc(d.token.ph)}" autocomplete="off"><div class="hint">${t(d.token.hint)}</div><div class="row mt-s"><button class="btn sm" data-svc-act="save-token">${t('Save the key')}</button></div></div>` : ''}
      ${d.token2 && tokenOk ? `<div class="field mt-s"><label>${t(d.token2.label)}</label><input type="password" data-token2="${v.kind}" value="${S.settings[d.token2.key]?.[d.token2.field] ? '********' : ''}" placeholder="${esc(d.token2.ph)}" autocomplete="off"><div class="hint">${t(d.token2.hint)}</div><div class="row mt-s"><button class="btn sm" data-svc-act="save-token2">${t('Save the key')}</button></div></div>` : ''}
      ${d.outlook ? `<div class="hint mt-s">${t('Uses an app you register in Microsoft Entra (see the docs). You choose what is read and what Microsoft is asked for.')}</div><div class="row mt-s"><button class="btn sm primary" data-svc-act="outlook-add">${icon('mail', 'sm')} ${t('Add a mailbox…')}</button></div>` : ''}
      ${d.imap ? `<div class="hint mt-s">${t('Your password is kept sealed on this computer. Gmail, Outlook and iCloud need an app password.')}</div><div class="row mt-s"><button class="btn sm primary" data-svc-act="imap-add">${icon('mail', 'sm')} ${t('Add a mailbox…')}</button></div>` : ''}
      ${d.google ? `<div class="hint mt-s">${t('You choose what is read and what Google is asked for. Each mailbox is its own source with its own access.')}</div><div class="row mt-s"><button class="btn sm primary" data-svc-act="gmail-add">${icon('mail', 'sm')} ${t('Add a mailbox…')}</button></div>` : ''}
      ${d.poll && !tokenOk ? `<div class="hint mt-s">${t(NO_TOKEN_NOTE[v.kind])} <a href="#/integrations">${t('Integrations')}</a></div>` : ''}
      ${tokenOk && !d.google ? `<div class="row mt-s" style="gap:8px;align-items:end;flex-wrap:wrap"><button class="btn sm" data-svc-act="check">${t('Check')}</button><button class="btn sm primary" data-svc-act="add">${icon('plus', 'sm')} ${t('Add…')}</button></div>
        ${st.msg ? `<div class="small mt-s" style="color:${st.bad ? 'var(--danger)' : 'var(--ok)'}">${esc(st.msg)}</div>` : ''}<div class="xsmall muted mt-s">${t('Checked every {n} minutes.', { n: v.everyMin })}</div>` : ''}</div>`;
  };
  const label = (s) => ({ native: t('Recorded here and imported files'), notion: 'Notion', linear: 'Linear', obsidian: 'Obsidian' }[s.kind] || s.name);
  const card = (s) => {
    const err = s.lastError;
    const status = s.syncing ? `<span class="spinner" aria-hidden="true"></span> ${s.progress ? t('Reading… {done} of {total}', s.progress) : t('Reading…')}` : !s.enabled ? t('Paused') : err ? `${icon('alert', 'sm')} ${esc(err)}` : `${t('Read {when}', { when: ago(s.lastSyncAt) })}`;
    return `<section class="panel" data-src="${s.id}">
      <div class="panel-head"><h3>${icon(s.kind === 'obsidian' ? 'book' : SERVICES[s.kind]?.ic || 'folder')} ${esc(s.name)}</h3><span class="badge ${s.enabled ? (err ? 'danger' : 'ok') : ''}">${s.enabled ? (err ? t('Problem') : t('On')) : t('Paused')}</span></div>
      <div class="small muted ellipsis" title="${esc(s.config.path || '')}">${esc(s.config.path || (s.config.remote ? (s.config.repos || s.config.channels || []).join(', ') || s.config.query || '' : ''))}</div>
      <div class="row between mt-s" style="flex-wrap:wrap;gap:8px">
        <div class="small" ${err && !s.syncing ? 'style="color:var(--danger)"' : ''}>${status}</div>
        <div class="small muted">${s.items} ${s.items === 1 ? t('note') : t('notes')} · <a href="#/documents?source=${s.id}">${t('Open')}</a></div>
      </div>
      <div class="row between mt" style="flex-wrap:wrap;gap:10px">
        <div class="small"><span class="muted">${t('Access')}:</span> ${esc(grantSummary(s))} <button class="btn sm ghost" data-access="${s.id}">${t('Change')}</button></div>
        <div class="row" style="gap:8px">${s.config.needsReconnect ? `<button class="btn sm primary" data-reconnect="${s.id}">${t('Reconnect')}</button>` : ''}<button class="btn sm" data-sync="${s.id}" ${s.syncing || !s.enabled ? 'disabled' : ''}>${icon('refresh', 'sm')} ${t('Read now')}</button>
          <button class="btn sm" data-toggle="${s.id}" data-on="${s.enabled ? 0 : 1}">${s.enabled ? t('Pause') : t('Resume')}</button>
          <button class="btn sm ghost" data-remove="${s.id}">${t('Remove')}</button></div>
      </div>
      <div class="xsmall muted mt-s">${s.config.remote ? t('A copy of the text is kept here so it can be searched. Removing it forgets that copy; nothing at the service is touched.') : `${t('Read in place')} · ${t('Removing it forgets these notes here; your files are not touched.')}`}</div>
    </section>`;
  };
  await draw();

  const serviceAction = async (b) => {
    const kind = b.closest('[data-svc]').dataset.svc, d = SERVICES[kind], act = b.dataset.svcAct;
    const say = (msg, bad = false) => { draft.svc = { kind, msg, bad }; return draw(); };
    if (act === 'save-token') {
      const v = b.closest('[data-svc]').querySelector('[data-token]').value.trim();
      if (!v) return;
      const cur = S.settings[d.token.key] || {};
      S.settings = await api('PUT', '/api/settings', { [d.token.key]: { ...cur, [d.token.field]: v } });
      return say(t('Key saved.'));
    }
    if (act === 'save-token2') {
      const v = b.closest('[data-svc]').querySelector('[data-token2]').value.trim();
      if (!v || v === '********') return;
      const cur = S.settings[d.token2.key] || {};
      S.settings = await api('PUT', '/api/settings', { [d.token2.key]: { ...cur, [d.token2.field]: v } });
      return say(t('Key saved.'));
    }
    if (act === 'outlook-add') {
      const ov = await api('GET', '/api/outlook/status');
      const r = await openAccessSheet({ provider: 'outlook', mode: 'connect', accounts: [] });
      if (!r) return;
      let creds = {};
      if (!ov.configured) {
        creds = await modal({ title: t('Your Microsoft app'), body: `<div class="stack"><div class="field"><label for="ol-id">${t('Application (client) ID')}</label><input id="ol-id" autocomplete="off" spellcheck="false"></div><div class="field"><label for="ol-tenant">${t('Tenant (common, organizations or an id)')}</label><input id="ol-tenant" value="common" autocomplete="off"></div><div class="field"><label for="ol-secret">${t('Client secret (only if your app has one)')}</label><input id="ol-secret" type="password" autocomplete="off"></div></div>`, foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" data-ok>${t('Sign in')}</button>`, onMount: (dl, close) => { dl.querySelector('[data-ok]').onclick = () => close({ clientId: dl.querySelector('#ol-id').value.trim(), tenant: dl.querySelector('#ol-tenant').value.trim(), clientSecret: dl.querySelector('#ol-secret').value }); } });
        if (!creds?.clientId) return;
      }
      done(t('Finish the sign-in in your browser.'));
      const c = await api('POST', '/api/outlook/connect', { ...creds, level: r.grant.readLevel, actions: r.grant.actions });
      if (!c.opened && c.authUrl) window.open(c.authUrl, '_blank', 'noopener');
      const ev = await new Promise((resolve) => { const h = (e) => { if (['outlook.connected', 'outlook.error'].includes(e.detail?.type)) { window.removeEventListener('wb:event', h); resolve(e.detail); } }; window.addEventListener('wb:event', h); setTimeout(() => { window.removeEventListener('wb:event', h); resolve({ type: 'timeout' }); }, 5 * 60_000); });
      if (ev.type === 'outlook.error') return say(ev.data?.message || t('Sign-in failed'), true);
      if (ev.type !== 'outlook.connected') return say(t('The sign-in did not finish.'), true);
      try { await api('POST', '/api/sources', { service: 'outlook', name: `Outlook ${ev.data?.email || ''}`.trim(), config: r.config, grant: r.grant }); done(t('Added. Reading…')); return draw(); } catch (e) { return say(e.message, true); }
    }
    if (act === 'imap-add') {
      const acc = await modal({ title: t('Add a mailbox (IMAP)'), body: `<div class="stack"><div class="formgrid"><div class="field"><label for="im-host">${t('Server')}</label><input id="im-host" placeholder="imap.fastmail.com" autocomplete="off" spellcheck="false"></div><div class="field"><label for="im-port">${t('Port')}</label><input id="im-port" value="993" inputmode="numeric"></div></div><div class="formgrid"><div class="field"><label for="im-user">${t('User')}</label><input id="im-user" placeholder="you@example.com" autocomplete="off"></div><div class="field"><label for="im-pass">${t('Password')}</label><input id="im-pass" type="password" autocomplete="off"></div></div><div class="hint">${t('Connects over an encrypted connection only. A server with a self-signed certificate is refused.')}</div><div class="small" id="im-msg" style="color:var(--danger)"></div></div>`, foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" data-ok>${t('Test and continue')}</button>`, onMount: (dl, close) => { dl.querySelector('[data-ok]').onclick = () => { const host = dl.querySelector('#im-host').value.trim(), user = dl.querySelector('#im-user').value.trim(), password = dl.querySelector('#im-pass').value; if (!host || !user || !password) { dl.querySelector('#im-msg').textContent = t('Fill in the server, the user and the password.'); return; } close({ id: Math.random().toString(36).slice(2, 14), label: user, host, port: Number(dl.querySelector('#im-port').value) || 993, tls: true, user, password, authMethod: 'password' }); }; } });
      if (!acc) return;
      const keep = (S.settings.imapAccounts || []);
      S.settings = await api('PUT', '/api/settings', { imapAccounts: [...keep, acc] });
      let info;
      try { info = await api('POST', '/api/imap/test', { account: acc.id }); } catch (e) { S.settings = await api('PUT', '/api/settings', { imapAccounts: keep }); return say(e.message, true); }
      const r = await openAccessSheet({ provider: 'imap', mode: 'connect', accounts: [] });
      if (!r) { S.settings = await api('PUT', '/api/settings', { imapAccounts: keep }); return; }
      try { await api('POST', '/api/sources', { service: 'imap', name: `Mail ${acc.user}`, config: { ...r.config, account: acc.id }, grant: r.grant }); done(t('Added. Reading…')); return draw(); } catch (e) { return say(e.message, true); }
    }
    if (act === 'gmail-add') {
      const accounts = (await api('GET', '/api/google/accounts').catch(() => [])).filter((x) => x.gmail || x.primary);
      const r = await openAccessSheet({ provider: 'gmail', mode: 'connect', accounts: accounts.length ? accounts : [{ id: 'primary', email: '' }] });
      if (!r) return;
      done(t('Finish the sign-in in your browser.'));
      const ev = await connectGoogle({ account: r.account || 'primary', level: r.grant.readLevel, actions: r.grant.actions });
      if (ev.type === 'google.error') return say(ev.data?.message || t('Sign-in failed'), true);
      if (ev.type !== 'google.connected') return say(t('The sign-in did not finish. Press Add a mailbox again when you are ready.'), true);
      S.settings = await api('GET', '/api/settings').catch(() => S.settings);
      try { await api('POST', '/api/sources', { service: 'gmail', name: `Gmail ${ev.data?.email || ''}`.trim(), config: { ...r.config, account: ev.data?.account || 'primary' }, grant: r.grant }); draft.svc = null; done(t('Added. Reading…')); return draw(); } catch (e) { return say(e.message, true); }
    }
    if (act === 'check') { try { const r = await api('POST', '/api/sources/check', { service: kind }); return say(`${t('Works')}: ${r.user || r.team || r.bot || r.email || t('connected')}`); } catch (e) { return say(e.message, true); } }
    if (act === 'add') {
      const r = await openAccessSheet({ provider: kind, mode: 'connect' });
      if (!r) return;
      try { await api('POST', '/api/sources', { service: kind, name: d.name, config: r.config, grant: r.grant }); draft.svc = null; done(t('Added. Reading…')); return draw(); } catch (e) { return say(e.message, true); }
    }
  };
  main.onchange = async (e) => {
    if (e.target.matches('[data-discord-pkg]')) {
      const f = e.target.files[0]; if (!f) return;
      const msg = main.querySelector('#dpk-msg'); msg.textContent = t('Reading…');
      try { const r = await api('POST', '/api/sources/discord-export', f); msg.style.color = 'var(--ok)'; msg.textContent = t('{n} channels imported.', { n: r.channels }); window.dispatchEvent(new Event('wb:refresh')); setTimeout(() => draw().catch(() => {}), 800); } catch (err) { msg.style.color = 'var(--danger)'; msg.textContent = err.message; }
      return;
    }
    if (e.target.id === 'src-kind') { draft.flavour = e.target.value; draft.check = null; return draw(); }
  };
  main.oninput = (e) => { if (e.target.id === 'src-path') { draft.path = e.target.value; if (draft.check || draft.error) { draft.check = null; draft.error = ''; const b = main.querySelector('[data-act="add"]'); if (b) b.disabled = true; } } };
  main.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.act === 'check') {
        draft.busy = true; draft.error = '';
        try { draft.check = await api('POST', '/api/sources/check', { path: draft.path.trim(), flavour: draft.flavour }); } catch (err) { draft.check = null; draft.error = err.message; }
        draft.busy = false; await draw();
      } else if (b.dataset.act === 'add') {
        await api('POST', '/api/sources', { path: draft.path.trim(), flavour: draft.flavour });
        draft = { path: '', flavour: draft.flavour, check: null, busy: false, error: '' }; done(t('Added. Reading the notes…')); await draw();
      } else if (b.dataset.act === 'use-vault') {
        await api('POST', '/api/sources', { path: S.settings.obsidian.vaultPath, flavour: 'obsidian', exclude: S.settings.obsidian.folder ? [S.settings.obsidian.folder] : [] });
        done(t('Added. Reading the notes…')); await draw();
      } else if (b.dataset.act === 'mbox-add') {
        const path = $('#mbox-path', main).value.trim(), msg = $('#mbox-msg', main);
        if (!path) return;
        const r = await openAccessSheet({ provider: 'mbox', mode: 'connect', accounts: [], title: t('What may WhisperBrain do with this file?') });
        if (!r) return;
        msg.style.color = ''; msg.textContent = t('Reading…');
        try { const out = await api('POST', '/api/sources/mbox', { path, name: path.split('/').pop(), grant: r.grant }); msg.style.color = 'var(--ok)'; msg.textContent = t('{n} conversations imported.', { n: out.threads }); window.dispatchEvent(new Event('wb:refresh')); setTimeout(() => draw().catch(() => {}), 800); }
        catch (err) { msg.style.color = 'var(--danger)'; msg.textContent = err.message; }
      } else if (b.dataset.svcAct) { await serviceAction(b);
      } else if (b.dataset.access) {
        const src = main._sources.find((x) => x.id === b.dataset.access);
        const r = await openAccessSheet({ provider: src.kind, mode: 'change', current: { ...src }, accounts: [] });
        if (r) { await api('PATCH', `/api/sources/${src.id}`, { config: r.config }); const res = await api('PATCH', `/api/sources/${src.id}/grant`, r.grant); done(res.purged ? t('Saved. {n} items were forgotten.', { n: res.purged }) : t('Saved')); await draw(); }
      } else if (b.dataset.reconnect) {
        const src = main._sources.find((x) => x.id === b.dataset.reconnect);
        if (src.kind === 'outlook') { const c = await api('POST', '/api/outlook/connect', { level: src.readLevel === 'metadata' ? 'metadata' : 'part', actions: src.actions || [] }); if (!c.opened && c.authUrl) window.open(c.authUrl, '_blank', 'noopener'); done(t('Finish the sign-in in your browser.')); return; }
        await connectGoogle({ account: src.config?.account || 'primary', level: src.readLevel === 'metadata' ? 'metadata' : 'part', actions: src.actions || [] });
        await api('POST', `/api/sources/${src.id}/sync`); await draw();
      } else if (b.dataset.sync) { await api('POST', `/api/sources/${b.dataset.sync}/sync`); await draw(); }
      else if (b.dataset.toggle) { await api('PATCH', `/api/sources/${b.dataset.toggle}`, { enabled: b.dataset.on === '1' }); await draw(); }
      else if (b.dataset.remove && await confirmDialog(t('Forget the notes of this source? Your files are not touched, and you can add the folder again later.'), { ok: t('Remove') })) { await api('DELETE', `/api/sources/${b.dataset.remove}`); await draw(); window.dispatchEvent(new Event('wb:refresh')); }
    } catch (err) { fail(err); }
  };
  const redraw = debounce(() => { if (S.view.name === 'sources' && !document.activeElement?.matches?.('#src-path')) draw().catch(() => {}); }, 400);
  if (onEvent) window.removeEventListener('wb:event', onEvent);
  onEvent = (e) => {
    if (S.view.name !== 'sources') { window.removeEventListener('wb:event', onEvent); onEvent = null; return; }
    if (['sources.changed', 'sources.syncing', 'sources.progress', 'job.changed'].includes(e.detail?.type)) redraw();
  };
  window.addEventListener('wb:event', onEvent, { signal: S.route.signal });   // and gone with the page (app.js route())
}
