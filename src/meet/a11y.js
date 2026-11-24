'use strict';
// Reads a meeting window off the accessibility tree of a browser (pure: no I/O, no OS).
//
// A native helper (native/*) prints the page of the browser window as a flat list of nodes { p: parent index, r: role,
// n: name, a: attributes, s: states }. This module turns that into "who is on the call and who is speaking", with
// selectors written as data (selectors/meet.json) so that a change of the meeting page is fixed by editing a file.
//
// What the trees of Chromium look like, measured: divs with no meaning are left out (the box around a participant's tile
// is not there), so the name, the speaking indicator and the like are siblings; only role, name, class, tag, id and a few
// states reach the tree, never data-* attributes. Hence the "group" modes below.
const { cleanName, nameKey } = require('./protocol');
const { role } = require('./roles');

// matcher: { role?, name?, attr?: { key: regex }, state?: [..], not?: matcher } — every part given must match.
// Regular expressions are case-insensitive and unanchored (write ^ and $ to anchor).
function compileMatcher(m) {
  if (m == null) return null;
  if (typeof m !== 'object') throw new Error('a matcher must be an object');
  const re = (s) => new RegExp(s, 'iu');
  return {
    role: m.role != null ? re(m.role) : null,
    name: m.name != null ? re(m.name) : null,
    attr: Object.entries(m.attr || {}).map(([k, v]) => [k, re(v)]),
    state: m.state || [],
    not: m.not ? compileMatcher(m.not) : null,
  };
}

function matches(c, node) {
  if (!c) return true;
  if (c.role && !c.role.test(node.r || '')) return false;
  if (c.name && !c.name.test(node.n || '')) return false;
  for (const [k, re] of c.attr) if (!re.test(String(node.a?.[k] ?? ''))) return false;
  for (const s of c.state) if (!node.s?.includes(s)) return false;
  if (c.not && matches(c.not, node)) return false;
  return true;
}

const GROUPS = new Set(['following', 'parent', 'siblings']);

function compileSelectors(json) {
  if (!json || json.version !== 1) throw new Error('selectors: version 1 expected');
  const p = json.participants || {};
  const group = p.group || 'following';
  if (!GROUPS.has(group) && !/^ancestor:[1-4]$/.test(group)) throw new Error(`selectors: unknown group "${group}"`);
  return {
    verified: !!json.verified,
    title: json.window?.title ? new RegExp(json.window.title, 'iu') : null,
    code: json.window?.code ? new RegExp(json.window.code, 'iu') : /([a-z]{3}-[a-z]{4}-[a-z]{3})/i,
    scope: compileMatcher(p.scope),
    name: compileMatcher(p.name) || compileMatcher({ role: '^(?:static|text)$' }),
    group,
    speaking: compileMatcher(p.speaking),
    self: compileMatcher(p.self),
    nameFrom: p.nameFrom || 'name',
  };
}

// Rebuilds the tree from the flat list: nodes[i].kids = indexes of children, in order. platform: where the tree came from;
// roles are put in the common vocabulary (roles.js).
function buildTree(nodes, platform = 'linux') {
  const t = nodes.map((n, i) => ({ ...n, r: role(platform, n), i, kids: [] }));
  for (const n of t) if (n.p >= 0 && t[n.p]) t[n.p].kids.push(n.i);
  return t;
}

function* descendants(t, i) {
  for (const k of t[i].kids) { yield t[k]; yield* descendants(t, k); }
}

// The nodes that belong to the participant whose name node is `n`.
function groupOf(t, n, sel) {
  const parent = n.p >= 0 ? t[n.p] : null;
  if (sel.group === 'parent' || /^ancestor:/.test(sel.group)) {
    let up = sel.group === 'parent' ? 1 : Number(sel.group.split(':')[1]);
    let top = n;
    while (up-- > 0 && top.p >= 0) top = t[top.p];
    return [...descendants(t, top.i)].filter((x) => x.i !== n.i);
  }
  if (!parent) return [];
  const sibs = parent.kids;
  const at = sibs.indexOf(n.i);
  if (sel.group === 'siblings') return sibs.filter((k) => k !== n.i).flatMap((k) => [t[k], ...descendants(t, k)]);
  // following: the siblings after the name, up to the next name
  const out = [];
  for (let k = at + 1; k < sibs.length; k++) {
    const s = t[sibs[k]];
    if (matches(sel.name, s) && (s.n || '').trim()) break;
    out.push(s, ...descendants(t, s.i));
  }
  return out;
}

// -> { title, code, participants: [{ name, self, speaking }], speaking: [name], found }
// `found` is false when the page has no participant list (not in a call, the list is closed, or the selectors are wrong).
function readMeeting(snapshot, sel) {
  const nodes = snapshot.nodes || [];
  const title = String(snapshot.window || '');
  const code = sel.code.exec(title)?.[1]?.toLowerCase() || '';
  const out = { title, code, participants: [], speaking: [], found: false };
  if (!nodes.length) return out;
  const t = buildTree(nodes, snapshot.platform || 'linux');
  const inScope = sel.scope ? t.filter((n) => matches(sel.scope, n)).flatMap((n) => [...descendants(t, n.i)]) : t;
  const seen = new Set();
  for (const n of inScope) {
    if (!matches(sel.name, n)) continue;
    const raw = sel.nameFrom === 'name' ? n.n : n.a?.[sel.nameFrom];
    const c = cleanName(raw);
    const grp = groupOf(t, n, sel);
    const self = c.self || (!!sel.self && [n, ...grp].some((x) => matches(sel.self, x)));
    const speaking = !!sel.speaking && grp.some((x) => matches(sel.speaking, x));
    const key = nameKey(c.name);
    if (!c.name && !self) continue;
    if (c.name && seen.has(key)) continue;
    if (c.name) seen.add(key);
    out.participants.push({ name: c.name, self, speaking });
  }
  out.found = out.participants.length > 0;
  out.speaking = out.participants.filter((p) => p.speaking && !p.self && p.name).map((p) => p.name);
  return out;
}

// Turns the snapshots of one window into protocol messages (protocol.js), only when something changed:
// the list of people, who is speaking (one name; with two speaking at once nothing says whose voice is whose, so null),
// and whether a call is on.
class MeetingReader {
  constructor(selectors) { this.sel = selectors; this.reset(); }

  reset() { this.roster = ''; this.speaker = undefined; this.inCall = false; this.code = ''; }

  // -> [message]
  feed(snapshot) {
    const m = readMeeting(snapshot, this.sel);
    const out = [];
    if (m.found !== this.inCall || (m.found && m.code !== this.code)) {
      this.inCall = m.found; this.code = m.code;
      out.push({ type: 'meeting', inCall: m.found, code: m.code, title: m.title });
    }
    if (!m.found) { this.roster = ''; if (this.speaker) { this.speaker = null; out.push({ type: 'speaker', name: null }); } return out; }
    const rosterKey = m.participants.map((p) => `${nameKey(p.name)}${p.self ? '*' : ''}`).sort().join('|');
    if (rosterKey !== this.roster) { this.roster = rosterKey; out.push({ type: 'roster', participants: m.participants.map((p) => ({ name: p.name, self: p.self })) }); }
    const who = m.speaking.length === 1 ? m.speaking[0] : null;
    const mine = m.participants.some((p) => p.self && p.speaking);
    const name = mine && !who ? null : who;
    if (name !== this.speaker && (this.speaker !== undefined || name)) { this.speaker = name; out.push({ type: 'speaker', name }); }
    return out;
  }
}

module.exports = { compileSelectors, readMeeting, MeetingReader, buildTree, matches, compileMatcher };
