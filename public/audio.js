// Sound, synthesised in the browser.
//
// There are no audio files here, for the same reason there are no images: the site runs
// under a strict Content-Security-Policy that forbids remote media, and shipping a few
// megabytes of samples for a handful of clicks and a background loop is a poor trade.
// Everything below is built from oscillators and filtered noise with the Web Audio API,
// which costs bytes measured in kilobytes of code and stays in tune at any length.
//
// The music is a slow noir jazz trio in C minor: walking upright bass with chromatic
// approach notes, brushed drums with a swung ride, rootless piano voicings over a
// half-diminished ii and an altered dominant, and a muted horn that only enters every
// other chorus. It runs through a synthesised room reverb over a bed of vinyl surface
// noise, and is scheduled a beat ahead so animating reels cannot make it stutter.
//
// The room and the rests are what make it noir. Four oscillators playing the right
// notes in a dry signal chain just sound like four oscillators.
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
let reverb = null;
let reverbGain = null;
let vinyl = null;

try {
  enabled = localStorage.getItem('sound') !== 'off';
  musicOn = localStorage.getItem('music') !== 'off';
} catch { /* private mode */ }

const BPM = 62;   // slower than a standard swing tune; noir is mostly space
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

  // Music runs through a reverb send and a gentle lowpass. The room is what makes a
  // jazz trio sound like a bar at 2am instead of four oscillators in a spreadsheet, and
  // rolling off the top end is what makes it sound recorded rather than generated.
  musicGain = ctx.createGain();
  musicGain.gain.value = 0.16;

  const musicTone = ctx.createBiquadFilter();
  musicTone.type = 'lowpass';
  musicTone.frequency.value = 2600;
  musicTone.Q.value = 0.6;

  reverb = ctx.createConvolver();
  reverb.buffer = makeRoom(2.6, 2.4);
  reverbGain = ctx.createGain();
  reverbGain.gain.value = 0.55;

  musicGain.connect(musicTone);
  musicTone.connect(master);
  musicTone.connect(reverbGain);
  reverbGain.connect(reverb);
  reverb.connect(master);

  startVinyl();

  sfxGain = ctx.createGain();
  sfxGain.gain.value = 0.5;
  sfxGain.connect(master);

  // One second of white noise, reused for every brush, whirr and click.
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;

  return ctx;
}

/**
 * A synthetic room impulse: exponentially decaying noise, slightly darker on the tail.
 * Cheaper than shipping an impulse-response file and close enough for a smoky bar.
 */
function makeRoom(seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch += 1) {
    const data = buf.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i += 1) {
      const env = (1 - i / len) ** decay;
      // A one-pole lowpass on the noise makes the tail darken as it dies away.
      last = last * 0.72 + (Math.random() * 2 - 1) * 0.28;
      data[i] = last * env;
    }
  }
  return buf;
}

/** A quiet bed of vinyl surface noise. Barely audible, and doing a lot of the work. */
function startVinyl() {
  if (vinyl) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1800;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 7000;

  const g = ctx.createGain();
  g.gain.value = 0.012;

  src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(master);
  src.start();
  vinyl = { src, gain: g };
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
// C minor, the way a noir cue actually moves: minor ii-V-i with a half-diminished ii and
// an altered dominant, a flat-six substitution, and a lot of silence between events.
//
// Chords are ROOTLESS voicings (3rd, 5th, 7th, 9th and no root), which is how a pianist
// comps behind a bass player. Voicing the root in both hands is what makes synthesised
// jazz sound like a MIDI file.
const midi = (n) => 440 * (2 ** ((n - 69) / 12));

const PROG = [
  { root: 36, voice: [51, 55, 58, 62], next: 41 },  // Cm9
  { root: 41, voice: [51, 56, 60, 63], next: 38 },  // Fm9
  { root: 38, voice: [53, 56, 60, 63], next: 43 },  // Dm7b5
  { root: 43, voice: [50, 53, 59, 63], next: 36 },  // G7b9
  { root: 36, voice: [51, 55, 58, 62], next: 44 },  // Cm9
  { root: 44, voice: [50, 54, 57, 62], next: 38 },  // Ab13
  { root: 38, voice: [53, 56, 60, 63], next: 43 },  // Dm7b5
  { root: 43, voice: [50, 53, 59, 63], next: 36 },  // G7b9
];

// A plaintive line in the C minor blues scale, played on the muted horn.
// Each entry is [scale degree, beats], and rests are nulls, because the rests are the
// point: a noir melody is mostly the space where the melody is not.
const BLUES = [0, 3, 5, 6, 7, 10, 12];
const PHRASES = [
  [[12, 1], [10, 0.5], [null, 0.5], [7, 1.5], [null, 0.5]],
  [[7, 0.5], [6, 0.5], [5, 1], [3, 1.5], [null, 0.5]],
  [[10, 1.5], [12, 0.5], [null, 1], [7, 1]],
  [[3, 0.5], [5, 0.5], [7, 1], [10, 2]],
];

/** Walking bass: land on the root, then step chromatically toward the next chord. */
function walkNote(bar, inBar) {
  const step = PROG[bar];
  if (inBar === 0) return step.root;
  if (inBar === 1) return step.root + 7;
  if (inBar === 2) return step.root + 3;
  // Approach the next root from a semitone above or below.
  const target = step.next;
  return target + (target > step.root ? -1 : 1);
}

function pluck(freq, time, dur, gain) {
  // Upright bass: a triangle through a lowpass, with a short noisy attack for the finger.
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq * 1.01, time);
  osc.frequency.exponentialRampToValueAtTime(freq, time + 0.05);
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1100, time);
  lp.frequency.exponentialRampToValueAtTime(320, time + dur);

  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(gain, time + 0.025);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

  osc.connect(lp); lp.connect(g); g.connect(musicGain);
  osc.start(time); osc.stop(time + dur + 0.05);

  noise({ start: time, dur: 0.035, gain: 0.05, type: 'bandpass', freq: 500, q: 1.4, dest: musicGain });
}

/** Muted horn: a filtered saw with vibrato and a soft, late attack. */
function horn(freq, time, dur, gain) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  const vib = ctx.createOscillator();
  const vibAmt = ctx.createGain();

  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq * 0.985, time);
  osc.frequency.exponentialRampToValueAtTime(freq, time + 0.09);

  vib.frequency.value = 5.2;
  vibAmt.gain.value = freq * 0.011;
  vib.connect(vibAmt); vibAmt.connect(osc.frequency);

  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1500, time);
  lp.frequency.linearRampToValueAtTime(2300, time + dur * 0.4);
  lp.Q.value = 3;

  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(gain, time + 0.12);
  g.gain.setValueAtTime(gain, time + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

  osc.connect(lp); lp.connect(g); g.connect(musicGain);
  osc.start(time); osc.stop(time + dur + 0.1);
  vib.start(time); vib.stop(time + dur + 0.1);
}

/** Rhodes-ish comp voice: two detuned sines with a bell-like attack. */
function comp(freq, time, dur, gain) {
  for (const [i, d] of [-5, 5].entries()) {
    tone({
      freq, start: time + i * 0.006, dur, type: 'sine', gain: gain * 0.7,
      detune: d, dest: musicGain,
    });
  }
  tone({ freq: freq * 2, start: time, dur: dur * 0.3, type: 'sine', gain: gain * 0.18, dest: musicGain });
}

let phraseIndex = 0;

function scheduleBeat(time, index) {
  const bar = Math.floor(index / 4) % PROG.length;
  const inBar = index % 4;
  const step = PROG[bar];

  // --- upright bass on every beat, walking
  pluck(midi(walkNote(bar, inBar)), time, BEAT * 0.82, 0.42);

  // --- brushed ride, swung, accented on 2 and 4
  for (const half of [0, 1]) {
    const t = time + (half ? BEAT * (0.5 + SWING) : 0);
    const accent = !half && (inBar === 1 || inBar === 3);
    noise({
      start: t, dur: 0.20, gain: accent ? 0.075 : (half ? 0.028 : 0.045),
      type: 'highpass', freq: 7000, dest: musicGain,
    });
  }
  // --- brush swish across the snare on 2 and 4
  if (inBar === 1 || inBar === 3) {
    noise({
      start: time, dur: 0.34, gain: 0.075, type: 'bandpass', freq: 1500, q: 0.6,
      sweepTo: 420, dest: musicGain,
    });
  }

  // --- comping. Beat 1 of each bar, plus a pushed stab before the turnaround, and
  //     nothing at all in bar 5, so the tune breathes.
  const pushed = inBar === 2 && (bar === 3 || bar === 7);
  if ((inBar === 0 && bar !== 4) || pushed) {
    const at = pushed ? time + BEAT * (0.5 + SWING) : time + 0.01;
    for (const [i, n] of step.voice.entries()) {
      comp(midi(n), at + i * 0.011, BEAT * (pushed ? 1.1 : 1.9), 0.065);
    }
  }

  // --- the horn enters for the second half of every other chorus
  const chorus = Math.floor(index / 32) % 2;
  if (chorus === 1 && bar >= 4) {
    if (inBar === 0) phraseIndex = (bar - 4) % PHRASES.length;
    const phrase = PHRASES[phraseIndex];
    let cursor = 0;
    for (const [deg, len] of phrase) {
      if (cursor >= inBar && cursor < inBar + 1 && deg !== null) {
        const semis = BLUES.includes(deg) ? deg : 0;
        horn(midi(60 + semis), time + (cursor - inBar) * BEAT, BEAT * len * 0.85, 0.055);
      }
      cursor += len;
    }
  }
}
/** Lookahead scheduler: queue notes slightly ahead so animation cannot make it stutter. */
function musicLoop() {
  if (!ctx) return;
  while (nextNoteTime < ctx.currentTime + 0.3) {
    scheduleBeat(nextNoteTime, beat);
    nextNoteTime += BEAT;
    beat += 1;
  }
}

function startMusic() {
  if (!enabled || !musicOn || musicTimer || !ensureContext()) return;
  if (ctx.state === 'suspended') ctx.resume();
  nextNoteTime = ctx.currentTime + 0.15;
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
