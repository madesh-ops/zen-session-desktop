(function () {
  'use strict';

  const api = window.pomodoro;

  const PLAY =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"></path></svg>';
  const PAUSE =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.4"></rect><rect x="13.5" y="5" width="4" height="14" rx="1.4"></rect></svg>';

  const pill = document.getElementById('pill');
  const timeEl = document.getElementById('time');
  const fillEl = document.getElementById('fill');
  const toggleBtn = document.getElementById('btn-toggle');
  const mediaEl = document.getElementById('media');
  const nameEl = document.getElementById('track-name');
  const sourceEl = document.getElementById('source');

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function renderState(state) {
    document.documentElement.dataset.mode = state.mode;
    pill.dataset.running = String(state.running);
    timeEl.textContent = formatClock(state.remainingMs);
    toggleBtn.innerHTML = state.running ? PAUSE : PLAY;
    toggleBtn.setAttribute('aria-label', state.running ? 'Pause' : 'Start');

    const elapsed = state.totalMs > 0 ? 1 - state.remainingMs / state.totalMs : 0;
    fillEl.style.width = `${Math.max(0, Math.min(1, elapsed)) * 100}%`;
  }

  // One pair of springs for the life of the pill. A fresh pair per update
  // would leave the old one still running underneath: a hide arriving mid
  // fade-in was overwritten a frame later by the fade-in finishing.
  let mediaOpacity = null;
  let mediaLift = null;
  let mediaShown = false;

  function mediaSprings() {
    if (!mediaOpacity) {
      mediaOpacity = new window.Motion.Spring({
        value: 0,
        damping: 1,
        response: 0.3,
        onUpdate: (v) => {
          mediaEl.style.opacity = String(v);
        }
      });
      // damping 0.8 / response 0.30 — the same spring as the minimize morph.
      mediaLift = new window.Motion.Spring({
        value: 5,
        damping: 0.8,
        response: 0.3,
        onUpdate: (v) => {
          mediaEl.style.transform = `translateY(${v}px)`;
        }
      });
    }
    return { opacity: mediaOpacity, lift: mediaLift };
  }

  // The window itself is resized by the main process; this springs the media
  // row in so the new content arrives rather than simply appearing.
  function renderMedia(media) {
    const has = Boolean(media && media.title);
    pill.dataset.media = String(has);
    const { opacity, lift } = mediaSprings();

    if (!has) {
      // The window has already shrunk around the row, so it goes at once —
      // jump() stops anything still in flight before it settles the value.
      mediaShown = false;
      opacity.jump(0);
      lift.jump(5);
      return;
    }

    nameEl.textContent = media.artist ? `${media.title} — ${media.artist}` : media.title;
    nameEl.title = nameEl.textContent;
    sourceEl.textContent = media.source || '';

    // A new track while the row is already up is only new words; the row
    // itself has nowhere to arrive from.
    if (mediaShown) return;
    mediaShown = true;

    if (reduced.matches) {
      opacity.jump(1);
      lift.jump(0);
      return;
    }

    opacity.to(1);
    lift.to(0);
  }

  function wire() {
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      api.timer.toggle();
    });

    document.getElementById('btn-restore').addEventListener('click', (e) => {
      e.stopPropagation();
      api.window.restore();
    });

    // Double-clicking anywhere on the pill brings the window back, the same
    // path the pill arrived along.
    pill.addEventListener('dblclick', () => api.window.restore());

    api.timer.onState(renderState);
    api.media.onNow(renderMedia);
    api.settings.onChanged((settings) => {
      document.documentElement.dataset.theme = settings.theme || 'midnight';
    });
  }

  async function init() {
    wire();
    const settings = await api.settings.get();
    document.documentElement.dataset.theme = settings.theme || 'midnight';
    renderState(await api.timer.get());
    renderMedia(await api.media.get());
  }

  init();
})();
