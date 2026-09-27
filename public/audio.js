// Sound, synthesised in the browser.
//
// There are no audio files here, for the same reason there are no images: the site runs
// under a strict Content-Security-Policy that forbids remote media, and shipping a few
// megabytes of samples for a handful of clicks and a background loop is a poor trade.
// Everything below is built from oscillators and filtered noise with the Web Audio API,
// which costs bytes measured in kilobytes of code and stays in tune at any length.
//
// The music is a slow noir jazz loop: walking upright bass, brushed drums, sparse piano
// chords and an occasional muted-trumpet line, scheduled a beat ahead so it does not
// stutter when the main thread is busy animating reels.
//
// Nothing starts until the player interacts, because browsers refuse to start audio
// before a gesture, and because a casino that makes noise at you unprompted is obnoxious.

let ctx = null;
let master = null;
let musicGain = null;
let sfxGain = null;
let noiseBuffer = null;

let enabled = true;
let musicOn = true;
let musicTimer = null;
let beat = 0;
let nextNoteTime = 0;

try {
  enabled = localStorage.getItem('sound') !== 'off';
  musicOn = localStorage.getItem('music') !== 'off';
} catch { /* private mode */ }

const BPM = 72;
const BEAT = 60 / BPM;
const SWING = 0.12; // how far the off-beat is pushed late, which is what makes it swing

// ---------------------------------------------------------------- plumbing
function ensureContext() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();

  master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  musicGain = ctx.createGain();
  musicGain.gain.value = 0.16;   // music sits well under the effects
  musicGain.connect(master);

  sfxGain = ctx.createGain();
  sfxGain.gain.value = 0.5;
  sfxGain.connect(master);

  // One second of white noise, reused for every brush, whirr and click.
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;

  return ctx;
}

/** A plain oscillator voice with an exponential decay envelope. */
function tone({ freq, start, dur, type = 'sine', gain = 0.3, dest, detune = 0, glideTo = 0 }) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, start + dur);
  if (detune) osc.detune.value = detune;

  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + Math.min(0.02, dur * 0.2));
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  osc.connect(g);
  g.connect(dest || sfxGain);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

/** Filtered noise, used for brushes, reel whirr and clicks. */
function noise({ start, dur, gain = 0.2, type = 'bandpass', freq = 2000, q = 1, dest, sweepTo = 0 }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, start);
  if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, start + dur);
  filter.Q.value = q;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + Math.min(0.015, dur * 0.3));
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  src.connect(filter);
  filter.connect(g);
  g.connect(dest || sfxGain);
  src.start(start);
  src.stop(start + dur + 0.05);
}

// ------------------------------------------------------------------- music
// A minor ii-V-i turnaround, which is about as noir as four bars get.
// Each entry: root midi note, and the chord tones above it.
const PROGRESSION = [
  { root: 50, chord: [53, 57, 60] },  // Dm7
  { root: 43, chord: [50, 53, 59] },  // G7
  { root: 48, chord: [52, 55, 59] },  // Cmaj7
  { root: 45, chord: [49, 52, 55] },  // A7
];
const midi = (n) => 440 * (2 ** ((n - 69) / 12));

// A sparse motif, played once every few bars so it never becomes a jingle.
const MOTIF = [0, 3, 5, 7, 5, 3];

function scheduleBeat(time, index) {
  const bar = Math.floor(index / 4) % PROGRESSION.length;
  const inBar = index % 4;
  const step = PROGRESSION[bar];

  // --- upright bass, walking a quarter note on every beat
  const walk = [0, 7, 5, 3][inBar];
  tone({
    freq: midi(step.root + walk - 12),
    start: time,
    dur: BEAT * 0.9,
    type: 'triangle',
    gain: 0.5,
    dest: musicGain,
  });

  // --- brushed ride on every eighth, swung
  for (const half of [0, 1]) {
    const t = time + (half ? BEAT * (0.5 + SWING) : 0);
    noise({
      start: t,
      dur: 0.16,
      gain: half ? 0.05 : 0.08,
      type: 'highpass',
      freq: 6000,
      dest: musicGain,
    });
  }
  // --- brush swish on 2 and 4
  if (inBar === 1 || inBar === 3) {
    noise({
      start: time, dur: 0.30, gain: 0.10, type: 'bandpass', freq: 1800, q: 0.7,
      sweepTo: 600, dest: musicGain,
    });
  }

  // --- piano-ish chord stabs, only on beat 1 and the and-of-3, so it breathes
  if (inBar === 0 || inBar === 2) {
    for (const [i, n] of step.chord.entries()) {
      tone({
        freq: midi(n),
        start: time + i * 0.012,
        dur: BEAT * 1.4,
        type: 'sine',
        gain: 0.10,
        detune: (i % 2 ? 4 : -4),
        dest: musicGain,
      });
    }
  }

  // --- a muted trumpet line once every four bars
  const cycle = Math.floor(index / 16) % 3;
  if (cycle === 0 && bar === 3) {
    const n = MOTIF[inBar % MOTIF.length];
    tone({
      freq: midi(step.root + 12 + n),
      start: time + BEAT * 0.25,
      dur: BEAT * 0.7,
      type: 'sawtooth',
      gain: 0.05,
      dest: musicGain,
    });
  }
}

/** Lookahead scheduler: queue notes slightly ahead so animation cannot make it stutter. */
function musicLoop() {
  if (!ctx) return;
  while (nextNoteTime < ctx.currentTime + 0.25) {
    scheduleBeat(nextNoteTime, beat);
    nextNoteTime += BEAT;
    beat += 1;
  }
}

function startMusic() {
  if (!enabled || !musicOn || musicTimer || !ensureContext()) return;
  if (ctx.state === 'suspended') ctx.resume();
  nextNoteTime = ctx.currentTime + 0.1;
  musicLoop();
  musicTimer = setInterval(musicLoop, 60);
}

function stopMusic() {
  if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
}

// ------------------------------------------------------------------ effects
const EFFECTS = {
  /** UI tick. */
  click: (t) => noise({ start: t, dur: 0.03, gain: 0.12, type: 'highpass', freq: 3000 }),

  /** Reels whirring: layered noise sweep, called repeatedly while spinning. */
  spin: (t) => {
    noise({ start: t, dur: 0.14, gain: 0.07, type: 'bandpass', freq: 900, q: 2, sweepTo: 1600 });
    tone({ freq: 180, start: t, dur: 0.12, type: 'sawtooth', gain: 0.03, glideTo: 240 });
  },

  /** A reel landing: a mechanical thunk. */
  reelStop: (t) => {
    noise({ start: t, dur: 0.07, gain: 0.22, type: 'lowpass', freq: 1400 });
    tone({ freq: 140, start: t, dur: 0.10, type: 'triangle', gain: 0.22, glideTo: 70 });
  },

  /** A modest win: a short rising arpeggio. */
  win: (t) => {
    [0, 4, 7, 12].forEach((n, i) => tone({
      freq: midi(72 + n), start: t + i * 0.07, dur: 0.30, type: 'triangle', gain: 0.18,
    }));
  },

  /** A big win: a longer fanfare with a shimmer on top. */
  bigWin: (t) => {
    [0, 4, 7, 12, 16, 19].forEach((n, i) => tone({
      freq: midi(72 + n), start: t + i * 0.085, dur: 0.55, type: 'triangle', gain: 0.20,
    }));
    [0, 7, 12].forEach((n, i) => tone({
      freq: midi(84 + n), start: t + 0.5 + i * 0.05, dur: 0.9, type: 'sine', gain: 0.10,
    }));
    noise({ start: t + 0.45, dur: 0.7, gain: 0.05, type: 'highpass', freq: 5000 });
  },

  /** A loss: one soft low thud, deliberately understated. */
  lose: (t) => tone({ freq: 130, start: t, dur: 0.28, type: 'sine', gain: 0.14, glideTo: 80 }),

  /** A puzzle piece lifting off. */
  tileOpen: (t) => {
    noise({ start: t, dur: 0.05, gain: 0.10, type: 'bandpass', freq: 2400, q: 2 });
    tone({ freq: 620, start: t, dur: 0.12, type: 'sine', gain: 0.12, glideTo: 880 });
  },

  /** A broken piece, or a mine. */
  crack: (t) => {
    noise({ start: t, dur: 0.22, gain: 0.30, type: 'lowpass', freq: 900, sweepTo: 200 });
    tone({ freq: 90, start: t, dur: 0.30, type: 'sawtooth', gain: 0.16, glideTo: 45 });
  },

  /** A card being played. */
  card: (t) => noise({ start: t, dur: 0.09, gain: 0.14, type: 'bandpass', freq: 3200, q: 0.8, sweepTo: 1200 }),

  /** Crash multiplier ticking upward. */
  tick: (t) => tone({ freq: 1200, start: t, dur: 0.02, type: 'square', gain: 0.04 }),

  /** Cashing out in time. */
  cashout: (t) => {
    [0, 5, 9].forEach((n, i) => tone({
      freq: midi(76 + n), start: t + i * 0.06, dur: 0.28, type: 'triangle', gain: 0.18,
    }));
  },
};

/** Play a named effect. Silent and harmless if audio is off or unsupported. */
function sfx(name) {
  if (!enabled || !ensureContext()) return;
  if (ctx.state === 'suspended') ctx.resume();
  const make = EFFECTS[name];
  if (make) make(ctx.currentTime + 0.001);
}

// -------------------------------------------------------------------- api
function setEnabled(on) {
  enabled = !!on;
  try { localStorage.setItem('sound', enabled ? 'on' : 'off'); } catch { /* ignore */ }
  if (!enabled) stopMusic();
  else if (musicOn) startMusic();
  return enabled;
}

function setMusic(on) {
  musicOn = !!on;
  try { localStorage.setItem('music', musicOn ? 'on' : 'off'); } catch { /* ignore */ }
  if (musicOn && enabled) startMusic();
  else stopMusic();
  return musicOn;
}

const isEnabled = () => enabled;
const isMusicOn = () => musicOn;

/**
 * Browsers will not start audio before a gesture, so the first click anywhere arms it.
 * Using `once` means this costs nothing after it has fired.
 */
function armOnFirstGesture() {
  const arm = () => {
    ensureContext();
    if (ctx?.state === 'suspended') ctx.resume();
    if (enabled && musicOn) startMusic();
  };
  document.addEventListener('pointerdown', arm, { once: true });
  document.addEventListener('keydown', arm, { once: true });
}

export { sfx, setEnabled, setMusic, isEnabled, isMusicOn, startMusic, stopMusic, armOnFirstGesture };
