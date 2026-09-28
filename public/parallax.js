// Where the viewer is, published as two CSS custom properties.
//
// A rendering is fixed; an object is something you look at from somewhere. Feeding the
// page a viewer position is the cheapest way to cross that gap, and the structure for it
// already existed — the slot stage sets a `perspective` and the cabinet is
// `transform-style: preserve-3d`, so it has been a real 3D box all along with a camera
// nailed to one spot.
//
// Two properties, not a transform. That is the whole design: this module never touches an
// element's transform, it only publishes `--tilt-x` and `--tilt-y` on one host, and each
// layer in the stylesheet decides how much of that tilt it wants. The cabinet takes all of
// it, the glass a little more, the wall behind it a little less — and that *difference in
// rate between layers is what parallax actually is*. A module that moved elements itself
// could not produce it without knowing about every layer.
//
// Three sources, in order of preference:
//
//   gyroscope  a phone, tilted. Relative to wherever it was held when the first reading
//              arrived, never to flat, because nobody holds a phone flat.
//   pointer    a desktop mouse over the host.
//   drift      neither: a slow wander, so the machine is never dead still.
//
// Deliberately excluded: anyone who has asked for reduced motion. This is exactly the kind
// of ambient movement that setting is about, and the page is complete without it.

/** Degrees. Small on purpose — a few reads as depth, more reads as a gimmick. */
const RANGE_X = 4.5;
const RANGE_Y = 7;

/** How fast the published value chases the target. Lower is heavier. */
const EASE = 0.085;

const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

/**
 * Start publishing tilt on `host`.
 *
 * Returns a handle with `stop()`. Safe to call when nothing is supported: it simply
 * publishes zero and stops, so callers never have to check.
 */
export function startParallax(host, { rangeX = RANGE_X, rangeY = RANGE_Y } = {}) {
  if (!host) return { stop() {} };

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (reduced?.matches) {
    host.style.setProperty('--tilt-x', '0');
    host.style.setProperty('--tilt-y', '0');
    return { stop() {} };
  }

  // Target and published values are separate so the published one can lag behind, which
  // is what stops a phone's gyroscope jitter arriving as a twitch.
  let targetX = 0;
  let targetY = 0;
  let curX = 0;
  let curY = 0;
  let raf = null;
  let source = 'drift';
  let driftT = Math.random() * 1000;
  const cleanups = [];

  const publish = () => {
    // setProperty, not a style attribute: the policy forbids inline style and a test
    // enforces it. Custom properties through the CSSOM are fine.
    // Unitless on purpose. A layer that wants degrees writes `* 1deg`, one that wants to
    // slide writes `* 1px`, one that wants a percentage writes `* 1%`. Publishing `deg`
    // here would have made the value unusable in every `translate` on the page.
    host.style.setProperty('--tilt-x', curX.toFixed(3));
    host.style.setProperty('--tilt-y', curY.toFixed(3));
  };

  const tick = () => {
    if (source === 'drift') {
      driftT += 0.006;
      targetX = Math.sin(driftT * 0.7) * rangeX * 0.28;
      targetY = Math.cos(driftT) * rangeY * 0.3;
    }
    curX += (targetX - curX) * EASE;
    curY += (targetY - curY) * EASE;
    publish();
    raf = requestAnimationFrame(tick);
  };

  // ---------------------------------------------------------------- pointer
  // `hover: hover` rather than a touch check: a laptop with a touchscreen has a real
  // pointer and should use it, and a phone reporting pointer events should not get a jump
  // every time it is tapped.
  if (window.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches) {
    const onMove = (e) => {
      const r = host.getBoundingClientRect();
      if (!r.width || !r.height) return;
      source = 'pointer';
      targetY = clamp(((e.clientX - r.left) / r.width - 0.5) * 2, -1, 1) * rangeY;
      targetX = clamp(((e.clientY - r.top) / r.height - 0.5) * -2, -1, 1) * rangeX;
    };
    const onLeave = () => { source = 'drift'; };
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerleave', onLeave);
    cleanups.push(() => {
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
    });
  }

  // -------------------------------------------------------------- gyroscope
  let neutral = null;
  const onOrient = (e) => {
    if (e.beta == null || e.gamma == null) return;
    // The first reading becomes the rest position. Anchoring to flat would mean the
    // machine sat hard against its limit the whole time anyone held their phone normally.
    if (!neutral) neutral = { beta: e.beta, gamma: e.gamma };
    source = 'gyro';
    targetX = clamp((e.beta - neutral.beta) / 22, -1, 1) * rangeX;
    targetY = clamp((e.gamma - neutral.gamma) / 22, -1, 1) * rangeY;
  };

  const listenOrient = () => {
    window.addEventListener('deviceorientation', onOrient);
    cleanups.push(() => window.removeEventListener('deviceorientation', onOrient));
  };

  const needsPermission = typeof DeviceOrientationEvent !== 'undefined'
    && typeof DeviceOrientationEvent.requestPermission === 'function';

  if (needsPermission) {
    // iOS will only grant this from inside a user gesture, so it is asked for on the first
    // touch rather than on load. A refusal is not an error: the drift keeps running and
    // nothing else notices.
    const ask = async () => {
      window.removeEventListener('touchend', ask);
      try {
        if (await DeviceOrientationEvent.requestPermission() === 'granted') listenOrient();
      } catch { /* declined, or not from a gesture. Drift is a fine answer. */ }
    };
    window.addEventListener('touchend', ask, { once: true });
    cleanups.push(() => window.removeEventListener('touchend', ask));
  } else if (typeof DeviceOrientationEvent !== 'undefined') {
    listenOrient();
  }

  // Someone turning reduced motion on mid-session means it, so honour it immediately.
  const onReduced = () => {
    if (!reduced?.matches) return;
    cancelAnimationFrame(raf);
    raf = null;
    curX = 0; curY = 0;
    publish();
  };
  reduced?.addEventListener?.('change', onReduced);
  cleanups.push(() => reduced?.removeEventListener?.('change', onReduced));

  publish();
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      for (const off of cleanups) off();
      host.style.setProperty('--tilt-x', '0');
      host.style.setProperty('--tilt-y', '0');
    },
  };
}
