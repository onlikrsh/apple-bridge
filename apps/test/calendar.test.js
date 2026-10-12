'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TZ = 'Asia/Kolkata';
const { CalendarStore, normColor } = require('../src/main/calendar');

const crlf = (s) => s.trim().split('\n').join('\r\n') + '\r\n';
const VTZ = `BEGIN:VTIMEZONE
TZID:Asia/Kolkata
BEGIN:STANDARD
DTSTART:19451015T000000
TZOFFSETFROM:+0630
TZOFFSETTO:+0530
TZNAME:IST
END:STANDARD
END:VTIMEZONE`;

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-'));
  const home = path.join(root, 'home-uuid');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'displayname'), 'Home');
  fs.writeFileSync(path.join(home, 'color'), '#34AADCFF');
  const stub = path.join(root, 'stub');
  fs.mkdirSync(stub);
  fs.writeFileSync(path.join(stub, 'displayname'), 'Reminders ⚠️');
  fs.mkdirSync(path.join(root, 'work'));
  fs.writeFileSync(path.join(root, 'work', 'displayname'), 'Work');
  const write = (name, body, dir = home) => fs.writeFileSync(path.join(dir, name), crlf(`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Apple Inc.//iPhone OS 26.0//EN\n${VTZ}\n${body}\nEND:VCALENDAR`));
  return { root, home, s: new CalendarStore(root), write };
}

const OCT = [new Date('2026-10-01T00:00:00+05:30'), new Date('2026-11-01T00:00:00+05:30')];

test('calendars: names, colors, and the Reminders stub hidden', () => {
  const { s } = store();
  assert.deepEqual(s.calendars(), [
    { id: 'home-uuid', name: 'Home', color: '#34AADC' },
    { id: 'work', name: 'Work', color: '#1BADF8' },
  ]);
  assert.equal(normColor('#1badf8ff'), '#1BADF8');
});

test('timed event in a VTIMEZONE, all-day event, and range filtering', () => {
  const { s, write } = store();
  write('a.ics', `BEGIN:VEVENT\nUID:a\nDTSTAMP:20261001T000000Z\nDTSTART;TZID=Asia/Kolkata:20261015T100000\nDTEND;TZID=Asia/Kolkata:20261015T113000\nSUMMARY:Dentist\nLOCATION:Clinic\nBEGIN:VALARM\nACTION:DISPLAY\nTRIGGER:-PT15M\nDESCRIPTION:x\nEND:VALARM\nEND:VEVENT`);
  write('b.ics', `BEGIN:VEVENT\nUID:b\nDTSTAMP:20261001T000000Z\nDTSTART;VALUE=DATE:20261020\nDTEND;VALUE=DATE:20261022\nSUMMARY:Trip\nEND:VEVENT`);
  write('c.ics', `BEGIN:VEVENT\nUID:c\nDTSTAMP:20261001T000000Z\nDTSTART:20261201T090000Z\nDTEND:20261201T100000Z\nSUMMARY:Later\nEND:VEVENT`);
  const evs = s.events(...OCT);
  assert.deepEqual(evs.map((e) => e.title), ['Dentist', 'Trip']);
  const [dentist, trip] = evs;
  assert.equal(dentist.start, '2026-10-15T04:30:00.000Z');
  assert.equal(dentist.end, '2026-10-15T06:00:00.000Z');
  assert.equal(dentist.alarm, 15);
  assert.equal(dentist.location, 'Clinic');
  assert.deepEqual([trip.allDay, trip.start, trip.end], [true, '2026-10-20', '2026-10-22']);
});

test('repeating events: weekly with an exception and an EXDATE, old daily and yearly rules', () => {
  const { s, write } = store();
  write('w.ics', `BEGIN:VEVENT\nUID:w\nDTSTAMP:20261001T000000Z\nDTSTART;TZID=Asia/Kolkata:20260907T090000\nDTEND;TZID=Asia/Kolkata:20260907T093000\nRRULE:FREQ=WEEKLY\nEXDATE;TZID=Asia/Kolkata:20261012T090000\nSUMMARY:Standup\nEND:VEVENT\nBEGIN:VEVENT\nUID:w\nDTSTAMP:20261001T000000Z\nRECURRENCE-ID;TZID=Asia/Kolkata:20261019T090000\nDTSTART;TZID=Asia/Kolkata:20261019T110000\nDTEND;TZID=Asia/Kolkata:20261019T113000\nSUMMARY:Standup (moved)\nEND:VEVENT`);
  write('d.ics', `BEGIN:VEVENT\nUID:d\nDTSTAMP:20150101T000000Z\nDTSTART:20150101T020000Z\nDTEND:20150101T021500Z\nRRULE:FREQ=DAILY\nSUMMARY:Meds\nEND:VEVENT`);
  write('y.ics', `BEGIN:VEVENT\nUID:y\nDTSTAMP:19950101T000000Z\nDTSTART;VALUE=DATE:19951003\nRRULE:FREQ=YEARLY\nSUMMARY:Birthday\nEND:VEVENT`);
  const evs = s.events(...OCT);
  const standups = evs.filter((e) => e.uid === 'w');
  assert.deepEqual(standups.map((e) => [e.start, e.title]), [
    ['2026-10-05T03:30:00.000Z', 'Standup'],
    ['2026-10-19T05:30:00.000Z', 'Standup (moved)'],
    ['2026-10-26T03:30:00.000Z', 'Standup'],
  ]);
  assert.equal(standups[1].exception, true);
  assert.deepEqual(standups[0].rrule, { freq: 'WEEKLY', interval: 1, count: null, until: null });
  assert.equal(evs.filter((e) => e.uid === 'd').length, 31);
  const bday = evs.find((e) => e.uid === 'y');
  assert.deepEqual([bday.start, bday.end, bday.allDay], ['2026-10-03', '2026-10-04', true]);
});

test('create, edit and delete round-trip through real .ics files', () => {
  const { s, home } = store();
  const made = s.save({
    calendarId: 'home-uuid', title: 'Lunch', start: '2026-10-16T07:00:00.000Z', end: '2026-10-16T08:00:00.000Z',
    allDay: false, location: 'Cafe', notes: 'with Ada', alarm: 30, rrule: null,
  });
  const text = fs.readFileSync(path.join(home, made.file), 'utf8');
  assert.match(text, /SUMMARY:Lunch\r\n/);
  assert.match(text, /DTSTART:20261016T070000Z\r\n/);
  assert.match(text, /TRIGGER:-PT30M\r\n/);
  assert.match(text, /PRODID:-\/\/apple-bridge\/\/Calendar\/\/EN/);

  let [lunch] = s.events(...OCT);
  s.save({ ...lunch, title: 'Long lunch', end: '2026-10-16T09:00:00.000Z', location: '', alarm: null });
  [lunch] = s.events(...OCT);
  assert.deepEqual([lunch.title, lunch.end, lunch.location, lunch.alarm], ['Long lunch', '2026-10-16T09:00:00.000Z', '', null]);
  assert.match(fs.readFileSync(path.join(home, made.file), 'utf8'), /SEQUENCE:2/);

  s.save({ ...lunch, toCalendarId: 'work' });
  assert.equal(s.events(...OCT)[0].calendarId, 'work');
  s.remove({ calendarId: 'work', file: made.file });
  assert.equal(s.events(...OCT).length, 0);
});

test('editing one occurrence moves the series; deleting one occurrence adds an EXDATE', () => {
  const { s, write, home } = store();
  write('w.ics', `BEGIN:VEVENT\nUID:w\nDTSTAMP:20261001T000000Z\nDTSTART;TZID=Asia/Kolkata:20261005T090000\nDTEND;TZID=Asia/Kolkata:20261005T093000\nRRULE:FREQ=WEEKLY;COUNT=4\nSUMMARY:Standup\nX-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC\nEND:VEVENT`);
  const second = s.events(...OCT)[1];
  // Drag the second occurrence one hour later: every occurrence moves, TZID kept.
  s.save({ ...second, start: '2026-10-12T04:30:00.000Z', end: '2026-10-12T05:00:00.000Z' });
  const text = fs.readFileSync(path.join(home, 'w.ics'), 'utf8');
  assert.match(text, /DTSTART;TZID=Asia\/Kolkata:20261005T100000/);
  assert.match(text, /X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC/);
  assert.deepEqual(s.events(...OCT).map((e) => e.start.slice(0, 16)), ['2026-10-05T04:30', '2026-10-12T04:30', '2026-10-19T04:30', '2026-10-26T04:30']);

  const third = s.events(...OCT)[2];
  s.remove({ calendarId: third.calendarId, file: third.file, scope: 'one', recurrenceId: third.recurrenceId });
  assert.deepEqual(s.events(...OCT).map((e) => e.start.slice(5, 10)), ['10-05', '10-12', '10-26']);
});

test('all-day create and bad ids', () => {
  const { s } = store();
  s.save({ calendarId: 'home-uuid', title: 'Holiday', start: '2026-10-02', end: '2026-10-03', allDay: true });
  const [h] = s.events(...OCT);
  assert.deepEqual([h.start, h.end, h.allDay], ['2026-10-02', '2026-10-03', true]);
  assert.throws(() => s.save({ calendarId: '../x', title: 't', start: '2026-10-02', end: '2026-10-03', allDay: true }), /bad calendar/);
  assert.throws(() => s.remove({ calendarId: 'home-uuid', file: '../../x.ics' }), /bad file/);
});
