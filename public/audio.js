// Sound, synthesised in the browser.
//
// There are no audio files here, for the same reason there are no images: the site runs
// under a strict Content-Security-Policy that forbids remote media, and shipping a few
// megabytes of samples for a handful of clicks and a background loop is a poor trade.
// Everything below is built from oscillators and filtered noise with the Web Audio API,
// which costs bytes measured in kilobytes of code and stays in tune at any length.
//
// The music is a radio rather than a loop: four stations, a dozen pieces, and a burst of
// tuning static between records. Everything is played live by a scheduler reading the
// arrangements in radio.js, on synthesised upright bass, brushes, Rhodes, piano, vibes,
// tremolo guitar, strings, clarinet, Hammond organ, muted horn and theremin. It runs
// through a synthesised room reverb over a bed of vinyl surface noise, scheduled a beat
// ahead so animating reels cannot make it stutter.
//
// The room and the rests are what make it noir. Four oscillators playing the right
// notes in a dry signal chain just sound like four oscillators.
//
// Nothing starts until the player interacts, because browsers refuse to start audio
// before a gesture, and because a casino that makes noise at you unprompted is obnoxious.

import {
  TRACKS, STATIONS, trackById, chorusesFor,
} from './radio.js';

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

// The bed of vinyl surface noise under the music.
//
// Off unless it is asked for. It is a nice texture and it is also a hiss, and a hiss that
// arrives without being requested is just noise coming out of somebody's speakers.
let vinylOn = false;

try {
  enabled = localStorage.getItem('sound') !== 'off';
  musicOn = localStorage.getItem('music') !== 'off';
  vinylOn = localStorage.getItem('vinyl') === 'on';
} catch { /* private mode */ }

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

  sfxGain = ctx.createGain();
  sfxGain.gain.value = 0.5;
  sfxGain.connect(master);

  // One second of white noise, reused for every brush, whirr and click.
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;

  // After the noise buffer exists, not before: the surface noise is a looping source
  // reading that buffer, and starting it first gave it a null buffer and silence.
  startVinyl();

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
  // Silent until something asks for it. See surfaceLevel().
  g.gain.value = 0;

  src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(master);
  src.start();
  // `level` is the AudioParam, not the node, so callers cannot mistake one for the other.
  vinyl = { src, level: g.gain };
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
// ------------------------------------------------------------- instruments
const midi = (n) => 440 * (2 ** ((n - 69) / 12));

/**
 * Deterministic pseudo-random in [0,1).
 *
 * The arrangement has to vary from chorus to chorus or a station turns into a loop, but
 * it also has to be reproducible within a bar: a lead line that entered at random would
 * sometimes be decided twice for the same bar and play over itself.
 */
function hash(a, b, c) {
  let h = ((a * 374761393) + (b * 668265263) + (c * 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Upright bass: a triangle through a closing lowpass, with a finger on the attack. */
function pluck(freq, time, dur, gain) {
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

/** Rhodes: two detuned sines with a bell partial on the attack. */
function rhodes(freq, time, dur, gain) {
  for (const [i, d] of [-5, 5].entries()) {
    tone({
      freq, start: time + i * 0.006, dur, type: 'sine', gain: gain * 0.7,
      detune: d, dest: musicGain,
    });
  }
  tone({ freq: freq * 2, start: time, dur: dur * 0.3, type: 'sine', gain: gain * 0.18, dest: musicGain });
}

/** Upright piano: a struck pair of triangles, fast decay, lowpass closing as it dies. */
function piano(freq, time, dur, gain) {
  const hold = Math.min(Math.max(dur, 0.4), 2.6);
  for (const det of [-4, 4]) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    osc.detune.value = det;
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3600, time);
    lp.frequency.exponentialRampToValueAtTime(700, time + hold);
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(gain * 0.8, time + 0.007);
    g.gain.exponentialRampToValueAtTime(0.0001, time + hold);
    osc.connect(lp); lp.connect(g); g.connect(musicGain);
    osc.start(time); osc.stop(time + hold + 0.05);
  }
  // The hammer. Without it a piano is just a soft synth pad with a fast decay.
  noise({ start: time, dur: 0.02, gain: gain * 0.3, type: 'highpass', freq: 3000, dest: musicGain });
}

/** Vibraphone: a sine, a bell partial, and the motor tremolo that defines the instrument. */
function vibes(freq, time, dur, gain) {
  const hold = Math.min(Math.max(dur * 2.2, 0.8), 3.6);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const trem = ctx.createOscillator();
  const tremAmt = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.value = freq;
  trem.frequency.value = 4.6;
  tremAmt.gain.value = gain * 0.35;
  trem.connect(tremAmt); tremAmt.connect(g.gain);

  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(gain, time + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, time + hold);

  osc.connect(g); g.connect(musicGain);
  osc.start(time); osc.stop(time + hold + 0.05);
  trem.start(time); trem.stop(time + hold + 0.05);
  tone({ freq: freq * 4, start: time, dur: Math.min(0.35, hold), type: 'sine', gain: gain * 0.12, dest: musicGain });
}

/** Tremolo guitar: half of what noir means on a screen, and it costs one LFO. */
function guitar(freq, time, dur, gain) {
  const hold = Math.min(Math.max(dur * 1.4, 0.5), 2.8);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  const trem = ctx.createOscillator();
  const tremAmt = ctx.createGain();

  osc.type = 'triangle';
  osc.frequency.value = freq;
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(2800, time);
  lp.frequency.exponentialRampToValueAtTime(900, time + hold);
  lp.Q.value = 2;

  trem.frequency.value = 5.8;
  tremAmt.gain.value = gain * 0.45;
  trem.connect(tremAmt); tremAmt.connect(g.gain);

  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(gain, time + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, time + hold);

  osc.connect(lp); lp.connect(g); g.connect(musicGain);
  osc.start(time); osc.stop(time + hold + 0.05);
  trem.start(time); trem.stop(time + hold + 0.05);
}

/** String section: three detuned saws under a slow bow. */
function strings(freq, time, dur, gain) {
  const hold = Math.max(dur, 0.7);
  for (const det of [-9, 0, 9]) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    osc.detune.value = det;
    lp.type = 'lowpass';
    lp.frequency.value = 1700;
    lp.Q.value = 0.7;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(gain * 0.45, time + hold * 0.35);
    g.gain.setValueAtTime(gain * 0.45, time + hold * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, time + hold + 0.25);
    osc.connect(lp); lp.connect(g); g.connect(musicGain);
    osc.start(time); osc.stop(time + hold + 0.3);
  }
}

/** Clarinet: a square filtered down toward its odd harmonics, with a breath of vibrato. */
function clarinet(freq, time, dur, gain) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  const vib = ctx.createOscillator();
  const vibAmt = ctx.createGain();

  osc.type = 'square';
  osc.frequency.value = freq;
  vib.frequency.value = 4.8;
  vibAmt.gain.value = freq * 0.008;
  vib.connect(vibAmt); vibAmt.connect(osc.frequency);

  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1100, time);
  lp.frequency.linearRampToValueAtTime(1800, time + dur * 0.5);
  lp.Q.value = 1.2;

  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(gain * 0.55, time + 0.09);
  g.gain.setValueAtTime(gain * 0.55, time + dur * 0.75);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

  osc.connect(lp); lp.connect(g); g.connect(musicGain);
  osc.start(time); osc.stop(time + dur + 0.08);
  vib.start(time); vib.stop(time + dur + 0.08);
}

/** Hammond-ish organ: drawbar sines through a slow Leslie wobble. */
function organ(freq, time, dur, gain) {
  const hold = Math.max(dur, 0.45);
  const bus = ctx.createGain();
  const wob = ctx.createOscillator();
  const wobAmt = ctx.createGain();

  wob.frequency.value = 5.4;
  wobAmt.gain.value = 0.12; // relative to the bus sitting at 1
  wob.connect(wobAmt); wobAmt.connect(bus.gain);

  bus.gain.setValueAtTime(0.0001, time);
  bus.gain.exponentialRampToValueAtTime(1, time + 0.03);
  bus.gain.setValueAtTime(1, time + hold * 0.8);
  bus.gain.exponentialRampToValueAtTime(0.0001, time + hold);
  bus.connect(musicGain);

  for (const [mult, level] of [[1, 1], [2, 0.5], [3, 0.28], [4, 0.16]]) {
    tone({ freq: freq * mult, start: time, dur: hold, type: 'sine', gain: gain * level, dest: bus });
  }
  wob.start(time); wob.stop(time + hold + 0.05);
}

/** Theremin: one pure sine, wide vibrato, sliding up into the note. */
function theremin(freq, time, dur, gain) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const vib = ctx.createOscillator();
  const vibAmt = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq * 0.82, time);
  osc.frequency.exponentialRampToValueAtTime(freq, time + Math.min(0.35, dur * 0.4));

  vib.frequency.value = 5.6;
  vibAmt.gain.value = freq * 0.022;
  vib.connect(vibAmt); vibAmt.connect(osc.frequency);

  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(gain, time + dur * 0.3);
  g.gain.setValueAtTime(gain, time + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

  osc.connect(g); g.connect(musicGain);
  osc.start(time); osc.stop(time + dur + 0.1);
  vib.start(time); vib.stop(time + dur + 0.1);
}

/** Named voices, so a track can say `comp: 'organ'` and mean it. */
const VOICES = {
  rhodes, piano, vibes, guitar, strings, clarinet, organ, theremin, horn,
  none: null,
};

// ---------------------------------------------------------------- patterns
/** Bass lines. Each is called once per beat and decides for itself whether to play. */
const BASS = {
  /** Walking: land on the root, then step chromatically toward the next chord. */
  walk(tr, bar, inBar, time, beatLen) {
    const step = tr.prog[bar];
    let note;
    if (inBar === 0) note = step.root;
    else if (inBar === 1) note = step.root + 7;
    else if (inBar === 2) note = step.root + 3;
    else note = step.next + (step.next > step.root ? -1 : 1);
    pluck(midi(note), time, beatLen * 0.82, 0.42);
  },
  /** The root on the downbeat and nothing else. What a waltz wants. */
  root(tr, bar, inBar, time, beatLen) {
    if (inBar !== 0) return;
    pluck(midi(tr.prog[bar].root), time, beatLen * 1.6, 0.44);
  },
  /** One held root under the whole bar. */
  pedal(tr, bar, inBar, time, beatLen) {
    if (inBar !== 0) return;
    pluck(midi(tr.prog[bar].root), time, beatLen * tr.meter * 0.9, 0.34);
  },
  /** Tango: root, then the fifth, then a push into the next bar. */
  tango(tr, bar, inBar, time, beatLen) {
    const step = tr.prog[bar];
    if (inBar === 0) pluck(midi(step.root), time, beatLen * 0.7, 0.46);
    else if (inBar === 2) pluck(midi(step.root + 7), time, beatLen * 0.6, 0.38);
    else if (inBar === tr.meter - 1) pluck(midi(step.next), time + beatLen * 0.5, beatLen * 0.45, 0.3);
  },
  none() {},
};

/** Percussion. Same contract as the bass: once per beat, decide internally. */
const DRUMS = {
  /** Brushed kit: swung ride, accents on two and four, a swish across the snare. */
  brushes(tr, bar, inBar, time, beatLen) {
    for (const half of [0, 1]) {
      const t = time + (half ? beatLen * (0.5 + tr.swing) : 0);
      const accent = !half && (inBar === 1 || inBar === 3);
      noise({
        start: t, dur: 0.2, gain: accent ? 0.075 : (half ? 0.028 : 0.045),
        type: 'highpass', freq: 7000, dest: musicGain,
      });
    }
    if (inBar === 1 || inBar === 3) {
      noise({
        start: time, dur: 0.34, gain: 0.075, type: 'bandpass', freq: 1500, q: 0.6,
        sweepTo: 420, dest: musicGain,
      });
    }
  },
  /** Tango rims over a soft heart-of-the-bar thump. Straight eighths, never swung. */
  bolero(tr, bar, inBar, time, beatLen) {
    const rim = (t, g) => noise({
      start: t, dur: 0.05, gain: g, type: 'bandpass', freq: 2200, q: 2.5, dest: musicGain,
    });
    if (inBar === 0) {
      rim(time, 0.13);
      rim(time + beatLen * 0.75, 0.07);
      tone({ freq: 70, start: time, dur: 0.18, type: 'sine', gain: 0.12, glideTo: 50, dest: musicGain });
    } else if (inBar === 1) rim(time + beatLen * 0.5, 0.07);
    else if (inBar === 2) rim(time, 0.11);
    else { rim(time, 0.08); rim(time + beatLen * 0.5, 0.09); }
  },
  /** Soft mallets: a low tom on one, a whisper on the rest. Made for three beats a bar. */
  mallets(tr, bar, inBar, time) {
    if (inBar === 0) {
      tone({ freq: 96, start: time, dur: 0.3, type: 'sine', gain: 0.13, glideTo: 72, dest: musicGain });
    } else {
      noise({ start: time, dur: 0.16, gain: 0.03, type: 'highpass', freq: 6000, dest: musicGain });
    }
  },
  /** A clock. It keeps time the way an evidence room does: audibly, and going nowhere. */
  ticks(tr, bar, inBar, time, beatLen) {
    noise({ start: time, dur: 0.012, gain: 0.07, type: 'bandpass', freq: 3800, q: 6, dest: musicGain });
    noise({
      start: time + beatLen * 0.5, dur: 0.01, gain: 0.03,
      type: 'bandpass', freq: 3200, q: 6, dest: musicGain,
    });
  },
  /** Two low thumps every other bar. Barely percussion; mostly a pulse. */
  heartbeat(tr, bar, inBar, time, beatLen) {
    if (inBar !== 0 || bar % 2) return;
    tone({ freq: 58, start: time, dur: 0.22, type: 'sine', gain: 0.16, glideTo: 40, dest: musicGain });
    tone({ freq: 54, start: time + beatLen * 0.42, dur: 0.2, type: 'sine', gain: 0.11, glideTo: 38, dest: musicGain });
  },
  none() {},
};

// -------------------------------------------------------------- the dial
let stationIndex = 0;
let order = [];
let orderPos = 0;
let track = null;
let trackIndex = 0;
let beatsThisTrack = 0;
const listeners = new Set();

try {
  const saved = localStorage.getItem('station');
  const found = STATIONS.findIndex((st) => st.id === saved);
  if (found >= 0) stationIndex = found;
} catch { /* private mode */ }

const shuffle = (list) => {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

function buildOrder(keepPos = false) {
  order = shuffle(STATIONS[stationIndex].tracks);
  if (!keepPos) orderPos = 0;
}

function announce() {
  const info = nowPlaying();
  for (const cb of listeners) {
    try { cb(info); } catch { /* a broken listener must not stop the music */ }
  }
}

/**
 * How loud the surface noise should be right now.
 *
 * Zero unless the music is actually playing and the listener asked for it. The noise is a
 * looping buffer connected to the master output: it is started once and runs for the life
 * of the page, so nothing else ever silences it. Stopping the scheduler stops the notes
 * and leaves this hissing away on its own, which is exactly what it did.
 */
function surfaceLevel() {
  if (!vinylOn || !enabled || !musicOn || !musicTimer || !track) return 0;
  return 0.002 + track.vinyl * 0.009;
}

function applySurface(at) {
  if (!ctx || !vinyl) return;
  const t = Math.max(at ?? ctx.currentTime, ctx.currentTime);
  vinyl.level.setTargetAtTime(surfaceLevel(), t, 0.25);
}

/** Each track carries its own room and surface noise, so the dial has a sense of place. */
function applyTrackTone(at) {
  if (!ctx) return;
  const t = Math.max(at ?? ctx.currentTime, ctx.currentTime);
  if (reverbGain && track) reverbGain.gain.setTargetAtTime(0.25 + track.room * 0.55, t, 0.4);
  applySurface(t);
}

function selectTrack(id, at) {
  track = trackById(id) || TRACKS[0];
  trackIndex = TRACKS.indexOf(track);
  beat = 0;
  beatsThisTrack = track.prog.length * track.meter * chorusesFor(track);
  applyTrackTone(at);
  announce();
}

/**
 * A second of tuning static between records.
 * A radio that cuts silently from one track to the next does not sound like a radio, it
 * sounds like a playlist that skipped.
 */
function stationBreak(time) {
  if (!ctx) return;
  musicGain.gain.cancelScheduledValues(time);
  musicGain.gain.setTargetAtTime(0.02, time, 0.25);
  musicGain.gain.setTargetAtTime(0.16, time + 1.15, 0.5);
  noise({
    start: time + 0.1, dur: 0.8, gain: 0.022, type: 'bandpass', freq: 800, q: 1.2,
    sweepTo: 2600, dest: master,
  });
  noise({ start: time + 0.55, dur: 0.45, gain: 0.011, type: 'highpass', freq: 3200, dest: master });
}

function advance(dir, at) {
  if (!order.length) buildOrder();
  orderPos = (orderPos + dir + order.length) % order.length;
  // Reshuffle each time round the dial, so a long session is not the same running order.
  if (dir > 0 && orderPos === 0) buildOrder(true);
  selectTrack(order[orderPos], at);
}

// -------------------------------------------------------------- scheduling
function scheduleBeat(time, index) {
  const tr = track;
  const beatLen = 60 / tr.bpm;
  const bars = tr.prog.length;
  const bar = Math.floor(index / tr.meter) % bars;
  const inBar = index % tr.meter;
  const chorus = Math.floor(index / (tr.meter * bars));
  const step = tr.prog[bar];

  (BASS[tr.bass] || BASS.none)(tr, bar, inBar, time, beatLen);
  (DRUMS[tr.drums] || DRUMS.none)(tr, bar, inBar, time, beatLen);

  // Comping lands on the downbeat, with a pushed stab before the turnaround and the
  // occasional bar left empty so the tune has somewhere to breathe.
  const compVoice = VOICES[tr.comp];
  if (compVoice) {
    const pushed = tr.meter === 4 && inBar === 2 && bar === bars - 1;
    const rest = hash(trackIndex, chorus, bar) < 0.14;
    if ((inBar === 0 && !rest) || pushed) {
      const at = pushed ? time + beatLen * (0.5 + tr.swing) : time + 0.01;
      const hold = beatLen * (pushed ? 1.1 : tr.meter * 0.55);
      for (const [i, n] of step.voice.entries()) {
        compVoice(midi(n), at + i * 0.011, hold, 0.065);
      }
    }
  }

  // The lead plays whole phrases from the top of a bar and sits out according to the
  // track's `space`. Scheduling a melody note by note across beats is how you get a line
  // that steps on its own tail at the bar line.
  const leadVoice = VOICES[tr.lead];
  if (leadVoice && inBar === 0 && hash(trackIndex + 7, chorus, bar) > tr.space) {
    const phrase = tr.phrases[(bar + chorus) % tr.phrases.length];
    let cursor = 0;
    for (const [semis, beats] of phrase) {
      if (semis !== null) {
        leadVoice(midi(tr.tonic + semis), time + cursor * beatLen, beatLen * beats * 0.85, 0.055);
      }
      cursor += beats;
    }
  }
}

/** Lookahead scheduler: queue notes slightly ahead so animation cannot make it stutter. */
function musicLoop() {
  if (!ctx || !track) return;
  while (nextNoteTime < ctx.currentTime + 0.3) {
    scheduleBeat(nextNoteTime, beat);
    nextNoteTime += 60 / track.bpm;
    beat += 1;
    if (beat >= beatsThisTrack) {
      stationBreak(nextNoteTime);
      nextNoteTime += 1.7;
      advance(1, nextNoteTime);
    }
  }
}

function startMusic() {
  if (!enabled || !musicOn || musicTimer || !ensureContext()) return;
  if (ctx.state === 'suspended') ctx.resume();
  if (!track) { buildOrder(); selectTrack(order[0], ctx.currentTime); }
  applyTrackTone(ctx.currentTime);
  musicGain.gain.cancelScheduledValues(ctx.currentTime);
  musicGain.gain.setTargetAtTime(0.16, ctx.currentTime, 0.3);
  nextNoteTime = ctx.currentTime + 0.15;
  musicLoop();
  musicTimer = setInterval(musicLoop, 60);
  // After the timer exists, not before: surfaceLevel() reads it to decide whether the
  // music is actually running, and it is not running until this line has happened.
  applySurface(ctx.currentTime);
}

function stopMusic() {
  if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  // The scheduler stopping is not enough: the surface noise is its own source and has to
  // be turned down explicitly, or the music goes quiet and the hiss carries on.
  applySurface();
}

// ------------------------------------------------------------- radio api
/** The dial, for the UI. Names are objects keyed by language; the UI picks one. */
const stations = () => STATIONS.map((st) => ({ id: st.id, name: st.name, blurb: st.blurb }));

function nowPlaying() {
  if (!track) return null;
  const st = STATIONS[stationIndex];
  return {
    station: st.id,
    stationName: st.name,
    track: track.id,
    title: track.title,
    bpm: track.bpm,
    position: orderPos + 1,
    of: order.length,
  };
}

/** Jump the dial. Takes effect on the next beat rather than cutting the current note. */
function retune(at) {
  if (!ctx || !musicTimer) return;
  stationBreak(ctx.currentTime);
  nextNoteTime = ctx.currentTime + 1.5;
  applyTrackTone(at);
}

function setStation(id) {
  const found = STATIONS.findIndex((st) => st.id === id);
  if (found < 0) return nowPlaying();
  stationIndex = found;
  try { localStorage.setItem('station', id); } catch { /* private mode */ }
  buildOrder();
  selectTrack(order[0], ctx ? ctx.currentTime + 1.5 : 0);
  retune(ctx ? ctx.currentTime + 1.5 : 0);
  return nowPlaying();
}

/** Skip forward or back through the current station. */
function skip(dir = 1) {
  if (!order.length) buildOrder();
  advance(dir >= 0 ? 1 : -1, ctx ? ctx.currentTime + 1.5 : 0);
  retune(ctx ? ctx.currentTime + 1.5 : 0);
  return nowPlaying();
}

/** Subscribe to track changes. Returns an unsubscribe function. */
function onRadio(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
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
  applySurface();
  return enabled;
}

/** Turn the surface noise on or off without touching the music. */
function setVinyl(on) {
  vinylOn = !!on;
  try { localStorage.setItem('vinyl', vinylOn ? 'on' : 'off'); } catch { /* private mode */ }
  applySurface();
  return vinylOn;
}

const isVinylOn = () => vinylOn;

function setMusic(on) {
  musicOn = !!on;
  try { localStorage.setItem('music', musicOn ? 'on' : 'off'); } catch { /* ignore */ }
  if (musicOn && enabled) startMusic();
  else stopMusic();
  applySurface();
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

export {
  sfx, setEnabled, setMusic, isEnabled, isMusicOn, startMusic, stopMusic, armOnFirstGesture,
  stations, nowPlaying, setStation, skip, onRadio, setVinyl, isVinylOn,
};
