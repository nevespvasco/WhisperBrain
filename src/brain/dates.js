'use strict';
// "by Friday", "até sexta", "tomorrow", "next week", "in 3 days", "2026-12-04": the words a person says about when, turned into a date
// in code, never by the model (a model gets dates wrong). Relative to when the meeting was. Returns the end of that day, or null when
// the words do not say (the words themselves are kept, so nothing is lost).
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const DAYS = [['sunday', 'domingo'], ['monday', 'segunda'], ['tuesday', 'terca'], ['wednesday', 'quarta'], ['thursday', 'quinta'], ['friday', 'sexta'], ['saturday', 'sabado']];
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5 };

const endOfDay = (d) => { const x = new Date(d); x.setHours(18, 0, 0, 0); return x.getTime(); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function resolveDue(phrase, ref = Date.now()) {
  const p = fold(phrase);
  if (!p) return null;
  const base = new Date(ref);
  let m;
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(p))) { const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); return Number.isNaN(d.getTime()) ? null : endOfDay(d); }
  if ((m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(p))) {
    let y = m[3] ? Number(m[3]) : base.getFullYear(); if (y < 100) y += 2000;
    const d = new Date(y, Number(m[2]) - 1, Number(m[1]));
    if (!m[3] && d.getTime() < endOfDay(base) - 86400000) d.setFullYear(y + 1);
    return Number.isNaN(d.getTime()) || Number(m[2]) > 12 ? null : endOfDay(d);
  }
  if (/\b(today|hoje)\b/.test(p)) return endOfDay(base);
  if (/\b(tomorrow|amanha)\b/.test(p)) return endOfDay(addDays(base, 1));
  if ((m = /\b(?:in|daqui a|dentro de|em)\s+(\d+|one|two|three|four|five|um|uma|dois|duas|tres|quatro|cinco)\s+(day|days|dia|dias|week|weeks|semana|semanas)\b/.exec(p))) {
    const n = NUM[m[1]] || Number(m[1]);
    return endOfDay(addDays(base, /week|semana/.test(m[2]) ? n * 7 : n));
  }
  if (/\b(next week|proxima semana|semana que vem)\b/.test(p)) { const d = addDays(base, ((8 - base.getDay()) % 7) || 7); return endOfDay(d); }   // next Monday
  if (/\b(end of (the )?week|fim da semana|fim de semana)\b/.test(p)) { const d = addDays(base, (5 - base.getDay() + 7) % 7); return endOfDay(d); }   // this Friday
  if (/\b(end of (the )?month|fim do mes|final do mes)\b/.test(p)) return endOfDay(new Date(base.getFullYear(), base.getMonth() + 1, 0));
  for (let i = 0; i < 7; i++) {
    if (DAYS[i].some((w) => new RegExp(`\\b${w}(-feira)?\\b`).test(p))) { const diff = ((i - base.getDay() + 7) % 7) || 7; return endOfDay(addDays(base, diff)); }   // the next one, never today
  }
  return null;
}

module.exports = { resolveDue };
