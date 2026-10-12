'use strict';
// One Electron codebase, three apps: `electron apps --app=notes|calendar|reminders`.
// Each app gets its own userData directory and single-instance lock, so they
// run side by side like separate Mac apps.

const { app, BrowserWindow, ipcMain, nativeTheme, shell, protocol, net, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const abridge = require('./abridge');
const { NotesVault } = require('./notes');
const { CalendarStore } = require('./calendar');
const { Syncer } = require('./sync');

const APPS = {
  notes: { title: 'Notes', width: 1120, height: 720, minWidth: 720, minHeight: 440, dark: '#1e1e1e', light: '#ffffff' },
  calendar: { title: 'Calendar', width: 1240, height: 820, minWidth: 780, minHeight: 520, dark: '#1e1e1e', light: '#ffffff' },
  reminders: { title: 'Reminders', width: 940, height: 660, minWidth: 640, minHeight: 440, dark: '#1e1e1e', light: '#ffffff' },
};

const argApp = (process.argv.find((a) => a.startsWith('--app=')) || '--app=notes').slice(6);
const NAME = APPS[argApp] ? argApp : 'notes';
const CONF = APPS[NAME];

app.setName(`abridge-${NAME}`);
app.setPath('userData', path.join(app.getPath('appData'), `apple-bridge-${NAME}`));
protocol.registerSchemesAsPrivileged([{ scheme: 'vault', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let win = null;
let paths = {};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ------------------------------------------------------------------- window

const boundsFile = () => path.join(app.getPath('userData'), 'window.json');

function loadBounds() {
  try {
    return JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    fs.mkdirSync(path.dirname(boundsFile()), { recursive: true });
    fs.writeFileSync(boundsFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch {
    // Window state is a convenience.
  }
}

function createWindow() {
  const saved = loadBounds();
  win = new BrowserWindow({
    width: saved.width || CONF.width,
    height: saved.height || CONF.height,
    x: saved.x,
    y: saved.y,
    minWidth: CONF.minWidth,
    minHeight: CONF.minHeight,
    title: CONF.title,
    frame: false,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? CONF.dark : CONF.light,
    icon: path.join(__dirname, 'icons', `${NAME}.png`),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      additionalArguments: [`--abridge-app=${NAME}`],
    },
  });
  Menu.setApplicationMenu(null);
  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => {
    if (!process.env.ABRIDGE_APP_HIDDEN) win.show();
  });
  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));
  win.on('focus', () => send('win:state', { focused: true }));
  win.on('blur', () => send('win:state', { focused: false }));
  win.on('close', saveBounds);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on('context-menu', (_e, p) => showContextMenu(p));
  win.loadFile(path.join(__dirname, 'ui', NAME, 'index.html'));

  const shot = process.env.ABRIDGE_APP_SCREENSHOT;
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(shot, image.toPNG());
        app.exit(0);
      }, Number(process.env.ABRIDGE_APP_SCREENSHOT_DELAY || 2000));
    });
  }
}

function showContextMenu(p) {
  const items = [];
  if (p.misspelledWord) {
    for (const s of p.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
    }
    items.push({ label: 'Learn Spelling', click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
    items.push({ type: 'separator' });
  }
  if (p.isEditable) {
    items.push(
      { label: 'Cut', role: 'cut', enabled: p.editFlags.canCut },
      { label: 'Copy', role: 'copy', enabled: p.editFlags.canCopy },
      { label: 'Paste', role: 'paste', enabled: p.editFlags.canPaste },
      { type: 'separator' },
      { label: 'Select All', role: 'selectAll' },
    );
  } else if (p.selectionText) {
    items.push({ label: 'Copy', role: 'copy' });
  }
  if (p.linkURL && /^https?:/.test(p.linkURL)) {
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: 'Open Link', click: () => shell.openExternal(p.linkURL) });
  }
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
}

// -------------------------------------------------------------------- start

function start() {
  // Normally the system theme (GTK / the desktop portal) decides; tests force one.
  if (process.env.ABRIDGE_APP_THEME) nativeTheme.themeSource = process.env.ABRIDGE_APP_THEME;
  try {
    paths = abridge.readPaths();
  } catch (err) {
    paths = { error: `Could not run abridge: ${err.message}` };
  }

  ipcMain.handle('app:info', () => ({
    app: NAME,
    paths,
    appleId: paths.APPLE_ID || '',
    error: paths.error || null,
    dark: nativeTheme.shouldUseDarkColors,
  }));
  ipcMain.on('win:close', () => win && win.close());
  ipcMain.on('win:minimize', () => win && win.minimize());
  ipcMain.on('win:toggle-maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('win:state', () => ({ maximized: !!win && win.isMaximized(), focused: !!win && win.isFocused() }));
  ipcMain.on('open-external', (_e, url) => {
    if (/^(https?|mailto):/.test(String(url))) shell.openExternal(String(url));
  });
  nativeTheme.on('updated', () => send('theme', { dark: nativeTheme.shouldUseDarkColors }));

  if (NAME === 'notes') setupNotes();
  if (NAME === 'calendar') setupCalendar();
  if (NAME === 'reminders') setupReminders();
  createWindow();
}

function syncerFor(perform, onDone) {
  return new Syncer({
    perform,
    onStatus: (status) => send('sync:status', status),
    onDone,
  });
}

// -------------------------------------------------------------------- notes

function setupNotes() {
  const vault = new NotesVault(paths.NOTES_DIR || path.join(app.getPath('home'), 'Notes'));
  const syncer = syncerFor(
    async (kind) => {
      const result = await abridge.run(['notes', kind]);
      return { ok: result.ok, message: result.ok ? '' : abridge.errorLine(result) };
    },
    (kind) => {
      if (kind === 'pull') send('notes:changed');
    },
  );
  const changed = () => syncer.request('push', 4000);

  protocol.handle('vault', (req) => {
    const url = new URL(req.url);
    const full = vault.attachmentPath(url.searchParams.get('note') || '', url.searchParams.get('src') || '');
    if (!full) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(full).toString());
  });

  ipcMain.handle('notes:scan', () => ({ configured: vault.exists(), root: vault.root, ...vault.scan() }));
  ipcMain.handle('notes:read', (_e, id) => vault.read(id));
  ipcMain.handle('notes:write', (_e, { id, markdown, mtime }) => {
    const summary = vault.write(id, markdown, mtime);
    changed();
    return summary;
  });
  ipcMain.handle('notes:create', (_e, { folder, markdown }) => {
    const summary = vault.create(folder, markdown);
    changed();
    return summary;
  });
  ipcMain.handle('notes:remove', (_e, id) => {
    vault.remove(id);
    changed();
  });
  ipcMain.handle('notes:move', (_e, { id, folder }) => {
    const moved = vault.move(id, folder);
    changed();
    return moved;
  });
  ipcMain.handle('notes:create-folder', (_e, { parent, name }) => vault.createFolder(parent, name));
  ipcMain.handle('notes:sync', () => {
    syncer.request('push');
    syncer.request('pull');
  });
  ipcMain.handle('sync:status', () => syncer.status);

  if (vault.exists() && !process.env.ABRIDGE_APP_NO_SYNC) {
    syncer.request('pull');
    syncer.every('pull', 5 * 60 * 1000);
  }
  app.on('before-quit', async (event) => {
    if (syncer.timers.has('push') || syncer.running === 'push' || syncer.queue.includes('push')) {
      // Don't lose a pending push: flush it, then quit for real.
      event.preventDefault();
      syncer.request('push');
      await syncer.idle();
      app.exit(0);
    }
  });
}

// ----------------------------------------------------------------- calendar

function setupCalendar() {
  const store = new CalendarStore(paths.CALENDAR_DIR || path.join(app.getPath('home'), '.local/share/apple-bridge/calendars'));
  const syncer = syncerFor(
    async () => {
      const result = await abridge.run(['sync', 'calendar']);
      return { ok: result.ok, message: result.ok ? '' : abridge.errorLine(result) };
    },
    () => send('calendar:changed'),
  );
  const changed = () => syncer.request('sync', 1500);

  ipcMain.handle('calendar:calendars', () => ({ configured: store.exists(), calendars: store.calendars() }));
  ipcMain.handle('calendar:events', (_e, { start, end }) => store.events(new Date(start), new Date(end)));
  ipcMain.handle('calendar:save', (_e, event) => {
    const saved = store.save(event);
    changed();
    return saved;
  });
  ipcMain.handle('calendar:delete', (_e, req) => {
    store.remove(req);
    changed();
  });
  ipcMain.handle('calendar:sync', () => syncer.request('sync'));
  ipcMain.handle('sync:status', () => syncer.status);

  if (store.exists() && !process.env.ABRIDGE_APP_NO_SYNC) {
    syncer.request('sync');
    syncer.every('sync', 5 * 60 * 1000);
  }
}

// ---------------------------------------------------------------- reminders

function setupReminders() {
  const cacheFile = path.join(app.getPath('userData'), 'reminders.json');
  let status = { state: 'idle', message: '', lastSync: null };
  const setStatus = (patch) => {
    status = { ...status, ...patch };
    send('sync:status', status);
  };
  ipcMain.handle('sync:status', () => status);
  let chain = Promise.resolve();
  // CloudKit writes for one account go one at a time.
  const serial = (fn) => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  const mutate = (args) =>
    serial(async () => {
      setStatus({ state: 'syncing' });
      const result = await abridge.run(['rem', ...args]);
      setStatus(result.ok ? { state: 'idle', lastSync: Date.now() } : { state: 'error', message: abridge.errorLine(result) });
      return { ok: result.ok, message: result.ok ? result.stdout.trim() : abridge.errorLine(result) };
    });

  ipcMain.handle('reminders:cached', () => {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      return null;
    }
  });
  ipcMain.handle('reminders:load', (_e, { completed } = {}) =>
    serial(async () => {
      setStatus({ state: 'syncing' });
      const result = await abridge.run(['rem', 'dump', ...(completed ? ['--completed'] : [])]);
      if (!result.ok) {
        const message = abridge.errorLine(result);
        setStatus({ state: 'error', message });
        return { error: message };
      }
      const data = JSON.parse(result.stdout);
      data.fetched = Date.now();
      data.completedIncluded = !!completed;
      try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(data));
      } catch {
        // The cache only makes the next start faster.
      }
      setStatus({ state: 'idle', lastSync: Date.now() });
      return data;
    }),
  );
  ipcMain.handle('reminders:add', (_e, r) => {
    const args = ['add', r.listId, r.title];
    if (r.due) args.push('--due', r.due);
    if (r.notes) args.push('--notes', r.notes);
    if (r.priority && r.priority !== 'none') args.push('--priority', r.priority);
    if (r.flagged) args.push('--flag');
    if (r.parentId) args.push('--parent', r.parentId);
    return mutate(args);
  });
  ipcMain.handle('reminders:edit', (_e, r) => {
    const args = ['edit', r.id];
    if (r.title !== undefined) args.push('--title', r.title);
    if (r.notes !== undefined) args.push('--notes', r.notes);
    if (r.due === null) args.push('--no-due');
    else if (r.due) args.push('--due', r.due);
    if (r.priority) args.push('--priority', r.priority);
    if (r.flagged !== undefined) args.push(r.flagged ? '--flag' : '--no-flag');
    return mutate(args);
  });
  ipcMain.handle('reminders:done', (_e, { id, done }) => mutate([done ? 'done' : 'undo', id]));
  ipcMain.handle('reminders:remove', (_e, id) => mutate(['rm', id]));
}
