'use strict';
// Before mail or chat goes to an AI server that is NOT on this computer (and only when its source allows that at all), the details that
// would hurt most if they leaked are swapped for stable placeholders: <email_1>, <phone_2>, <iban_1>, <card_1>, <secret_1>, <code_1>,
// <link_1>. The same value always gets the same placeholder inside one request, so the AI can still say "<email_1> asked ...", and the
// placeholders are swapped back in what the AI answers, here, before anyone reads it. A best effort, not a promise: names and free text
// are not touched. Pure functions; no I/O.
const PATTERNS = [
  // links that carry a secret: password resets, magic sign-in, verification, invitations with a token
  ['link', /https?:\/\/[^\s<>"')]+(?:token|reset|verify|magic|confirm|invite|signin|sign-in|login|auth|otp|code|key|session)[^\s<>"')]*/gi],
  ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
  ['iban', /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g],
  ['secret', /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\bAKIA[0-9A-Z]{16}\b|\b[A-Za-z0-9_-]{32,}\b/g],
  ['code', /(?<=\b(?:code|c[oó]digo|pin|otp|password|palavra-passe|senha|verification)\b[^\n\d]{0,25})\d{4,8}\b/gi],
];
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const PHONE = /(?<![\w@.])(?:\+|00)?\d{1,3}[ .-]?\(?\d{2,4}\)?(?:[ .-]?\d{2,4}){2,4}(?![\w@])/g;
const DATE = /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})$/;
const luhn = (digits) => { let sum = 0, alt = false; for (let i = digits.length - 1; i >= 0; i--) { let n = digits.charCodeAt(i) - 48; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; } return sum % 10 === 0; };

class Redactor {
  constructor() { this.byValue = new Map(); this.byPlaceholder = new Map(); this.counts = {}; }

  hide(kind, value) {
    const key = `${kind}:${value}`;
    if (!this.byValue.has(key)) { const n = (this.counts[kind] = (this.counts[kind] || 0) + 1); const ph = `<${kind}_${n}>`; this.byValue.set(key, ph); this.byPlaceholder.set(ph, value); }
    return this.byValue.get(key);
  }

  apply(text) {
    let out = String(text ?? '');
    for (const [kind, re] of PATTERNS) out = out.replace(re, (m) => { if (kind === 'secret' && m.length >= 32 && !/^(?:sk|pk|rk|gh|xox|AKIA)/.test(m) && !(/\d/.test(m) && /[A-Za-z]/.test(m))) return m; const tail = /[.,;:!?]+$/.exec(m)?.[0] || ''; return this.hide(kind, tail ? m.slice(0, -tail.length) : m) + tail; });   // sentence punctuation stays outside
    out = out.replace(CARD, (m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d) ? this.hide('card', m) : m; });
    out = out.replace(PHONE, (m) => { const d = m.replace(/\D/g, ''); return d.length >= 9 && d.length <= 15 && !DATE.test(m.trim()) ? this.hide('phone', m) : m; });
    return out;
  }

  // what the AI said, with the placeholders put back (an unknown placeholder is left as written)
  restore(text) { return String(text ?? '').replace(/<(?:email|phone|iban|card|secret|code|link)_\d+>/g, (ph) => this.byPlaceholder.get(ph) ?? ph); }

  get used() { return this.byValue.size; }
}

module.exports = { Redactor };
