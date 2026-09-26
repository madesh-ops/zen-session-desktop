'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');

// The pill's visible size...
const PILL_COMPACT = { width: 240, height: 56 };
const PILL_MEDIA = { width: 300, height: 86 };

// ...plus a transparent margin around it, so the CSS shadow has somewhere to
// land. Without this the window is clipped to the pill, the soft rounded shadow
// is cut away entirely, and the only thing left on screen is the square shadow
// Windows draws around the window itself.
const PAD = 24;
const EDGE_MARGIN = 24;

const windowSizeFor = (pill) => ({
  width: pill.width + PAD * 2,
  height: pill.height + PAD * 2
});

function createPillWindow(store) {
  const win = new BrowserWindow({
    ...windowSizeFor(PILL_COMPACT),
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // The constructor option is not always honoured for transparent windows on
  // Windows, so say it again once the window exists.
  win.setHasShadow(false);

  // 'screen-saver' keeps it above full-screen apps, which is the whole point of it.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Start click-through: the transparent margin must not swallow clicks meant
  // for whatever is behind it. startCursorWatch below turns this off again
  // whenever the cursor is actually over the pill.
  win.setIgnoreMouseEvents(true, { forward: true });

  const saved = store.data.pillBounds;
  if (saved && isOnScreen(saved)) {
    win.setPosition(saved.x, saved.y);
  } else {
    const area = screen.getPrimaryDisplay().workArea;
    win.setPosition(
      area.x + area.width - PILL_COMPACT.width - PAD - EDGE_MARGIN,
      area.y + area.height - PILL_COMPACT.height - PAD - EDGE_MARGIN
    );
  }

  win.loadFile(path.join(__dirname, '..', 'renderer', 'pill.html'));

  win.on('moved', () => {
    const [x, y] = win.getPosition();
    store.setPillBounds({ x, y });
  });

  return win;
}

function isOnScreen(bounds) {
  return screen.getAllDisplays().some((display) => {
    const a = display.workArea;
    return (
      bounds.x >= a.x - 60 &&
      bounds.y >= a.y - 60 &&
      bounds.x < a.x + a.width - 40 &&
      bounds.y < a.y + a.height - 20
    );
  });
}

// Resizing keeps the window's top-left anchored. Because the margin is a
// constant, that also keeps the pill's own top-left still: growing a media row
// pushes down and right rather than shifting the pill under the pointer.
function resizePill(win, wantsMedia) {
  if (!win || win.isDestroyed()) return;
  const target = windowSizeFor(wantsMedia ? PILL_MEDIA : PILL_COMPACT);
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  if (w === target.width && h === target.height) return;

  // The pill is not user-resizable, and on Windows that also blocks setBounds.
  // Lift the lock just for the programmatic resize.
  win.setResizable(true);
  win.setMinimumSize(target.width, target.height);
  win.setMaximumSize(target.width, target.height);
  win.setBounds({ x, y, width: target.width, height: target.height });
  win.setResizable(false);
}

// Whether the window accepts the mouse is decided from the real cursor
// position in main, rather than from forwarded mousemove events in the
// renderer. Forwarding is the usual recipe, but if it ever fails to deliver
// the pill becomes permanently click-through and unusable; polling the cursor
// cannot get stuck that way.
function startCursorWatch(win) {
  let ignoring = null;

  const tick = () => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const b = win.getBounds();
    const p = screen.getCursorScreenPoint();

    // The pill itself, not the transparent shadow margin around it.
    const inside =
      p.x >= b.x + PAD &&
      p.x <= b.x + b.width - PAD &&
      p.y >= b.y + PAD &&
      p.y <= b.y + b.height - PAD;

    if (inside === !ignoring) return;
    ignoring = !inside;
    win.setIgnoreMouseEvents(ignoring, { forward: true });
  };

  const handle = setInterval(tick, 60);
  return () => clearInterval(handle);
}

module.exports = {
  createPillWindow,
  resizePill,
  startCursorWatch,
  PILL_COMPACT,
  PILL_MEDIA,
  PAD
};
