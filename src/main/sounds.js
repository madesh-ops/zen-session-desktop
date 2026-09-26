'use strict';

/* Hands the renderer the bytes of a bundled sound loop.
 *
 * The renderer cannot simply fetch these: the page is loaded from file://, and
 * Chromium refuses fetch() against file:// URLs whatever the CSP says. So the
 * main process reads the file and the bytes travel over IPC, where they are
 * decoded once and cached as an AudioBuffer.
 *
 * The two candidate roots are the same pair the tray icon looks through:
 * a packaged build copies resources/ beside the asar, development runs from
 * source. */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// The id comes from the renderer, so it decides a filename: anything but a
// plain lowercase word is refused rather than joined onto a path.
const SAFE_ID = /^[a-z][a-z0-9-]{0,23}$/;

function roots() {
  return [
    process.resourcesPath ? path.join(process.resourcesPath, 'resources', 'sounds') : null,
    path.join(app.getAppPath(), 'resources', 'sounds')
  ].filter(Boolean);
}

// Returns the file as a Buffer, or null when there is no recording for this id
// — which is not a failure: ambience.js then synthesises the sound instead.
function readSound(id) {
  if (!SAFE_ID.test(String(id || ''))) return null;
  for (const root of roots()) {
    const file = path.join(root, `${id}.ogg`);
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file);
    } catch (err) {
      console.warn(`[sounds] could not read ${file}:`, err.message);
    }
  }
  return null;
}

module.exports = { readSound };
