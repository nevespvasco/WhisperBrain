'use strict';
// What can be done in Gmail, always as a proposal that waits for a person's approval with the exact text (src/brain/actions.js):
//   gmail.draft    a reply (or a new message) written into Gmail's Drafts; the person sends it from Gmail
//   gmail.send     sends exactly the text that was shown (the approved message itself, not a draft that could be edited meanwhile)
//   gmail.label    adds / removes labels on threads (one proposal for many threads)
//   gmail.archive  takes threads out of the Inbox
//   gmail.markRead marks threads read
// Which Google permission each needs is in src/access/gmail-scopes.js; whether the SOURCE may do it is its grant (can(source, 'action.<kind>')).
const { covers, ACTION_SCOPE } = require('../access/gmail-scopes');
const { can } = require('../access/grants');

const err = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (s) => String(s ?? '').replace(/\r/g, '').trim();
const addr = (s) => (/<([^>]+)>/.exec(String(s))?.[1] || String(s)).trim().toLowerCase();
const isMail = (s) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s);
const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const wrap = (b64) => b64.replace(/(.{76})/g, '$1\r\n');

// The message as Gmail takes it: RFC 5322 headers, a UTF-8 text body, replying inside the thread when it is a reply.
function buildRaw({ from, to, cc = [], subject, body, inReplyTo = '', references = [] }) {
  const lines = [
    `From: ${from}`, `To: ${to.join(', ')}`, ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []), `Subject: ${encodeWord(String(subject).replace(/[\r\n]+/g, ' '))}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${[...references, inReplyTo].join(' ')}`] : []),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    wrap(Buffer.from(String(body).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64')),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

// The raw message that would go is the one the shown fields describe: its To line and its text are the ones on the proposal
function rawMatches(args) {
  const text = Buffer.from(String(args.raw), 'base64url').toString('utf8');
  const [head, ...rest] = text.split('\r\n\r\n');
  const to = (/^To: (.*)$/m.exec(head)?.[1] || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const body = Buffer.from(rest.join('\r\n\r\n').replace(/\s+/g, ''), 'base64').toString('utf8').replace(/\r\n/g, '\n');
  return to.join(',') === args.to.join(',') && body === String(args.body).replace(/\r?\n/g, '\n');
}

function gmailSource(deps, input) {
  const item = input.itemId ? deps.items.item(input.itemId) : null;
  if (input.itemId && !item) throw err('That thread is gone.', 404);
  const source = deps.items.source(item ? item.sourceId : input.sourceId);
  if (!source || source.kind !== 'gmail') throw err('Choose a Gmail source.');
  return { item, source };
}

function needScope(kind, source, deps) {
  const g = deps.googleAccounts.forSource(source);
  const need = ACTION_SCOPE[kind];
  if (!g || !covers(g.grantedScopes?.(), need)) throw err(`Google was not asked for this permission yet: reconnect the account with “${kind.replace('gmail.', '')}” ticked in Access.`, 412);
  return g;
}

// ready: a Gmail source exists. Whether its grant allows this action, and whether Google was asked for the permission, are checked when the
// proposal is made, each with a message that says what to do.
const readyFor = () => (deps) => deps.items.sources().some((s) => s.kind === 'gmail');

function messageBuilder(kind, verb) {
  return (input, deps) => {
    const { item, source } = gmailSource(deps, input);
    needScope(kind, source, deps);
    const meta = item?.meta || {};
    const me = String(deps.googleAccounts.forSource(source)?.config().email || '').toLowerCase();
    const body = clean(input.body);
    if (!body) throw err('Write the message first.');
    const people = (meta.people || []).filter((e) => e !== me);
    const to = (Array.isArray(input.to) && input.to.length ? input.to : item ? [meta.lastFromMe ? (people.find((e) => e !== me) || '') : meta.lastFrom || ''] : []).map(addr).filter(Boolean);
    const cc = (Array.isArray(input.cc) ? input.cc : []).map(addr).filter(Boolean);
    if (!to.length || [...to, ...cc].some((e) => !isMail(e))) throw err('Who is it to? Every address must be a valid e-mail address.');
    const subject = clean(input.subject) || (item ? (/^re:/i.test(meta.subject || item.title) ? (meta.subject || item.title) : `Re: ${meta.subject || item.title}`) : '');
    if (!subject) throw err('A new message needs a subject.');
    const raw = buildRaw({ from: me, to, cc, subject, body, inReplyTo: item ? meta.lastMessageId || '' : '', references: item ? meta.references || [] : [] });
    return {
      title: `${verb} ${item ? 'a reply' : 'a message'} to ${[...to, ...cc].join(', ')}: “${subject.slice(0, 80)}”`,
      args: { sourceId: source.id, account: source.config?.account || 'primary', threadId: item ? meta.gmailThreadId || String(item.externalId).replace(/^thread:/, '') : undefined, to, cc, subject, body, raw },
      outbound: { recipients: [...to, ...cc], text: body },
      context: { people: meta.people || [], text: item ? item.text || '' : '', sourceId: source.id },
    };
  };
}

const HANDLERS = {
  'gmail.draft': {
    label: 'Gmail', provider: 'gmail', ready: readyFor('gmail.draft'),
    build: messageBuilder('gmail.draft', 'Write a draft'),
    async run(args, deps) {
      const g = deps.googleAccounts.forSource(deps.items.source(args.sourceId));
      const d = await g.gmail('/users/me/drafts', {}, { method: 'POST', body: { message: { raw: args.raw, ...(args.threadId ? { threadId: args.threadId } : {}) } } });
      return { draftId: d.id, url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(g.config().email)}#drafts` };
    },
  },
  'gmail.send': {
    label: 'Gmail', provider: 'gmail', ready: readyFor('gmail.send'),
    build: messageBuilder('gmail.send', 'Send'),
    // the approved message itself is what goes: there is no draft in between that could be edited after approval
    async run(args, deps) {
      if (!rawMatches(args)) throw err('The message does not match what was approved.', 409);
      const g = deps.googleAccounts.forSource(deps.items.source(args.sourceId));
      const m = await g.gmail('/users/me/messages/send', {}, { method: 'POST', body: { raw: args.raw, ...(args.threadId ? { threadId: args.threadId } : {}) } });
      return { messageId: m.id, threadId: m.threadId };
    },
  },
};

// labels / archive / mark read: input { sourceId | itemIds[], add[], remove[], create }
function threadsOf(input, deps) {
  const ids = Array.isArray(input.itemIds) ? input.itemIds : input.itemId ? [input.itemId] : [];
  if (!ids.length) throw err('Choose the threads first.');
  const rows = ids.slice(0, 200).map((id) => deps.items.item(id)).filter(Boolean);
  const sourceIds = [...new Set(rows.map((r) => r.sourceId))];
  if (sourceIds.length !== 1) throw err('Choose threads from one Gmail source.');
  return { rows, source: deps.items.source(sourceIds[0]) };
}
function modifier(kind, label, add, remove) {
  return {
    label: 'Gmail', provider: 'gmail', ready: readyFor(kind),
    build(input, deps) {
      const { rows, source } = threadsOf(input, deps);
      if (source.kind !== 'gmail') throw err('Choose Gmail threads.');
      needScope(kind, source, deps);
      const a = (add || input.add || []).map(String), r = (remove || input.remove || []).map(String);
      if (!a.length && !r.length) throw err('Which labels?');
      const threads = rows.map((it) => ({ id: it.meta?.gmailThreadId || String(it.externalId).replace(/^thread:/, ''), title: it.title }));
      return { title: `${label(a, r)} on ${threads.length} thread${threads.length === 1 ? '' : 's'}${threads.length === 1 ? `: “${threads[0].title.slice(0, 80)}”` : ''}`, args: { sourceId: source.id, threads, add: a, remove: r, create: !!input.create } };
    },
    async run(args, deps) {
      const g = deps.googleAccounts.forSource(deps.items.source(args.sourceId));
      const SYSTEM = new Set(['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'SPAM', 'TRASH']);
      const known = new Map(((await g.gmail('/users/me/labels')).labels || []).map((l) => [l.name.toLowerCase(), l.id]));
      const id = async (name) => {
        if (SYSTEM.has(name)) return name;
        if (known.has(name.toLowerCase())) return known.get(name.toLowerCase());
        if (!args.create) throw err(`There is no label “${name}” in Gmail.`);
        const made = await g.gmail('/users/me/labels', {}, { method: 'POST', body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
        known.set(name.toLowerCase(), made.id);
        return made.id;
      };
      const addLabelIds = await Promise.all(args.add.map(id)), removeLabelIds = await Promise.all(args.remove.map(id));
      let done = 0;
      for (const t of args.threads) { await g.gmail(`/users/me/threads/${t.id}/modify`, {}, { method: 'POST', body: { addLabelIds, removeLabelIds } }); done++; }
      return { threads: done };
    },
  };
}
HANDLERS['gmail.label'] = modifier('gmail.label', (a, r) => `${a.length ? `Add ${a.join(', ')}` : ''}${a.length && r.length ? ' and ' : ''}${r.length ? `remove ${r.join(', ')}` : ''}`.replace(/^./, (c) => c.toUpperCase()), null, null);
HANDLERS['gmail.archive'] = modifier('gmail.archive', () => 'Archive (take out of the Inbox)', [], ['INBOX']);
HANDLERS['gmail.markRead'] = modifier('gmail.markRead', () => 'Mark as read', [], ['UNREAD']);

module.exports = { HANDLERS, buildRaw };
