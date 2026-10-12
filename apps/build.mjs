// Bundles the apps into dist/: the main process and preload for Node, each
// app's page for Chromium. dist/ is committed, so installing needs only
// Electron itself (`pacman -S electron`), no npm.
import { build } from 'esbuild';
import fs from 'node:fs';

const APPS = ['notes', 'calendar', 'reminders'];
const common = { bundle: true, logLevel: 'warning', legalComments: 'none', minify: process.argv.includes('--minify') };

fs.rmSync('dist', { recursive: true, force: true });

await build({ ...common, entryPoints: ['src/main/main.js'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', target: 'node20', external: ['electron'] });
await build({ ...common, entryPoints: ['src/main/preload.js'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', target: 'node20', external: ['electron'] });

for (const app of APPS) {
  if (!fs.existsSync(`src/ui/${app}/app.js`)) continue;
  await build({ ...common, entryPoints: [`src/ui/${app}/app.js`], outfile: `dist/ui/${app}/app.js`, platform: 'browser', format: 'iife', target: 'chrome120' });
  fs.copyFileSync(`src/ui/${app}/index.html`, `dist/ui/${app}/index.html`);
}
fs.cpSync('icons', 'dist/icons', { recursive: true });
console.log('built', fs.readdirSync('dist/ui').join(', '));
