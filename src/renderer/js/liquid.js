/* Liquid glass — the material that answers a press and carries the selection
 * from one section to the next.
 *
 * Three pieces, all built on the springs in springs.js so every one of them can
 * be interrupted mid-flight and retargeted without a jump:
 *
 *   indicator(...)  one pane of glass that travels between the buttons of a
 *                   group instead of a background switching off here and on
 *                   there. It squashes along its direction of travel from its
 *                   own spring velocity, which is what reads as liquid.
 *   ripple(...)     a specular bloom from the exact point of contact, on
 *                   pointer-down — never on click.
 *   transitionView  a lens of blurred glass sweeps across the panel in the
 *                   direction the rail moved, and the arriving section
 *                   materialises behind it.
 *
 * Only transform and opacity animate per frame. The blur radius on the glass is
 * constant and the element moves under it, because animating a backdrop-filter
 * every frame costs far more than it is worth. */

(function (global) {
  'use strict';

  const { Spring, REDUCED } = global.Motion;

  // Deliberate values, not taste: critically damped for anything that just
  // repositions, a little overshoot only where the motion has momentum behind it.
  const TRAVEL = { damping: 0.82, response: 0.34 }; // selection sliding between buttons
  const RESIZE = { damping: 1, response: 0.34 }; // its width/height following along
  const ARRIVE = { damping: 1, response: 0.42 }; // a section settling into place

  // 2000 px/s of travel buys about 7% stretch, and it is capped there. Beyond
  // that the mode pill grows wider than the 4px of padding its frame has to
  // spare and pokes out of the glass it is supposed to sit inside.
  const STRETCH = 1 / 28000;
  const STRETCH_MAX = 0.07;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /* ------------------------------------------------------------ indicator -- */

  /* container  the group; must be a positioned element
   * selector   its buttons
   * isActive   which one currently owns the glass
   * axis       the direction it travels, for the squash */
  function indicator(container, { selector, isActive, axis = 'x', className = '' }) {
    const thumb = document.createElement('span');
    thumb.className = 'liquid-thumb' + (className ? ' ' + className : '');
    thumb.setAttribute('aria-hidden', 'true');
    container.prepend(thumb);

    let placed = false;

    const write = () => {
      // Stretch along the axis that is actually moving, and pull in on the
      // other one, so the glass conserves its volume the way a real blob would.
      const v = axis === 'x' ? x.velocity : y.velocity;
      const s = clamp(Math.abs(v) * STRETCH, 0, STRETCH_MAX);
      const sx = axis === 'x' ? 1 + s : 1 - s * 0.5;
      const sy = axis === 'x' ? 1 - s * 0.5 : 1 + s;

      thumb.style.width = w.value + 'px';
      thumb.style.height = h.value + 'px';
      thumb.style.transform = `translate3d(${x.value}px, ${y.value}px, 0) scale(${sx}, ${sy})`;
    };

    const x = new Spring({ ...TRAVEL, onUpdate: write });
    const y = new Spring({ ...TRAVEL, onUpdate: write });
    const w = new Spring({ ...RESIZE, onUpdate: write });
    const h = new Spring({ ...RESIZE, onUpdate: write });

    function sync() {
      const active = Array.from(container.querySelectorAll(selector)).find(isActive);
      if (!active) {
        thumb.dataset.on = 'false';
        placed = false;
        return;
      }

      // A group inside a hidden view measures zero on every axis. Callers reach
      // here on every timer tick, whichever section is on screen, so without
      // this the glass would be dragged to nothing behind the user's back and
      // pop back into place when they returned.
      if (!active.offsetWidth && !active.offsetHeight) return;

      const to = [
        [x, active.offsetLeft],
        [y, active.offsetTop],
        [w, active.offsetWidth],
        [h, active.offsetHeight]
      ];

      // The first placement is not a movement — it should not be animated.
      if (!placed) {
        for (const [spring, value] of to) spring.jump(value);
        placed = true;
        write();
        // A frame of grace so the browser paints it where it belongs before it fades up.
        requestAnimationFrame(() => {
          thumb.dataset.on = 'true';
        });
        return;
      }

      // Nothing has moved: four ticks a second must not each start a frame loop
      // only to discover the spring is already where it belongs.
      const settled = to.every(([spring, value]) => spring.resting && spring.target === value);
      if (settled) return;

      thumb.dataset.on = 'true';
      for (const [spring, value] of to) spring.to(value);
    }

    sync();
    return { sync, element: thumb };
  }

  /* --------------------------------------------------------------- ripple -- */

  function ripple(host, clientX, clientY) {
    if (REDUCED.matches) return;

    const rect = host.getBoundingClientRect();
    if (!rect.width) return;

    // Big enough that the far corner is reached before it has faded out.
    const size = Math.hypot(rect.width, rect.height) * 1.9;
    const node = document.createElement('span');
    node.className = 'liquid-ripple';
    node.setAttribute('aria-hidden', 'true');
    node.style.width = node.style.height = size + 'px';
    node.style.left = clientX - rect.left - size / 2 + 'px';
    node.style.top = clientY - rect.top - size / 2 + 'px';
    host.appendChild(node);

    const spread = new Spring({
      value: 0,
      damping: 1,
      response: 0.55,
      onUpdate: (p) => {
        node.style.transform = `scale(${0.22 + 0.78 * p})`;
        // Brightest just after contact, gone by the time it reaches the edge.
        node.style.opacity = String(Math.max(0, 1 - p) * 0.85);
      },
      onRest: () => node.remove()
    });
    spread.to(1);
  }

  /* Delegated, so buttons rendered later (theme swatches, week chips) are covered. */
  function ripples(root, selector) {
    root.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 0) return;
        const host = e.target.closest(selector);
        if (host && !host.disabled) ripple(host, e.clientX, e.clientY);
      },
      { passive: true }
    );
  }

  /* -------------------------------------------------------- view switching -- */

  let sweepNode = null;
  let sweepSpring = null;
  let sweepRun = { from: 0, to: 1 };

  function sweep(host, dir) {
    if (REDUCED.matches) return;

    if (!sweepNode || sweepNode.parentElement !== host) {
      sweepNode = document.createElement('div');
      sweepNode.className = 'liquid-sweep';
      sweepNode.setAttribute('aria-hidden', 'true');
      sweepNode.innerHTML = '<div class="band"></div>';
      host.appendChild(sweepNode);
      sweepSpring = null;
    }

    const band = sweepNode.firstElementChild;
    const span = sweepNode.clientHeight;
    const depth = band.offsetHeight || span * 0.42;
    const from = dir > 0 ? -depth : span;
    const to = dir > 0 ? span : -depth;

    if (!sweepSpring) {
      sweepSpring = new Spring({
        value: from,
        damping: 1,
        response: 0.42,
        onUpdate: (v) => {
          band.style.transform = `translate3d(0, ${v}px, 0)`;
          // Fade the lens out over the last stretch of its run, so it leaves
          // the panel rather than stopping dead at the edge.
          const run = Math.abs(sweepRun.to - sweepRun.from) || 1;
          const p = Math.abs(v - sweepRun.from) / run;
          band.style.opacity = String(clamp(1 - (p - 0.6) / 0.4, 0, 1));
        },
        onRest: () => {
          band.style.opacity = '0';
        }
      });
    }

    // One spring for the lens, for the life of the window. A second section
    // change while the first is still crossing retargets it — carrying its
    // velocity, reversing if that is the new direction — rather than leaving
    // two springs fighting over the same element.
    if (sweepSpring.resting) {
      sweepSpring.value = from;
      sweepSpring.velocity = 0;
      sweepRun = { from, to };
    } else {
      sweepRun = { from: sweepSpring.value, to };
    }
    sweepSpring.to(to);
  }

  // One arrival spring per section, kept for the life of the window.
  const arrivals = new WeakMap();

  /* dir is +1 when the new section sits below the old one on the rail, -1 above.
   * Enter and exit share that axis, so a section always returns the way it came. */
  function transitionView(view, host, dir) {
    if (REDUCED.matches) {
      // Not "no feedback" — a gentler one, with nothing that travels.
      view.style.transform = 'none';
      view.style.opacity = '0';
      view.style.transition = 'opacity 160ms ease';
      requestAnimationFrame(() => {
        view.style.opacity = '1';
      });
      return;
    }

    view.style.transition = '';
    sweep(host, dir);

    let arrive = arrivals.get(view);
    if (!arrive) {
      // The direction is read at each frame, not captured, so a section grabbed
      // on its way out leaves the way it is now going rather than the way it
      // was going when this spring was made.
      const from = { dir };
      arrive = new Spring({
        value: 0,
        damping: 1,
        response: ARRIVE.response,
        onUpdate: (p) => {
          const y = (1 - p) * from.dir * 16;
          const s = 0.985 + 0.015 * p;
          view.style.transform = `translate3d(0, ${y}px, 0) scale(${s})`;
          view.style.opacity = String(clamp(p * 1.4, 0, 1));
        },
        onRest: () => {
          // Hand the subtree back to the browser: a lingering transform on a
          // scrolling panel costs a composited layer for nothing.
          view.style.transform = '';
          view.style.opacity = '';
        }
      });
      arrive.from = from;
      arrivals.set(view, arrive);
    }
    arrive.from.dir = dir;

    // Only reset to the start when it is not already in flight — a section
    // returned to mid-fade should continue from where it is, not snap back.
    if (arrive.resting) {
      arrive.value = 0;
      arrive.velocity = 0;
      // Set the starting frame synchronously: the view is already displayed,
      // and without this it paints once at rest before the first spring frame.
      view.style.opacity = '0';
      view.style.transform = `translate3d(0, ${dir * 16}px, 0) scale(0.985)`;
    }
    arrive.to(1);
  }

  global.Liquid = { indicator, ripple, ripples, transitionView };
})(window);
