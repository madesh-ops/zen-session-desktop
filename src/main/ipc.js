'use strict';

const { app } = require('electron');

const { readSound } = require('./sounds');

function registerIpc(ctx) {
  const { ipcMain, store, timer, media, getWindows, showPill, restoreWindow, pushState, pushMedia, broadcast, quit } = ctx;

  // --- timer -------------------------------------------------------------
  ipcMain.handle('timer:get', () => timer.state);
  ipcMain.on('timer:start', () => timer.start());
  ipcMain.on('timer:pause', () => timer.pause());
  ipcMain.on('timer:toggle', () => timer.toggle());
  ipcMain.on('timer:reset', () => timer.reset());
  ipcMain.on('timer:skip', () => timer.skip());
  ipcMain.on('timer:mode', (_event, mode) => timer.setMode(mode));

  // --- window ------------------------------------------------------------
  ipcMain.on('window:minimize-to-pill', () => showPill());
  ipcMain.on('window:restore', () => restoreWindow());

  ipcMain.on('window:minimize', () => {
    const { mainWindow } = getWindows();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    showPill();
  });
  ipcMain.on('window:close', () => showPill());
  ipcMain.on('app:quit', () => quit());

  // --- settings ----------------------------------------------------------
  ipcMain.handle('settings:get', () => store.settings);
  ipcMain.handle('settings:set', (_event, patch) => {
    const before = store.settings;
    const next = store.updateSettings(patch || {});

    if (patch && 'launchAtLogin' in patch) {
      try {
        app.setLoginItemSettings({ openAtLogin: Boolean(patch.launchAtLogin), args: ['--pill'] });
      } catch (err) {
        console.warn('[ipc] could not change the login item:', err.message);
      }
    }

    if (patch && 'showMedia' in patch && patch.showMedia !== before.showMedia) {
      if (patch.showMedia) media.start();
      else media.stop();
      pushMedia();
    }

    if (patch && 'pillAlwaysOnTop' in patch) {
      const { pillWindow } = getWindows();
      if (pillWindow && !pillWindow.isDestroyed()) {
        pillWindow.setAlwaysOnTop(Boolean(patch.pillAlwaysOnTop), 'screen-saver');
      }
    }

    // Hand over the patch so the timer can tell a new focus length from a theme
    // or sound change, which must leave a paused interval exactly where it was.
    timer.settingsChanged(patch || {});
    broadcast('settings:changed', next);
    pushState();
    return next;
  });

  // --- sounds ------------------------------------------------------------
  // Null means there is no recording bundled for that id; the renderer falls
  // back to synthesising it, so this is an answer, not an error.
  ipcMain.handle('sounds:file', (_event, id) => readSound(id));

  // --- media -------------------------------------------------------------
  ipcMain.handle('media:get', () => (store.settings.showMedia ? media.current : null));

  // --- timetable ---------------------------------------------------------
  ipcMain.handle('plan:week', (_event, weekKey) => ({
    plan: store.plan.filter((b) => b.weekKey === weekKey),
    sessions: store.sessionsForWeek(weekKey)
  }));

  // The grid refuses a third block over the same minute before it asks, but the
  // store is what has to stay true, so the same rule is applied here as well.
  const MAX_OVERLAP = 2;

  function exceedsOverlapLimit(candidate) {
    const events = [];
    const same = store.plan.filter(
      (b) => b.weekKey === candidate.weekKey && b.day === candidate.day
    );
    for (const b of [...same, candidate]) {
      if ((b.kind || 'focus') !== 'focus') continue;
      if (b.endMin <= b.startMin) continue;
      events.push([b.startMin, 1], [b.endMin, -1]);
    }
    // Ends before starts: a block that finishes where the next begins does not
    // overlap it.
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    let depth = 0;
    for (const [, delta] of events) {
      depth += delta;
      if (depth > MAX_OVERLAP) return true;
    }
    return false;
  }

  ipcMain.handle('plan:add', (_event, block) => {
    const candidate = {
      weekKey: block.weekKey,
      day: block.day,
      startMin: block.startMin,
      endMin: block.endMin,
      kind: block.kind || 'focus'
    };
    if (exceedsOverlapLimit(candidate)) return null;

    const saved = store.addBlock({
      id: `b${Date.now()}${Math.floor(Math.random() * 1000)}`,
      weekKey: block.weekKey,
      day: block.day,
      startMin: block.startMin,
      endMin: block.endMin,
      label: block.label || 'Focus block',
      kind: block.kind || 'focus'
    });
    broadcast('plan:changed', null);
    return saved;
  });

  ipcMain.handle('plan:rename', (_event, id, label) => {
    const block = store.renameBlock(id, label);
    broadcast('plan:changed', null);
    return block;
  });

  ipcMain.handle('plan:remove', (_event, id) => {
    store.removeBlock(id);
    broadcast('plan:changed', null);
    return true;
  });
}

module.exports = { registerIpc };
