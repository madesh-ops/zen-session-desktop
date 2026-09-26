/* The weekly grid: days down the left, hours across the top.
 * A dashed block is what you planned; the solid fill inside it is what you
 * actually completed, so intent and reality share one grid. */

(function (global) {
  'use strict';

  const START_HOUR = 5;
  const END_HOUR = 24; // exclusive — the last labelled column is END_HOUR - 1
  const COLS = END_HOUR - START_HOUR;
  const WINDOW_START = START_HOUR * 60;
  const WINDOW_SPAN = (END_HOUR - START_HOUR) * 60;
  const SNAP_MIN = 15;
  const DAY_COL_PX = 98; // must match --daycol in app.css
  const DRAG_THRESHOLD_PX = 10;

  // An hour is a real width now, not a share of whatever the window happens to
  // be, so it can be widened until a quarter-hour block is worth labelling.
  const HOUR_PX_DEFAULT = 64;
  const HOUR_PX_MIN = 26;
  const HOUR_PX_MAX = 240;
  const ZOOM_STEP = 1.25;
  const WHEEL_NOTCH = 120; // one wheel click, and the cap on a touchpad flick
  const ZOOM_SENSITIVITY = 0.0015; // a notch is worth ~20%
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // Two focus blocks over the same hour still read as a choice; three read as a
  // mess, and no one works three things at once. The third is refused.
  const MAX_OVERLAP = 2;

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function clockOf(min) {
    return `${pad(Math.floor(min / 60) % 24)}:${pad(Math.round(min % 60))}`;
  }

  function durationLabel(min) {
    const total = Math.max(1, Math.round(min));
    if (total < 60) return `${total}m`;
    return `${Math.floor(total / 60)}h ${pad(total % 60)}m`;
  }

  function dayIndex(date) {
    return (date.getDay() + 6) % 7;
  }

  function mondayOf(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - dayIndex(d));
    return d;
  }

  function weekKeyOf(date) {
    const m = mondayOf(date);
    return `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function minutesToPercent(min) {
    return ((clamp(min, WINDOW_START, WINDOW_START + WINDOW_SPAN) - WINDOW_START) / WINDOW_SPAN) * 100;
  }

  function overlapMinutes(a1, a2, b1, b2) {
    return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
  }

  // Sweep the day's focus blocks with the candidate added: if any instant is
  // covered more than MAX_OVERLAP times, the candidate is not allowed to land.
  function exceedsOverlapLimit(blocks, candidate) {
    const events = [];
    for (const b of [...blocks, candidate]) {
      if ((b.kind || 'focus') !== 'focus') continue;
      if (b.endMin <= b.startMin) continue;
      events.push([b.startMin, 1], [b.endMin, -1]);
    }
    // A block ending where the next begins is a handover, not an overlap, so
    // the closing edge is counted before the opening one.
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    let depth = 0;
    for (const [, delta] of events) {
      depth += delta;
      if (depth > MAX_OVERLAP) return true;
    }
    return false;
  }

  // Greedy interval packing: each item takes the first lane that is already
  // free at its start time, and opens a new one only when none is. Two blocks
  // over the same hour therefore sit above each other rather than on top of
  // each other, and a day that never double-books stays a single lane.
  function packLanes(items) {
    const sorted = [...items].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    const laneEnds = [];
    const lanes = new Map();

    for (const item of sorted) {
      let lane = laneEnds.findIndex((end) => end <= item.startMin);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = item.endMin;
      lanes.set(item, lane);
    }

    return { lanes, count: Math.max(1, laneEnds.length) };
  }

  function formatRange(monday) {
    const end = new Date(monday);
    end.setDate(end.getDate() + 6);
    const month = (d) => d.toLocaleString(undefined, { month: 'long' });
    if (monday.getMonth() === end.getMonth()) {
      return `Week of ${monday.getDate()}–${end.getDate()} ${month(monday)}`;
    }
    return `Week of ${monday.getDate()} ${month(monday)} – ${end.getDate()} ${month(end)}`;
  }

  class Timetable {
    constructor(root, api) {
      this.root = root;
      this.api = api;
      this.monday = mondayOf(new Date());
      this.data = { plan: [], sessions: [] };
      this.built = false;
      this.tracks = [];
      this._nowTimer = null;
      this._nowShown = false;
      this._nowLeftPx = null;
      this.scroller = root.parentElement; // .grid-panel — what actually scrolls
      this.hourPx = HOUR_PX_DEFAULT;
      this._zoomSave = null;
      this._didInitialScroll = false;
    }

    get weekKey() {
      return weekKeyOf(this.monday);
    }

    build() {
      if (this.built) return;
      this.root.style.setProperty('--cols', String(COLS));
      const frag = document.createDocumentFragment();

      // The one cell both sticky axes cross. Without it an hour label slides
      // into the corner and sits beside the day names as the week scrolls.
      const corner = document.createElement('div');
      corner.className = 'corner';
      frag.appendChild(corner);

      // Hour labels across the top. Which of them survive is down to the zoom
      // level; the CSS hides the rest rather than the DOM churning on a wheel.
      for (let c = 0; c < COLS; c++) {
        const hour = START_HOUR + c;
        const el = document.createElement('div');
        el.className = 'hour';
        el.style.gridColumn = String(c + 2);
        el.style.gridRow = '1';
        el.dataset.odd = String(hour % 2 !== 0);
        el.dataset.third = String(hour % 3 === 0);
        el.textContent = pad(hour);
        frag.appendChild(el);
      }

      // A rule per hour, behind everything else; the odd ones drop out when the
      // columns get tight.
      for (let c = 1; c < COLS; c++) {
        const line = document.createElement('div');
        line.className = 'gridline';
        line.style.gridColumn = String(c + 2);
        line.style.gridRow = '2 / -1';
        line.dataset.odd = String((START_HOUR + c) % 2 !== 0);
        frag.appendChild(line);
      }

      this.dayLabels = [];
      this.tracks = [];

      for (let d = 0; d < 7; d++) {
        const label = document.createElement('div');
        label.className = 'daylabel';
        label.style.gridColumn = '1';
        label.style.gridRow = String(d + 2);
        label.innerHTML = `<span>${DAY_NAMES[d]}</span><span class="num"></span>`;
        frag.appendChild(label);
        this.dayLabels.push(label);

        const track = document.createElement('div');
        track.className = 'daytrack';
        track.style.gridRow = String(d + 2);
        track.dataset.day = String(d);
        frag.appendChild(track);
        this.tracks.push(track);

        this._wireDrag(track, d);
      }

      this.todayRow = document.createElement('div');
      this.todayRow.className = 'todayrow';
      this.todayRow.style.gridColumn = '2 / -1';
      this.todayRow.style.display = 'none';
      frag.appendChild(this.todayRow);

      this.nowLine = document.createElement('div');
      this.nowLine.className = 'nowline';
      this.nowDot = document.createElement('div');
      this.nowDot.className = 'nowdot';
      frag.appendChild(this.nowLine);
      frag.appendChild(this.nowDot);

      this.root.appendChild(frag);
      this.built = true;

      this._applyZoom();
      this._wireZoom();

      this._nowTimer = setInterval(() => this._positionNow(), 30000);
    }

    async load() {
      this.build();
      this.data = await this.api.plan.week(this.weekKey);
      this.render();
    }

    goToWeek(offsetWeeks) {
      const next = new Date(this.monday);
      next.setDate(next.getDate() + offsetWeeks * 7);
      this.monday = mondayOf(next);
      this.load();
    }

    goToToday() {
      this.monday = mondayOf(new Date());
      this.load();
    }

    render() {
      const today = new Date();
      const isThisWeek = weekKeyOf(today) === this.weekKey;
      const todayIdx = dayIndex(today);

      if (isThisWeek) {
        this.todayRow.style.display = 'block';
        this.todayRow.style.gridRow = String(todayIdx + 2);
      } else {
        this.todayRow.style.display = 'none';
      }

      for (let d = 0; d < 7; d++) {
        const date = new Date(this.monday);
        date.setDate(date.getDate() + d);
        this.dayLabels[d].querySelector('.num').textContent = String(date.getDate());
        this.dayLabels[d].dataset.today = String(isThisWeek && d === todayIdx);
        this.tracks[d].replaceChildren();
      }

      const sessions = this.data.sessions || [];
      const plan = this.data.plan || [];

      // Everything that will be drawn in a day track, collected before any of
      // it is placed — the lanes cannot be worked out one block at a time.
      const byDay = Array.from({ length: 7 }, () => []);

      for (const block of plan) {
        const el = this._blockEl(block);
        // How much of this planned block did real sessions actually cover?
        let done = 0;
        for (const s of sessions) {
          if (s.day !== block.day) continue;
          done += overlapMinutes(block.startMin, block.endMin, s.startMin, s.endMin);
        }
        const span = Math.max(1, block.endMin - block.startMin);
        el.querySelector('.fill').style.width = `${clamp((done / span) * 100, 0, 100)}%`;
        byDay[block.day].push({ item: block, el });
      }

      // A completed session with nothing planned behind it gets a solid block of
      // its own, exactly where it happened — two sessions stay two blocks, never
      // one stretched over the break between them. Where something was planned,
      // the fill inside that block already stands for the same work, so the
      // session gives way to it.
      for (let d = 0; d < 7; d++) {
        const planned = plan.filter((b) => b.day === d);

        for (const session of sessions.filter((s) => s.day === d)) {
          const claimed = planned.some(
            (b) => overlapMinutes(b.startMin, b.endMin, session.startMin, session.endMin) > 0
          );
          if (claimed) continue;

          const focusMin = Math.max(0, session.endMin - session.startMin);
          const el = document.createElement('div');
          el.className = 'block actual';
          el.dataset.kind = 'focus';
          el.style.left = `${minutesToPercent(session.startMin)}%`;
          el.style.width = `${Math.max(
            0.4,
            minutesToPercent(session.endMin) - minutesToPercent(session.startMin)
          )}%`;
          el.innerHTML = `<div class="label">${durationLabel(focusMin)}</div>`;
          el.title = `Focused ${durationLabel(focusMin)} · ${clockOf(session.startMin)}–${clockOf(
            session.endMin
          )}`;
          byDay[d].push({ item: session, el });
        }
      }

      // Lanes are fractions of the row, so one lane is exactly the full-height
      // block it has always been and N lanes share the row between them. The
      // week never grows past the panel, so nothing scrolls vertically.
      for (let d = 0; d < 7; d++) {
        const entries = byDay[d];
        const { lanes, count } = packLanes(entries.map((e) => e.item));
        this.tracks[d].dataset.lanes = String(count);
        for (const entry of entries) {
          const lane = lanes.get(entry.item);
          entry.el.style.top = `calc(${lane} * 100% / ${count} + 3px)`;
          entry.el.style.height = `calc(100% / ${count} - 6px)`;
          this.tracks[d].appendChild(entry.el);
        }
      }

      this._renderHeader(sessions, plan);
      this._positionNow();
      this._initialScroll();
    }

    _blockEl(block) {
      const el = document.createElement('div');
      el.className = 'block';
      el.dataset.kind = block.kind || 'focus';
      el.dataset.id = block.id;
      el.style.left = `${minutesToPercent(block.startMin)}%`;
      el.style.width = `${Math.max(2, minutesToPercent(block.endMin) - minutesToPercent(block.startMin))}%`;

      const fill = document.createElement('div');
      fill.className = 'fill';

      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = block.label;
      label.title = 'Double-click to rename';
      label.addEventListener('dblclick', () => this._editLabel(block, label));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.setAttribute('aria-label', `Remove ${block.label}`);
      remove.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"></path></svg>';
      remove.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.api.plan.remove(block.id);
        this.load();
      });

      el.append(fill, label, remove);
      return el;
    }

    _editLabel(block, labelEl) {
      labelEl.contentEditable = 'true';
      labelEl.style.userSelect = 'text';
      labelEl.focus();
      document.execCommand('selectAll', false, null);

      const commit = async () => {
        labelEl.contentEditable = 'false';
        labelEl.style.userSelect = '';
        const text = labelEl.textContent.trim() || block.label;
        labelEl.textContent = text;
        if (text !== block.label) {
          await this.api.plan.rename(block.id, text);
          this.load();
        }
      };

      labelEl.addEventListener('blur', commit, { once: true });
      labelEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          labelEl.blur();
        }
        if (e.key === 'Escape') {
          labelEl.textContent = block.label;
          labelEl.blur();
        }
      });
    }

    // Would a block over this span be the third one stacked on some minute?
    _wouldExceedOverlap(day, startMin, endMin) {
      const sameDay = (this.data.plan || []).filter((b) => b.day === day);
      return exceedsOverlapLimit(sameDay, { startMin, endMin, kind: 'focus' });
    }

    // Drag on an empty part of a day row to block out time.
    _wireDrag(track, day) {
      let active = false;
      let committed = false;
      let anchorMin = 0;
      let draft = null;
      let samples = [];

      const minutesAt = (clientX) => {
        const rect = track.getBoundingClientRect();
        const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
        return WINDOW_START + ratio * WINDOW_SPAN;
      };

      track.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.block')) return; // let blocks handle their own clicks
        track.setPointerCapture(e.pointerId);
        active = true;
        committed = false;
        anchorMin = minutesAt(e.clientX);
        samples = [{ x: e.clientX, t: performance.now() }];
      });

      track.addEventListener('pointermove', (e) => {
        if (!active) return;
        samples.push({ x: e.clientX, t: performance.now() });
        if (samples.length > 6) samples.shift();

        if (!committed) {
          // Hysteresis: a click is not a drag until it has travelled far enough.
          if (Math.abs(e.clientX - samples[0].x) < DRAG_THRESHOLD_PX) return;
          committed = true;
          draft = document.createElement('div');
          draft.className = 'draft';
          track.appendChild(draft);
        }

        const current = minutesAt(e.clientX);
        const lo = Math.min(anchorMin, current);
        const hi = Math.max(anchorMin, current);
        draft.style.left = `${minutesToPercent(lo)}%`;
        draft.style.width = `${minutesToPercent(hi) - minutesToPercent(lo)}%`;
        // The draft says no before the release does, so the limit is never a
        // surprise at the end of a drag.
        draft.dataset.invalid = String(this._wouldExceedOverlap(day, lo, hi));
      });

      const finish = async (e) => {
        if (!active) return;
        active = false;
        try {
          track.releasePointerCapture(e.pointerId);
        } catch { }

        if (!committed) return;
        if (draft) draft.remove();
        draft = null;

        // Momentum projection: the edge lands where the flick was heading,
        // then snaps to the nearest quarter hour — not nearest-from-release.
        const last = samples[samples.length - 1];
        const first = samples[0];
        const dt = Math.max(1, last.t - first.t);
        const pxPerSec = ((last.x - first.x) / dt) * 1000;
        const rect = track.getBoundingClientRect();
        const minPerPx = WINDOW_SPAN / rect.width;
        const projectedPx = global.Motion.projectMomentum(pxPerSec);
        const releaseMin = minutesAt(last.x);
        const projectedMin = releaseMin + projectedPx * minPerPx;

        let lo = Math.min(anchorMin, projectedMin);
        let hi = Math.max(anchorMin, projectedMin);
        lo = Math.round(lo / SNAP_MIN) * SNAP_MIN;
        hi = Math.round(hi / SNAP_MIN) * SNAP_MIN;
        lo = clamp(lo, WINDOW_START, WINDOW_START + WINDOW_SPAN - SNAP_MIN);
        hi = clamp(hi, lo + SNAP_MIN, WINDOW_START + WINDOW_SPAN);

        if (this._wouldExceedOverlap(day, lo, hi)) return;

        await this.api.plan.add({
          weekKey: this.weekKey,
          day,
          startMin: lo,
          endMin: hi,
          label: 'Focus block',
          kind: 'focus'
        });
        this.load();
      };

      track.addEventListener('pointerup', finish);
      track.addEventListener('pointercancel', (e) => {
        active = false;
        committed = false;
        if (draft) {
          draft.remove();
          draft = null;
        }
      });
    }

    _renderHeader(sessions, plan) {
      const title = document.getElementById('week-title');
      const sub = document.getElementById('week-sub');
      if (title) title.textContent = formatRange(this.monday);
      if (sub) {
        const focusedMin = sessions.reduce((acc, s) => acc + Math.max(0, s.endMin - s.startMin), 0);
        const h = Math.floor(focusedMin / 60);
        const m = Math.round(focusedMin % 60);
        const time = h > 0 ? `${h} h ${m} m` : `${m} m`;
        // A session that runs past midnight is stored as one piece per day, all
        // sharing a sessionId, so the pieces are counted once. The minutes above
        // still add up piece by piece, which is exactly the whole session. Older
        // records have no sessionId and stand for themselves — by id, or failing
        // even that, as the record itself.
        const completed = new Set(sessions.map((s) => s.sessionId || s.id || s)).size;
        sub.innerHTML = `${plan.length} block${plan.length === 1 ? '' : 's'} planned · <em>${completed} session${
          completed === 1 ? '' : 's'
        } completed</em> · ${time} focused`;
      }
    }

    // --- zoom ------------------------------------------------------------

    // px is the width of one hour column. Everything else — the now line, the
    // scroll extent, how many hour labels fit — falls out of it.
    setZoom(px, opts = {}) {
      const next = clamp(Math.round(px), HOUR_PX_MIN, HOUR_PX_MAX);
      if (next === this.hourPx) return;

      const previous = this.hourPx;
      const panel = this.scroller;
      const anchored = this.built && panel && opts.anchorX != null;

      // Which hour is under the cursor, measured against the scrollport rather
      // than the grid's own box, whose max-content width rounds as it grows.
      let offsetX = 0;
      let hours = 0;
      if (anchored) {
        offsetX = opts.anchorX - panel.getBoundingClientRect().left;
        hours = (panel.scrollLeft + offsetX - DAY_COL_PX) / previous;
      }

      this.hourPx = next;
      this._applyZoom();

      // Put that same hour back under the cursor at the new width. The read of
      // scrollWidth is load-bearing: it flushes the layout the new column width
      // just invalidated, so the write below is clamped against the grid's new
      // extent rather than the old, narrower one.
      if (anchored) {
        void panel.scrollWidth;
        panel.scrollLeft = DAY_COL_PX + hours * next - offsetX;
      }

      this._positionNow();
      if (opts.persist !== false) this._persistZoom();
    }

    zoomBy(factor) {
      const rect = this.scroller ? this.scroller.getBoundingClientRect() : null;
      this.setZoom(this.hourPx * factor, { anchorX: rect ? rect.left + rect.width / 2 : null });
    }

    _applyZoom() {
      this.root.style.setProperty('--hour-px', `${this.hourPx}px`);
      // Below these widths the labels collide, so they thin out instead.
      this.root.dataset.density = this.hourPx >= 44 ? 'full' : this.hourPx >= 32 ? 'half' : 'third';
      this.root.dataset.rules = this.hourPx >= 70 ? 'hour' : 'two';
    }

    _persistZoom() {
      // One wheel gesture is a burst of events; the store only needs the last.
      clearTimeout(this._zoomSave);
      this._zoomSave = setTimeout(() => this.api.settings.set({ weekZoom: this.hourPx }), 400);
    }

    _wireZoom() {
      const panel = this.scroller;
      if (!panel) return;

      panel.addEventListener('scroll', () => this._clipNow(), { passive: true });

      // The grid reads as a horizontal timeline, and it is the only axis there
      // is, so any wheel that is not a zoom moves along it.
      panel.addEventListener(
        'wheel',
        (e) => {
          const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
          if (e.ctrlKey) {
            e.preventDefault();
            // A precision touchpad can report a delta in the hundreds for one
            // gesture, and an unbounded exponent turns that into a jump from end
            // to end of the range. One event is worth a notch, no more.
            const notch = clamp(delta, -WHEEL_NOTCH, WHEEL_NOTCH);
            this.setZoom(this.hourPx * Math.exp(-notch * ZOOM_SENSITIVITY), { anchorX: e.clientX });
          } else {
            e.preventDefault();
            panel.scrollLeft += delta;
          }
        },
        { passive: false }
      );
    }

    // Open on the working day rather than on 05:00, and on the current hour when
    // the week on screen is the one being lived in. Only ever on the first
    // render — after that the scroll position is the user's.
    _initialScroll() {
      if (this._didInitialScroll || !this.scroller) return;
      this._didInitialScroll = true;

      const now = new Date();
      const target =
        weekKeyOf(now) === this.weekKey ? now.getHours() * 60 + now.getMinutes() - 60 : 8 * 60;
      const mins = clamp(target, WINDOW_START, WINDOW_START + WINDOW_SPAN);
      this.scroller.scrollLeft = ((mins - WINDOW_START) / 60) * this.hourPx;
    }

    _positionNow() {
      if (!this.built) return;
      const now = new Date();
      const inThisWeek = weekKeyOf(now) === this.weekKey;
      const mins = now.getHours() * 60 + now.getMinutes();
      const inWindow = mins >= WINDOW_START && mins <= WINDOW_START + WINDOW_SPAN;
      const show = inThisWeek && inWindow;

      this._nowShown = show;
      if (!show) {
        this._nowLeftPx = null;
        this._clipNow();
        return;
      }

      // Exact, now that an hour is a width: no interpolating across a container
      // whose 100% is the whole scrollable span rather than what is on screen.
      const hours = (mins - WINDOW_START) / 60;
      const left = `calc(${DAY_COL_PX}px + ${this.hourPx}px * ${hours.toFixed(4)})`;
      this.nowLine.style.left = left;
      this.nowDot.style.left = left;
      this._nowLeftPx = DAY_COL_PX + this.hourPx * hours;
      this._clipNow();
    }

    // The day column is sticky and opaque, so the marker itself disappears
    // behind it once the day has been scrolled past now — but its glow is not
    // clipped by anything, and leaks out above the first day and below the last
    // as two stray smears. Scrolled out of the timeline is scrolled out of
    // sight.
    _clipNow() {
      if (!this.built) return;
      const behind =
        this._nowLeftPx == null ||
        !this.scroller ||
        this._nowLeftPx - this.scroller.scrollLeft < DAY_COL_PX;
      const visible = this._nowShown && !behind;
      for (const el of [this.nowLine, this.nowDot]) {
        el.style.display = visible ? 'block' : 'none';
      }
    }
  }

  // The timer view needs the same week/day arithmetic to ask what is planned
  // for right now, and two copies of it would be two things to keep in step.
  Timetable.ZOOM_STEP = ZOOM_STEP;
  Timetable.weekKeyOf = weekKeyOf;
  Timetable.dayIndex = dayIndex;

  global.Timetable = Timetable;
})(window);
