// The access sheet: what WhisperBrain may do with a source, asked when it is connected and whenever it is changed (docs/access.md).
// Five choices (nothing / only who and when / a part / everything / read + actions), what the filter is, who may see it (an AI on this
// computer, ask each time, any AI), live search, the actions allowed, how long a live copy is kept, and an optional end date.
// openAccessSheet({ provider, current, mode, accounts }) -> Promise<{ grant, config, account } | undefined>
import { S, $, api, t, esc, icon, modal, fail } from './lib.js';
import { isThisComputer } from './locality.js';

const GMAIL_ACTIONS = [
  ['gmail.draft', 'Write drafts of replies', 'Saved in Gmail’s Drafts: you send them from Gmail.'],
  ['gmail.send', 'Send e-mail', 'Each one is shown in full and sent only after you approve it.'],
  ['gmail.label', 'Add or remove labels', 'Google describes this permission as “read, compose and send”: it also covers archive and mark as read.'],
  ['gmail.archive', 'Archive', 'Takes a thread out of the Inbox.'],
  ['gmail.markRead', 'Mark as read', ''],
];

// per service: what each choice means there, what a filter can say, which actions exist
export const PROVIDERS = {
  gmail: {
    name: 'Gmail', levels: { metadata: 'Sender, recipients, date and subject of each thread. No message text, and not Gmail’s preview either.', part: 'Only the mail your filter allows.', all: 'The whole mailbox, newest first, in the background.' },
    actions: GMAIL_ACTIONS, live: 'Search Gmail itself when you search, so older mail can be found too.',
    filterFields: [
      ['query', 'config', 'Which mail', 'newer_than:90d', 'Gmail search words: newer_than:90d, from:ana, label:Work… Empty with “everything”.'],
      ['labels', 'config', 'Only these labels', 'Work, Clients', 'Any of them. Leave empty for all.'],
      ['excludeLabels', 'filter', 'Never these labels', 'Newsletters', ''],
      ['fromDomains', 'filter', 'Only from these domains', 'acme.io, partner.pt', ''],
    ],
    toggles: [['skipCategories', 'filter', 'Skip Promotions, Social, Updates and Forums', true], ['attachmentText', 'filter', 'Also read the text of PDF and text attachments (up to 5 MB)', false]],
    never: true,
  },
  slack: { name: 'Slack', levels: { metadata: 'Channel, who wrote and when. No message text.', part: 'The channels you list.', all: 'Every channel the app is in.' }, actions: [['slack.post', 'Post or reply in a channel', 'Each message is shown in full and sent only after you approve it.']], live: 'Search Slack itself (needs a user token with search:read).', filterFields: [['channels', 'config', 'Channels', 'general, atlas', '']], never: true },
  github: { name: 'GitHub', levels: { metadata: 'Title, number, state, author and labels. No text.', part: 'The repositories you list.', all: 'Every repository the token can see.' }, actions: [['github.comment', 'Comment on an issue or pull request', ''], ['github.issue', 'Open an issue', '']], live: 'Search GitHub itself, only in the repositories you allow.', filterFields: [['repos', 'config', 'Repositories', 'owner/name, owner/other', '']], never: true },
  discord: { name: 'Discord', levels: { metadata: 'Channel, who wrote and when. No message text.', part: 'The channels you list.', all: 'Every text channel of the server.' }, actions: [['discord.send', 'Post in a channel', '']], live: '', filterFields: [['channels', 'config', 'Channel ids', '123456789012345678, …', '']], never: true },
  notion: { name: 'Notion', levels: { part: 'Only the pages you imported, kept up to date.', all: 'Every page shared with the integration.' }, actions: [['notion.page', 'Create a page', '']], live: 'Search Notion itself (titles only).', filterFields: [], never: false },
  linear: { name: 'Linear', levels: { part: 'Only the issues you imported, kept up to date.', all: 'Every issue of your team.' }, actions: [['linear.issue', 'Open an issue', ''], ['linear.comment', 'Comment on an issue', '']], live: 'Search Linear itself.', filterFields: [], never: false },
  mbox: { name: 'Mail file (.mbox)', levels: { metadata: 'Sender, recipients, date and subject. No message text.', part: 'The mail your filter allows.', all: 'Every message in the file.' }, actions: [], live: '', filterFields: [], never: true },
  folder: { name: 'Folder', levels: { part: 'The folder, without what you exclude.', all: 'Everything in the folder.' }, actions: [], live: '', filterFields: [], never: false },
  obsidian: { name: 'Obsidian vault', levels: { part: 'The vault, without what you exclude.', all: 'Everything in the vault.' }, actions: [['obsidian.note', 'Write a note into the vault', 'Never overwrites a file.']], live: '', filterFields: [], never: false },
  outlook: { name: 'Outlook', levels: { metadata: 'Sender, recipients, date and subject. No message text.', part: 'Only the mail your filter allows.', all: 'The whole mailbox.' }, actions: [], live: 'Search Outlook itself when you search.', filterFields: [['labels', 'config', 'Only these categories', 'Work', '']], never: true },
  imap: { name: 'E-mail (IMAP)', levels: { metadata: 'Headers only: sender, recipients, date and subject.', part: 'Only the mail your filter allows.', all: 'The whole mailbox.' }, actions: [], live: 'Search the mailbox itself when you search.', filterFields: [], never: true },
};
const LEVEL_NAME = { none: 'Nothing', metadata: 'Only who and when', part: 'A part', all: 'Everything', actions: 'Read + actions' };
const LEVEL_NOTE = { none: 'Connected, but nothing is read. What was read before is forgotten.' };
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean);
const val = (d, id) => d.querySelector(`#${id}`)?.value ?? '';
const chk = (d, id) => !!d.querySelector(`#${id}`)?.checked;

// What a person is told about who may see what, using the AI server really configured
function reachNote() {
  const url = S.settings?.llm?.baseUrl || '';
  let host = ''; try { host = new URL(url).hostname; } catch { /* none set */ }
  const local = isThisComputer(url);   // a server elsewhere on the network is another computer (src/core/policy.js)
  return local ? t('Your AI server ({host}) is on this computer.', { host: host || t('none set') })
    : t('Your AI server ({host}) is NOT on this computer. “Any AI server” would let this go there, with e-mail addresses, phone numbers, bank numbers and codes replaced by placeholders first.', { host });
}

// current: { readLevel, filter, actions, aiReach, liveSearch, mcp, retentionDays, expiresAt, config } of an existing source (or nothing: new)
export async function openAccessSheet({ provider, current = {}, mode = 'connect', accounts = [], title } = {}) {
  const P = PROVIDERS[provider] || PROVIDERS.folder;
  const cur = { readLevel: 'part', filter: {}, actions: [], aiReach: 'local', liveSearch: false, mcp: false, retentionDays: 7, expiresAt: null, config: {}, ...current };
  const levels = ['none', ...Object.keys(P.levels)];
  let choice = cur.actions?.length && cur.readLevel !== 'none' ? 'actions' : cur.readLevel;
  const sel = new Set(cur.actions || []);
  const f = cur.filter || {}, c = cur.config || {};
  const nv = (key, where) => (where === 'config' ? c[key] : f[key]);
  const fieldHtml = ([key, where, label, ph, hint]) => `<div class="field"><label for="as-${key}">${t(label)}</label><input id="as-${key}" data-where="${where}" value="${esc(Array.isArray(nv(key, where)) ? nv(key, where).join(', ') : nv(key, where) ?? '')}" placeholder="${esc(ph)}" autocomplete="off" spellcheck="false">${hint ? `<div class="hint">${t(hint)}</div>` : ''}</div>`;
  const radio = (v, text, note) => `<label class="card as-choice" data-choice="${v}" style="padding:10px 12px;display:flex;gap:10px;cursor:pointer;align-items:flex-start"><input type="radio" name="as-level" value="${v}" ${choice === v ? 'checked' : ''} style="margin-top:3px"><div><div class="strong">${t(LEVEL_NAME[v])}</div><div class="small muted">${t(note)}</div></div></label>`;
  const body = `<div class="stack">
    ${accounts.length > 1 || (mode === 'connect' && provider === 'gmail') ? `<div class="field"><label for="as-account">${t('Which Google account')}</label><select id="as-account">${accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.email || t('This sign-in'))}</option>`).join('')}${provider === 'gmail' ? `<option value="new">${t('Another Google account…')}</option>` : ''}</select></div>` : ''}
    <div><div class="strong" style="margin-bottom:6px">${t('What may WhisperBrain do?')}</div><div class="stack tight">
      ${levels.map((l) => radio(l, LEVEL_NAME[l], l === 'none' ? LEVEL_NOTE.none : P.levels[l])).join('')}
      ${P.actions.length ? radio('actions', LEVEL_NAME.actions, 'Read, and also propose actions. Each one waits for your approval in the Inbox, with its exact text; nothing is ever done by itself.') : ''}
    </div></div>
    <div id="as-actions" ${choice === 'actions' ? '' : 'hidden'}><div class="strong" style="margin-bottom:6px">${t('Which actions may it propose?')}</div>
      <div class="field"><label for="as-readfor">${t('And what may it read?')}</label><select id="as-readfor">${Object.keys(P.levels).map((l) => `<option value="${l}" ${(cur.readLevel === l || (!P.levels[cur.readLevel] && l === 'part')) ? 'selected' : ''}>${t(LEVEL_NAME[l])}</option>`).join('')}</select></div>
      <div class="stack tight">${P.actions.map(([k, label, note]) => `<label class="row" style="gap:8px;align-items:flex-start"><input type="checkbox" class="as-act" value="${k}" ${sel.has(k) ? 'checked' : ''} style="margin-top:3px"><span><span class="strong small">${t(label)}</span>${note ? `<span class="xsmall muted" style="display:block">${t(note)}</span>` : ''}</span></label>`).join('')}</div></div>
    <div id="as-filter" ${['part', 'actions', 'metadata'].includes(choice) ? '' : 'hidden'}>
      ${P.filterFields.length || P.toggles ? `<div class="strong" style="margin-bottom:6px">${t('Which part?')}</div>` : ''}
      ${P.filterFields.map(fieldHtml).join('')}
      ${(P.toggles || []).map(([key, where, label, def]) => `<label class="row" style="gap:8px;align-items:center"><input type="checkbox" id="as-${key}" data-where="${where}" ${(nv(key, where) ?? def) ? 'checked' : ''}> <span class="small">${t(label)}</span></label>`).join('')}
    </div>
    ${P.never ? `<details ${f.never && Object.values(f.never).some((v) => list(v).length) ? 'open' : ''}><summary class="strong">${t('Never read')}</summary>
      <div class="hint" style="margin:4px 0 8px">${t('HR, legal, medical… Whatever matches is left out, before anything is stored.')}</div>
      <div class="formgrid">${[['senders', 'Senders', 'boss@acme.io'], ['domains', 'Domains', 'clinic.pt'], ['labels', 'Labels', 'HR, Medical'], ['keywords', 'Words in the subject', 'salary, diagnosis']].map(([k, l, ph]) => `<div class="field"><label for="as-never-${k}">${t(l)}</label><input id="as-never-${k}" value="${esc(list(f.never?.[k]).join(', '))}" placeholder="${esc(ph)}" autocomplete="off"></div>`).join('')}</div></details>` : ''}
    <div class="field"><label for="as-reach">${t('May an AI see it?')}</label><select id="as-reach">
      <option value="local" ${cur.aiReach === 'local' ? 'selected' : ''}>${t('Only an AI on this computer')}</option>
      <option value="ask" ${cur.aiReach === 'ask' ? 'selected' : ''}>${t('Ask me each time')}</option>
      <option value="any" ${cur.aiReach === 'any' ? 'selected' : ''}>${t('Any AI server I chose')}</option></select>
      <div class="hint">${esc(reachNote())}</div></div>
    ${P.live ? `<label class="row" style="gap:8px;align-items:flex-start"><input type="checkbox" id="as-live" ${cur.liveSearch ? 'checked' : ''} style="margin-top:3px"><span><span class="strong small">${t('Live search')}</span><span class="xsmall muted" style="display:block">${t(P.live)}</span></span></label>` : ''}
    <label class="row" style="gap:8px;align-items:flex-start"><input type="checkbox" id="as-mcp" ${cur.mcp ? 'checked' : ''} style="margin-top:3px"><span><span class="strong small">${t('Let other tools read it over MCP')}</span><span class="xsmall muted" style="display:block">${t('Claude Desktop, Cursor… Only when “any AI server” is chosen above, and never while the app is locked.')}</span></span></label>
    <details><summary class="strong">${t('More')}</summary><div class="formgrid mt-s">
      <div class="field"><label for="as-keep">${t('Keep results opened from a live search')}</label><select id="as-keep">${[1, 7, 30].map((d) => `<option value="${d}" ${Number(cur.retentionDays) === d ? 'selected' : ''}>${t('{n} days', { n: d })}</option>`).join('')}</select></div>
      <div class="field"><label for="as-expiry">${t('This access ends')}</label><select id="as-expiry"><option value="">${t('Never')}</option>${[7, 30, 90].map((d) => `<option value="${d}">${t('In {n} days', { n: d })}</option>`).join('')}${cur.expiresAt ? `<option value="keep" selected>${t('As set')}</option>` : ''}</select></div></div></details>
    ${provider === 'gmail' ? `<div class="banner small" id="as-estimate" hidden>${icon('clock')}<div class="grow" id="as-estimate-text"></div></div><div class="xsmall muted" id="as-google">${t('Google is asked for exactly what this needs and nothing more. Changing it later means signing in again.')}</div>` : ''}
    <div class="small" id="as-msg" style="color:var(--danger)"></div></div>`;
  return modal({
    title: title || t('What may WhisperBrain do with {name}?', { name: P.name }), wide: true, body,
    foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" data-ok>${mode === 'connect' ? t('Continue') : t('Save')}</button>`,
    onMount: (d, close) => {
      const sync = () => {
        choice = d.querySelector('input[name="as-level"]:checked')?.value || choice;
        d.querySelector('#as-actions').hidden = choice !== 'actions';
        d.querySelector('#as-filter').hidden = !['part', 'actions', 'metadata'].includes(choice);
        for (const el of d.querySelectorAll('.as-choice')) el.style.outline = el.dataset.choice === choice ? '2px solid var(--accent)' : '';
        const est = d.querySelector('#as-estimate');
        const all = choice === 'all' || (choice === 'actions' && val(d, 'as-readfor') === 'all');
        if (est && provider === 'gmail') {
          est.hidden = !all;
          if (all && !est.dataset.done) {
            est.dataset.done = '1';
            d.querySelector('#as-estimate-text').textContent = t('Working out how big the mailbox is…');
            api('POST', '/api/access/estimate', { service: 'gmail', config: { account: val(d, 'as-account') && val(d, 'as-account') !== 'new' ? val(d, 'as-account') : undefined } })
              .then((e) => { d.querySelector('#as-estimate-text').textContent = t('About {threads} conversations: roughly {mb} MB here and {h} hours the first time, in the background, newest first. Only the last 12 months are searched by meaning; the rest by words.', { threads: e.threads.toLocaleString(), mb: e.megabytes, h: e.hours }); })
              .catch(() => { d.querySelector('#as-estimate-text').textContent = t('This can be big: a large mailbox takes hours the first time, in the background, newest first.'); });
          }
        }
      };
      d.addEventListener('change', sync); sync();
      d.querySelector('[data-ok]').onclick = () => {
        try {
          const level = choice === 'actions' ? val(d, 'as-readfor') || 'part' : choice;
          const actions = choice === 'actions' ? [...d.querySelectorAll('.as-act:checked')].map((x) => x.value) : [];
          if (choice === 'actions' && !actions.length) { d.querySelector('#as-msg').textContent = t('Tick at least one action, or choose a read level.'); return; }
          const filter = {}, config = {};
          for (const [key, where] of [...P.filterFields.map(([k, w]) => [k, w]), ...(P.toggles || []).map(([k, w]) => [k, w])]) {
            const el = d.querySelector(`#as-${key}`);
            if (!el) continue;
            const v = el.type === 'checkbox' ? el.checked : (['query'].includes(key) ? el.value.trim() : list(el.value));
            (where === 'config' ? config : filter)[key] = v;
          }
          if (P.never) filter.never = Object.fromEntries(['senders', 'domains', 'labels', 'keywords'].map((k) => [k, list(val(d, `as-never-${k}`))]));
          const days = val(d, 'as-expiry');
          const grant = { readLevel: level, filter: { ...(current.filter || {}), ...filter }, actions, aiReach: val(d, 'as-reach'), liveSearch: chk(d, 'as-live'), mcp: chk(d, 'as-mcp'), retentionDays: Number(val(d, 'as-keep')) || 7 };
          if (days === 'keep') grant.expiresAt = cur.expiresAt; else grant.expiresAt = days ? Date.now() + Number(days) * 86_400_000 : null;
          close({ grant, config, account: val(d, 'as-account') || undefined });
        } catch (e) { fail(e); }
      };
    },
  });
}

// A line saying what a source is allowed, for cards and the Access page
export function grantSummary(s) {
  const lvl = s.actions?.length && s.readLevel !== 'none' ? `${t(LEVEL_NAME[s.readLevel])} + ${t('actions')}` : t(LEVEL_NAME[s.readLevel] || s.readLevel);
  const reach = { local: t('only an AI on this computer'), ask: t('ask each time'), any: t('any AI server') }[s.aiReach] || '';
  return `${lvl} · ${reach}${s.liveSearch ? ` · ${t('live search')}` : ''}${s.mcp ? ' · MCP' : ''}`;
}

// Sign in to Google for what a grant needs (level and actions decide the permissions asked for). Resolves when the browser sign-in is done
// ({ type: 'google.connected', data } or 'google.error'), or after five minutes. account: 'primary' | an account id | 'new'.
export async function connectGoogle({ account = 'primary', level = 'part', actions = [] } = {}) {
  const r = await api('POST', '/api/google/connect', { gmail: true, level, actions, account });
  if (!r.opened && r.authUrl) window.open(r.authUrl, '_blank', 'noopener');
  return new Promise((resolve) => {
    const end = (v) => { window.removeEventListener('wb:event', h); clearTimeout(timer); resolve(v); };
    const h = (e) => { if (['google.connected', 'google.error'].includes(e.detail?.type)) end(e.detail); };
    const timer = setTimeout(() => end({ type: 'timeout' }), 5 * 60_000);
    window.addEventListener('wb:event', h);
  });
}

// the Google permissions in words a person reads
export const scopeWords = (scopes = []) => scopes.map((s) => ({ metadata: t('who and when only'), readonly: t('read mail'), compose: t('write drafts and send'), modify: t('read, label, archive, write and send'), send: t('send') }[String(s).split('gmail.')[1]] || s)).join(', ');
