'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ics = require('../src/meetings/ics');

const wrap = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const D = (s) => Date.parse(s);
const iso = (ms) => new Date(ms).toISOString();

test('single event: UTC time, folded lines, attendees and meeting link', () => {
  const text = wrap([
    'BEGIN:VEVENT', 'UID:a1', 'SUMMARY:Design review\\, round 2', 'DTSTART:20261125T140000Z', 'DTEND:20261125T150000Z',
    'DESCRIPTION:Join us at https://meet.google.com/abc-defg-hij?authuser=0 and\r\n  bring notes', 'ATTENDEE;CN=Ana Silva;PARTSTAT=ACCEPTED:mailto:ana@x.com',
    'ATTENDEE;CN="Bob, Jr":mailto:bob@x.com', 'BEGIN:VALARM', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT',
  ]);
  const evs = ics.parseIcs(text);
  assert.equal(evs.length, 1);
  const [o] = ics.expand(evs, D('2026-11-25T00:00:00Z'), D('2026-11-26T00:00:00Z'));
  assert.equal(o.summary, 'Design review, round 2');
  assert.equal(iso(o.start), '2026-11-25T14:00:00.000Z');
  assert.equal(o.end - o.start, 3600000);
  assert.equal(o.url, 'https://meet.google.com/abc-defg-hij?authuser=0');
  assert.deepEqual(o.attendees.map((a) => a.name), ['Ana Silva', 'Bob, Jr']);
});

test('TZID events convert across DST (Lisbon winter vs summer, New York)', () => {
  const mk = (dt, tz) => ics.parseIcs(wrap(['BEGIN:VEVENT', 'UID:t', 'SUMMARY:x', `DTSTART;TZID=${tz}:${dt}`, 'DURATION:PT30M', 'END:VEVENT']));
  const all = (evs) => ics.expand(evs, 0, 4e12)[0];
  assert.equal(iso(all(mk('20261215T090000', 'Europe/Lisbon')).start), '2026-12-15T09:00:00.000Z');
  assert.equal(iso(all(mk('20260715T090000', 'Europe/Lisbon')).start), '2026-07-15T08:00:00.000Z');
  assert.equal(iso(all(mk('20260715T090000', 'America/New_York')).start), '2026-07-15T13:00:00.000Z');
  assert.equal(iso(all(mk('20261215T090000', 'W. Europe Standard Time')).start), '2026-12-15T08:00:00.000Z');
  assert.equal(all(mk('20261215T090000', 'Europe/Lisbon')).end - all(mk('20261215T090000', 'Europe/Lisbon')).start, 1800000);
});

test('weekly RRULE keeps the wall-clock time across the DST change, honours EXDATE and COUNT', () => {
  const evs = ics.parseIcs(wrap([
    'BEGIN:VEVENT', 'UID:w', 'SUMMARY:Standup', 'DTSTART;TZID=Europe/Lisbon:20261019T100000', 'DTEND;TZID=Europe/Lisbon:20261019T101500',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6', 'EXDATE;TZID=Europe/Lisbon:20261021T100000', 'END:VEVENT',
  ]));
  const out = ics.expand(evs, D('2026-10-01T00:00:00Z'), D('2027-01-01T00:00:00Z'));
  // Mondays/Wednesdays from Oct 19; count 6 includes the excluded Oct 21 → 5 shown. DST ends Oct 25 2026.
  assert.deepEqual(out.map((o) => iso(o.start)), [
    '2026-10-19T09:00:00.000Z', '2026-10-26T10:00:00.000Z', '2026-10-28T10:00:00.000Z', '2026-11-02T10:00:00.000Z', '2026-11-04T10:00:00.000Z',
  ]);
});

test('monthly ordinal BYDAY, UNTIL, daily INTERVAL and all-day events', () => {
  const second = ics.parseIcs(wrap(['BEGIN:VEVENT', 'UID:m', 'SUMMARY:Board', 'DTSTART:20261110T150000Z', 'DURATION:PT1H', 'RRULE:FREQ=MONTHLY;BYDAY=2TU;UNTIL=20270201T000000Z', 'END:VEVENT']));
  assert.deepEqual(ics.expand(second, 0, 4e12).map((o) => iso(o.start).slice(0, 10)), ['2026-11-10', '2026-12-08', '2027-01-12']);
  const last = ics.parseIcs(wrap(['BEGIN:VEVENT', 'UID:l', 'SUMMARY:Close', 'DTSTART:20261127T150000Z', 'DURATION:PT1H', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3', 'END:VEVENT']));
  assert.deepEqual(ics.expand(last, 0, 4e12).map((o) => iso(o.start).slice(0, 10)), ['2026-11-27', '2026-12-25', '2027-01-29']);
  const daily = ics.parseIcs(wrap(['BEGIN:VEVENT', 'UID:d', 'SUMMARY:Chk', 'DTSTART:20261101T090000Z', 'DURATION:PT10M', 'RRULE:FREQ=DAILY;INTERVAL=3;COUNT=4', 'END:VEVENT']));
  assert.deepEqual(ics.expand(daily, 0, 4e12).map((o) => iso(o.start).slice(0, 10)), ['2026-11-01', '2026-11-04', '2026-11-07', '2026-11-10']);
  const allday = ics.parseIcs(wrap(['BEGIN:VEVENT', 'UID:ad', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20261201', 'END:VEVENT']));
  const [h] = ics.expand(allday, 0, 4e12);
  assert.equal(h.allDay, true);
  assert.equal(h.end - h.start, 86400000);
  const yearly = ics.parseIcs(wrap(['BEGIN:VEVENT', 'UID:y', 'SUMMARY:Bday', 'DTSTART;VALUE=DATE:20260301', 'RRULE:FREQ=YEARLY;COUNT=3', 'END:VEVENT']));
  assert.equal(ics.expand(yearly, 0, 4e12).length, 3);
});

test('RECURRENCE-ID overrides move or cancel one instance; cancelled events are dropped', () => {
  const evs = ics.parseIcs(wrap(
    ['BEGIN:VEVENT', 'UID:r', 'SUMMARY:Sync', 'DTSTART:20261102T100000Z', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=3', 'END:VEVENT'],
    ['BEGIN:VEVENT', 'UID:r', 'RECURRENCE-ID:20261109T100000Z', 'SUMMARY:Sync (moved)', 'DTSTART:20261109T140000Z', 'DURATION:PT1H', 'END:VEVENT'],
    ['BEGIN:VEVENT', 'UID:r', 'RECURRENCE-ID:20261116T100000Z', 'STATUS:CANCELLED', 'SUMMARY:Sync', 'DTSTART:20261116T100000Z', 'DURATION:PT1H', 'END:VEVENT'],
    ['BEGIN:VEVENT', 'UID:c', 'SUMMARY:Gone', 'STATUS:CANCELLED', 'DTSTART:20261103T100000Z', 'DURATION:PT1H', 'END:VEVENT'],
  ));
  const out = ics.expand(evs, 0, 4e12);
  assert.deepEqual(out.map((o) => [o.summary, iso(o.start).slice(0, 16)]), [['Sync', '2026-11-02T10:00'], ['Sync (moved)', '2026-11-09T14:00']]);
});

test('window filtering and meeting link detection variants', () => {
  assert.match(ics.meetingUrl('see https://acme.zoom.us/j/12345?pwd=abc for the call'), /zoom\.us\/j\/12345/);
  assert.match(ics.meetingUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=y'), /meetup-join/);
  assert.equal(ics.meetingUrl('no link here'), null);
  const evs = ics.parseIcs(wrap(['BEGIN:VEVENT', 'UID:o', 'SUMMARY:Old', 'DTSTART:20200101T100000Z', 'DURATION:PT1H', 'END:VEVENT']));
  assert.equal(ics.expand(evs, D('2026-01-01T00:00:00Z'), D('2027-01-01T00:00:00Z')).length, 0);
});

// ---- cost: the meeting detector expands the feeds every 4 s ----
const ms = (f) => { const t = process.hrtime.bigint(); const r = f(); return [Number(process.hrtime.bigint() - t) / 1e6, r]; };
const pad = (n) => String(n).padStart(2, '0');
// every occurrence walked from DTSTART (no jump: the window starts before the series; no 2000-per-series cap), cut to the window
const walkAll = (feed, from, to) => feed.flatMap((ev) => ics.occurrences(ev, D('2010-01-01T00:00:00Z'), to, { max: 1e7 }))
  .filter((o) => o.end > from && o.start < to).sort((a, b) => a.start - b.start || a.summary.localeCompare(b.summary));
function oldFeed() {   // 10 daily stand-ups and 40 weeklies since 2018, all with TZID (took 4–5 s per expand)
  const evs = [];
  for (let i = 0; i < 10; i++) evs.push(['BEGIN:VEVENT', `UID:d${i}`, `SUMMARY:Daily ${i}`, `DTSTART;TZID=Europe/Lisbon:2018010${(i % 9) + 1}T09${pad(i)}00`, 'DURATION:PT15M', 'RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', 'END:VEVENT']);
  for (let i = 0; i < 40; i++) evs.push(['BEGIN:VEVENT', `UID:w${i}`, `SUMMARY:Weekly ${i}`, `DTSTART;TZID=America/New_York:2018${pad((i % 12) + 1)}10T140000`, 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;BYDAY=TU', 'END:VEVENT']);
  evs.push(['BEGIN:VEVENT', 'UID:m', 'SUMMARY:Monthly', 'DTSTART;TZID=Europe/Berlin:20180115T100000', 'DURATION:PT1H', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15', 'END:VEVENT']);
  evs.push(['BEGIN:VEVENT', 'UID:y', 'SUMMARY:Yearly', 'DTSTART;VALUE=DATE:20181128', 'RRULE:FREQ=YEARLY', 'END:VEVENT']);
  return ics.parseIcs(wrap(...evs));
}

test('a feed of old recurring TZID series expands fast, and the jump to the window gives the same events as walking from DTSTART', () => {
  const feed = oldFeed(), at = D('2026-11-26T12:00:00Z');
  const [t, out] = ms(() => ics.expand(feed, at - 6 * 3600000, at + 3600000));
  assert.ok(t < 100, `${t.toFixed(0)} ms`);
  assert.deepEqual(out.map((o) => o.uid).sort(), ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9']);
  const [tw, week] = ms(() => ics.expand(feed, at - 3600000, at + 7 * 86400000));
  assert.ok(tw < 100, `${tw.toFixed(0)} ms`);
  // the same window cut out of a walk that starts at DTSTART (a window that begins before every series never jumps)
  const walked = walkAll(feed, at - 3600000, at + 7 * 86400000);
  assert.deepEqual(week.map((o) => `${o.uid}@${iso(o.start)}`), walked.map((o) => `${o.uid}@${iso(o.start)}`));
  assert.ok(week.some((o) => o.uid === 'm' && iso(o.start) === '2026-12-15T09:00:00.000Z') || !walked.some((o) => o.uid === 'm'));
});

test('jumping keeps COUNT, UNTIL, INTERVAL, BYDAY, EXDATE and events that started before the window but still run', () => {
  const rules = [
    ['DTSTART;TZID=Europe/Lisbon:20200106T090000', 'RRULE:FREQ=DAILY;INTERVAL=3', 'PT2H'],
    ['DTSTART;TZID=Europe/Lisbon:20200106T090000', 'RRULE:FREQ=DAILY;COUNT=2513', 'PT30M'],      // ends inside the window
    ['DTSTART;TZID=Europe/Lisbon:20200106T090000', 'RRULE:FREQ=DAILY;COUNT=900', 'PT30M'],       // ended long before
    ['DTSTART;TZID=Europe/Lisbon:20200106T090000', 'RRULE:FREQ=DAILY;BYDAY=MO,WE,FR;COUNT=1080', 'PT30M'],
    ['DTSTART;TZID=America/New_York:20190101T230000', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=415', 'PT3H'],
    ['DTSTART;TZID=America/New_York:20190103T230000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU;COUNT=1000', 'PT1H'],
    ['DTSTART:20190101T080000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20261127T000000Z', 'PT1H'],
    ['DTSTART:20190131T080000Z', 'RRULE:FREQ=MONTHLY;INTERVAL=2', 'PT1H'],
    ['DTSTART:20190131T080000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=94', 'PT1H'],
    ['DTSTART;VALUE=DATE:20160229', 'RRULE:FREQ=YEARLY', 'P1D'],
    ['DTSTART:20190101T080000Z', 'RRULE:FREQ=DAILY;BYMONTH=11,12', 'PT1H'],
    ['DTSTART;TZID=Europe/Lisbon:20251126T220000', 'RRULE:FREQ=DAILY', 'PT26H'],
  ];
  const from = D('2026-11-20T00:00:00Z'), to = D('2026-12-20T00:00:00Z');
  for (const [dt, rr, dur] of rules) {
    const feed = ics.parseIcs(wrap(['BEGIN:VEVENT', 'UID:x', 'SUMMARY:x', dt, `DURATION:${dur}`, rr, 'EXDATE:20261201T080000Z', 'END:VEVENT']));
    const got = ics.expand(feed, from, to).map((o) => iso(o.start));
    const walked = walkAll(feed, from, to).map((o) => iso(o.start));
    assert.deepEqual(got, walked, `${dt} ${rr}`);
    if (/COUNT=(2513|1080|415|94)\b/.test(rr)) assert.ok(got.length > 0 && got.length < 31, `${rr}: the series ends inside the window (${got.length})`);
  }
});

test('a crafted RRULE cannot spin: INTERVAL=0, negative or junk is 1; a DTSTART in year 1 or an unknown FREQ is quick', () => {
  const at = D('2026-11-26T00:00:00Z');
  for (const rr of ['FREQ=DAILY;INTERVAL=0', 'FREQ=WEEKLY;INTERVAL=-3', 'FREQ=DAILY;INTERVAL=x', 'FREQ=SECONDLY', 'FREQ=DAILY;COUNT=-1']) {
    assert.equal(ics.parseRrule(rr).interval >= 1, true);
    const feed = ics.parseIcs(wrap(['BEGIN:VEVENT', 'UID:z', 'SUMMARY:z', 'DTSTART;TZID=Europe/Berlin:20260101T090000', `RRULE:${rr}`, 'END:VEVENT']));
    const [t] = ms(() => ics.expand(feed, at, at + 86400000));
    assert.ok(t < 50, `${rr}: ${t.toFixed(0)} ms`);
  }
  const zero = ics.parseIcs(wrap(['BEGIN:VEVENT', 'UID:z', 'SUMMARY:z', 'DTSTART:20261120T090000Z', 'RRULE:FREQ=DAILY;INTERVAL=0', 'END:VEVENT']));
  assert.equal(ics.expand(zero, at, at + 2 * 86400000).length, 2, 'INTERVAL=0 reads as every day');
  for (const dt of ['DTSTART;TZID=Europe/Berlin:00010101T090000', 'DTSTART:00010101T090000Z', 'DTSTART;VALUE=DATE:00010101']) {
    for (const rr of ['FREQ=DAILY', 'FREQ=WEEKLY', 'FREQ=MONTHLY', 'FREQ=YEARLY', 'FREQ=DAILY;COUNT=100000']) {
      const feed = ics.parseIcs(wrap(['BEGIN:VEVENT', 'UID:y', 'SUMMARY:y', dt, `RRULE:${rr}`, 'END:VEVENT']));
      const [t] = ms(() => ics.expand(feed, at, at + 86400000));
      assert.ok(t < 50, `${dt} ${rr}: ${t.toFixed(0)} ms`);
    }
  }
});

test('expandCached: the same answer as expand, computed once per feed load and day window', () => {
  const feed = oldFeed(), at = D('2026-11-26T12:00:00Z');
  const a = ics.expandCached(feed, at - 6 * 3600000, at + 3600000);
  assert.deepEqual(a, ics.expand(feed, at - 6 * 3600000, at + 3600000));
  const [t, b] = ms(() => ics.expandCached(feed, at + 4000 - 6 * 3600000, at + 4000 + 3600000));
  assert.ok(t < 5, `a detector tick 4 s later is served from the cache (${t.toFixed(2)} ms)`);
  assert.deepEqual(b, ics.expand(feed, at + 4000 - 6 * 3600000, at + 4000 + 3600000));
  const reloaded = oldFeed();   // a reload is a new array: never the old answer
  assert.notEqual(ics.expandCached(reloaded, at - 6 * 3600000, at + 3600000), a);
});

// ---- all-day events are local dates (floating, like Google's), recurring or not, in any machine time zone ----
test('all-day recurring events, EXDATE and RECURRENCE-ID land on the right local day outside UTC', () => {
  const { execFileSync } = require('node:child_process');
  const script = `
    const ics = require(${JSON.stringify(require.resolve('../src/meetings/ics'))});
    const wrap = (...e) => ['BEGIN:VCALENDAR', ...e.flat(), 'END:VCALENDAR'].join('\\r\\n');
    const feed = ics.parseIcs(wrap(
      ['BEGIN:VEVENT', 'UID:a', 'SUMMARY:Gym', 'DTSTART;VALUE=DATE:20261102', 'DTEND;VALUE=DATE:20261103', 'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE;VALUE=DATE:20261109', 'END:VEVENT'],
      ['BEGIN:VEVENT', 'UID:a', 'RECURRENCE-ID;VALUE=DATE:20261116', 'SUMMARY:Gym (moved)', 'DTSTART;VALUE=DATE:20261117', 'DTEND;VALUE=DATE:20261118', 'END:VEVENT'],
      ['BEGIN:VEVENT', 'UID:b', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20261201', 'END:VEVENT']));
    const day = (ms) => { const d = new Date(ms); return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()].join('-'); };
    const out = ics.expand(feed, new Date(2026, 9, 1).getTime(), new Date(2027, 0, 1).getTime());
    process.stdout.write(JSON.stringify(out.map((o) => o.summary + ' ' + day(o.start) + ' ' + o.allDay)));`;
  for (const TZ of ['Europe/Berlin', 'America/New_York', 'UTC', 'Asia/Kolkata']) {
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ } }).toString());
    assert.deepEqual(out, ['Gym 2026-11-2-0 true', 'Gym (moved) 2026-11-17-0 true', 'Gym 2026-11-23-0 true', 'Holiday 2026-12-1-0 true'], TZ);
  }
});
