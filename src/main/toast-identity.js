'use strict';

/* Gives the Windows toast a name instead of an id.
 *
 * Windows attributes a notification by AppUserModelID, and when nothing on the
 * machine claims that id it simply prints the id — "com.zensession.desktop" —
 * where the app name belongs. An installer normally supplies the claim, in the
 * form of a Start Menu shortcut carrying the id, so a copy that has only ever
 * been run from source has nothing to go on.
 *
 * The documented alternative for a desktop app that sends toasts is to
 * register the id under the current user:
 *
 *   HKCU\SOFTWARE\Classes\AppUserModelId\<id>
 *       DisplayName = Zen Session
 *       IconUri     = ...\resources\icon-256.png
 *
 * Which covers both cases, and puts the app icon on the toast as well. It is
 * the user's own hive, so nothing here needs elevation, and reg.exe ships with
 * Windows, so nothing here needs a dependency.
 *
 * Every failure is swallowed: not being able to write this costs the toast its
 * name and nothing else. The notification still arrives.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const KEY = 'HKCU\\SOFTWARE\\Classes\\AppUserModelId\\com.zensession.desktop';
const DISPLAY_NAME = 'Zen Session';

// Packaged builds copy resources/ beside the asar; development runs from
// source. The same pair the tray and the sound loader look through.
function iconPath() {
  const roots = [
    process.resourcesPath ? path.join(process.resourcesPath, 'resources') : null,
    path.join(app.getAppPath(), 'resources')
  ].filter(Boolean);

  for (const root of roots) {
    const file = path.join(root, 'icon-256.png');
    try {
      if (fs.existsSync(file)) return file;
    } catch {
      // An unreadable root is not worth reporting: the next one, or no icon.
    }
  }
  return null;
}

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || '') });
    });
  });
}

// The icon path differs between a source run and an installed one, so this
// cannot be skipped on a one-time flag: what is already there has to be read.
async function alreadyCorrect(icon) {
  const { ok, out } = await reg(['query', KEY]);
  if (!ok) return false;
  if (!out.includes(DISPLAY_NAME)) return false;
  return icon ? out.includes(icon) : true;
}

async function registerToastIdentity() {
  if (process.platform !== 'win32') return false;

  try {
    const icon = iconPath();
    if (await alreadyCorrect(icon)) return false;

    const wrote = await reg(['add', KEY, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', DISPLAY_NAME, '/f']);
    if (!wrote.ok) {
      console.warn('[toast] could not register the notification name');
      return false;
    }
    if (icon) {
      await reg(['add', KEY, '/v', 'IconUri', '/t', 'REG_SZ', '/d', icon, '/f']);
    }
    console.log('[toast] registered "Zen Session" for notifications');
    return true;
  } catch (err) {
    console.warn('[toast] could not register the notification name:', err.message);
    return false;
  }
}

module.exports = { registerToastIdentity, KEY, DISPLAY_NAME };
