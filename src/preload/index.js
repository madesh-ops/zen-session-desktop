'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('pomodoro', {
  timer: {
    get: () => ipcRenderer.invoke('timer:get'),
    start: () => ipcRenderer.send('timer:start'),
    pause: () => ipcRenderer.send('timer:pause'),
    toggle: () => ipcRenderer.send('timer:toggle'),
    reset: () => ipcRenderer.send('timer:reset'),
    skip: () => ipcRenderer.send('timer:skip'),
    setMode: (mode) => ipcRenderer.send('timer:mode', mode),
    onState: (handler) => on('timer:state', handler),
    onComplete: (handler) => on('timer:complete', handler)
  },
  window: {
    minimizeToPill: () => ipcRenderer.send('window:minimize-to-pill'),
    minimize: () => ipcRenderer.send('window:minimize'),
    close: () => ipcRenderer.send('window:close'),
    restore: () => ipcRenderer.send('window:restore'),
    quit: () => ipcRenderer.send('app:quit')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    onChanged: (handler) => on('settings:changed', handler)
  },
  sounds: {
    file: (id) => ipcRenderer.invoke('sounds:file', id)
  },
  media: {
    get: () => ipcRenderer.invoke('media:get'),
    onNow: (handler) => on('media:now', handler)
  },
  plan: {
    week: (weekKey) => ipcRenderer.invoke('plan:week', weekKey),
    add: (block) => ipcRenderer.invoke('plan:add', block),
    rename: (id, label) => ipcRenderer.invoke('plan:rename', id, label),
    remove: (id) => ipcRenderer.invoke('plan:remove', id),
    onChanged: (handler) => on('plan:changed', handler)
  }
});
