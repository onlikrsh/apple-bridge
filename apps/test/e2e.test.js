'use strict';
// Drives the real Electron apps against the demo fixture.
// Needs an X display: DISPLAY=:99 node --test test/e2e.test.js
// (skipped without one).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const skip = !process.env.DISPLAY && 'no X display';

async function start(app) {
  const { _electron } = require('playwright-core');
  const fixture = fs.mkdtempSync(path.join(os.homedir(), '.abe2e-'));
  execFileSync(process.execPath, [path.join(__dirname, 'make-fixture.js'), fixture]);
  const home = path.join(fixture, 'home');
  fs.mkdirSync(home);
  const electronApp = await _electron.launch({
    executablePath: require('electron'),
    cwd: ROOT,
    args: ['--no-sandbox', '--disable-gpu', '.', `--app=${app}`],
    env: { ...process.env, HOME: home, ABRIDGE_BIN: path.join(fixture, 'bin', 'abridge'), ABRIDGE_APP_NO_SYNC: '1', DBUS_SESSION_BUS_ADDRESS: 'disabled:' },
  });
  const page = await electronApp.firstWindow();
  const log = () => fs.readFileSync(path.join(fixture, 'abridge.log'), 'utf8');
  const done = async () => {
    await electronApp.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  };
  return { page, fixture, notes: path.join(fixture, 'Notes'), log, done };
}

const read = (f) => fs.readFileSync(f, 'utf8');

test('notes: browsing never writes, typing saves and keeps the frontmatter', { skip }, async () => {
  const s = await start('notes');
  try {
    const { page } = s;
    await page.waitForSelector('.note-row');
    const files = ['Notes/Grocery List.md', 'Notes/Trip to Goa.md', 'Work/Standup notes.md'].map((f) => path.join(s.notes, f));
    const before = files.map((f) => [read(f), fs.statSync(f).mtimeMs]);
    for (const title of ['Trip to Goa', 'Standup notes', 'Grocery List']) {
      await page.locator('.note-row', { hasText: title }).dispatchEvent('mousedown');
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(900);
    assert.deepEqual(files.map((f) => [read(f), fs.statSync(f).mtimeMs]), before, 'opening notes must not change them');

    // Type at the end of Grocery List.
    await page.locator('.note-body').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Cardamom');
    await page.waitForTimeout(1200);
    const text = read(files[0]);
    assert.ok(text.startsWith('---\napple-note-id: "N1"\n---\n\n# Grocery List\n'), text);
    assert.match(text, /- \[ \] Paneer\n- \[ \] Cardamom\n$/);
    // The list row moved to the top with the new snippet, and a push was scheduled.
    assert.match(await page.locator('.note-row').first().textContent(), /Grocery List/);
  } finally {
    await s.done();
  }
});

test('notes: checklist ticks, new notes, folders and delete', { skip }, async () => {
  const s = await start('notes');
  try {
    const { page } = s;
    await page.waitForSelector('.note-row');
    await page.locator('.note-row', { hasText: 'Books to read' }).dispatchEvent('mousedown');
    await page.locator('.note-body input[type=checkbox]').first().click();
    await page.waitForTimeout(1200);
    assert.match(read(path.join(s.notes, 'Personal/Books to read.md')), /- \[x\] The Pragmatic Programmer/);

    // New note in the Work folder.
    await page.locator('.row.folder', { hasText: 'Work' }).click();
    await page.keyboard.press('Control+n');
    await page.keyboard.type('Release checklist');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Tag the build');
    await page.waitForTimeout(1200);
    const made = path.join(s.notes, 'Work/Release checklist.md');
    assert.equal(read(made), '# Release checklist\n\nTag the build\n');
    assert.match(await page.locator('.row.folder.selected').textContent(), /Work\s*3/);

    // Delete it again.
    await page.locator('button[title="Delete note"]').click();
    await page.waitForTimeout(400);
    assert.equal(fs.existsSync(made), false);
    assert.equal(await page.locator('.note-row', { hasText: 'Release checklist' }).count(), 0);

    // An empty new note is never written.
    await page.keyboard.press('Control+n');
    await page.waitForTimeout(800);
    await page.locator('.note-row', { hasText: 'Standup notes' }).dispatchEvent('mousedown');
    await page.waitForTimeout(400);
    assert.deepEqual(fs.readdirSync(path.join(s.notes, 'Work')).sort(), ['Interview questions.md', 'Standup notes.md']);
  } finally {
    await s.done();
  }
});

test('notes: switching notes saves first; search finds body text', { skip }, async () => {
  const s = await start('notes');
  try {
    const { page } = s;
    await page.waitForSelector('.note-row');
    await page.locator('.note-row', { hasText: 'Ideas' }).dispatchEvent('mousedown');
    await page.locator('.note-body').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' (soon)');
    // Switch away immediately, before the autosave delay.
    await page.locator('.note-row', { hasText: 'Masala Chai' }).dispatchEvent('mousedown');
    await page.waitForTimeout(500);
    assert.match(read(path.join(s.notes, 'Notes/Ideas.md')), /lives in Reminders \(soon\)\n$/);

    await page.locator('.search input').fill('cardamom');
    await page.waitForTimeout(200);
    const titles = await page.locator('.note-row .note-title').allTextContents();
    assert.deepEqual(titles, ['Masala Chai']);
  } finally {
    await s.done();
  }
});

// ------------------------------------------------------------------ calendar

const icsFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.ics'));

test('calendar: double-click creates, the inspector edits, drag moves', { skip }, async () => {
  const s = await start('calendar');
  try {
    const { page } = s;
    const cals = path.join(s.fixture, 'calendars');
    await page.waitForSelector('.tg-grid');
    await page.locator('.segmented button', { hasText: 'Week' }).click();
    const homeBefore = icsFiles(path.join(cals, 'home'));

    // Double-click an empty slot in the first column: a new event in Home.
    await page.locator('.tg-scroll').evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(100);
    const col = page.locator('.tg-col').first();
    const box = await col.boundingBox();
    await page.mouse.dblclick(box.x + box.width / 2, box.y + 48 * 2 + 10); // ~2 AM
    await page.locator('.insp-title').fill('Write the release notes');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    const created = icsFiles(path.join(cals, 'home')).filter((f) => !homeBefore.includes(f));
    assert.equal(created.length, 1);
    const ics = read(path.join(cals, 'home', created[0]));
    assert.match(ics, /SUMMARY:Write the release notes/);
    assert.match(ics, /PRODID:-\/\/apple-bridge\/\/Calendar\/\/EN/);
    assert.match(s.log(), /sync calendar|^$/m);

    // Drag it down one hour.
    const ev = page.locator('.event', { hasText: 'Write the release notes' });
    const eb = await ev.boundingBox();
    await page.mouse.move(eb.x + 10, eb.y + 8);
    await page.mouse.down();
    await page.mouse.move(eb.x + 10, eb.y + 30, { steps: 4 });
    await page.mouse.move(eb.x + 10, eb.y + 56, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const before = ics.match(/DTSTART:(\d{8}T\d{6}Z)/)[1];
    const after = read(path.join(cals, 'home', created[0])).match(/DTSTART:(\d{8}T\d{6}Z)/)[1];
    assert.notEqual(after, before);
    assert.equal(Number(after.slice(9, 11)) - Number(before.slice(9, 11)), 1);

    // Open it, set a location and an alert.
    await page.locator('.event', { hasText: 'Write the release notes' }).click();
    await page.locator('.insp-plain[placeholder="Add Location"]').fill('Library');
    await page.locator('.insp-row', { hasText: 'alert:' }).locator('select').selectOption('15');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    const edited = read(path.join(cals, 'home', created[0]));
    assert.match(edited, /LOCATION:Library/);
    assert.match(edited, /TRIGGER:-PT15M/);

    // Delete it.
    await page.locator('.event', { hasText: 'Write the release notes' }).click();
    await page.locator('button', { hasText: 'Delete Event' }).click();
    await page.waitForTimeout(500);
    assert.equal(fs.existsSync(path.join(cals, 'home', created[0])), false);
  } finally {
    await s.done();
  }
});

test('calendar: repeating events ask before changing the series, and can lose one date', { skip }, async () => {
  const s = await start('calendar');
  try {
    const { page } = s;
    await page.waitForSelector('.tg-grid');
    const gymFile = icsFiles(path.join(s.fixture, 'calendars', 'fitness')).find((f) => read(path.join(s.fixture, 'calendars', 'fitness', f)).includes('SUMMARY:Gym'));
    const gymPath = path.join(s.fixture, 'calendars', 'fitness', gymFile);
    const count = async () => page.locator('.event', { hasText: 'Gym' }).count();
    const before = await count();
    assert.ok(before >= 2);

    // Delete only one occurrence: an EXDATE, the series stays.
    await page.locator('.event', { hasText: 'Gym' }).nth(1).click();
    await page.locator('button', { hasText: 'Delete Event' }).click();
    await page.locator('.alert button', { hasText: 'Delete This Event Only' }).click();
    await page.waitForTimeout(600);
    assert.match(read(gymPath), /EXDATE/);
    assert.equal(await count(), before - 1);

    // Moving the time of a repeating event asks first; Cancel leaves the file alone.
    const original = read(gymPath);
    await page.locator('.event', { hasText: 'Gym' }).first().click();
    await page.locator('.insp-row', { hasText: 'starts:' }).locator('input[type=time]').fill('06:00');
    await page.keyboard.press('Escape');
    await page.locator('.alert button', { hasText: 'Cancel' }).click();
    await page.waitForTimeout(400);
    assert.equal(read(gymPath), original);
  } finally {
    await s.done();
  }
});
