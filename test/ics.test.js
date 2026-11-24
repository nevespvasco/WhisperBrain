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
