'use strict';
// A fake browser, just big enough to run an arcade cabinet.
//
// The cabinets are canvas games: they draw, they read a clock, they ask for animation
// frames and they listen for keys. None of that exists in Node, so this stands up the
// smallest version of each that will do, and hands back a driver that advances time only
// when told to.
//
// That last part is what makes these tests worth having. The physics are a pure function
// of the timestep, so a fixed-step run here is deterministic: a ball that escapes the
// table, a drain counted twice, a launch that cannot clear a lane. Every one of those was
// found this way, and none of them can be found by looking at the screen.

/** A 2D context that accepts everything and draws nothing. */
function stubContext() {
  const gradient = { addColorStop() {} };
  return new Proxy({}, {
    get(target, prop) {
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
        return () => gradient;
      }
      if (prop === 'measureText') return () => ({ width: 0 });
      if (!(prop in target)) target[prop] = () => {};
      return target[prop];
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

/**
 * Install the globals a cabinet expects and return a driver.
 *
 * `advance(frames, stepMs)` runs whole frames and nothing moves without it. `keyDown` and
 * `keyUp` deliver events the way a keyboard would, and `pointer` the way a mouse would.
 */
function harness({ width = 400, height = 640 } = {}) {
  const listeners = { window: {}, canvas: {} };
  const addTo = (bag) => (type, fn) => { (bag[type] ||= []).push(fn); };
  const removeFrom = (bag) => (type, fn) => {
    bag[type] = (bag[type] || []).filter((f) => f !== fn);
  };

  let clock = 0;
  let pending = null;

  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext: () => stubContext(),
    getBoundingClientRect: () => ({
      left: 0, top: 0, width, height, right: width, bottom: height,
    }),
    addEventListener: addTo(listeners.canvas),
    removeEventListener: removeFrom(listeners.canvas),
    setPointerCapture() {},
    releasePointerCapture() {},
    focus() {},
  };

  const saved = {
    window: global.window,
    performance: global.performance,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
  };

  global.window = {
    addEventListener: addTo(listeners.window),
    removeEventListener: removeFrom(listeners.window),
  };
  global.performance = { now: () => clock };
  global.requestAnimationFrame = (fn) => { pending = fn; return 1; };
  global.cancelAnimationFrame = () => { pending = null; };

  const fire = (bag, type, event) => {
    for (const fn of listeners[bag][type] || []) fn(event);
  };

  return {
    canvas,
    get clock() { return clock; },

    /** Run `frames` frames of `stepMs` each. Returns how many actually ran. */
    advance(frames, stepMs = 16) {
      let ran = 0;
      for (let i = 0; i < frames; i += 1) {
        const fn = pending;
        if (!fn) break;
        pending = null;
        clock += stepMs;
        fn(clock);
        ran += 1;
      }
      return ran;
    },

    /** Keep advancing until `done()` says so, or `limit` frames have gone by. */
    until(done, limit = 4000, stepMs = 16) {
      let frames = 0;
      while (frames < limit && !done()) {
        if (this.advance(1, stepMs) === 0) break;
        frames += 1;
      }
      return frames;
    },

    keyDown: (code) => fire('window', 'keydown', { code, repeat: false, preventDefault() {} }),
    keyUp: (code) => fire('window', 'keyup', { code, repeat: false, preventDefault() {} }),

    /** A pointer event in canvas coordinates. */
    pointer(type, x, y, extra = {}) {
      fire('canvas', type, {
        clientX: x, clientY: y, pointerId: 1, button: 0,
        preventDefault() {}, ...extra,
      });
    },

    /**
     * The same pointer event, delivered to the WINDOW.
     *
     * A cabinet that has to hear a drag leave its canvas listens for the move and the
     * release on the window, the way the jigsaw board always has and billiards does now.
     * fire() reaches one bag only and nothing bubbles here, so those listeners need their
     * own door. Coordinates are still the canvas's, and may lie outside it: that is the
     * point.
     */
    pointerWindow(type, x, y, extra = {}) {
      fire('window', type, {
        clientX: x, clientY: y, pointerId: 1, button: 0,
        preventDefault() {}, ...extra,
      });
    },

    restore() {
      global.window = saved.window;
      global.performance = saved.performance;
      global.requestAnimationFrame = saved.requestAnimationFrame;
      global.cancelAnimationFrame = saved.cancelAnimationFrame;
    },
  };
}

/**
 * Start a cabinet, run `body`, and always put the globals back.
 * `events` collects everything the cabinet reported upward.
 */
async function cabinet(modulePath, body, opts = {}) {
  const h = harness(opts);
  const mod = await import(modulePath);
  const events = { scores: [], balls: [], ends: [] };
  const game = mod.start(h.canvas, {
    onScore: (s) => events.scores.push(s),
    onBall: (n) => events.balls.push(n),
    onEnd: (s) => events.ends.push(s),
  });
  // The loop asks for its first frame during start(); prime the clock past it.
  h.advance(1);
  try {
    await body({ h, game, events, meta: mod.meta, mod });
  } finally {
    game.stop();
    h.restore();
  }
}

module.exports = { harness, cabinet, stubContext };
