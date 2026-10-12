'use strict';
// Builds a demo account under DIR for screenshots and end-to-end tests:
// a Notes vault, iCloud-style calendar vdirs, a Reminders dump, and a fake
// `abridge` that serves them. Nothing here talks to Apple.
//
//   node test/make-fixture.js DIR   -> prints the ABRIDGE_BIN to use

const fs = require('node:fs');
const path = require('node:path');

const dir = path.resolve(process.argv[2] || 'fixture');
fs.rmSync(dir, { recursive: true, force: true });
const now = new Date();
const day = 86400000;
const at = (offsetDays, hour = 9, minute = 0) => {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays, hour, minute);
  return d;
};

function write(file, text, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

// ---------------------------------------------------------------- notes
const notes = path.join(dir, 'Notes');
write(path.join(notes, '.icloud-md', 'state.json'), JSON.stringify({ titleMode: 'in-body' }));
const fm = (id) => `---\napple-note-id: "${id}"\n---\n\n`;
const N = [
  ['Notes/Grocery List.md', `${fm('N1')}# Grocery List\n\n- [ ] Oat milk\n- [x] Eggs\n- [ ] Basmati rice\n- [ ] Tomatoes\n- [x] Coffee beans\n- [ ] Paneer\n`, -0.02],
  ['Notes/Trip to Goa.md', `${fm('N2')}# Trip to Goa\n\nLeaving **Friday morning**, back on Monday night.\n\n## Packing\n\n- Sunscreen\n- Swimwear\n- Chargers and the *good* camera\n\n## Budget\n\n| Item | Cost |\n| --- | --- |\n| Flights | 9,400 |\n| Hotel | 12,000 |\n| Food | 6,000 |\n\n> Check in opens 48 hours before the flight.\n`, -0.1],
  ['Notes/Ideas.md', `${fm('N3')}# Ideas\n\nA running list of things worth building.\n\n1. Endless runner with two element twins\n2. Menu bar weather app\n3. A tiny habit tracker that lives in Reminders\n`, -1.2],
  ['Work/Standup notes.md', `${fm('N4')}# Standup notes\n\n### Monday\n\nShipped the calendar sync. Next: <u>recurring events</u> and drag to resize.\n\n\`\`\`\nabridge sync calendar\n\`\`\`\n`, -3],
  ['Work/Interview questions.md', `${fm('N5')}# Interview questions\n\n- Tell me about a hard bug you fixed\n- How do you review code?\n- What would you change about our product?\n`, -5],
  ['Notes/Masala Chai.md', `${fm('N6')}# Masala Chai\n\nFor two cups.\n\n1. Boil 1 cup water with ginger and cardamom\n2. Add 2 tsp tea and simmer for 2 minutes\n3. Add 1 cup milk and sugar, bring to a boil\n4. Strain and serve\n`, -12],
  ['Personal/Books to read.md', `${fm('N7')}# Books to read\n\n- [ ] The Pragmatic Programmer\n- [x] Atomic Habits\n- [ ] Designing Data-Intensive Applications\n`, -20],
  ['Notes/Wi-Fi passwords.md', `${fm('N8')}# Wi-Fi at the office\n\nGuest network is on the board near reception.\n`, -45],
  ['Personal/Car service.md', `${fm('N9')}# Car service\n\nNext service due at 30,000 km. Ask about the brake pads.\n`, -120],
];
for (const [rel, text, offset] of N) write(path.join(notes, rel), text, new Date(now.getTime() + offset * day));
fs.mkdirSync(path.join(notes, 'Recipes'), { recursive: true });

// ------------------------------------------------------------- calendars
const cals = path.join(dir, 'calendars');
const calendars = [
  ['home', 'Home', '#34AADCFF'],
  ['work', 'Work', '#FF9500FF'],
  ['family', 'Family', '#CC73E1FF'],
  ['fitness', 'Fitness', '#65DB39FF'],
];
for (const [id, name, color] of calendars) {
  write(path.join(cals, id, 'displayname'), name);
  write(path.join(cals, id, 'color'), color);
}
write(path.join(cals, 'stub', 'displayname'), 'Reminders ⚠️');

const utc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
let n = 0;
function event(cal, title, start, end, extra = '') {
  n += 1;
  const allDay = typeof start === 'string';
  const dt = allDay ? `DTSTART;VALUE=DATE:${start}\r\nDTEND;VALUE=DATE:${end}` : `DTSTART:${utc(start)}\r\nDTEND:${utc(end)}`;
  write(
    path.join(cals, cal, `E${n}.ics`),
    `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//iPhone OS 26.0//EN\r\nBEGIN:VEVENT\r\nUID:E${n}\r\nDTSTAMP:20261001T000000Z\r\n${dt}\r\nSUMMARY:${title}\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`,
  );
}
const weekStart = -now.getDay(); // Sunday of this week
event('work', 'Team standup', at(weekStart + 1, 9, 30), at(weekStart + 1, 9, 45), `RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR\r\nLOCATION:Zoom\r\n`);
event('work', 'Design review', at(weekStart + 2, 11), at(weekStart + 2, 12, 30), 'LOCATION:Room 4\r\n');
event('work', '1:1 with Priya', at(weekStart + 3, 15), at(weekStart + 3, 15, 30));
event('work', 'Sprint planning', at(weekStart + 4, 10), at(weekStart + 4, 12));
event('home', 'Dentist', at(weekStart + 2, 17), at(weekStart + 2, 18), 'LOCATION:Smile Clinic\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT30M\r\nDESCRIPTION:x\r\nEND:VALARM\r\n');
event('home', 'Groceries', at(weekStart + 6, 10), at(weekStart + 6, 11));
event('family', 'Dinner with parents', at(weekStart + 5, 19, 30), at(weekStart + 5, 21, 30));
event('family', "Amma's birthday", ymd(at(weekStart + 4)), ymd(at(weekStart + 5)), 'RRULE:FREQ=YEARLY\r\n');
event('fitness', 'Gym', at(weekStart + 1, 7), at(weekStart + 1, 8), 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\r\n');
event('fitness', 'Run', at(weekStart + 6, 6, 30), at(weekStart + 6, 7, 15));
event('home', 'Goa trip', ymd(at(weekStart + 12)), ymd(at(weekStart + 15)));
event('work', 'Quarterly review', at(weekStart + 9, 14), at(weekStart + 9, 16));
event('home', 'Car service', at(weekStart + 17, 9), at(weekStart + 17, 11));
event('family', 'Movie night', at(weekStart + 20, 20), at(weekStart + 20, 22, 30));
event('work', 'Lunch with team', at(weekStart + 3, 12, 30), at(weekStart + 3, 13, 30));

// ------------------------------------------------------------- reminders
const iso = (d) => d.toISOString();
const R = (id, list, title, extra = {}) => ({
  id: `${id}-0000-4000-8000-000000000000`, short: id, list_id: list, title, notes: '', completed: false, completed_date: null,
  due: null, all_day: false, due_label: '', priority: 0, flagged: false, parent_id: null, created: iso(at(-10)), modified: iso(at(-1)), ...extra,
});
const allDay = (offset) => ({ due: `${ymd(at(offset)).replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3')}T00:00:00+00:00`, all_day: true });
const timed = (offset, hh, mm = 0) => ({ due: iso(at(offset, hh, mm)), all_day: false });
const reminders = {
  lists: [
    { id: 'L-REMINDERS', title: 'Reminders', color: '#0A84FF', open: 4 },
    { id: 'L-SHOPPING', title: 'Shopping', color: '#FF9500', open: 3 },
    { id: 'L-WORK', title: 'Work', color: '#FF2D55', open: 3 },
    { id: 'L-HOME', title: 'Home', color: '#34C759', open: 2 },
  ],
  reminders: [
    R('A1000001', 'L-REMINDERS', 'Call the bank about the card', { ...timed(0, 11), priority: 1 }),
    R('A1000002', 'L-REMINDERS', 'Renew passport', { ...allDay(-2), flagged: true, notes: 'Appointment at the Seva Kendra' }),
    R('A1000003', 'L-REMINDERS', 'Pay electricity bill', allDay(0)),
    R('A1000004', 'L-REMINDERS', 'Book Goa hotel', { ...allDay(3), flagged: true }),
    R('A1000005', 'L-SHOPPING', 'Oat milk'),
    R('A1000006', 'L-SHOPPING', 'Basmati rice'),
    R('A1000007', 'L-SHOPPING', 'Birthday gift for Amma', { ...allDay(4), flagged: true }),
    R('A1000008', 'L-WORK', 'Review pull request', { ...timed(0, 16), priority: 5 }),
    R('A1000009', 'L-WORK', 'Prepare sprint demo', { ...allDay(1), notes: 'Calendar drag and drop + recurring events' }),
    R('A1000010', 'L-WORK', 'Write release notes', allDay(5)),
    R('A1000011', 'L-WORK', 'Screenshots for the README', { parent_id: 'A1000010-0000-4000-8000-000000000000', short: 'A1000011' }),
    R('A1000012', 'L-HOME', 'Water the plants', timed(0, 18, 30)),
    R('A1000013', 'L-HOME', 'Fix the kitchen tap'),
  ],
};
for (const r of reminders.reminders) if (r.due) r.due_label = r.all_day ? r.due.slice(0, 10) : new Date(r.due).toISOString().slice(0, 16).replace('T', ' ');
write(path.join(dir, 'reminders.json'), JSON.stringify(reminders));

// ---------------------------------------------------------- fake abridge
const bin = path.join(dir, 'bin', 'abridge');
write(
  bin,
  `#!/bin/sh
# Fake abridge for screenshots and tests. Logs every call.
echo "$*" >> "${dir}/abridge.log"
case "$1" in
  paths)
    printf 'APPLE_ID=demo@icloud.com\\nNOTES_DIR=${notes}\\nCALENDAR_DIR=${cals}\\nREMINDERS_DIR=${dir}/rem\\nCONFIG_DIR=${dir}/config\\nSTATE_DIR=${dir}/state\\n' ;;
  notes|sync) exit 0 ;;
  rem)
    case "$2" in
      dump) cat "${dir}/reminders.json" ;;
      *) echo "ok" ;;
    esac ;;
esac
`,
);
fs.chmodSync(bin, 0o755);
console.log(bin);
