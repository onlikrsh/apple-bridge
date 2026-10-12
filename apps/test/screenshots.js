'use strict';
// Screenshots of the apps against the demo fixture, for review and the README.
//   node test/screenshots.js OUT_DIR [notes|calendar|reminders ...]
// Needs an X display (DISPLAY) and builds the fixture itself.

const { _electron } = require('playwright-core');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'screenshots');
const only = process.argv.slice(3);
fs.mkdirSync(out, { recursive: true });

async function launch(app, theme, fixture) {
  const home = fs.mkdtempSync(path.join(os.homedir(), '.abshot-'));
  const electronApp = await _electron.launch({
    executablePath: require('electron'),
    cwd: ROOT,
    args: ['--no-sandbox', '--disable-gpu', '.', `--app=${app}`],
    env: { ...process.env, HOME: home, ABRIDGE_BIN: path.join(fixture, 'bin', 'abridge'), ABRIDGE_APP_NO_SYNC: '1', ABRIDGE_APP_THEME: theme, DBUS_SESSION_BUS_ADDRESS: 'disabled:' },
  });
  const page = await electronApp.firstWindow();
  // A window that isn't in front gets no frames, and a screenshot waits for one.
  await electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.setBackgroundThrottling(false);
    w.show();
    w.focus();
    w.moveTop();
  });
  page.on('pageerror', (e) => console.error(`[${app}] page error:`, e.message));
  page.on('console', (m) => m.type() === 'error' && console.error(`[${app}] console:`, m.text()));
  await page.setViewportSize({ width: 1180, height: 740 });
  await page.emulateMedia({ colorScheme: theme }); // Playwright otherwise pins pages to light
  return { electronApp, page, home };
}

const SCENES = {
  async notes(page, shot) {
    await page.waitForSelector('.note-row');
    await page.locator('.note-row', { hasText: 'Trip to Goa' }).dispatchEvent('mousedown');
    await page.locator('.note-list').focus();
    await page.waitForTimeout(400);
    await shot('notes');
    await page.locator('.note-body h2').first().click();
    await page.locator('button[title="Format"]').click();
    await page.waitForTimeout(250);
    await shot('notes-format');
  },
  async calendar(page, shot) {
    await page.waitForSelector('.tg-grid, .month');
    await page.waitForTimeout(500);
    await shot('calendar-week');
    await page.locator('.segmented button', { hasText: 'Month' }).click();
    await page.waitForTimeout(400);
    await shot('calendar-month');
    await page.locator('.segmented button', { hasText: 'Week' }).click();
    await page.waitForTimeout(300);
    await page.locator('.event', { hasText: 'Design review' }).first().click();
    await page.waitForTimeout(300);
    await shot('calendar-event');
    await page.keyboard.press('Escape');
    await page.locator('.segmented button', { hasText: 'Year' }).click();
    await page.waitForTimeout(300);
    await shot('calendar-year');
  },
  async reminders(page, shot) {
    await page.waitForSelector('.tile');
    await page.waitForTimeout(400);
    await shot('reminders-today');
    await page.locator('.list-row', { hasText: 'Work' }).click();
    await page.waitForTimeout(300);
    await shot('reminders-list');
    await page.locator('.rem-row', { hasText: 'Prepare sprint demo' }).hover();
    await page.locator('.rem-row', { hasText: 'Prepare sprint demo' }).locator('.info').click();
    await page.waitForTimeout(300);
    await shot('reminders-info');
  },
};

(async () => {
  const fixture = fs.mkdtempSync(path.join(os.homedir(), '.abfix-'));
  execFileSync(process.execPath, [path.join(__dirname, 'make-fixture.js'), fixture]);
  const apps = only.length ? only : Object.keys(SCENES);
  for (const app of apps) {
    for (const theme of ['light', 'dark']) {
      const { electronApp, page, home } = await launch(app, theme, fixture);
      const shot = (name) => page.screenshot({ path: path.join(out, `${name}-${theme}.png`) });
      try {
        await SCENES[app](page, shot);
      } finally {
        await electronApp.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  }
  fs.rmSync(fixture, { recursive: true, force: true });
  console.log('screenshots in', out);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
