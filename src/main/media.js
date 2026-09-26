'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Friendly names for the source app ids Windows reports. Anything unmatched
// falls back to a tidied-up version of the raw id.
const KNOWN_SOURCES = {
  'spotify.exe': 'Spotify',
  'msedge.exe': 'Edge',
  'chrome.exe': 'Chrome',
  'firefox.exe': 'Firefox',
  'vlc.exe': 'VLC',
  'foobar2000.exe': 'foobar2000',
  'musicbee.exe': 'MusicBee',
  'brave.exe': 'Brave',
  'opera.exe': 'Opera'
};

function prettySource(raw) {
  if (!raw) return '';
  const key = String(raw).toLowerCase();
  if (KNOWN_SOURCES[key]) return KNOWN_SOURCES[key];
  // Store apps report a long AUMID like "AppId!App" — take the readable half.
  const head = String(raw).split('!')[0];
  const noExe = head.replace(/\.exe$/i, '');
  if (/^[0-9A-F]{8,}$/i.test(noExe)) return 'Media';
  const short = noExe.split('.').pop();
  return short.length > 18 ? 'Media' : short;
}

// Watches now-playing state. Deliberately optional: if PowerShell or the WinRT
// bridge is unavailable for any reason, this reports "nothing playing" forever
// and the rest of the app carries on untouched.
class MediaWatcher extends EventEmitter {
  constructor() {
    super();
    this.current = null;
    this.available = false;
    this.child = null;
    this._stopped = false;
    this._buffer = '';
  }

  scriptPath() {
    // Packaged builds copy `resources/` next to the app; development runs from source.
    const packaged = path.join(process.resourcesPath || '', 'resources', 'smtc.ps1');
    if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
    return path.join(app.getAppPath(), 'resources', 'smtc.ps1');
  }

  start() {
    // Clearing the flag here is what lets the media setting be turned off and
    // back on again within one run.
    this._stopped = false;
    if (this.child) return;

    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath()],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (err) {
      console.warn('[media] could not start the now-playing bridge:', err.message);
      this._fail();
      return;
    }

    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.on('error', (err) => {
      console.warn('[media] bridge error:', err.message);
      this._fail();
    });
    child.on('exit', () => {
      this.child = null;
      // A deliberate stop reports "nothing playing" through its own path;
      // only an unexpected exit needs to announce the loss here.
      if (!this._stopped) this._fail();
    });
  }

  _onData(chunk) {
    this._buffer += chunk;
    const lines = this._buffer.split(/\r?\n/);
    this._buffer = lines.pop() || '';
    for (const line of lines) {
      const text = line.trim();
      if (!text.startsWith('{')) continue;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      if (parsed.ok === false) {
        this._fail();
        continue;
      }
      this.available = true;
      this._publish(parsed);
    }
  }

  _publish(parsed) {
    const title = (parsed.title || '').trim();
    const next =
      parsed.playing && title
        ? {
            title,
            artist: (parsed.artist || '').trim(),
            source: prettySource(parsed.source)
          }
        : null;

    const same =
      (next === null && this.current === null) ||
      (next &&
        this.current &&
        next.title === this.current.title &&
        next.artist === this.current.artist &&
        next.source === this.current.source);

    if (same) return;
    this.current = next;
    this.emit('media', next);
  }

  _fail() {
    this.available = false;
    if (this.current !== null) {
      this.current = null;
      this.emit('media', null);
    }
  }

  stop() {
    this._stopped = true;
    const child = this.child;
    this.child = null;
    if (child) {
      child.removeAllListeners();
      try {
        child.kill();
      } catch { }
    }
    this.available = false;
    this.current = null;
  }
}

module.exports = { MediaWatcher };
