'use strict';

// Exercises the timer core outside Electron: drift, pause/resume accuracy,
// session logging, the focus -> break -> long-break cycle, settings saves
// against a paused timer, and sessions that cross midnight.

const assert = require('assert');
const { TimerCore } = require('../src/main/timer-core');

function stubStore(overrides = {}) {
  return {
    settings: {
      focusMin: 25,
      shortMin: 5,
      longMin: 15,
      longEvery: 2,
      autoStartBreaks: false,
      autoStartFocus: false,
      ...overrides
    },
    sessions: [],
    addSession(s) {
      this.sessions.push(s);
    }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIN = 60 * 1000;

// A hand-driven clock. The timer logs with `new Date()` as well as Date.now(),
// so replacing Date.now alone would leave the logged times on the real clock;
// the whole global is swapped for a subclass that reads the fake time when
// constructed without arguments. With arguments it behaves exactly as Date.
function withFakeClock(startMs, fn) {
  const RealDate = Date;
  const clock = { now: startMs };
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }
    static now() {
      return clock.now;
    }
  }
  global.Date = FakeDate;
  try {
    return fn(clock);
  } finally {
    global.Date = RealDate;
  }
}

// A timer on real minute-length durations whose interval is stopped, so the
// test decides exactly when it ticks.
function manualTimer(store) {
  const timer = new TimerCore(store);
  timer.dispose();
  return timer;
}

// Run the current interval out: move the clock to its deadline and tick.
function runOut(timer, clock) {
  clock.now = timer.endsAt;
  timer._tick();
}

// Short synthetic durations so the whole suite runs in a few seconds.
function fastTimer(store, durations) {
  const timer = new TimerCore(store);
  timer.durationFor = (mode) => durations[mode];
  timer.remainingMs = timer.totalMs;
  return timer;
}

async function testCountdownAccuracy() {
  const store = stubStore();
  const timer = fastTimer(store, { focus: 3000, short: 1000, long: 2000 });

  const startedAt = Date.now();
  timer.start();
  await sleep(1500);
  const state = timer.state;
  const realElapsed = Date.now() - startedAt;
  const reportedElapsed = state.totalMs - state.remainingMs;

  const drift = Math.abs(realElapsed - reportedElapsed);
  assert.ok(drift < 300, `countdown drifted by ${drift}ms`);
  timer.dispose();
  console.log(`  countdown tracks wall clock (drift ${drift}ms)`);
}

async function testPauseResume() {
  const store = stubStore();
  const timer = fastTimer(store, { focus: 5000, short: 1000, long: 2000 });

  timer.start();
  await sleep(1000);
  timer.pause();
  const atPause = timer.state.remainingMs;

  await sleep(800); // time passing while paused must not count
  assert.strictEqual(timer.state.remainingMs, atPause, 'paused timer kept running');

  timer.start();
  await sleep(600);
  const after = timer.state.remainingMs;
  assert.ok(after < atPause, 'resumed timer did not continue');
  assert.ok(atPause - after < 900, 'resume lost or gained time');

  timer.dispose();
  console.log(`  pause holds, resume continues (held at ${atPause}ms)`);
}

async function testCycleAndLogging() {
  const store = stubStore({ longEvery: 2, autoStartBreaks: false });
  const timer = fastTimer(store, { focus: 600, short: 400, long: 500 });

  const seen = [];
  timer.on('complete', (info) => seen.push(info));

  // focus #1 -> short break
  timer.start();
  await sleep(900);
  assert.strictEqual(timer.state.mode, 'short', 'first focus did not lead to a short break');
  assert.strictEqual(store.sessions.length, 1, 'first focus was not logged');

  // short break -> focus
  timer.start();
  await sleep(700);
  assert.strictEqual(timer.state.mode, 'focus', 'break did not lead back to focus');
  assert.strictEqual(store.sessions.length, 1, 'a break was wrongly logged as a session');

  // focus #2 -> long break, because longEvery is 2
  timer.start();
  await sleep(900);
  assert.strictEqual(timer.state.mode, 'long', 'second focus did not lead to a long break');
  assert.strictEqual(store.sessions.length, 2, 'second focus was not logged');

  const session = store.sessions[0];
  for (const key of ['startedAt', 'endedAt', 'weekKey', 'day', 'startMin', 'endMin']) {
    assert.ok(session[key] !== undefined, `logged session is missing ${key}`);
  }
  assert.ok(session.day >= 0 && session.day <= 6, 'day index out of range');
  assert.strictEqual(seen.length, 3, `expected 3 completions, saw ${seen.length}`);

  timer.dispose();
  console.log(`  focus -> short -> focus -> long, ${store.sessions.length} sessions logged`);
}

async function testSkipDoesNotLog() {
  const store = stubStore();
  const timer = fastTimer(store, { focus: 5000, short: 1000, long: 2000 });

  timer.start();
  await sleep(300);
  timer.skip();

  assert.strictEqual(timer.state.mode, 'short', 'skip did not advance the mode');
  assert.strictEqual(store.sessions.length, 0, 'skip wrongly logged a session');
  timer.dispose();
  console.log('  skip advances without logging a session');
}

async function testAutoStart() {
  const store = stubStore({ autoStartBreaks: true });
  const timer = fastTimer(store, { focus: 400, short: 3000, long: 2000 });

  timer.start();
  await sleep(700);
  assert.strictEqual(timer.state.mode, 'short', 'did not move to the break');
  assert.strictEqual(timer.state.running, true, 'break did not auto-start');
  timer.dispose();
  console.log('  breaks auto-start when the setting is on');
}

function testSettingsKeepPausedProgress() {
  const store = stubStore({ focusMin: 25 });
  withFakeClock(new Date(2026, 8, 23, 9, 0).getTime(), (clock) => {
    const timer = manualTimer(store);
    timer.start();
    clock.now += 10 * MIN;
    timer.pause();
    const atPause = timer.state.remainingMs;
    assert.strictEqual(atPause, 15 * MIN, 'setup: pause did not hold 15 minutes');

    // Saves that have nothing to do with the length on screen.
    const unrelated = [{ theme: 'dark' }, { soundId: 'rain' }, { soundVolume: 0.4 }, { weekZoom: 2 }, { longEvery: 3 }];
    for (const patch of unrelated) {
      Object.assign(store.settings, patch);
      timer.settingsChanged(patch);
      assert.strictEqual(timer.state.remainingMs, atPause, `saving ${Object.keys(patch)[0]} wiped a paused interval`);
    }

    // Even a new focus length leaves a started interval alone.
    store.settings.focusMin = 50;
    timer.settingsChanged({ focusMin: 50 });
    assert.strictEqual(timer.state.remainingMs, atPause, 'a new focus length wiped a paused interval');

    // An interval that has not been started yet does show the new length...
    timer.reset();
    store.settings.focusMin = 40;
    timer.settingsChanged({ focusMin: 40 });
    assert.strictEqual(timer.state.remainingMs, 40 * MIN, 'an unstarted timer ignored the new focus length');

    // ...but only for the mode it is in.
    store.settings.shortMin = 9;
    timer.settingsChanged({ shortMin: 9 });
    assert.strictEqual(timer.state.remainingMs, 40 * MIN, 'a short-break length changed the focus timer');
  });
  console.log('  theme, sound, zoom and duration saves keep a paused interval');
}

function testPausedTimeNotLogged() {
  const store = stubStore({ focusMin: 25 });
  withFakeClock(new Date(2026, 8, 23, 10, 0).getTime(), (clock) => {
    const timer = manualTimer(store);
    timer.start();
    clock.now += 10 * MIN;
    timer.pause();
    clock.now += 2 * 60 * MIN; // a two-hour lunch in the middle
    timer.start();
    runOut(timer, clock);

    assert.strictEqual(store.sessions.length, 1, 'the focus was not logged');
    const s = store.sessions[0];
    const minutes = (s.endedAt - s.startedAt) / MIN;
    assert.strictEqual(minutes, 25, `logged ${minutes} minutes for a 25-minute focus`);
    assert.strictEqual(s.endedAt, new Date(2026, 8, 23, 12, 25).getTime(), 'endedAt is not the completion time');
    assert.strictEqual(s.startMin, 12 * 60, `startMin ${s.startMin} is not end-aligned`);
    assert.strictEqual(s.endMin, 12 * 60 + 25, `endMin ${s.endMin} is wrong`);
    assert.strictEqual(s.sessionId, s.id, 'a single-day session should carry its own id as sessionId');
  });
  console.log('  a 25-minute focus with a 2h pause logs as 25 minutes, end-aligned');
}

function testMidnightSplit() {
  const store = stubStore({ focusMin: 25 });
  // Sunday 27 Sep 2026, 23:50 -> Monday 00:15: a different day and a different week.
  withFakeClock(new Date(2026, 8, 27, 23, 50).getTime(), (clock) => {
    const timer = manualTimer(store);
    timer.start();
    runOut(timer, clock);

    assert.strictEqual(store.sessions.length, 2, `expected 2 pieces, got ${store.sessions.length}`);
    const [a, b] = store.sessions;
    assert.deepStrictEqual(
      [a.weekKey, a.day, a.startMin, a.endMin],
      ['2026-09-21', 6, 1430, 1440],
      `first piece is ${JSON.stringify(a)}`
    );
    assert.deepStrictEqual(
      [b.weekKey, b.day, b.startMin, b.endMin],
      ['2026-09-28', 0, 0, 15],
      `second piece is ${JSON.stringify(b)}`
    );
    assert.strictEqual(a.endedAt, new Date(2026, 8, 28).getTime(), 'the cut is not at midnight');
    assert.strictEqual(a.endedAt, b.startedAt, 'the pieces do not meet at midnight');
    assert.strictEqual(b.endedAt - a.startedAt, 25 * MIN, 'the pieces do not add up to the session');
    assert.ok(a.sessionId && a.sessionId === b.sessionId, 'the pieces do not share a sessionId');
    assert.notStrictEqual(a.id, b.id, 'the pieces share an id');
    for (const s of store.sessions) {
      const keys = Object.keys(s).sort().join(',');
      assert.strictEqual(
        keys,
        'day,endMin,endedAt,id,mode,sessionId,startMin,startedAt,weekKey',
        `record shape drifted: ${keys}`
      );
    }
  });
  console.log('  23:50 -> 00:15 logs 1430-1440 on Sunday and 0-15 on Monday');
}

function testCycleResetsWhenLongBreakAbandoned() {
  const store = stubStore({ focusMin: 25, longEvery: 4 });
  withFakeClock(new Date(2026, 8, 23, 9, 0).getTime(), (clock) => {
    const timer = manualTimer(store);
    for (let i = 0; i < 4; i++) {
      timer.start();
      runOut(timer, clock);
      if (i < 3) timer.skip(); // skip the short break back to focus
    }
    assert.strictEqual(timer.state.mode, 'long', 'setup: four focuses did not reach a long break');
    assert.strictEqual(timer.state.completedInCycle, 4, 'setup: count is not 4');

    // The user clicks Focus instead of taking the long break.
    timer.setMode('focus');
    assert.strictEqual(timer.state.completedInCycle, 0, 'abandoning the long break did not close the cycle');
    timer.start();
    runOut(timer, clock);
    assert.strictEqual(timer.state.completedInCycle, 1, 'count ran past longEvery');
    assert.strictEqual(timer.state.mode, 'short', 'first focus of the new cycle went to the wrong break');

    // Skipping a long break still closes the cycle and logs nothing.
    timer.completedInCycle = 3;
    timer.setMode('focus');
    timer.start();
    runOut(timer, clock);
    assert.strictEqual(timer.state.mode, 'long', 'fourth focus did not reach a long break');
    const logged = store.sessions.length;
    timer.skip();
    assert.strictEqual(timer.state.completedInCycle, 0, 'skipping the long break did not close the cycle');
    assert.strictEqual(store.sessions.length, logged, 'skip logged a session');

    // A count already past longEvery (longEvery lowered mid-cycle) is due now.
    timer.completedInCycle = 5;
    timer.start();
    runOut(timer, clock);
    assert.strictEqual(timer.state.mode, 'long', 'an overshot count did not lead to a long break');
    assert.strictEqual(timer.state.completedInCycle, 4, 'an overshot count was not held at longEvery');
  });
  console.log('  clicking Focus over a due long break restarts the cycle; overshoot goes to long');
}

(async () => {
  const tests = [
    ['countdown accuracy', testCountdownAccuracy],
    ['pause and resume', testPauseResume],
    ['cycle and session logging', testCycleAndLogging],
    ['skip does not log', testSkipDoesNotLog],
    ['auto-start breaks', testAutoStart],
    ['settings saves keep paused progress', testSettingsKeepPausedProgress],
    ['paused time is not logged', testPausedTimeNotLogged],
    ['midnight split', testMidnightSplit],
    ['cycle resets when a long break is abandoned', testCycleResetsWhenLongBreakAbandoned]
  ];

  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      console.log(`\n${name}`);
      await fn();
    } catch (err) {
      failed++;
      console.error(`  FAILED: ${err.message}`);
    }
  }

  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})();
