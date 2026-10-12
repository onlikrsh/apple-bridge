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
