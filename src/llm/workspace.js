'use strict';
// Everything Ask AI can draw on besides meeting text and document excerpts: action items, decisions and promises, people,
// projects, topics, glossary terms, calendar events and the newest documents of a connected source ("my latest e-mails").
// Each comes back as a short record the answer can cite as [n], with what the UI needs to open it.
//
// A record is picked when the question names it (a person, project, topic or term, by whole words) or asks for that kind
// of thing ("open tasks", "what did we decide", "what do I owe", "my calendar", "latest e-mails"). Nothing is guessed:
// a question that names none of them gets no records. Every store is optional, so a smaller setup (tests, older data)
// simply has fewer kinds.

const DAY = 86400000;
const MAX_RECORDS = 30;
const TEXT_MAX = 420;

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// whole words of `name` appear in the folded question (names shorter than 3 letters never match: too many false hits)
const named = (fq, name) => { const n = fold(name).trim(); return n.length >= 3 && new RegExp(`(?:^|[^\\p{L}\\p{N}])${esc(n)}(?:$|[^\\p{L}\\p{N}])`, 'u').test(fq); };
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
const clip = (s, n = TEXT_MAX) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// What kind of thing a question asks for (English and Portuguese, accents folded)
const WANTS = {
  actions: /\b(action items?|tasks?|to-?dos?|follow-?ups?|next steps?|tarefas?|pendentes?|a fazer|acoes|proximos passos)\b/,
  decisions: /\b(decid\w*|decisions?|decisao|decisoes|agreed|acordamos|combinamos)\b/,
  promises: /\b(promis\w*|commit\w*|owe[sd]?|owing|prometi\w*|promet\w*|promessas?|compromissos?|devo|devem|deve-me|me devem)\b/,
  topics: /\b(topics?|themes?|subjects?|topicos?|temas?|assuntos?)\b/,
  projects: /\b(projects?|projetos?|projectos?)\b/,
  calendar: /\b(calendar|agenda|schedule[d]?|upcoming|tomorrow|next (?:meeting|call|week)|calendario|amanha|marcad[ao]s?|proxim[ao]s? (?:reuni\w*|chamadas?|semana))\b/,
};
// A connected source named in the question -> the source kinds it means
const SOURCE_WORDS = [
  [/\b(e-?mails?|gmail|mail|inbox|correio)\b/, ['gmail']],
  [/\bslack\b/, ['slack']],
  [/\b(github|issues?|pull requests?|prs?)\b/, ['github']],
  [/\bdiscord\b/, ['discord', 'discord-export']],
  [/\bnotion\b/, ['notion']],
  [/\blinear\b/, ['linear']],
  [/\b(documents?|docs|files?|pdfs?|folders?|documentos?|ficheiros?|arquivos?|pastas?)\b/, ['folder']],
];

// -> [{ kind, id, title, text, at, noteId?, segmentId?, startMs?, key?, uri?, source? }]
// ws: { notes, knowledge, assertions, projects, items, entities, calendar, mayShare }; scope: from chatScope (when/terms)
async function workspaceRecords(question, ws = {}, { scope = {}, now = Date.now() } = {}) {
  const fq = fold(question);
  const terms = fold(scope.terms || '').split(/\s+/).filter((w) => w.length >= 4);
  const inWhen = (ms) => !scope.when || (ms >= scope.when.from && ms < scope.when.to);
  const mayShare = ws.mayShare || (() => true);
  const out = [];
  const seen = new Set();
  // a record that comes from a meeting kept on this computer (an import marked local) never goes to an AI server that is not (src/access/grants.js)
  const fromOk = (noteId) => !noteId || mayShare('note', noteId);
  const add = (r) => { const k = `${r.kind}:${r.id}`; if (seen.has(k) || out.length >= MAX_RECORDS || !fromOk(r.noteId)) return; seen.add(k); out.push(r); };
  const safe = (fn) => { try { return fn(); } catch { return []; } };
  const k = ws.knowledge;

  // Glossary terms the question uses
  if (k?.glossary) {
    for (const g of safe(() => k.glossary())) {
      if ([g.term, ...(g.aliases || [])].some((n) => named(fq, n))) add({ kind: 'term', id: g.id, title: g.term, text: clip(g.definition || 'no definition yet') });
    }
  }

  // People: named in the question; with their open promises
  let people = [];
  if (ws.entities?.list) {
    const all = safe(() => ws.entities.list());
    people = all.filter((p) => named(fq, p.name) || (p.name.split(/\s+/)[0].length >= 3 && named(fq, p.name.split(/\s+/)[0]) && all.filter((o) => fold(o.name.split(/\s+/)[0]) === fold(p.name.split(/\s+/)[0])).length === 1)).slice(0, 3);
    const open = people.length && ws.assertions ? safe(() => ws.assertions.list({ state: 'accepted', kind: 'commitment', limit: 300 })).filter((a) => fromOk(a.noteId)) : [];
    for (const p of people) {
      const theirs = open.filter((a) => a.owner?.id === p.id || a.to?.id === p.id).slice(0, 5);
      const promise = theirs.map((a) => `${a.owner?.id === p.id ? 'owes' : 'is owed'}: ${clip(a.text, 120)}${a.dueAt ? ` (due ${day(a.dueAt)})` : ''}`).join('; ');
      add({ kind: 'person', id: p.id, key: p.key, title: p.name, at: p.lastAt,
        text: clip(`in ${p.meetings} meeting${p.meetings === 1 ? '' : 's'}${p.lastAt ? `, last on ${day(p.lastAt)}` : ''}${p.emails?.length ? `; e-mail ${p.emails.join(', ')}` : ''}${p.isMe ? '; this is the user' : ''}${promise ? `; open promises — ${promise}` : ''}`) });
    }
  }

  // Projects: named in the question (by name or one of their keywords), or asked for as a list
  if (ws.projects?.rows) {
    const rows = safe(() => ws.projects.rows());
    const hit = rows.filter((p) => named(fq, p.name) || (p.keywords || []).some((kw) => named(fq, kw)));
    const list = hit.length ? hit.slice(0, 3) : WANTS.projects.test(fq) ? rows.slice(0, 8) : [];
    for (const p of list) {
      let text;
      if (hit.length) {
        const m = safe(() => ws.projects.members(p));
        m.meetings = (m.meetings || []).filter((n) => fromOk(n.id));
        m.decisions = (m.decisions || []).filter((d) => fromOk(d.noteId));
        m.promises = (m.promises || []).filter((d) => fromOk(d.noteId));
        text = [m.meetings?.length && `meetings: ${m.meetings.slice(0, 5).map((n) => `${n.title || 'untitled'} (${day(n.startedAt || n.createdAt)})`).join(', ')}`,
          m.docs?.length && `documents: ${m.docs.filter((d) => mayShare('item', d.id)).slice(0, 5).map((d) => d.title || 'untitled').join(', ')}`,
          m.decisions?.length && `decisions: ${m.decisions.slice(0, 5).map((d) => clip(d.text, 100)).join('; ')}`,
          m.promises?.length && `open promises: ${m.promises.slice(0, 5).map((d) => clip(d.text, 100)).join('; ')}`].filter(Boolean).join(' | ');
      }
      add({ kind: 'project', id: p.id, title: p.name, text: clip(text || `keywords: ${(p.keywords || []).join(', ')}`, 700) });
    }
  }

  // Topics: named in the question, or asked for ("which topics keep coming up?")
  if (k?.topics) {
    const rows = safe(() => k.topics({ limit: 300 }));
    const hit = rows.filter((tp) => named(fq, tp.name));
    const list = hit.length ? hit.slice(0, 4) : WANTS.topics.test(fq) ? rows.slice(0, 10) : [];
    for (const tp of list) add({ kind: 'topic', id: tp.id, title: tp.name, at: tp.lastAt, text: clip(`${tp.description ? `${tp.description} — ` : ''}in ${tp.notes} meeting${tp.notes === 1 ? '' : 's'}${tp.lastAt ? `, last on ${day(tp.lastAt)}` : ''}`) });
  }

  // Action items: all open ones when asked for; else the ones whose text has the question's words; or those of a named person
  if (k?.actionItems) {
    let list = [];
    if (WANTS.actions.test(fq)) list = safe(() => k.actionItems({ done: false, limit: 60 }));
    else if (terms.length) for (const w of terms.slice(0, 4)) list.push(...safe(() => k.actionItems({ q: w, limit: 8 })));
    for (const p of people) list.push(...safe(() => k.actionItems({ owner: p.name.split(/\s+/)[0], done: false, limit: 8 })));
    for (const a of list.filter((x) => inWhen(x.noteAt || x.createdAt)).slice(0, 15)) {
      add({ kind: 'action', id: a.id, noteId: a.noteId, title: clip(a.text, 70), at: a.noteAt,
        text: clip(`${a.done ? '[done] ' : '[open] '}${a.text}${a.owner ? ` — owner ${a.owner}` : ''}${a.due ? `, due ${a.due}` : ''}; from the meeting “${a.noteTitle || 'untitled'}”`) });
    }
  }

  // Decisions and promises (accepted ones are facts; suggested ones are marked as not confirmed yet)
  if (ws.assertions?.list) {
    const kinds = [WANTS.decisions.test(fq) && 'decision', WANTS.promises.test(fq) && 'commitment'].filter(Boolean);
    let list = [];
    for (const kind of kinds) list.push(...safe(() => ws.assertions.list({ kind, state: ['accepted', 'suggested'], limit: 80 })));
    if (!kinds.length && terms.length) {
      const re = new RegExp(terms.map(esc).join('|'), 'u');
      list = safe(() => ws.assertions.list({ state: ['accepted', 'suggested'], limit: 300 })).filter((a) => re.test(fold(a.text)));
    }
    for (const a of list.filter((x) => inWhen(x.occurredAt || x.createdAt)).slice(0, 12)) {
      const meeting = a.noteId && ws.notes?.get ? ws.notes.get(a.noteId) : null;
      const who = a.kind === 'commitment' ? ` — ${a.owner?.name || 'someone'} owes ${a.to?.name || 'it'}${a.dueAt ? `, due ${day(a.dueAt)}` : a.dueText ? `, ${a.dueText}` : ''}` : '';
      add({ kind: a.kind, id: a.id, noteId: a.noteId, segmentId: a.segmentId, startMs: a.startMs, at: a.occurredAt || a.createdAt,
        title: clip(a.text, 70),
        text: clip(`${a.state === 'suggested' ? '(suggested, not confirmed yet) ' : ''}${a.text}${who}${a.quote ? ` — “${clip(a.quote, 140)}”` : ''}${a.noteId ? `; from the meeting “${meeting?.title || 'untitled'}”` : ''}`) });
    }
  }

  // Calendar: the next 7 days (or the period the question names) when asked
  if (ws.calendar?.events && (WANTS.calendar.test(fq) || (scope.when && /\b(meetings?|calls?|events?|reunioes?|reuniao|eventos?|chamadas?)\b/.test(fq) && scope.when.to > now))) {
    const from = scope.when && scope.when.to > now ? Math.max(scope.when.from, now - DAY) : now - 3600000;
    const to = scope.when && scope.when.to > now ? scope.when.to : now + 7 * DAY;
    let events = [];
    try {
      const timeout = new Promise((r) => { const t = setTimeout(() => r({ events: [] }), 4000); t.unref?.(); });
      events = (await Promise.race([ws.calendar.events({ from, to }), timeout]))?.events || [];
    } catch { events = []; }
    for (const e of events.slice(0, 12)) {
      const at = new Date(e.start);
      const time = e.allDay ? 'all day' : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
      const who = (e.attendees || []).map((a) => a.name || a.email).filter(Boolean).slice(0, 6).join(', ');
      add({ kind: 'event', id: e.id || `${e.uid}:${e.start}`, title: e.summary || '(no title)', at: e.start,
        text: clip(`${day(e.start)} ${time}${e.location ? `, ${e.location}` : ''}${who ? `; with ${who}` : ''}${e.description ? `; ${e.description}` : ''}`) });
    }
  }

  // The newest documents of a source the question names ("my latest e-mails", "what's new in Slack?")
  if (ws.items?.list && ws.items?.sources) {
    const kinds = SOURCE_WORDS.filter(([re]) => re.test(fq)).flatMap(([, ks]) => ks);
    if (kinds.length) {
      for (const src of safe(() => ws.items.sources()).filter((s) => kinds.includes(s.kind))) {
        // the words left once the ones that only name the source or ask for a kind of thing are gone; nothing found with them -> the newest
        const what = terms.filter((w) => !SOURCE_WORDS.some(([re]) => re.test(w)) && !Object.values(WANTS).some((re) => re.test(w)) && !/^(latest|newest|recent|ultim\w*|recentes?|novos?|new)$/.test(w));
        let rows = what.length ? safe(() => ws.items.list({ sourceId: src.id, q: what.join(' '), limit: 12 })) : [];
        if (!rows.length) rows = safe(() => ws.items.list({ sourceId: src.id, limit: 12 }));
        for (const it of rows.filter((r) => inWhen(r.occurredAt) && mayShare('item', r.id)).slice(0, 6)) {
          add({ kind: 'item', id: it.id, title: it.title || 'untitled', at: it.occurredAt, uri: it.uri || undefined, source: src.name || src.kind, text: clip(it.snippet || it.preview || '') });
        }
      }
    }
  }
  return out;
}

// One line telling the AI what is connected, so a question about e-mail with no e-mail source gets "Gmail is not connected"
// rather than "I found nothing". -> '' when the question names no kind of source.
const SOURCE_NAMES = { gmail: 'e-mail (Gmail)', slack: 'Slack', github: 'GitHub', discord: 'Discord', 'discord-export': 'Discord', notion: 'Notion', linear: 'Linear', folder: 'documents from a folder' };
function sourceCoverage(question, ws = {}) {
  const fq = fold(question);
  const asked = [...new Set(SOURCE_WORDS.filter(([re]) => re.test(fq)).flatMap(([, ks]) => ks))];
  if (!asked.length || !ws.items?.sources) return '';
  let all = [];
  try { all = ws.items.sources().filter((s) => s.kind !== 'native' && s.enabled !== false); } catch { return ''; }
  const have = all.map((s) => `${s.name || SOURCE_NAMES[s.kind] || s.kind} (${s.items || 0} item${s.items === 1 ? '' : 's'})`);
  const missing = [...new Set(asked.filter((k) => !all.some((s) => s.kind === k)).map((k) => SOURCE_NAMES[k]))];
  return [`Connected sources: ${have.length ? have.join(', ') : 'none besides meetings'}.`,
    missing.length && `Not connected: ${missing.join(', ')}. If the question needs it, say plainly that it is not connected to WhisperBrain yet and can be added in Integrations; do not pretend to have read it.`].filter(Boolean).join(' ');
}

const LABEL = { note: 'Meeting', item: 'Document', action: 'Action item', decision: 'Decision', commitment: 'Promise', person: 'Person', project: 'Project', topic: 'Topic', term: 'Glossary term', event: 'Calendar event' };

module.exports = { workspaceRecords, sourceCoverage, LABEL, WANTS, fold, named };
