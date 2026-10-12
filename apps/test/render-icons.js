'use strict';
// Renders share/icons/*.svg to 256 px PNGs in apps/icons/ (the window icon;
// Electron can't use SVG for that). Run with Electron:
//   electron test/render-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../../share/icons');
const OUT = path.resolve(__dirname, '../icons');

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: 256, height: 256, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  for (const name of ['notes', 'calendar', 'reminders']) {
    const svg = fs.readFileSync(path.join(SRC, `abridge-${name}.svg`), 'utf8');
    await win.loadURL(`data:text/html,<html><body style="margin:0;background:transparent"><img width="256" height="256" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`);
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.resize({ width: 256, height: 256 }).toPNG());
  }
  app.exit(0);
});
