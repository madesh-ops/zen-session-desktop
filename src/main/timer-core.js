'use strict';

const { EventEmitter } = require('events');
const { weekKey, dayIndex, minutesOfDay } = require('./week');

const TICK_MS = 250;

// The single source of truth for the timer, deliberately in the main process:
// both windows render the same state, and a hidden or throttled renderer can
// never desync it. Remaining time is always derived from a wall-clock deadline,
// never accumulated from interval callbacks, so it cannot drift.
class TimerCore extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.mode = 'focus';
    this.running = false;
    this.endsAt = 0;
    this.remainingMs = this.durationFor('focus');
    this.completedInCycle = 0;
    // Whether the current interval has been started at all. A paused interval
    // is still "started": its progress belongs to the user and must survive
    // anything short of reset, a mode change or the interval ending.
    this.started = false;
    // Time the current interval has actually spent running. Paused time is not
    // focus time, so the logged session is built from this, not from the moment
    // the interval was first started.
    this.runMs = 0;
    // remainingMs at the moment the current running stretch began; what the
    // stretch has consumed is measured against it at pause or completion.
    this._segmentMs = 0;
    this._interval = setInterval(() => this._tick(), TICK_MS);
  }

  durationFor(mode) {
    const s = this.store.settings;
    const minutes = mode === 'focus' ? s.focusMin : mode === 'short' ? s.shortMin : s.longMin;
    return Math.max(1, Number(minutes) || 1) * 60 * 1000;
  }

  get totalMs() {
    return this.durationFor(this.mode);
  }

  get state() {
    return {
      mode: this.mode,
      running: this.running,
      remainingMs: Math.max(0, Math.round(this.remainingMs)),
      totalMs: this.totalMs,
      completedInCycle: this.completedInCycle,
      longEvery: Math.max(1, Number(this.store.settings.longEvery) || 4)
    };
  }

  _emit() {
    this.emit('state', this.state);
  }

  _tick() {
    if (!this.running) return;
    const left = this.endsAt - Date.now();
    if (left <= 0) {
      // The whole of what was left when this stretch began has now run.
      this.runMs += this._segmentMs;
      this._segmentMs = 0;
      this.remainingMs = 0;
      this._complete();
      return;
    }
    this.remainingMs = left;
    this._emit();
  }

  start() {
    if (this.running) return;
    if (this.remainingMs <= 0) this.remainingMs = this.totalMs;
    this._segmentMs = this.remainingMs;
    this.endsAt = Date.now() + this.remainingMs;
    this.running = true;
    this.started = true;
    this._emit();
  }

  pause() {
    if (!this.running) return;
    this.remainingMs = Math.max(0, this.endsAt - Date.now());
    this.runMs += this._segmentMs - this.remainingMs;
    this.running = false;
    this._emit();
  }

  toggle() {
    if (this.running) this.pause();
    else this.start();
  }

  // Forget the current interval: nothing it ran is kept or logged.
  _forgetInterval() {
    this.running = false;
    this.started = false;
    this.runMs = 0;
    this._segmentMs = 0;
  }

  reset() {
    this._forgetInterval();
    this.remainingMs = this.totalMs;
    this._emit();
  }

  setMode(mode, { autoStart = false } = {}) {
    if (!['focus', 'short', 'long'].includes(mode)) return;
    // Walking away from a long break without finishing it (clicking Focus while
    // one is due) still closes the cycle. Otherwise the count would stay at
    // longEvery, climb past it on the next focus, and push the following long
    // break a whole cycle further away.
    if (this.mode === 'long' && mode !== 'long') this.completedInCycle = 0;
    this.mode = mode;
    this._forgetInterval();
    this.remainingMs = this.totalMs;
    this._emit();
    if (autoStart) this.start();
  }

  // Skip is an explicit user action: it moves on without logging a completed session.
  skip() {
    this._advance({ logged: false });
  }

  _complete() {
    this._advance({ logged: true });
  }

  _advance({ logged }) {
    const finishedMode = this.mode;

    if (logged && finishedMode === 'focus' && this.started && this.runMs > 0) {
      this._logSession(new Date(), this.runMs);
    }

    let next;
    if (finishedMode === 'focus') {
      if (logged) this.completedInCycle += 1;
      const longEvery = Math.max(1, Number(this.store.settings.longEvery) || 4);
      // >= rather than an exact multiple: if the count ever overshoots (longEvery
      // lowered mid-cycle, say), the long break is due now, not a cycle later.
      // The count is held at longEvery so the dots read "all done".
      if (this.completedInCycle >= longEvery) {
        this.completedInCycle = longEvery;
        next = 'long';
      } else {
        next = 'short';
      }
    } else {
      next = 'focus';
      if (finishedMode === 'long') this.completedInCycle = 0;
    }

    this._forgetInterval();
    this.mode = next;
    this.remainingMs = this.totalMs;

    if (logged) this.emit('complete', { finishedMode, nextMode: next });
    this._emit();

    const s = this.store.settings;
    const shouldAutoStart = next === 'focus' ? s.autoStartFocus : s.autoStartBreaks;
    if (logged && shouldAutoStart) this.start();
  }

  // The session is logged as the time that actually ran, ending now: endedAt is
  // the completion and startedAt is backed off by the running time, so pauses
  // drop out and the block sits flush against when the work finished. A session
  // that crosses midnight is written as one record per calendar day, because
  // the timetable is a grid of days and a block cannot wrap from one row into
  // the next. Every piece shares a sessionId so they can be told apart from two
  // separate sessions.
  _logSession(ended, focusedMs) {
    const endedAt = ended.getTime();
    const sessionId = `s${endedAt}`;
    const pieces = [];

    let from = new Date(endedAt - focusedMs);
    while (from.getTime() < endedAt) {
      const midnight = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
      const crosses = midnight.getTime() < endedAt;
      const to = crosses ? midnight : ended;
      pieces.push({
        startedAt: from.getTime(),
        endedAt: to.getTime(),
        weekKey: weekKey(from),
        day: dayIndex(from),
        startMin: Math.round(minutesOfDay(from)),
        // A piece cut at midnight ends at the bottom of its own day, not at
        // minute 0 of the next one.
        endMin: crosses ? 1440 : Math.round(minutesOfDay(to))
      });
      from = to;
    }

    pieces.forEach((piece, i) => {
      this.store.addSession({
        id: pieces.length === 1 ? sessionId : `${sessionId}-${i}`,
        sessionId,
        startedAt: piece.startedAt,
        endedAt: piece.endedAt,
        mode: 'focus',
        weekKey: piece.weekKey,
        day: piece.day,
        startMin: piece.startMin,
        endMin: piece.endMin
      });
    });
  }

  // Settings changed under us. Only a new length for the mode on screen can
  // matter, and only to an interval that has not been started yet: a paused
  // interval keeps its progress, and a theme or sound save must never wipe it.
  // Called with no patch, any key might have changed, so durations count.
  settingsChanged(patch) {
    const durationKey = { focus: 'focusMin', short: 'shortMin', long: 'longMin' }[this.mode];
    const touchesDuration = !patch || durationKey in patch;
    if (touchesDuration && !this.running && !this.started) this.remainingMs = this.totalMs;
    this._emit();
  }

  dispose() {
    clearInterval(this._interval);
  }
}

module.exports = { TimerCore };
