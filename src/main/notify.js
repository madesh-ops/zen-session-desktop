'use strict';

/* The Windows toast that says an interval is over.
 *
 * It fires from the main process, off the timer's own 'complete' event, which
 * is the only thing that knows an interval ended by itself — skipping does not
 * raise it, and neither does pausing. That matters: a notification for
 * something you did on purpose is noise.
 *
 * Windows attributes a toast by AppUserModelID, which index.js sets to
 * com.zensession.desktop and the installer puts on the Start Menu shortcut.
 * Running from source there is no such shortcut, so a toast in development may
 * be attributed to Electron or, depending on the machine, not shown at all —
 * that is Windows, not a bug here.
 */

const { Notification } = require('electron');

function minutesFor(mode, settings) {
  const raw = mode === 'focus' ? settings.focusMin : mode === 'short' ? settings.shortMin : settings.longMin;
  return Math.max(1, Number(raw) || 1);
}

function plural(n) {
  return `${n} minute${n === 1 ? '' : 's'}`;
}

// Says what just ended and what is waiting, because the toast is read from
// across the room and often after the fact.
function wording(finishedMode, nextMode, settings) {
  const next = plural(minutesFor(nextMode, settings));

  if (finishedMode === 'focus') {
    return {
      title: 'Focus session done',
      body: nextMode === 'long' ? `Long break next — ${next}.` : `Break next — ${next}.`
    };
  }

  return {
    title: finishedMode === 'long' ? 'Long break over' : 'Break over',
    body: `Focus next — ${next}.`
  };
}

function notifyComplete(info, settings, onClick) {
  if (!settings || !settings.notify) return false;
  if (!Notification.isSupported()) return false;

  try {
    const { title, body } = wording(info.finishedMode, info.nextMode, settings);
    const toast = new Notification({
      title,
      body,
      // The app already has its own tone. Two sounds for one moment is one
      // too many, so the toast keeps quiet whenever the chime is on.
      silent: Boolean(settings.chime),
      timeoutType: 'default'
    });
    toast.on('click', () => {
      if (typeof onClick === 'function') onClick();
    });
    toast.show();
    return true;
  } catch (err) {
    console.warn('[notify] could not show the notification:', err.message);
    return false;
  }
}

module.exports = { notifyComplete, wording };
