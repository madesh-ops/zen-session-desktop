'use strict';

// Exercises the data store outside Electron: atomic writes, the last-good
// backup, and recovery from a damaged data file. Everything happens in a
// throwaway folder under the OS temp dir — never in the real userData.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// store.js only needs electron's app.getPath('userData'). Point it at a
// temp folder that each test swaps out.
let userData = null;
const STUB_ID = path.join(__dirname, '__electron-stub__.js');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB_ID;
  return realResolve.call(this, request, ...rest);
};
const stub = new Module(STUB_ID);
stub.filename = STUB_ID;
stub.loaded = true;
stub.exports = {
  app: {
    getPath(name) {
      assert.strictEqual(name, 'userData');
      assert.ok(userData, 'userData not set for this test');
      return userData;
    }
  }
};
require.cache[STUB_ID] = stub;

const { Store, DEFAULTS } = require('../src/main/store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-store-test-'));
let caseNo = 0;

// Each test gets its own parent folder, so the Pomodoro migration looks in a
// sibling folder that does not exist.
function freshDir() {
  caseNo += 1;
  userData = path.join(root, `case-${caseNo}`, 'Zen Session');
  return userData;
}

// Collects console.warn output while a test runs, still echoing it dimly.
function captureWarnings(fn) {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.join(' '));
    realWarn('      (warn)', ...args);
  };
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = realWarn;
  }
}

const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const read = (f) => fs.readFileSync(f, 'utf8');
const corruptFiles = (dir) => files(dir).filter((f) => /^zen-session-data\.corrupt-.*\.json$/.test(f));

function seededStore() {
  const store = new Store();
  store.updateSettings({ focusMin: 50 });
  store.addSession({ id: 's1', sessionId: 'abc-123', startedAt: 1, endedAt: 2, mode: 'focus', weekKey: '2026-W39' });
  store.addBlock({ id: 'b1', weekKey: '2026-W39', day: 0, startMin: 540, endMin: 600, label: 'Deep work', kind: 'focus' });
  store.flush();
  return store;
}

function testRoundTrip() {
  const dir = freshDir();
  const { warnings } = captureWarnings(() => {
    seededStore();
    const again = new Store();
    assert.strictEqual(again.settings.focusMin, 50);
    assert.strictEqual(again.settings.theme, DEFAULTS.settings.theme, 'defaults fill in missing settings');
    assert.strictEqual(again.sessionsForWeek('2026-W39').length, 1);
    assert.strictEqual(again.sessionsForWeek('2026-W39')[0].sessionId, 'abc-123', 'extra fields persist');
    assert.strictEqual(again.plan[0].label, 'Deep work');
  });
  assert.deepStrictEqual(warnings, [], 'a clean round trip is quiet');
  assert.deepStrictEqual(files(dir), ['zen-session-data.json', 'zen-session-data.json.bak'], 'no .tmp left behind');
  assert.strictEqual(read(path.join(dir, 'zen-session-data.json.bak')), read(path.join(dir, 'zen-session-data.json')));
  console.log('  ok  round trip: settings, sessions (with sessionId), plan; backup matches, no .tmp');
}

function testBackupStaysFresh() {
  const dir = freshDir();
  const store = seededStore();
  store.addSession({ id: 's2', startedAt: 3, endedAt: 4, mode: 'focus', weekKey: '2026-W39' });
  store.flush();
  store.renameBlock('b1', 'Renamed');
  store.flush();
  const bak = JSON.parse(read(path.join(dir, 'zen-session-data.json.bak')));
  assert.strictEqual(bak.sessions.length, 2, 'backup picked up the second session');
  assert.strictEqual(bak.plan[0].label, 'Renamed', 'backup picked up the latest write');
  console.log('  ok  backup is refreshed on every write, not just the first');
}

function testCorruptMainWithGoodBackup() {
  const dir = freshDir();
  seededStore();
  const main = path.join(dir, 'zen-session-data.json');
  const damaged = read(main).slice(0, 40); // what a power cut mid-write leaves
  fs.writeFileSync(main, damaged);

  const { result: store, warnings } = captureWarnings(() => new Store());
  assert.strictEqual(store.settings.focusMin, 50, 'settings came back from the backup');
  assert.strictEqual(store.sessionsForWeek('2026-W39').length, 1, 'sessions came back from the backup');
  assert.strictEqual(store.plan.length, 1, 'plan came back from the backup');
  assert.ok(warnings.some((w) => /restored from the last good backup/.test(w)), 'recovery is logged');

  const aside = corruptFiles(dir);
  assert.strictEqual(aside.length, 1, 'damaged file was set aside');
  assert.strictEqual(read(path.join(dir, aside[0])), damaged, 'set-aside file holds the damaged bytes');

  captureWarnings(() => store.flush());
  assert.strictEqual(read(path.join(dir, aside[0])), damaged, 'a later write leaves it alone');
  JSON.parse(read(main));
  JSON.parse(read(path.join(dir, 'zen-session-data.json.bak')));
  assert.strictEqual(new Store().sessionsForWeek('2026-W39').length, 1, 'the next launch is clean again');
  console.log('  ok  damaged main + good backup: restored from backup, damaged file preserved');
}

function testCorruptMainNoBackup() {
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  const main = path.join(dir, 'zen-session-data.json');
  const damaged = '{"settings":{"focusMin":50},"sessions":[{"id":"s1"';
  fs.writeFileSync(main, damaged);

  const { result: store, warnings } = captureWarnings(() => new Store());
  assert.deepStrictEqual(store.data, DEFAULTS, 'falls back to defaults');
  assert.ok(warnings.some((w) => /damaged/.test(w)), 'damage is logged');
  assert.ok(!fs.existsSync(path.join(dir, 'zen-session-data.json.bak')), 'the damaged file is never copied into the backup');

  const aside = corruptFiles(dir);
  assert.strictEqual(aside.length, 1, 'damaged file was set aside');
  captureWarnings(() => {
    store.addSession({ id: 'new', startedAt: 5, endedAt: 6, mode: 'focus' });
    store.flush();
  });
  assert.strictEqual(read(path.join(dir, aside[0])), damaged, 'defaults were not written over it');
  assert.strictEqual(JSON.parse(read(main)).sessions[0].id, 'new');
  console.log('  ok  damaged main, no backup: defaults, damaged file preserved and not overwritten');
}

function testCorruptMainAndCorruptBackup() {
  const dir = freshDir();
  seededStore();
  fs.writeFileSync(path.join(dir, 'zen-session-data.json'), '{"sett');
  fs.writeFileSync(path.join(dir, 'zen-session-data.json.bak'), 'null');
  const { result: store } = captureWarnings(() => new Store());
  assert.deepStrictEqual(store.data, DEFAULTS);
  assert.strictEqual(corruptFiles(dir).length, 1);
  console.log('  ok  damaged main and damaged backup: defaults, nothing crashes');
}

function testFirstRun() {
  const dir = freshDir();
  const { result: store, warnings } = captureWarnings(() => new Store());
  assert.deepStrictEqual(store.data, DEFAULTS);
  assert.deepStrictEqual(warnings, [], 'first run is silent');
  assert.deepStrictEqual(files(dir), [], 'nothing written until the first save');
  captureWarnings(() => store.flush());
  assert.deepStrictEqual(files(dir), ['zen-session-data.json', 'zen-session-data.json.bak']);
  console.log('  ok  first run: defaults, no warning');
}

function testLeftoverTmp() {
  const dir = freshDir();
  seededStore();
  fs.writeFileSync(path.join(dir, 'zen-session-data.json.tmp'), '{"half a wri');
  fs.writeFileSync(path.join(dir, 'zen-session-data.json.bak.tmp'), '');
  const { result: store, warnings } = captureWarnings(() => new Store());
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(store.settings.focusMin, 50, 'real file wins over a leftover .tmp');
  assert.deepStrictEqual(files(dir), ['zen-session-data.json', 'zen-session-data.json.bak'], 'stale .tmp files cleaned up');
  store.flush();
  assert.strictEqual(new Store().settings.focusMin, 50);

  // A leftover .tmp on what is otherwise a first run.
  const dir2 = freshDir();
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'zen-session-data.json.tmp'), 'garbage');
  const { result: fresh, warnings: w2 } = captureWarnings(() => new Store());
  assert.deepStrictEqual(fresh.data, DEFAULTS);
  assert.deepStrictEqual(w2, []);
  assert.deepStrictEqual(files(dir2), []);
  console.log('  ok  leftover .tmp files are ignored and removed');
}

// Makes fs.renameSync onto the data file fail with EPERM a set number of
// times (Infinity = always), the way antivirus holding the file looks.
function withLockedRename(times, fn) {
  const realRename = fs.renameSync;
  let failures = 0;
  fs.renameSync = function (from, to) {
    if (path.basename(to) === 'zen-session-data.json' && failures < times) {
      failures += 1;
      const err = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`);
      err.code = 'EPERM';
      throw err;
    }
    return realRename.apply(this, arguments);
  };
  try {
    return { result: fn(), failures };
  } finally {
    fs.renameSync = realRename;
  }
}

function testRenameRetry() {
  const dir = freshDir();
  const store = seededStore();
  store.updateSettings({ focusMin: 30 });
  const { failures, result } = withLockedRename(2, () => captureWarnings(() => store.flush()));
  assert.strictEqual(failures, 2, 'the lock was hit');
  assert.deepStrictEqual(result.warnings, [], 'a brief lock is ridden out quietly');
  assert.strictEqual(JSON.parse(read(path.join(dir, 'zen-session-data.json'))).settings.focusMin, 30);
  assert.deepStrictEqual(files(dir), ['zen-session-data.json', 'zen-session-data.json.bak']);
  console.log('  ok  rename briefly locked (EPERM x2): retried and succeeded');
}

function testRenameStaysLocked() {
  const dir = freshDir();
  const store = seededStore();
  store.updateSettings({ focusMin: 35 });
  const { result } = withLockedRename(Infinity, () => captureWarnings(() => store.flush()));
  assert.ok(result.warnings.some((w) => /locked/.test(w)));
  JSON.parse(read(path.join(dir, 'zen-session-data.json'))); // never left truncated
  assert.strictEqual(JSON.parse(read(path.join(dir, 'zen-session-data.json.bak'))).settings.focusMin, 35, 'backup secured first');
  assert.strictEqual(new Store().settings.focusMin, 35, 'the change survives');
  assert.deepStrictEqual(files(dir), ['zen-session-data.json', 'zen-session-data.json.bak'], 'no .tmp left behind');
  console.log('  ok  rename locked throughout: backup secured, then in-place write; nothing lost');
}

function testUnreadableMainIsNotOverwritten() {
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  const main = path.join(dir, 'zen-session-data.json');
  const precious = JSON.stringify({ sessions: [{ id: 'keep-me' }] });
  fs.writeFileSync(main, precious);

  const realRead = fs.readFileSync;
  fs.readFileSync = function (file) {
    if (file === main) {
      const err = new Error('EBUSY: resource busy or locked');
      err.code = 'EBUSY';
      throw err;
    }
    return realRead.apply(this, arguments);
  };
  let store;
  try {
    store = captureWarnings(() => new Store()).result;
  } finally {
    fs.readFileSync = realRead;
  }
  assert.deepStrictEqual(store.data, DEFAULTS);
  captureWarnings(() => store.flush());
  assert.strictEqual(read(main), precious, 'a file we could not read is never written over');
  assert.strictEqual(corruptFiles(dir).length, 0, 'and it is not treated as damaged');
  console.log('  ok  unreadable (locked) main, no backup: defaults, but writes are held');
}

function testMigrationStillWorks() {
  const dir = freshDir();
  const legacyDir = path.join(path.dirname(dir), 'Pomodoro');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'pomodoro-data.json'), JSON.stringify({ settings: { focusMin: 45 } }));
  const { result: store } = captureWarnings(() => new Store());
  assert.strictEqual(store.settings.focusMin, 45);
  assert.ok(fs.existsSync(path.join(legacyDir, 'pomodoro-data.json')), 'old file left where it was');
  console.log('  ok  Pomodoro migration still carries data over');
}

function main() {
  console.log(`store tests in ${root}`);
  const tests = [
    testRoundTrip,
    testBackupStaysFresh,
    testCorruptMainWithGoodBackup,
    testCorruptMainNoBackup,
    testCorruptMainAndCorruptBackup,
    testFirstRun,
    testLeftoverTmp,
    testRenameRetry,
    testRenameStaysLocked,
    testUnreadableMainIsNotOverwritten,
    testMigrationStillWorks
  ];
  let failed = 0;
  for (const t of tests) {
    try {
      t();
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${t.name}: ${err.message}`);
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
  if (failed) {
    console.log(`\n${failed} of ${tests.length} failed`);
    process.exit(1);
  }
  console.log(`\nall ${tests.length} store tests passed`);
}

main();
