(function () {
  'use strict';

  const api = window.pomodoro;
  const { Spring } = window.Motion;

  const CIRCUMFERENCE = 2 * Math.PI * 170; // r = 170 on the 380px ring

  // Colours live in tokens.css; each swatch gets a data-theme and inherits them.
  // Midnight first: it is the default, and applyTheme falls back to the head
  // of this list when a stored theme names something that no longer exists.
  const THEMES = [
    { id: 'midnight', name: 'Midnight', hint: 'Midnight — true black, for OLED panels' },
    { id: 'forest', name: 'Forest', hint: 'Forest — green focus, coral break' },
    { id: 'amber', name: 'Amber', hint: 'Amber — warm focus, cool teal break' },
    { id: 'slate', name: 'Slate', hint: 'Slate — calm blue focus, sand break' },
    { id: 'graphite', name: 'Graphite', hint: 'Graphite — one accent, modes differ by intensity' }
  ];

  const MODE_NAMES = { focus: 'Focus', short: 'Short break', long: 'Long break' };

  const PLAY_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"></path></svg>';
  const PAUSE_ICON =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.4"></rect><rect x="13.5" y="5" width="4" height="14" rx="1.4"></rect></svg>';

  const el = {
    root: document.documentElement,
    shell: document.getElementById('shell'),
    clock: document.getElementById('clock'),
    ring: document.getElementById('ring-progress'),
    ringWrap: document.querySelector('.ring-wrap'),
    ringLabel: document.getElementById('ring-label'),
    ringSub: document.getElementById('ring-sub'),
    statusText: document.getElementById('status-text'),
    primary: document.getElementById('btn-primary'),
    primaryIcon: document.getElementById('primary-icon'),
    primaryText: document.getElementById('primary-text'),
    dots: document.getElementById('dots'),
    themes: document.getElementById('themes'),
    themeHint: document.getElementById('theme-hint'),
    ringNow: document.getElementById('ring-now'),
    ringNowWhat: document.getElementById('ring-now-what'),
    ringNowUntil: document.getElementById('ring-now-until'),
    soundGrid: document.getElementById('sound-grid'),
    soundBtn: document.getElementById('btn-sound'),
    soundIcon: document.getElementById('sound-icon'),
    soundText: document.getElementById('sound-text'),
    soundNow: document.getElementById('sound-now'),
    soundNowHint: document.getElementById('sound-now-hint'),
    soundCredit: document.getElementById('sound-credit'),
    soundVolume: document.getElementById('sound-volume')
  };

  let state = null;
  let settings = null;
  let timetable = null;
  let nowBlockTimer = null;
  let soundId = window.Ambience.SOUNDS[0].id;

  // --- motion ------------------------------------------------------------
  // The sweep itself is linear off the clock; only the discrete moments spring.
  const ringScale = new Spring({
    value: 1,
    damping: 0.8,
    response: 0.4,
    onUpdate: (v) => {
      el.ringWrap.style.transform = `scale(${v})`;
    }
  });

  const ringGlow = new Spring({
    value: 0,
    damping: 1,
    response: 0.35,
    onUpdate: (v) => {
      el.ring.style.opacity = String(0.35 + 0.65 * v);
    }
  });

  // One pane of glass per group, travelling between the buttons of that group.
  let railThumb = null;
  let modeThumb = null;

  function buildLiquid() {
    railThumb = window.Liquid.indicator(document.querySelector('.rail'), {
      selector: '.rail-btn',
      isActive: (btn) => btn.hasAttribute('aria-current'),
      axis: 'y',
      className: 'rail-thumb'
    });

    modeThumb = window.Liquid.indicator(document.querySelector('.segmented'), {
      selector: 'button',
      isActive: (btn) => btn.getAttribute('aria-pressed') === 'true',
      axis: 'x',
      className: 'mode-thumb'
    });

    // Both are measured from layout, so they have to be remeasured whenever the
    // layout can have changed underneath them.
    const resync = () => {
      railThumb.sync();
      modeThumb.sync();
    };
    window.addEventListener('resize', resync);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(resync);

    // Feedback on pointer-down, never on click — delegated, so the theme
    // swatches and week chips built later are covered too.
    window.Liquid.ripples(
      document.body,
      '.rail-btn, .segmented button, .glass-btn, .chip-btn, .theme-btn, .win-btn, .step, .sound-card'
    );
  }

  function setRingProgress(fraction) {
    const clamped = Math.max(0, Math.min(1, fraction));
    el.ring.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - clamped));
  }

  // --- rendering ---------------------------------------------------------

  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function render(next) {
    const modeChanged = !state || state.mode !== next.mode;
    const runChanged = !state || state.running !== next.running;
    state = next;

    el.root.dataset.mode = state.mode;
    el.shell.dataset.running = String(state.running);

    el.clock.textContent = formatClock(state.remainingMs);
    document.title = `${formatClock(state.remainingMs)} · ${MODE_NAMES[state.mode]} · Zen Session`;

    const elapsed = state.totalMs > 0 ? 1 - state.remainingMs / state.totalMs : 0;
    setRingProgress(elapsed);

    el.ringLabel.textContent = state.running ? MODE_NAMES[state.mode] : 'Ready';
    el.statusText.textContent = state.mode === 'focus' ? 'Focusing' : 'On a break';

    if (state.mode === 'focus') {
      el.ringSub.textContent = `Session ${Math.min(state.completedInCycle + 1, state.longEvery)} of ${state.longEvery}`;
    } else {
      el.ringSub.textContent = 'Focus resumes next';
    }

    el.primaryIcon.innerHTML = state.running ? PAUSE_ICON : PLAY_ICON;
    el.primaryText.textContent = state.running
      ? 'Pause'
      : state.mode === 'focus'
      ? 'Start focus'
      : 'Start break';

    for (const btn of document.querySelectorAll('.segmented button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === state.mode));
    }
    if (modeThumb) modeThumb.sync();

    renderDots();

    if (runChanged) ringGlow.to(state.running ? 1 : 0);
    if (modeChanged) {
      ringGlow.to(state.running ? 1 : 0);
    }
  }

  function renderDots() {
    const total = state.longEvery;
    if (el.dots.childElementCount !== total) {
      el.dots.replaceChildren();
      for (let i = 0; i < total; i++) el.dots.appendChild(document.createElement('span'));
    }
    [...el.dots.children].forEach((dot, i) => {
      dot.dataset.done = String(i < state.completedInCycle);
      dot.dataset.current = String(i === state.completedInCycle && state.mode === 'focus');
    });
  }

  // --- what is planned for right now -------------------------------------

  function hhmm(min) {
    const h = Math.floor(min / 60) % 24;
    const m = Math.round(min % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // The timetable is the source of truth; the timer face only reads it. A block
  // counts as current when the clock sits inside it, and the soonest-ending one
  // wins if two overlap, because that is the one about to demand attention.
  async function refreshNowBlock() {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const day = window.Timetable.dayIndex(now);

    let block = null;
    try {
      const week = await api.plan.week(window.Timetable.weekKeyOf(now));
      for (const b of week.plan || []) {
        if (b.day !== day) continue;
        if (nowMin < b.startMin || nowMin >= b.endMin) continue;
        if (!block || b.endMin < block.endMin) block = b;
      }
    } catch {
      block = null;
    }

    el.ringNow.dataset.has = String(Boolean(block));
    if (!block) return;

    el.ringNowWhat.textContent = block.label;
    el.ringNowUntil.textContent = `till ${hhmm(block.endMin)}`;
    el.ringNow.title = `${block.label} · ${hhmm(block.startMin)}–${hhmm(block.endMin)}`;
  }

  function watchNowBlock() {
    refreshNowBlock();
    clearInterval(nowBlockTimer);
    // Blocks snap to the quarter hour, so a half-minute beat is more than enough
    // to catch an edge without asking the main process anything like as often.
    nowBlockTimer = setInterval(refreshNowBlock, 30000);
  }

  // --- sounds ------------------------------------------------------------
  // The engine in ambience.js owns the audio; this owns the section. Playback
  // is never started on its own — the choice and the volume come back from
  // the store, silence does too, and only a press makes a sound.

  const BARS =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
    '<path class="bar" d="M6 9v6"></path><path class="bar" d="M12 5v14"></path><path class="bar" d="M18 9v6"></path></svg>';

  const STOP_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.4"></rect></svg>';

  function buildSounds() {
    el.soundGrid.replaceChildren();
    for (const sound of window.Ambience.SOUNDS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sound-card';
      btn.dataset.sound = sound.id;
      btn.setAttribute('aria-pressed', 'false');

      const glyph = document.createElement('span');
      glyph.className = 'glyph';
      glyph.innerHTML = BARS;

      const text = document.createElement('span');
      text.className = 'text';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = sound.name;
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = sound.hint;
      text.append(name, hint);

      btn.append(glyph, text);
      btn.addEventListener('click', () => selectSound(sound.id));
      el.soundGrid.appendChild(btn);
    }
  }

  // Picking while something is playing crossfades to it; picking while silent
  // only moves the selection, because a click on a card is not a play button.
  // play() resolves when the recording has decoded and is audible; the state
  // it reports flips on the press, so the button never lags behind the click.
  function selectSound(id) {
    if (id === soundId && window.Ambience.isPlaying()) return;
    soundId = id;
    if (window.Ambience.isPlaying()) window.Ambience.play(id).then(renderSounds);
    renderSounds();
    api.settings.set({ soundId: id });
  }

  function toggleSound() {
    if (window.Ambience.isPlaying()) window.Ambience.stop();
    else window.Ambience.play(soundId).then(renderSounds);
    renderSounds();
  }

  function renderSounds() {
    const sound = window.Ambience.SOUNDS.find((s) => s.id === soundId) || window.Ambience.SOUNDS[0];
    const playing = window.Ambience.isPlaying();

    for (const card of el.soundGrid.children) {
      const picked = card.dataset.sound === sound.id;
      card.setAttribute('aria-pressed', String(picked));
      card.dataset.playing = String(picked && playing);
    }

    el.soundIcon.innerHTML = playing ? STOP_ICON : PLAY_ICON;
    el.soundText.textContent = playing ? 'Stop' : 'Play';
    el.soundNow.textContent = sound.name;
    el.soundNowHint.textContent = playing ? 'Playing' : sound.hint;

    // The recorded sounds are used under licences that ask to be carried with
    // them, so the credit is part of the player, not buried in a file. If the
    // recording could not be read the engine synthesises instead, and saying
    // so is more honest than crediting a recording nobody is hearing.
    if (!sound.credit) {
      el.soundCredit.textContent = 'Generated in the app, not recorded';
    } else if (playing && !window.Ambience.isRecorded(sound.id)) {
      el.soundCredit.textContent = 'Recording unavailable — generated instead';
    } else {
      el.soundCredit.textContent =
        `${sound.credit.title} — ${sound.credit.author} · ${sound.credit.license}`;
    }

    // Audible from any section, so the rail says so from any section.
    const rail = document.querySelector('.rail-btn[data-view="sounds"]');
    if (rail) rail.dataset.playing = String(playing);
  }

  function wireSounds() {
    el.soundBtn.addEventListener('click', toggleSound);

    // Live while dragging, persisted only when the drag ends: the store write
    // is debounced, but there is no reason to feed it every pixel.
    el.soundVolume.addEventListener('input', () => {
      window.Ambience.setVolume(Number(el.soundVolume.value) / 100);
    });
    el.soundVolume.addEventListener('change', () => {
      api.settings.set({ soundVolume: Number(el.soundVolume.value) / 100 });
    });
  }

  // --- settings ----------------------------------------------------------

  function buildThemes() {
    el.themes.replaceChildren();
    for (const theme of THEMES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'theme-btn';
      btn.setAttribute('aria-label', `${theme.name} theme`);
      btn.setAttribute('aria-pressed', 'false');
      btn.dataset.theme = theme.id;
      btn.innerHTML = '<i class="a"></i><i class="b"></i>';
      btn.addEventListener('click', () => applyTheme(theme.id, true));
      el.themes.appendChild(btn);
    }
  }

  function applyTheme(id, persist) {
    const theme = THEMES.find((t) => t.id === id) || THEMES[0];
    el.root.dataset.theme = theme.id;
    el.themeHint.textContent = theme.hint;
    for (const btn of el.themes.children) {
      btn.setAttribute('aria-pressed', String(btn.dataset.theme === theme.id));
    }
    if (persist) api.settings.set({ theme: theme.id });
  }

  function renderSettings(next) {
    settings = next;
    document.getElementById('s-focus').value = settings.focusMin;
    document.getElementById('s-short').value = settings.shortMin;
    document.getElementById('s-long').value = settings.longMin;
    document.getElementById('s-every').value = settings.longEvery;

    // The timetable owns its zoom while you are using it; this only carries the
    // stored value in, and setZoom ignores a value it is already at, so a
    // settings broadcast cannot pull the grid out from under a wheel gesture.
    if (timetable && typeof settings.weekZoom === 'number') {
      timetable.setZoom(settings.weekZoom, { persist: false });
    }

    // The selection and the level are restored; playback never is. The slider
    // is left alone while it is the element being dragged, the same way the
    // timetable keeps its zoom out of a broadcast's reach.
    // A stored id can name a sound that no longer exists: brown noise became
    // white noise, and white noise was then dropped altogether. So the stored
    // value is checked against the list rather than trusted, and anyone left
    // pointing at a dead id lands on the first sound.
    if (window.Ambience.SOUNDS.some((s) => s.id === settings.soundId)) {
      soundId = settings.soundId;
    }
    if (typeof settings.soundVolume === 'number') {
      window.Ambience.setVolume(settings.soundVolume);
      if (document.activeElement !== el.soundVolume) {
        el.soundVolume.value = Math.round(settings.soundVolume * 100);
      }
    }
    renderSounds();

    for (const step of document.querySelectorAll('.step[data-for]')) {
      const input = document.getElementById(step.dataset.for);
      const next = Number(input.value) + Number(step.dataset.step);
      step.disabled = next < Number(input.min) || next > Number(input.max);
    }

    for (const sw of document.querySelectorAll('.switch[data-setting]')) {
      sw.setAttribute('aria-checked', String(Boolean(settings[sw.dataset.setting])));
    }
    applyTheme(settings.theme, false);
  }

  function wireSettings() {
    const numeric = [
      ['s-focus', 'focusMin', 1, 180],
      ['s-short', 'shortMin', 1, 60],
      ['s-long', 'longMin', 1, 120],
      ['s-every', 'longEvery', 1, 12]
    ];

    for (const [id, key, min, max] of numeric) {
      const input = document.getElementById(id);
      const commit = async (value) => {
        const clamped = Math.max(min, Math.min(max, Math.round(Number(value) || min)));
        input.value = clamped;
        renderSettings(await api.settings.set({ [key]: clamped }));
      };

      input.addEventListener('change', () => commit(input.value));

      // The native spinner is hidden in CSS; these are what replace it.
      for (const step of document.querySelectorAll(`.step[data-for="${id}"]`)) {
        step.addEventListener('click', () => commit(Number(input.value) + Number(step.dataset.step)));
      }
    }

    for (const sw of document.querySelectorAll('.switch[data-setting]')) {
      sw.addEventListener('click', async () => {
        const key = sw.dataset.setting;
        const next = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', String(next));
        // Switching the chime on plays it once: it is the only setting here
        // whose effect you would otherwise have to wait out a timer to hear.
        if (key === 'chime' && next) window.Ambience.chime();
        renderSettings(await api.settings.set({ [key]: next }));
      });
    }

    document.getElementById('btn-quit').addEventListener('click', () => api.window.quit());
  }

  // --- navigation --------------------------------------------------------

  const VIEW_ORDER = ['timer', 'timetable', 'sounds', 'settings'];
  let currentView = 'timer';

  function showView(name) {
    if (name === currentView) return;

    // The rail runs top to bottom, so a section below the current one arrives
    // from below and leaves downward. Enter and exit share the axis.
    const dir = VIEW_ORDER.indexOf(name) > VIEW_ORDER.indexOf(currentView) ? 1 : -1;
    currentView = name;

    for (const view of document.querySelectorAll('.view')) {
      view.dataset.active = String(view.id === `view-${name}`);
    }
    for (const btn of document.querySelectorAll('.rail-btn')) {
      if (btn.dataset.view === name) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    }

    railThumb.sync();
    // The mode pill cannot be measured while its section is hidden, so it is
    // placed the moment that section is displayed again and never before.
    if (name === 'timer') modeThumb.sync();
    if (name === 'timetable' && timetable) timetable.load();

    // After the view is displayed, so it can be measured and laid out first.
    window.Liquid.transitionView(
      document.getElementById(`view-${name}`),
      document.querySelector('.main'),
      dir
    );
  }

  // --- wiring ------------------------------------------------------------

  function wire() {
    for (const btn of document.querySelectorAll('.rail-btn')) {
      btn.addEventListener('click', () => showView(btn.dataset.view));
    }

    for (const btn of document.querySelectorAll('.segmented button')) {
      btn.addEventListener('click', () => api.timer.setMode(btn.dataset.mode));
    }

    el.primary.addEventListener('click', () => api.timer.toggle());
    document.getElementById('btn-reset').addEventListener('click', () => api.timer.reset());
    document.getElementById('btn-skip').addEventListener('click', () => api.timer.skip());

    document.getElementById('btn-pill').addEventListener('click', () => api.window.minimizeToPill());
    document.getElementById('btn-min').addEventListener('click', () => api.window.minimize());
    document.getElementById('btn-close').addEventListener('click', () => api.window.close());

    document.getElementById('week-prev').addEventListener('click', () => timetable.goToWeek(-1));
    document.getElementById('week-next').addEventListener('click', () => timetable.goToWeek(1));
    document.getElementById('week-today').addEventListener('click', () => timetable.goToToday());
    document
      .getElementById('week-zoom-in')
      .addEventListener('click', () => timetable.zoomBy(window.Timetable.ZOOM_STEP));
    document
      .getElementById('week-zoom-out')
      .addEventListener('click', () => timetable.zoomBy(1 / window.Timetable.ZOOM_STEP));

    document.addEventListener('keydown', (e) => {
      const typing = ['INPUT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable;
      if (typing) return;
      if (e.code === 'Space') {
        e.preventDefault();
        api.timer.toggle();
      }
      if (e.key === '1') showView('timer');
      if (e.key === '2') showView('timetable');
      if (e.key === '3') showView('sounds');
      if (e.key === '4') showView('settings');
    });

    api.timer.onState(render);
    api.settings.onChanged(renderSettings);
    api.plan.onChanged(() => {
      if (document.getElementById('view-timetable').dataset.active === 'true') timetable.load();
      refreshNowBlock();
    });

    api.timer.onComplete(() => {
      // The one place bounce is earned: the ring closes, overshoots once, settles.
      ringScale.velocity = 2.4;
      ringScale.to(1);
      if (settings && settings.chime) window.Ambience.chime();
    });
  }

  async function init() {
    buildThemes();
    buildSounds();
    buildLiquid();
    wireSettings();
    wireSounds();
    wire();

    timetable = new window.Timetable(document.getElementById('grid'), api);

    renderSettings(await api.settings.get());
    render(await api.timer.get());
    watchNowBlock();
  }

  init();
})();
