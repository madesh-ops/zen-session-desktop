/* Springs, in Apple's two parameters rather than the physics triplet.
 *
 *   damping  1.0 = critically damped, no overshoot. Below 1.0 it bounces.
 *   response      seconds to reach the target. Not a duration — a spring has none.
 *
 * Every spring here retargets from its *current* value and keeps its velocity,
 * which is what makes motion interruptible: grab something mid-flight, change
 * the target, and it continues rather than jumping. */

(function (global) {
  'use strict';

  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

  class Spring {
    constructor({ value = 0, damping = 1, response = 0.35, onUpdate, onRest } = {}) {
      this.value = value;
      this.target = value;
      this.velocity = 0;
      this.damping = damping;
      this.response = response;
      this.onUpdate = onUpdate || null;
      this.onRest = onRest || null;
      this._raf = null;
      this._last = 0;
    }

    get stiffness() {
      const w = (2 * Math.PI) / this.response;
      return w * w;
    }

    get friction() {
      return (4 * Math.PI * this.damping) / this.response;
    }

    // True when no frame is scheduled: the spring is sitting at its target and
    // a caller may safely reposition it rather than retarget it.
    get resting() {
      return this._raf === null;
    }

    // Retarget without losing velocity — no brick wall on a reversal.
    to(target, { velocity } = {}) {
      this.target = target;
      if (typeof velocity === 'number') this.velocity = velocity;

      if (REDUCED.matches) {
        this.jump(target);
        return;
      }
      this._start();
    }

    jump(value) {
      this.stop();
      this.value = value;
      this.target = value;
      this.velocity = 0;
      if (this.onUpdate) this.onUpdate(this.value);
      if (this.onRest) this.onRest(this.value);
    }

    stop() {
      if (this._raf !== null) {
        cancelAnimationFrame(this._raf);
        this._raf = null;
      }
    }

    _start() {
      if (this._raf !== null) return;
      this._last = performance.now();
      const step = (now) => {
        // Clamp dt so a stalled tab or a dragged window cannot fling the spring.
        let dt = Math.min((now - this._last) / 1000, 1 / 30);
        this._last = now;

        // Sub-step for stability at stiff settings.
        const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
        const h = dt / steps;
        for (let i = 0; i < steps; i++) {
          const accel = -this.stiffness * (this.value - this.target) - this.friction * this.velocity;
          this.velocity += accel * h;
          this.value += this.velocity * h;
        }

        if (this.onUpdate) this.onUpdate(this.value);

        const settled = Math.abs(this.value - this.target) < 0.001 && Math.abs(this.velocity) < 0.01;
        if (settled) {
          this.value = this.target;
          this.velocity = 0;
          this._raf = null;
          if (this.onUpdate) this.onUpdate(this.value);
          if (this.onRest) this.onRest(this.value);
          return;
        }
        this._raf = requestAnimationFrame(step);
      };
      this._raf = requestAnimationFrame(step);
    }
  }

  // Where a flick is heading, the same exponential decay scroll views use.
  // Not the textbook v^2/(2a) — this is the one that feels right.
  function projectMomentum(velocity, decelerationRate = 0.998) {
    return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
  }

  // Progressive resistance past a boundary, rather than a hard stop.
  function rubberband(overshoot, dimension, constant = 0.55) {
    return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
  }

  global.Motion = { Spring, projectMomentum, rubberband, REDUCED };
})(window);
