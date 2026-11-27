'use strict';
// What a meeting source tells the app. Sources are the Chrome extension, the accessibility readers (Linux AT-SPI, macOS
// AX, Windows UI Automation) and the screen reader; they all speak this one format, so everything after it is shared.
//
//   Every message also carries `platform` (platforms.js id: 'meet', ...); one without is read as Google Meet, so an
//   extension that is already paired keeps working.
//
//   { type: 'speaker', name: 'Ana' | null, id?, self? }     who is the active speaker now (null: nobody)
//   { type: 'roster', participants: [{ name, id?, self? }], partial? } who is in the call (all of them, you included; partial: only those shown)
//   { type: 'meeting', inCall: bool, code?, title? }         joined or left a call
//   { type: 'caption', name, text, final? }                  one caption line, name and words together
//
// Times are never sent: the app stamps a message when it arrives and subtracts the source's lag.

const { platformId } = require('./platforms');

const MAX_NAME = 80;
const MAX_TEXT = 600;
const MAX_PEOPLE = 500;

class SignalError extends Error {}

const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// Words a meeting UI shows in place of a name. They are not people.
const NOT_A_NAME = /^(?:you|me|tu|você|voce|vous|du|tú|yo|unknown|desconhecido|someone|alguém|alguem|presentation|apresentação|apresentacao|\(you\)|\(tu\))$/i;
const SELF_MARK = /\s*[([]\s*(?:you|tu|você|voce|vous|du|tú|yo|me|eu)\s*[)\]]\s*$/i;

// "Ana Silva (You)" -> { name: 'Ana Silva', self: true }; "You" -> { name: '', self: true }
function cleanName(raw) {
  let name = str(raw, MAX_NAME);
  let self = false;
  if (SELF_MARK.test(name)) { name = name.replace(SELF_MARK, '').trim(); self = true; }
  if (NOT_A_NAME.test(name)) { self = self || /^(?:you|me|tu|você|voce|vous|du|tú|yo|\(you\)|\(tu\))$/i.test(name); name = ''; }
  return { name, self };
}

// A key to compare names across sources: "José  da Silva" and "jose da silva" are one person.
function nameKey(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function person(p) {
  const raw = typeof p === 'string' ? { name: p } : p || {};
  const c = cleanName(raw.name);
  return { name: c.name, id: raw.id == null ? '' : str(raw.id, 120), self: !!raw.self || c.self };
}

// -> a clean message, or throws SignalError
function normalize(msg) {
  if (!msg || typeof msg !== 'object') throw new SignalError('a message must be an object');
  switch (msg.type) {
    case 'speaker': {
      const p = person({ name: msg.name, id: msg.id, self: msg.self });
      return { type: 'speaker', name: p.name || null, id: p.id, self: p.self };
    }
    case 'roster': {
      if (!Array.isArray(msg.participants)) throw new SignalError('a roster needs a participants list');
      const seen = new Set();
      const participants = [];
      for (const raw of msg.participants.slice(0, MAX_PEOPLE)) {
        const p = person(raw);
        const key = p.id || nameKey(p.name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        participants.push(p);
      }
      // partial: only the people whose tile is on the screen, not everybody on the call (so it says who is there, never how many)
      return { type: 'roster', participants, ...(msg.partial ? { partial: true } : {}) };
    }
    case 'meeting':
      return { type: 'meeting', inCall: !!msg.inCall, code: str(msg.code, 40), title: str(msg.title, 200) };
    case 'caption': {
      const p = person({ name: msg.name, self: msg.self });
      const text = str(msg.text, MAX_TEXT);
      if (!text) throw new SignalError('a caption needs text');
      return { type: 'caption', name: p.name || null, self: p.self, text, final: !!msg.final };
    }
    default:
      throw new SignalError(`unknown message type: ${String(msg.type).slice(0, 30)}`);
  }
}

// What the hub accepts: a clean message that also says which platform it is about (Google Meet when it does not say).
function normalizeSignal(msg) {
  const m = normalize(msg);
  return { ...m, platform: platformId(msg.platform) };
}

module.exports = { normalize, normalizeSignal, cleanName, nameKey, SignalError, NOT_A_NAME };
