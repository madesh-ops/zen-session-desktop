'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  settings: {
    focusMin: 25,
    shortMin: 5,
    longMin: 15,
    longEvery: 4,
    autoStartBreaks: true,
    autoStartFocus: false,
    pillAlwaysOnTop: true,
    chime: false,
    // A Windows toast when an interval ends by itself — never when you skip.
    notify: true,
    launchAtLogin: false,
    showMedia: true,
    theme: 'midnight',
    // Which calm background sound is picked, and how loud (0..1). An id that
    // no longer exists falls back to the first sound, so this can change.
    // Playback itself is never restored: the app should open silent.
    soundId: 'rain',
    soundVolume: 0.5,
    // Width of one hour column on the timetable, in px. Set by Ctrl+wheel.
    weekZoom: 64
  },
  // { id, startedAt, endedAt, mode }
  sessions: [],
  // { id, weekKey, day (0 = Mon), startMin, endMin, label, kind }
  plan: [],
  pillBounds: null,
  windowBounds: null
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Error codes Windows gives when something else (antivirus, the search
// indexer, a backup tool) briefly has the file open. They pass on their own.
const LOCKED_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_MS = [15, 30, 60, 120, 250];

// flush() runs synchronously on quit, so the pause between retries has to be
// synchronous too. Atomics.wait blocks without spinning the CPU.
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeQuietly(file) {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    // Already gone is the outcome we wanted; anything else is not worth a crash.
  }
}

// Writes the whole text to `<target>.tmp`, flushes it to disk, then renames it
// over the target. A rename on the same volume replaces the file in one step,
// so a crash leaves either the old file or the new one — never half of either.
// Returns false (and leaves the target untouched) if the target stayed locked
// through every retry; any other failure throws.
function writeAtomic(target, text) {
  const tmp = target + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return true;
    } catch (err) {
      if (!LOCKED_CODES.has(err.code)) {
        removeQuietly(tmp);
        throw err;
      }
      if (attempt >= RENAME_RETRY_MS.length) {
        removeQuietly(tmp);
        return false;
      }
      pause(RENAME_RETRY_MS[attempt]);
    }
  }
}

// Only a plain object is a data file we wrote; `null`, a number or an array
// that happens to parse is still a damaged file.
function parseData(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('data file does not hold an object');
  }
  return parsed;
}

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'zen-session-data.json');
    // A copy of the last contents known to parse. It is only ever written from
    // text that parsed or that this process produced itself, so it can never
    // be a copy of a damaged file.
    this.backupFile = this.file + '.bak';
    this.data = clone(DEFAULTS);
    this._writeTimer = null;
    // Set when the data file exists but could not be read or moved aside.
    // Writing over it then could destroy the only copy, so writes are held.
    this._holdWrites = false;
    this.migrateFromPomodoro();
    this.load();
  }

  // The app was called Pomodoro before, and userData is keyed on the product
  // name, so a rename would otherwise strand everything the user had saved.
  // One-time, non-destructive: the old file is left where it is.
  migrateFromPomodoro() {
    if (fs.existsSync(this.file)) return;
    const legacy = path.join(path.dirname(app.getPath('userData')), 'Pomodoro', 'pomodoro-data.json');
    try {
      if (!fs.existsSync(legacy)) return;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.copyFileSync(legacy, this.file);
      console.log('[store] carried settings and history over from the previous name');
    } catch (err) {
      console.warn('[store] could not migrate the old data file:', err.message);
    }
  }

  // Reads the data file. If it is damaged it is moved aside (never deleted,
  // never written over) and the last known-good backup is used instead.
  // Defaults are the last resort, and on a first run they are silent.
  load() {
    this._holdWrites = false;
    // A leftover .tmp is from a write that never finished its rename. The real
    // file still holds the last complete write, so the leftover is dropped.
    removeQuietly(this.file + '.tmp');
    removeQuietly(this.backupFile + '.tmp');

    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        // First run. A backup without a main file would be unusual, but if
        // one is there it is better than starting empty.
        if (!this.loadBackup('the data file is missing')) this.data = clone(DEFAULTS);
        return;
      }
      // The file is there but could not be opened — possibly perfectly fine
      // and just locked. Don't move it, and don't write over it later.
      console.warn('[store] could not read data file:', err.message);
      if (!this.loadBackup('the data file could not be read')) {
        console.warn('[store] no usable backup either; using defaults and leaving the data file untouched');
        this._holdWrites = true;
        this.data = clone(DEFAULTS);
      }
      return;
    }

    try {
      this.apply(parseData(raw));
    } catch (err) {
      console.warn('[store] data file is damaged:', err.message);
      this.setAsideCorrupt();
      if (!this.loadBackup('the data file was damaged')) {
        console.warn('[store] no usable backup; starting from defaults');
        this.data = clone(DEFAULTS);
      }
      return;
    }

    // The file parsed, so it becomes the new backup. Refreshing on every good
    // load (and every write) keeps the backup from going stale.
    this.writeBackup(raw);
  }

  apply(parsed) {
    this.data = {
      ...clone(DEFAULTS),
      ...parsed,
      settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) }
    };
    if (!Array.isArray(this.data.sessions)) this.data.sessions = [];
    if (!Array.isArray(this.data.plan)) this.data.plan = [];
  }

  loadBackup(reason) {
    let raw;
    try {
      raw = fs.readFileSync(this.backupFile, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[store] could not read backup:', err.message);
      return false;
    }
    try {
      this.apply(parseData(raw));
    } catch (err) {
      console.warn('[store] backup is damaged too:', err.message);
      return false;
    }
    console.warn(`[store] ${reason}; restored from the last good backup`);
    return true;
  }

  // Moves a damaged data file to zen-session-data.corrupt-<timestamp>.json so
  // nothing ever writes over it; whatever it still holds can be dug out by hand.
  setAsideCorrupt() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = this.file.replace(/\.json$/, '');
    let target = `${base}.corrupt-${stamp}.json`;
    for (let n = 1; fs.existsSync(target); n++) target = `${base}.corrupt-${stamp}-${n}.json`;
    try {
      fs.renameSync(this.file, target);
      console.warn('[store] kept the damaged file as', path.basename(target));
      return;
    } catch (err) {
      // Locked, perhaps. A copy preserves it just as well; the original can then
      // be replaced by the next write.
      try {
        fs.copyFileSync(this.file, target, fs.constants.COPYFILE_EXCL);
        console.warn('[store] kept a copy of the damaged file as', path.basename(target));
        return;
      } catch (copyErr) {
        console.warn('[store] could not set the damaged file aside:', copyErr.message);
      }
    }
    // It could not be preserved anywhere, so it must not be written over.
    this._holdWrites = true;
  }

  writeBackup(text) {
    try {
      if (!writeAtomic(this.backupFile, text)) {
        console.warn('[store] backup file is locked; kept the previous one');
        return false;
      }
      return true;
    } catch (err) {
      console.warn('[store] could not write backup:', err.message);
      return false;
    }
  }

  // Writes are debounced: the timer touches the store often and the data is small.
  save() {
    if (this._writeTimer) clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    if (this._holdWrites) {
      console.warn('[store] not saving: the existing data file could not be read or set aside');
      return;
    }
    const text = JSON.stringify(this.data, null, 2);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (writeAtomic(this.file, text)) {
        this.writeBackup(text);
        return;
      }
      // The data file stayed locked through every retry. Put the new contents
      // in the backup first; only once that is safely on disk is the data file
      // written in place. If that in-place write is cut short, the next launch
      // finds a damaged file and restores this backup, so nothing is lost.
      console.warn('[store] data file is locked; writing it in place after securing a backup');
      if (!this.writeBackup(text)) {
        console.warn('[store] could not secure a backup; leaving the data file as it was');
        return;
      }
      fs.writeFileSync(this.file, text, 'utf8');
    } catch (err) {
      console.warn('[store] could not write data file:', err.message);
    }
  }

  get settings() {
    return this.data.settings;
  }

  updateSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.data.settings;
  }

  addSession(session) {
    this.data.sessions.push(session);
    // Keep the log bounded; a year of heavy use is well under this.
    if (this.data.sessions.length > 5000) {
      this.data.sessions = this.data.sessions.slice(-5000);
    }
    this.save();
  }

  sessionsForWeek(weekKey) {
    return this.data.sessions.filter((s) => s.weekKey === weekKey);
  }

  get plan() {
    return this.data.plan;
  }

  addBlock(block) {
    this.data.plan.push(block);
    this.save();
    return block;
  }

  removeBlock(id) {
    this.data.plan = this.data.plan.filter((b) => b.id !== id);
    this.save();
  }

  renameBlock(id, label) {
    const block = this.data.plan.find((b) => b.id === id);
    if (!block) return null;
    block.label = String(label).slice(0, 60);
    this.save();
    return block;
  }

  setPillBounds(bounds) {
    this.data.pillBounds = bounds;
    this.save();
  }

  setWindowBounds(bounds) {
    this.data.windowBounds = bounds;
    this.save();
  }
}

module.exports = { Store, DEFAULTS };
