'use strict';

const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./store');
const { TimerCore } = require('./timer-core');
const { MediaWatcher } = require('./media');
const { createPillWindow, resizePill, startCursorWatch } = require('./pill-window');
const { registerIpc } = require('./ipc');
const { notifyComplete } = require('./notify');
const { registerToastIdentity } = require('./toast-identity');

// Points the whole app at a different data folder, for testing against a
// throwaway profile instead of the real one. It has to happen before the
// single-instance lock, which is keyed on this folder too, and before
// anything reads or writes the store.
if (process.env.ZEN_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.ZEN_USER_DATA));
}

// A second copy only exists to hand the first one a nudge (see
// 'second-instance' below) and leave. Everything else — windows, tray,
// shortcuts, the store — is registered inside start(), which only the copy
// holding the lock ever reaches. Otherwise the leaving copy would still build
// its own windows and, on the way out, flush its own idea of the data file.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let store = null;
let timer = null;
let media = null;
let mainWindow = null;
let pillWindow = null;
let tray = null;
let quitting = false;

// `reveal: false` builds the window without ever putting it on screen, for a
// launch that should open on the pill alone.
function createMainWindow({ reveal = true } = {}) {
  const saved = store.data.windowBounds;
  const usable = saved && Number.isFinite(saved.width) && Number.isFinite(saved.height);
  const win = new BrowserWindow({
    width: usable ? Math.max(860, Math.round(saved.width)) : 980,
    height: usable ? Math.max(640, Math.round(saved.height)) : 720,
    minWidth: 860,
    minHeight: 640,
    x: saved && Number.isFinite(saved.x) ? saved.x : undefined,
    y: saved && Number.isFinite(saved.y) ? saved.y : undefined,
    show: false,
    frame: false,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  forwardConsole(win, 'main-window');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (reveal) win.once('ready-to-show', () => win.show());

  const saveBounds = () => {
    if (!win.isDestroyed() && !win.isMinimized() && !win.isMaximized()) {
      const b = win.getBounds();
      store.setWindowBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    }
  };
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);

  // The window button and the OS minimize button both mean the same thing here:
  // hand off to the pill.
  win.on('minimize', (event) => {
    event.preventDefault();
    showPill();
  });

  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      showPill();
    }
  });

  return win;
}

// Renderer errors are invisible otherwise — surface them on the terminal in dev.
function forwardConsole(win, tag) {
  if (app.isPackaged) return;
  win.webContents.on('console-message', (_event, level, message, line, source) => {
    if (level >= 2) {
      const file = String(source || '').split('/').pop();
      console.log(`[${tag}] ${message}  (${file}:${line})`);
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log(`[${tag}] render process gone:`, details.reason);
  });
}

function broadcast(channel, payload) {
  for (const win of [mainWindow, pillWindow]) {
    if (!win || win.isDestroyed()) continue;
    const contents = win.webContents;
    if (!contents || contents.isDestroyed()) continue;
    try {
      contents.send(channel, payload);
    } catch {
      // The render frame can be disposed between the check and the send —
      // during shutdown, or after a renderer crash. Dropping the message is
      // correct: state is pushed again as soon as a window comes back.
    }
  }
}

function showPill() {
  if (!pillWindow || pillWindow.isDestroyed()) {
    pillWindow = createPillWindow(store);
    wirePill();
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  pillWindow.showInactive();
  pushState();
  pushMedia();
}

function wirePill() {
  forwardConsole(pillWindow, 'pill');
  const stopWatch = startCursorWatch(pillWindow);
  pillWindow.on('closed', () => {
    stopWatch();
    pillWindow = null;
  });
}

function restoreWindow() {
  if (pillWindow && !pillWindow.isDestroyed()) pillWindow.hide();
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  pushState();
  pushMedia();
}

function pushState() {
  broadcast('timer:state', timer.state);
}

function pushMedia() {
  const showMedia = store.settings.showMedia;
  const payload = showMedia ? media.current : null;
  broadcast('media:now', payload);
  resizePill(pillWindow, Boolean(payload));
}

function buildTray() {
  // Packaged builds copy `resources/` beside the asar; development runs from
  // source. A PNG rather than the .ico on purpose: Electron reports an .ico as
  // 256x256 and upscales it, which renders blurry in the notification area.
  // createFromPath picks up tray@2x.png beside it for high-DPI displays.
  const roots = [
    process.resourcesPath ? path.join(process.resourcesPath, 'resources') : null,
    path.join(app.getAppPath(), 'resources')
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, 'tray.png'), path.join(root, 'icon.ico'));
  }

  let image = nativeImage.createEmpty();
  for (const iconPath of candidates) {
    if (fs.existsSync(iconPath)) {
      image = nativeImage.createFromPath(iconPath);
      break;
    }
  }
  tray = new Tray(image);
  tray.setToolTip('Zen Session');
  refreshTrayMenu();
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) showPill();
    else restoreWindow();
  });
}

function refreshTrayMenu() {
  if (!tray) return;
  const state = timer.state;
  const menu = Menu.buildFromTemplate([
    { label: labelFor(state), enabled: false },
    { type: 'separator' },
    { label: state.running ? 'Pause' : 'Start', click: () => timer.toggle() },
    { label: 'Reset', click: () => timer.reset() },
    { label: 'Skip', click: () => timer.skip() },
    { type: 'separator' },
    { label: 'Open window', click: () => restoreWindow() },
    { label: 'Show pill', click: () => showPill() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
}

function labelFor(state) {
  const total = Math.max(0, state.remainingMs);
  const mins = Math.floor(total / 60000);
  const secs = Math.floor((total % 60000) / 1000);
  const clock = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  const name = state.mode === 'focus' ? 'Focus' : state.mode === 'short' ? 'Short break' : 'Long break';
  return `${name} — ${clock}${state.running ? '' : ' (paused)'}`;
}

function start() {
  // Windows groups taskbar items and attributes notifications by this id.
  app.setAppUserModelId('com.zensession.desktop');
  app.setName('Zen Session');

  app.on('second-instance', () => restoreWindow());

  app.whenReady().then(() => {
    // Without this the toast is headed by the raw AppUserModelID. It reads the
    // registry before it writes, so an ordinary launch only looks.
    registerToastIdentity();

    store = new Store();
    timer = new TimerCore(store);
    media = new MediaWatcher();

    let trayTick = 0;
    timer.on('state', (state) => {
      broadcast('timer:state', state);
      // The tray label only needs second resolution, not every 250ms tick.
      if (++trayTick % 4 === 0) refreshTrayMenu();
    });

    timer.on('complete', (info) => {
      broadcast('timer:complete', info);
      refreshTrayMenu();
      // A finished focus session belongs on the timetable straight away.
      broadcast('plan:changed', null);
      // The whole point of the toast is to reach you when the app is not on
      // screen, so clicking it brings the window back rather than the pill.
      notifyComplete(info, store.settings, () => restoreWindow());
    });

    media.on('media', () => pushMedia());
    if (store.settings.showMedia) media.start();

    // Launch at login registers the app with --pill: signing in should leave a
    // quiet pill in the corner, not a window across the desktop. The main
    // window is still built, only kept off screen until it is asked for.
    const startAsPill = process.argv.includes('--pill');

    mainWindow = createMainWindow({ reveal: !startAsPill });
    pillWindow = createPillWindow(store);
    wirePill();

    registerIpc({
      ipcMain,
      store,
      timer,
      media,
      getWindows: () => ({ mainWindow, pillWindow }),
      showPill,
      restoreWindow,
      pushState,
      pushMedia,
      broadcast,
      quit: () => {
        quitting = true;
        app.quit();
      }
    });

    buildTray();

    if (startAsPill) showPill();

    globalShortcut.register('Control+Alt+P', () => timer.toggle());
    globalShortcut.register('Control+Alt+O', () => {
      if (mainWindow && mainWindow.isVisible()) showPill();
      else restoreWindow();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  });

  // Closing the main window drops to the pill, so the app deliberately does not
  // quit on 'window-all-closed'. Quitting happens from the tray.
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (media) media.stop();
    if (timer) timer.dispose();
    if (store) store.flush();
  });
}

if (gotLock) start();
