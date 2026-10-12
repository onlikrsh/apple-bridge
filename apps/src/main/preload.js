'use strict';
// The whole surface the pages can reach. Pages run sandboxed with context
// isolation; they never see Node or the filesystem directly.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (arg) => ipcRenderer.invoke(channel, arg);
const listen = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  info: invoke('app:info'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  onTheme: listen('theme'),
  win: {
    close: () => ipcRenderer.send('win:close'),
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    state: invoke('win:state'),
    onState: listen('win:state'),
  },
  sync: {
    status: invoke('sync:status'),
    onStatus: listen('sync:status'),
  },
  notes: {
    scan: invoke('notes:scan'),
    read: invoke('notes:read'),
    write: invoke('notes:write'),
    create: invoke('notes:create'),
    remove: invoke('notes:remove'),
    move: invoke('notes:move'),
    createFolder: invoke('notes:create-folder'),
    sync: invoke('notes:sync'),
    onChanged: listen('notes:changed'),
  },
  calendar: {
    calendars: invoke('calendar:calendars'),
    events: invoke('calendar:events'),
    save: invoke('calendar:save'),
    remove: invoke('calendar:delete'),
    sync: invoke('calendar:sync'),
    onChanged: listen('calendar:changed'),
  },
  reminders: {
    cached: invoke('reminders:cached'),
    load: invoke('reminders:load'),
    add: invoke('reminders:add'),
    edit: invoke('reminders:edit'),
    done: invoke('reminders:done'),
    remove: invoke('reminders:remove'),
  },
});
