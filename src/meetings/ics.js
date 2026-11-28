'use strict';
// iCalendar (RFC 5545) subset: enough for Google/Outlook/Apple feeds. Events, attendees, time zones via Intl,
// RRULE (DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY incl. ordinals, BYMONTHDAY, BYMONTH), EXDATE and RECURRENCE-ID overrides.

const WIN_TZ = {
  'W. Europe Standard Time': 'Europe/Berlin', 'GMT Standard Time': 'Europe/London', 'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest', 'E. Europe Standard Time': 'Europe/Bucharest', 'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
  'UTC': 'UTC', 'India Standard Time': 'Asia/Kolkata', 'Tokyo Standard Time': 'Asia/Tokyo', 'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. South America Standard Time': 'America/Sao_Paulo',
};

function unfold(text) { return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/); }

function unescapeText(s) { return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\;/g, ';').replace(/\\\\/g, '\\'); }

function parseLine(line) {
  // NAME;PARAM=val;PARAM="v:al":value  — the first colon outside quotes ends the name+params
  let inQ = false, idx = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQ = !inQ;
    else if (line[i] === ':' && !inQ) { idx = i; break; }
  }
  if (idx < 0) return null;
  const head = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const parts = head.split(';');
  const name = parts.shift().toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

// One formatter per time zone: building an Intl.DateTimeFormat costs far more than using one, and an occurrence needs two.
const FORMATTERS = new Map();
function formatter(tz) {
  let f = FORMATTERS.get(tz);
  if (!f) FORMATTERS.set(tz, f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
  return f;
}

function tzOffsetMs(utcMs, tz) {
  const f = formatter(tz);
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

function wallToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (!tz) { const l = new Date(y, mo - 1, d, h, mi, s); return l.getTime(); } // floating = machine-local
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz);
  return t;
}

function resolveTz(tzid) {
  if (!tzid) return null;
  const name = WIN_TZ[tzid] || tzid.replace(/^\/?(mozilla\.org|freeassociation\.sourceforge\.net)\/[^/]*\//, '');
  try { formatter(name); return name; } catch { return null; }
}

// A DATE (all-day) value is a floating local date: local midnight, the same as Google all-day events (google.js dateMs) and
// what the UI groups by. DTSTART, EXDATE, RECURRENCE-ID and every occurrence use this one rule (occurrences used UTC
// midnight while DTSTART/EXDATE used local, so outside UTC the first day was skipped and EXDATE never matched).
const localDate = (y, mo, d) => new Date(y, mo - 1, d).getTime();

// -> { ms, allDay, tz, wall:{y,mo,d,h,mi,s} }
function parseDate(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', z] = m;
  const wall = { y: +y, mo: +mo, d: +d, h: +h, mi: +mi, s: +s };
  const allDay = params.VALUE === 'DATE' || m[4] === undefined;
  if (allDay) return { ms: localDate(wall.y, wall.mo, wall.d), allDay: true, tz: null, wall };
  if (z) return { ms: Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s), allDay: false, tz: 'UTC', wall };
  const tz = resolveTz(params.TZID);
  return { ms: wallToUtc(wall.y, wall.mo, wall.d, wall.h, wall.mi, wall.s, tz), allDay, tz, wall };
}

const URL_RES = [
  /https?:\/\/[\w.-]*zoom\.us\/(?:j|my|wc\/join)\/[^\s<>"')\\]+/i,
  /https?:\/\/meet\.google\.com\/[a-z0-9-]+(?:\?[^\s<>"')\\]*)?/i,
  /https?:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s<>"')\\]+/i,
  /https?:\/\/[\w.-]*webex\.com\/[^\s<>"')\\]*(?:meet|join)[^\s<>"')\\]*/i,
  /https?:\/\/(?:whereby\.com|meet\.jit\.si|around\.co|gotomeet\.me|app\.slack\.com\/huddle)\/[^\s<>"')\\]+/i,
];
function meetingUrl(...texts) {
  const hay = texts.filter(Boolean).join('\n');
  for (const re of URL_RES) { const m = re.exec(hay); if (m) return m[0]; }
  return null;
}

function parseIcs(text) {
  const events = [];
  let cur = null;
  let depth = 0;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') { cur = { attendees: [], exdates: [] }; depth = 0; continue; }
    if (line === 'END:VEVENT') { if (cur) { finish(cur); events.push(cur); } cur = null; continue; }
    if (!cur) continue;
    if (line.startsWith('BEGIN:')) { depth++; continue; }       // VALARM etc.
    if (line.startsWith('END:')) { depth--; continue; }
    if (depth > 0) continue;
    const p = parseLine(line);
    if (!p) continue;
    switch (p.name) {
      case 'UID': cur.uid = p.value; break;
      case 'SUMMARY': cur.summary = unescapeText(p.value); break;
      case 'DESCRIPTION': cur.description = unescapeText(p.value); break;
      case 'LOCATION': cur.location = unescapeText(p.value); break;
      case 'STATUS': cur.status = p.value.toUpperCase(); break;
      case 'DTSTART': cur.dtstart = parseDate(p.value, p.params); break;
      case 'DTEND': cur.dtend = parseDate(p.value, p.params); break;
      case 'DURATION': cur.duration = parseDuration(p.value); break;
      case 'RRULE': cur.rrule = parseRrule(p.value); break;
      case 'EXDATE': for (const v of p.value.split(',')) { const d = parseDate(v, p.params); if (d) cur.exdates.push(d.ms); } break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDate(p.value, p.params)?.ms; break;
      case 'X-GOOGLE-CONFERENCE': cur.conference = p.value; break;
      case 'ORGANIZER': cur.organizer = { name: p.params.CN || '', email: p.value.replace(/^mailto:/i, '') }; break;
      case 'ATTENDEE': cur.attendees.push({ name: p.params.CN || '', email: p.value.replace(/^mailto:/i, ''), status: p.params.PARTSTAT || '' }); break;
      default: break;
    }
  }
  return events.filter((e) => e.dtstart && e.status !== 'CANCELLED' || (e.dtstart && e.recurrenceId));
}

function finish(e) {
  e.uid = e.uid || `${e.summary}-${e.dtstart?.ms}`;
  if (e.dtstart && !e.dtend) {
    e.durationMs = e.duration ?? (e.dtstart.allDay ? 86400000 : 0);
  } else if (e.dtstart && e.dtend) e.durationMs = e.dtend.ms - e.dtstart.ms;
  e.url = meetingUrl(e.conference, e.location, e.description);
}

function parseDuration(v) {
  const m = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v);
  if (!m) return 0;
  const [, neg, w = 0, d = 0, h = 0, mi = 0, s = 0] = m;
  const ms = ((+w * 7 + +d) * 86400 + +h * 3600 + +mi * 60 + +s) * 1000;
  return neg ? -ms : ms;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
function parseRrule(v) {
  const r = {};
  for (const part of v.split(';')) {
    const [k, val] = part.split('=');
    r[k.toUpperCase()] = val;
  }
  // INTERVAL below 1 (0, negative, junk) would never move forward: the walk spun 20,000 times on the same day
  const interval = Math.floor(Number(r.INTERVAL || 1)), count = Math.floor(Number(r.COUNT));
  const out = { freq: String(r.FREQ || '').toUpperCase(), interval: interval >= 1 ? interval : 1, count: count >= 1 ? count : null, until: r.UNTIL ? parseDate(r.UNTIL, {})?.ms : null };
  out.byday = (r.BYDAY || '').split(',').filter(Boolean).map((d) => { const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d); return m ? { n: m[1] ? Number(m[1]) : 0, day: DAYS.indexOf(m[2]) } : null; }).filter(Boolean);
  out.bymonthday = (r.BYMONTHDAY || '').split(',').filter(Boolean).map(Number);
  out.bymonth = (r.BYMONTH || '').split(',').filter(Boolean).map(Number);
  out.wkst = DAYS.indexOf(r.WKST || 'MO');
  return out;
}

const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based

// Candidate wall dates (UTC-date arithmetic, no tz) for the period containing `base` shifted by k intervals.
function periodDates(rule, start, k) {
  const { y, mo, d } = start.wall;
  const baseUtc = Date.UTC(y, mo - 1, d);
  const dow = new Date(baseUtc).getUTCDay();
  const out = [];
  const push = (yy, mm, dd) => out.push({ y: yy, mo: mm, d: dd });
  switch (rule.freq) {
    case 'DAILY': {   // BYDAY on a daily rule filters the days ("every weekday"); it used to be ignored
      const t = new Date(baseUtc + k * rule.interval * 86400000);
      if (!rule.byday.length || rule.byday.some((x) => x.day === t.getUTCDay())) push(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
      break;
    }
    case 'WEEKLY': {
      const days = rule.byday.length ? rule.byday.map((x) => x.day) : [dow];
      const weekStart = baseUtc - ((dow - rule.wkst + 7) % 7) * 86400000 + k * rule.interval * 7 * 86400000;
      for (const wd of days) { const t = new Date(weekStart + ((wd - rule.wkst + 7) % 7) * 86400000); push(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
      break;
    }
    case 'MONTHLY': case 'YEARLY': {
      const months = rule.freq === 'YEARLY' ? (rule.bymonth.length ? rule.bymonth : [mo]) : null;
      const target = rule.freq === 'MONTHLY' ? [[y + Math.floor((mo - 1 + k * rule.interval) / 12), ((mo - 1 + k * rule.interval) % 12 + 12) % 12 + 1]] : months.map((m) => [y + k * rule.interval, m]);
      for (const [yy, mm] of target) {
        const n = dim(yy, mm);
        if (rule.byday.length) {
          for (const bd of rule.byday) {
            const matches = [];
            for (let dd = 1; dd <= n; dd++) if (new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay() === bd.day) matches.push(dd);
            if (bd.n === 0) matches.forEach((dd) => push(yy, mm, dd));
            else { const dd = bd.n > 0 ? matches[bd.n - 1] : matches[matches.length + bd.n]; if (dd) push(yy, mm, dd); }
          }
        } else if (rule.bymonthday.length) {
          for (const md of rule.bymonthday) { const dd = md > 0 ? md : n + md + 1; if (dd >= 1 && dd <= n) push(yy, mm, dd); }
        } else if (d <= n) push(yy, mm, d);
      }
      break;
    }
    default: break;
  }
  return out.sort((a, b) => Date.UTC(a.y, a.mo - 1, a.d) - Date.UTC(b.y, b.mo - 1, b.d));
}

const FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const DAY = 86400000;

// The first period worth looking at for a window that starts at `fromMs`, and how many occurrences the skipped periods hold
// (needed for COUNT). Walking from DTSTART cost one wall-clock conversion per occurrence since the series began (a 2018 daily
// stand-up: thousands per expand, every 4 s). Periods are counted on the UTC calendar like periodDates; the margin of two
// days plus the duration covers time zones and an occurrence that started before the window but still runs.
function skipTo(ev, fromMs) {
  const r = ev.rrule, w = ev.dtstart.wall, dur = Math.max(ev.durationMs || 0, 0);
  const baseUtc = Date.UTC(w.y, w.mo - 1, w.d), target = fromMs - dur - 2 * DAY;
  if (!(target > baseUtc)) return { k: 0, produced: 0 };
  const t = new Date(target);
  let k;
  switch (r.freq) {
    case 'DAILY': k = Math.floor((target - baseUtc) / DAY / r.interval); break;
    case 'WEEKLY': k = Math.floor((target - baseUtc) / (7 * DAY) / r.interval); break;
    // MONTHLY/YEARLY periods count from the written year, as periodDates does
    case 'MONTHLY': k = Math.floor(((t.getUTCFullYear() - w.y) * 12 + t.getUTCMonth() - (w.mo - 1)) / r.interval); break;
    case 'YEARLY': k = Math.floor((t.getUTCFullYear() - w.y) / r.interval); break;
    default: return { k: 0, produced: 0 };
  }
  k = Math.max(0, k - 1);
  if (k === 0 || !r.count) return { k, produced: 0 };
  // With COUNT the skipped occurrences must be counted. That is arithmetic only when every period holds the same number of
  // dates: DAILY without BYDAY, and WEEKLY (its first week may start before DTSTART). Other rules walk from DTSTART;
  // COUNT bounds that walk anyway.
  if (r.bymonth.length || !(r.freq === 'WEEKLY' || (r.freq === 'DAILY' && !r.byday.length))) return { k: 0, produced: 0 };
  const perPeriod = periodDates(r, ev.dtstart, 1).length;
  const first = periodDates(r, ev.dtstart, 0).filter((dt) => startOf(ev, dt) >= ev.dtstart.ms).length;
  return { k, produced: first + (k - 1) * perPeriod };
}

const startOf = (ev, dt) => (ev.dtstart.allDay ? localDate(dt.y, dt.mo, dt.d) : wallToUtc(dt.y, dt.mo, dt.d, ev.dtstart.wall.h, ev.dtstart.wall.mi, ev.dtstart.wall.s, ev.dtstart.tz));

// All occurrences of one parsed event that intersect [fromMs, toMs).
function occurrences(ev, fromMs, toMs, { max = 2000 } = {}) {
  const dur = ev.durationMs || 0;
  const make = (startMs) => ({ uid: ev.uid, start: startMs, end: startMs + dur, allDay: ev.dtstart.allDay, summary: ev.summary || '(no title)', location: ev.location || '', description: ev.description || '', attendees: ev.attendees, organizer: ev.organizer, url: ev.url, recurring: !!ev.rrule });
  if (!ev.rrule) {
    const s = ev.dtstart.ms;
    return s < toMs && s + Math.max(dur, 1) > fromMs ? [make(s)] : [];
  }
  const r = ev.rrule;
  if (!FREQS.has(r.freq)) return [];              // HOURLY/MINUTELY/SECONDLY are not supported: nothing, at once
  if (r.until != null && r.until < fromMs - Math.max(dur, 1)) return [];
  const out = [];
  const excluded = new Set(ev.exdates);
  let { k, produced } = skipTo(ev, fromMs);
  for (const end = k + 20000; k < end && out.length < max; k++) {
    const dates = periodDates(r, ev.dtstart, k);
    let pastEnd = false;
    for (const dt of dates) {
      if (r.bymonth.length && r.freq !== 'YEARLY' && !r.bymonth.includes(dt.mo)) continue;
      const ms = startOf(ev, dt);
      if (ms < ev.dtstart.ms) continue;
      if (r.until && ms > r.until) { pastEnd = true; break; }
      produced++;
      if (r.count && produced > r.count) { pastEnd = true; break; }
      if (ms >= toMs) { pastEnd = true; break; }
      if (ms + Math.max(dur, 1) > fromMs && !excluded.has(ms)) out.push(make(ms));
    }
    if (pastEnd) break;
  }
  return out;
}

// Expand a whole feed, applying RECURRENCE-ID overrides, sorted by start.
function expand(events, fromMs, toMs) {
  const masters = events.filter((e) => !e.recurrenceId);
  const overrides = new Map();
  for (const e of events) if (e.recurrenceId) overrides.set(`${e.uid}|${e.recurrenceId}`, e);
  const out = [];
  for (const m of masters) {
    for (const occ of occurrences(m, fromMs, toMs)) {
      const o = overrides.get(`${m.uid}|${occ.start}`);
      if (o) {
        if (o.status === 'CANCELLED') continue;
        const [oo] = occurrences({ ...o, rrule: null }, -Infinity, Infinity);
        if (oo) { out.push({ ...oo, recurring: true }); continue; }
      }
      out.push(occ);
    }
  }
  for (const [key, o] of overrides) { // overrides whose master is absent from the feed
    if (!masters.some((m) => m.uid === o.uid) && o.status !== 'CANCELLED') out.push(...occurrences({ ...o, rrule: null }, fromMs, toMs));
  }
  return out.filter((o) => o.end > fromMs && o.start < toMs).sort((a, b) => a.start - b.start || a.summary.localeCompare(b.summary));
}

// expand() for the calendar views and the meeting detector, which ask every few seconds for a window that moves by seconds.
// The answer is computed once per feed load (a reload parses a new events array, so a WeakMap entry dies with the old one)
// and per window widened to whole days, then cut to the exact window.
const EXPANDED = new WeakMap();
function expandCached(events, fromMs, toMs) {
  if (!Array.isArray(events) || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) return expand(events, fromMs, toMs);
  const lo = Math.floor(fromMs / DAY) * DAY - DAY, hi = Math.ceil(toMs / DAY) * DAY + DAY, key = `${lo}|${hi}`;
  let per = EXPANDED.get(events);
  if (!per) EXPANDED.set(events, per = new Map());
  let all = per.get(key);
  if (!all) {
    all = expand(events, lo, hi);
    if (per.size >= 8) per.delete(per.keys().next().value);
    per.set(key, all);
  }
  return all.filter((o) => o.end > fromMs && o.start < toMs);
}

module.exports = { parseIcs, expand, expandCached, occurrences, parseDate, parseRrule, meetingUrl, wallToUtc, tzOffsetMs };
