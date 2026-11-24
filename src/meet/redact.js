'use strict';
// Makes a captured accessibility tree safe to share (pure). What the selectors need is the shape of the tree: roles, how
// nodes nest, class and tag names, and the few words the page uses for itself ("Speaking", "Participants", "(You)").
// What must not leave a call is who was in it and what was said, so every other name is replaced by its length.
// This is a best effort that a person reads over before sharing; it never promises to catch everything.
const KEEP = /^(?:speaking|is speaking|talking|participants?|people|in this call|in call|chat|mute(?:d)?|unmute|turn (?:on|off) (?:camera|microphone)|camera|microphone|present(?:ing|ation)?|raise hand|hand raised|leave call|meeting details|a falar|participantes|pessoas)$/i;
const KEEP_ATTR = new Set(['tag', 'class', 'id', 'xml-roles', 'display', 'role', 'aria-live', 'explicit-name', 'name-from']);

const mask = (s) => `«${[...String(s)].length}»`;

function redactName(name, keep) {
  const n = String(name || '');
  if (!n) return '';
  if (KEEP.test(n.trim()) || (keep && keep.test(n))) return n;
  // the self mark survives, so the "(You)" selector can be checked; the name before it does not
  const m = /^(.*?)\s*(\((?:you|tu|você|voce|vous|du|tú)\))$/i.exec(n);
  return m ? `${mask(m[1])} ${m[2]}` : mask(n);
}

// snapshot: { app, window, nodes } -> the same shape, redacted. keep: an extra RegExp of names to leave readable.
function redactSnapshot(snapshot, { keep = null } = {}) {
  const code = /([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(snapshot.window || '')?.[1];
  return {
    ...snapshot,
    window: code ? 'Meet «code»' : redactName(snapshot.window, keep),
    nodes: (snapshot.nodes || []).map((n) => {
      const a = n.a ? Object.fromEntries(Object.entries(n.a).map(([k, v]) => [k, KEEP_ATTR.has(k) && !/^id$/.test(k) ? v : mask(v)])) : undefined;
      return { ...n, n: redactName(n.n, keep), ...(a ? { a } : {}) };
    }),
  };
}

module.exports = { redactSnapshot, redactName };
