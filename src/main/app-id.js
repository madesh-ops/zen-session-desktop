'use strict';

/* The AppUserModelID: what Windows groups taskbar buttons by and attributes
 * notifications to.
 *
 * The installed app and a copy run from source must not share one. Windows
 * resolves an id to whatever Start Menu shortcut claims it, and the first
 * notification from a source run leaves an "Electron" shortcut claiming it,
 * pointing at node_modules. From then on the installed app's taskbar button
 * wore the Electron logo. The toast name and icon in the registry flipped
 * between the two copies on every launch, too.
 *
 * So a source run gets an id of its own. The installed id matches the appId
 * in package.json, which is what the installer stamps on its shortcut.
 */

const { app } = require('electron');

const APP_ID = app.isPackaged ? 'com.zensession.desktop' : 'com.zensession.desktop.dev';
const DISPLAY_NAME = app.isPackaged ? 'Zen Session' : 'Zen Session (dev)';

module.exports = { APP_ID, DISPLAY_NAME };
