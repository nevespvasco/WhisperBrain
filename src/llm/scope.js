'use strict';
// Which meetings a question across all meetings is about. "Summarise the last meeting", "what did we decide this week?",
// "resume a última reunião": the time words pick meetings by date, and only the words left over search their text, so asking
// for a summary of "the last meeting" never goes looking for meetings that contain the words "summarise" or "meeting".
const { words } = require('../core/text');

// Words that say what to do with the meetings, not what to look for in them (English and Portuguese)
const ASK = new Set(`summarise summarize summary summaries recap overview everything anything something all list give show explain describe
  write draft please bullet bullets point points main key short brief quick happened happen discussed discuss talked talk mentioned
  meeting meetings call calls session sessions conversation conversations recording recordings last latest recent previous newest
  today yesterday week weeks month months year ago this past one two three four five ever across whole any every us our just
  resume resumo resumir resumos sumariza sumário sumario tudo todos todas reunião reuniao reuniões reunioes chamada chamadas conversa
  última ultima últimas ultimas último ultimo últimos ultimos recente recentes anterior hoje ontem semana semanas mês mes meses
  esta este nesta neste passada passado em no na nos nas os as de do da dos das um uma que qual quais foi foram sobre por favor
  pontos ponto principais lista mostra diz fala falámos falamos discutimos discutido se com para`.split(/\s+/).filter(Boolean));

const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, um: 1, uma: 1, dois: 2, duas: 2, 'três': 3, tres: 3, quatro: 4, cinco: 5 };
const MEETING = '(?:meetings?|calls?|sessions?|conversations?|recordings?|reuni(?:ão|ao|ões|oes)|chamadas?|conversas?)';

const DAY = 24 * 3600 * 1000;
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const startOfWeek = (ms) => { const d = new Date(startOfDay(ms)); return d.getTime() - ((d.getDay() + 6) % 7) * DAY; }; // Monday
const startOfMonth = (ms) => { const d = new Date(startOfDay(ms)); d.setDate(1); return d.getTime(); };

// -> { latest: n | 0, when: { from, to, label } | null, terms: 'words to search for' }
function chatScope(question, now = Date.now()) {
  const q = String(question || '').toLowerCase();
  let latest = 0;
  // "the last meeting", "my 3 latest calls", "a última reunião", "as últimas 2 reuniões", "the previous call", "reunião anterior"
  const en = q.match(new RegExp(`\\b(?:last|latest|most recent|previous|newest|recent)\\s+(?:(\\d+|one|two|three|four|five)\\s+)?${MEETING}`, 'u'));
  const en2 = q.match(new RegExp(`\\b(?:last|latest|previous)\\s+(\\d+|two|three|four|five)\\s+${MEETING}`, 'u'));
  const pt = q.match(new RegExp(`(?:^|[^\\p{L}])(?:[úu]ltim[ao]s?|mais recentes?)\\s+(?:(\\d+|duas|dois|tr[êe]s|quatro|cinco)\\s+)?${MEETING}`, 'u'));
  const pt2 = q.match(new RegExp(`${MEETING}\\s+(?:anterior|mais recente|passada)`, 'u'));
  const m = en2 || en || pt || pt2;
  // a number says how many; a plural without one ("recent meetings", "últimas reuniões") means a few
  if (m) { const n = m[1] ? Number(m[1]) || NUM[m[1]] || 1 : /(?:s|ões|oes)$/u.test(m[0]) ? 3 : 1; latest = Math.min(5, Math.max(1, n)); }

  let when = null;
  const sod = startOfDay(now);
  if (/\b(today|this morning|this afternoon)\b|(?:^|[^\p{L}])hoje(?:$|[^\p{L}])/u.test(q)) when = { from: sod, to: sod + DAY, label: 'today' };
  else if (/\byesterday\b|(?:^|[^\p{L}])ontem(?:$|[^\p{L}])/u.test(q)) when = { from: sod - DAY, to: sod, label: 'yesterday' };
  else if (/\blast week\b|semana passada/u.test(q)) { const w = startOfWeek(now); when = { from: w - 7 * DAY, to: w, label: 'last week' }; }
  else if (/\bthis week\b|\bpast (?:7|seven) days\b|(?:esta|nesta) semana/u.test(q)) when = { from: startOfWeek(now), to: sod + DAY, label: 'this week' };
  else if (/\blast month\b|m[êe]s passado/u.test(q)) { const mo = startOfMonth(now); const prev = new Date(mo); prev.setMonth(prev.getMonth() - 1); when = { from: prev.getTime(), to: mo, label: 'last month' }; }
  else if (/\bthis month\b|(?:este|neste) m[êe]s/u.test(q)) when = { from: startOfMonth(now), to: sod + DAY, label: 'this month' };

  const terms = words(q).filter((w) => !ASK.has(w) && !/^\d+$/.test(w)).join(' ');
  return { latest, when, terms };
}

module.exports = { chatScope, ASK };
