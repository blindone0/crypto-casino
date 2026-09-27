// The station list for the noir radio.
//
// This file is pure data with no browser APIs in it, so the whole programme can be checked
// by the test suite: that every station points at tracks that exist, that every chord has a
// playable voicing, that every melody fits the bar it is written in. A wrong note in a
// progression is not something you want to find out about from a player.
//
// Everything is synthesised at play time from these descriptions. There are no audio files
// anywhere in this project: the site runs under a Content-Security-Policy that forbids
// remote media, and a few megabytes of samples for background music is a bad trade when an
// oscillator stays in tune at any length.
//
// How to read a track:
//
//   bpm/meter/swing  tempo, beats per bar (4 or 3), and how late the off-beat sits.
//                    swing 0 is straight, which is what a ballad or a tango wants.
//   prog             the chord loop. `root` is the bass note as a MIDI number, `voice` is
//                    a ROOTLESS voicing (3rd, 5th, 7th, 9th and no root), which is how a
//                    pianist comps behind a bass player. Voicing the root in both hands is
//                    what makes synthesised jazz sound like a MIDI file. `next` is the root
//                    of the following chord, so the bass can walk into it.
//   bass/comp/lead   which synthesised voice plays which part, or 'none'.
//   drums            the percussion pattern, or 'none'.
//   tonic            MIDI note the melody is written against.
//   phrases          melodies as [semitones above tonic, beats]. A null is a rest, and the
//                    rests matter more than the notes: a noir melody is mostly the space
//                    where the melody is not.
//   space            0 to 1, how much of the time the lead sits out entirely.
//   room/vinyl       reverb send and surface-noise level, 0 to 1.

// MIDI reference: 36 = C2, 48 = C3, 60 = middle C, 72 = C5.

const TRACKS = [
  {
    id: 'smoke',
    title: { en: 'Smoke Under the Door', ru: 'Дым под дверью' },
    bpm: 58, meter: 4, swing: 0.12,
    // C minor, the way a noir cue actually moves: a minor ii-V-i with a half-diminished ii
    // and an altered dominant, plus a flat-six substitution on the second pass.
    prog: [
      { root: 36, voice: [51, 55, 58, 62], next: 41 }, // Cm9
      { root: 41, voice: [51, 56, 60, 63], next: 38 }, // Fm9
      { root: 38, voice: [53, 56, 60, 63], next: 43 }, // Dm7b5
      { root: 43, voice: [50, 53, 59, 63], next: 36 }, // G7alt
      { root: 36, voice: [51, 55, 58, 62], next: 44 }, // Cm9
      { root: 44, voice: [50, 54, 57, 62], next: 38 }, // Ab13
      { root: 38, voice: [53, 56, 60, 63], next: 43 }, // Dm7b5
      { root: 43, voice: [50, 53, 59, 63], next: 36 }, // G7alt
    ],
    bass: 'walk', comp: 'rhodes', lead: 'horn', drums: 'brushes',
    tonic: 60, space: 0.5, room: 0.6, vinyl: 0.5,
    phrases: [
      [[12, 1], [10, 0.5], [null, 0.5], [7, 1.5], [null, 0.5]],
      [[7, 0.5], [6, 0.5], [5, 1], [3, 1.5], [null, 0.5]],
      [[10, 1.5], [12, 0.5], [null, 1], [7, 1]],
      [[3, 0.5], [5, 0.5], [7, 1], [10, 2]],
    ],
  },
  {
    id: 'bourbon',
    title: { en: 'Two Bourbons, No Ice', ru: 'Два бурбона, безо льда' },
    bpm: 74, meter: 4, swing: 0.16,
    // A twelve-bar minor blues in F. The turnaround is an altered dominant, not a plain
    // seven, which is the difference between a blues and a bar-band blues.
    prog: [
      { root: 41, voice: [51, 56, 60, 63], next: 41 }, // Fm9
      { root: 41, voice: [51, 56, 60, 63], next: 41 }, // Fm9
      { root: 41, voice: [51, 56, 60, 63], next: 41 }, // Fm9
      { root: 41, voice: [51, 56, 60, 63], next: 46 }, // Fm9
      { root: 46, voice: [49, 53, 56, 60], next: 46 }, // Bbm9
      { root: 46, voice: [49, 53, 56, 60], next: 41 }, // Bbm9
      { root: 41, voice: [51, 56, 60, 63], next: 41 }, // Fm9
      { root: 41, voice: [51, 56, 60, 63], next: 49 }, // Fm9
      { root: 49, voice: [53, 56, 59, 63], next: 48 }, // Db9
      { root: 48, voice: [52, 55, 58, 63], next: 41 }, // C7#9
      { root: 41, voice: [51, 56, 60, 63], next: 48 }, // Fm9
      { root: 48, voice: [52, 55, 58, 63], next: 41 }, // C7#9
    ],
    bass: 'walk', comp: 'organ', lead: 'guitar', drums: 'brushes',
    tonic: 65, space: 0.35, room: 0.45, vinyl: 0.6,
    phrases: [
      [[0, 0.5], [3, 0.5], [5, 1], [6, 0.5], [5, 1.5]],
      [[12, 1], [10, 1], [7, 0.5], [5, 1.5]],
      [[5, 0.5], [6, 0.5], [7, 2], [null, 1]],
      [[10, 0.5], [12, 1.5], [10, 0.5], [7, 1.5]],
    ],
  },
  {
    id: 'rain',
    title: { en: 'Rain on the Glass', ru: 'Дождь по стеклу' },
    bpm: 48, meter: 4, swing: 0,
    // Modal and mostly still. No drums at all: the rhythm section here is the reverb.
    prog: [
      { root: 33, voice: [48, 52, 55, 59], next: 29 }, // Am9
      { root: 29, voice: [45, 48, 52, 59], next: 38 }, // Fmaj7#11
      { root: 38, voice: [53, 57, 60, 64], next: 40 }, // Dm9
      { root: 40, voice: [56, 59, 62, 65], next: 33 }, // E7b9
    ],
    bass: 'pedal', comp: 'piano', lead: 'strings', drums: 'none',
    tonic: 69, space: 0.55, room: 0.95, vinyl: 0.35,
    phrases: [
      [[0, 2], [null, 1], [3, 1]],
      [[7, 1.5], [5, 0.5], [3, 2]],
      [[null, 1], [10, 1], [12, 2]],
      [[5, 2], [3, 1], [0, 1]],
    ],
  },
  {
    id: 'tram',
    title: { en: 'The Last Tram', ru: 'Последний трамвай' },
    bpm: 92, meter: 4, swing: 0,
    // A tango. Straight eighths and a rimshot pattern; swinging this would ruin it.
    prog: [
      { root: 38, voice: [53, 57, 60, 64], next: 45 }, // Dm9
      { root: 45, voice: [49, 52, 55, 58], next: 38 }, // A7b9
      { root: 38, voice: [53, 57, 60, 64], next: 43 }, // Dm9
      { root: 43, voice: [46, 50, 53, 57], next: 45 }, // Gm9
      { root: 38, voice: [53, 57, 60, 64], next: 46 }, // Dm9
      { root: 46, voice: [50, 53, 57, 60], next: 45 }, // Bbmaj7
      { root: 45, voice: [49, 52, 55, 58], next: 38 }, // A7b9
      { root: 38, voice: [53, 57, 60, 64], next: 38 }, // Dm9
    ],
    bass: 'tango', comp: 'organ', lead: 'clarinet', drums: 'bolero',
    tonic: 62, space: 0.25, room: 0.5, vinyl: 0.45,
    phrases: [
      [[0, 0.5], [2, 0.5], [3, 1], [5, 1], [3, 1]],
      [[7, 1], [5, 0.5], [3, 0.5], [2, 2]],
      [[12, 0.5], [11, 0.5], [9, 1], [7, 2]],
      [[3, 1], [5, 1], [7, 1], [8, 1]],
    ],
  },
  {
    id: 'fifth',
    title: { en: 'The Fifth Floor', ru: 'Пятый этаж' },
    bpm: 108, meter: 3, swing: 0,
    // A minor waltz. Three beats to the bar changes everything about how the comp lands.
    prog: [
      { root: 40, voice: [55, 59, 62, 66], next: 47 }, // Em9
      { root: 47, voice: [51, 54, 57, 61], next: 40 }, // B7b9
      { root: 40, voice: [55, 59, 62, 66], next: 45 }, // Em9
      { root: 45, voice: [48, 52, 55, 59], next: 40 }, // Am9
      { root: 40, voice: [55, 59, 62, 66], next: 43 }, // Em9
      { root: 43, voice: [47, 50, 54, 57], next: 47 }, // Gmaj7
      { root: 47, voice: [51, 54, 57, 61], next: 40 }, // B7b9
      { root: 40, voice: [55, 59, 62, 66], next: 40 }, // Em9
    ],
    bass: 'root', comp: 'vibes', lead: 'clarinet', drums: 'mallets',
    tonic: 64, space: 0.3, room: 0.7, vinyl: 0.4,
    phrases: [
      [[0, 1], [3, 1], [7, 1]],
      [[8, 1.5], [7, 0.5], [5, 1]],
      [[12, 2], [10, 1]],
      [[null, 1], [7, 1], [3, 1]],
    ],
  },
  {
    id: 'neon',
    title: { en: 'Neon and Rust', ru: 'Неон и ржавчина' },
    bpm: 66, meter: 4, swing: 0,
    // A two-chord vamp. Harmonic motion is not the point here; the drift is.
    prog: [
      { root: 36, voice: [51, 55, 58, 62], next: 32 }, // Cm9
      { root: 36, voice: [51, 55, 58, 62], next: 32 }, // Cm9
      { root: 32, voice: [48, 51, 55, 58], next: 36 }, // Abmaj9
      { root: 32, voice: [48, 51, 55, 58], next: 36 }, // Abmaj9
    ],
    bass: 'pedal', comp: 'guitar', lead: 'theremin', drums: 'heartbeat',
    tonic: 72, space: 0.5, room: 0.9, vinyl: 0.55,
    phrases: [
      [[0, 3], [null, 1]],
      [[3, 2], [2, 2]],
      [[null, 2], [7, 2]],
      [[10, 1.5], [7, 2.5]],
    ],
  },
  {
    id: 'confession',
    title: { en: 'Confession', ru: 'Признание' },
    bpm: 52, meter: 4, swing: 0.08,
    // Solo piano. No bass, no drums, nothing to hide behind.
    prog: [
      { root: 43, voice: [46, 50, 53, 57], next: 48 }, // Gm9
      { root: 48, voice: [52, 55, 58, 62], next: 41 }, // C9
      { root: 41, voice: [45, 48, 52, 55], next: 46 }, // Fmaj7
      { root: 46, voice: [49, 53, 56, 60], next: 43 }, // Bbm9
      { root: 43, voice: [46, 50, 53, 57], next: 45 }, // Gm9
      { root: 45, voice: [48, 51, 55, 62], next: 38 }, // Am7b5
      { root: 38, voice: [54, 57, 60, 63], next: 43 }, // D7b9
      { root: 43, voice: [46, 50, 53, 57], next: 43 }, // Gm9
    ],
    bass: 'none', comp: 'piano', lead: 'piano', drums: 'none',
    tonic: 67, space: 0.4, room: 0.85, vinyl: 0.3,
    phrases: [
      [[0, 1.5], [3, 0.5], [null, 2]],
      [[7, 1], [5, 1], [3, 2]],
      [[10, 0.5], [12, 1.5], [null, 2]],
      [[5, 1], [3, 1], [2, 2]],
    ],
  },
  {
    id: 'twoam',
    title: { en: 'Two in the Morning', ru: 'Два часа ночи' },
    bpm: 80, meter: 4, swing: 0.18,
    // Hard swing and a Hammond. The only track here with any hurry in it.
    prog: [
      { root: 46, voice: [50, 53, 56, 60], next: 46 }, // Bb9
      { root: 46, voice: [50, 53, 56, 60], next: 51 }, // Bb9
      { root: 51, voice: [55, 58, 61, 65], next: 46 }, // Eb9
      { root: 46, voice: [50, 53, 56, 60], next: 41 }, // Bb9
      { root: 41, voice: [51, 56, 60, 63], next: 46 }, // Fm9
      { root: 46, voice: [50, 53, 56, 60], next: 43 }, // Bb9
      { root: 43, voice: [50, 53, 59, 63], next: 48 }, // G7alt
      { root: 48, voice: [52, 55, 58, 63], next: 46 }, // C7#9
    ],
    bass: 'walk', comp: 'organ', lead: 'horn', drums: 'brushes',
    tonic: 70, space: 0.3, room: 0.4, vinyl: 0.5,
    phrases: [
      [[0, 0.5], [2, 0.5], [3, 0.5], [5, 1.5], [null, 1]],
      [[10, 1], [7, 0.5], [5, 0.5], [3, 2]],
      [[7, 0.5], [10, 0.5], [12, 1], [10, 2]],
      [[3, 1], [5, 0.5], [6, 0.5], [7, 2]],
    ],
  },
  {
    id: 'coldcase',
    title: { en: 'Cold Case', ru: 'Висяк' },
    bpm: 54, meter: 4, swing: 0,
    // A clock and a string section. The percussion is a tick, so the bar keeps time the
    // way an evidence room does: audibly, and without ever getting anywhere.
    prog: [
      { root: 37, voice: [52, 56, 59, 63], next: 42 }, // C#m9
      { root: 42, voice: [52, 57, 61, 64], next: 39 }, // F#m9
      { root: 39, voice: [54, 57, 61, 64], next: 44 }, // D#m7b5
      { root: 44, voice: [51, 54, 60, 64], next: 37 }, // G#7alt
    ],
    bass: 'pedal', comp: 'strings', lead: 'clarinet', drums: 'ticks',
    tonic: 61, space: 0.6, room: 0.9, vinyl: 0.4,
    phrases: [
      [[0, 2], [3, 2]],
      [[null, 2], [7, 1.5], [5, 0.5]],
      [[10, 1], [12, 3]],
      [[7, 1], [5, 1], [3, 2]],
    ],
  },
  {
    id: 'silhouette',
    title: { en: 'A Familiar Silhouette', ru: 'Знакомый силуэт' },
    bpm: 100, meter: 3, swing: 0,
    // A minor romance waltz, guitar-led. Closer to a Russian romance than to jazz, which
    // is on purpose: the station is not all one city.
    prog: [
      { root: 33, voice: [48, 52, 55, 59], next: 40 }, // Am9
      { root: 40, voice: [44, 47, 50, 53], next: 33 }, // E7b9
      { root: 33, voice: [48, 52, 55, 59], next: 38 }, // Am9
      { root: 38, voice: [53, 57, 60, 64], next: 33 }, // Dm9
      { root: 33, voice: [48, 52, 55, 59], next: 41 }, // Am9
      { root: 41, voice: [45, 48, 52, 55], next: 40 }, // Fmaj7
      { root: 40, voice: [44, 47, 50, 53], next: 33 }, // E7b9
      { root: 33, voice: [48, 52, 55, 59], next: 33 }, // Am9
    ],
    bass: 'root', comp: 'guitar', lead: 'strings', drums: 'mallets',
    tonic: 69, space: 0.25, room: 0.75, vinyl: 0.5,
    phrases: [
      [[0, 1], [2, 1], [3, 1]],
      [[5, 2], [3, 1]],
      [[7, 1], [8, 1], [7, 1]],
      [[12, 1.5], [10, 0.5], [7, 1]],
    ],
  },
  {
    id: 'velvet',
    title: { en: 'Velvet Rope', ru: 'Бархатный канат' },
    bpm: 64, meter: 4, swing: 0.13,
    // Vibraphone over Rhodes. The lushest thing on the dial.
    prog: [
      { root: 35, voice: [50, 54, 57, 61], next: 40 }, // Bm9
      { root: 40, voice: [55, 59, 62, 66], next: 33 }, // Em9
      { root: 33, voice: [48, 52, 55, 59], next: 42 }, // Am9
      { root: 42, voice: [46, 49, 52, 56], next: 35 }, // F#7b9
      { root: 35, voice: [50, 54, 57, 61], next: 43 }, // Bm9
      { root: 43, voice: [47, 50, 54, 57], next: 40 }, // Gmaj7
      { root: 40, voice: [55, 59, 62, 66], next: 42 }, // Em9
      { root: 42, voice: [46, 49, 52, 56], next: 35 }, // F#7b9
    ],
    bass: 'walk', comp: 'rhodes', lead: 'vibes', drums: 'brushes',
    tonic: 71, space: 0.35, room: 0.7, vinyl: 0.45,
    phrases: [
      [[0, 1], [3, 1], [5, 1.5], [null, 0.5]],
      [[7, 2], [5, 1], [3, 1]],
      [[10, 0.5], [12, 1.5], [10, 1], [7, 1]],
      [[null, 1], [5, 1], [3, 2]],
    ],
  },
  {
    id: 'afterhours',
    title: { en: 'After Hours', ru: 'После закрытия' },
    bpm: 50, meter: 4, swing: 0.1,
    // Bass and horn. Nothing else, and almost none of that.
    prog: [
      { root: 34, voice: [49, 53, 56, 60], next: 39 }, // Bbm9
      { root: 39, voice: [54, 58, 61, 65], next: 41 }, // Ebm9
      { root: 41, voice: [51, 56, 60, 63], next: 46 }, // Fm9
      { root: 46, voice: [49, 53, 56, 60], next: 34 }, // Bbm9
    ],
    bass: 'walk', comp: 'none', lead: 'horn', drums: 'none',
    tonic: 70, space: 0.45, room: 0.85, vinyl: 0.65,
    phrases: [
      [[0, 2], [null, 2]],
      [[3, 1.5], [0, 0.5], [null, 2]],
      [[7, 1], [5, 1], [3, 2]],
      [[10, 2], [7, 2]],
    ],
  },
];

// Stations are playlists, not genres. A track can sit on more than one dial position,
// because a tune belongs to a mood rather than to a folder.
const STATIONS = [
  {
    id: 'desk',
    name: { en: 'Night Desk', ru: 'Ночной эфир' },
    blurb: { en: 'Trio jazz, a lamp and a case file.', ru: 'Джазовое трио, лампа и папка с делом.' },
    tracks: ['smoke', 'velvet', 'afterhours', 'twoam', 'bourbon'],
  },
  {
    id: 'rain',
    name: { en: 'Rain Window', ru: 'Дождь за окном' },
    blurb: { en: 'Slow, wide and almost still.', ru: 'Медленно, широко и почти неподвижно.' },
    tracks: ['rain', 'confession', 'coldcase', 'neon', 'afterhours'],
  },
  {
    id: 'tram',
    name: { en: 'Last Tram', ru: 'Последний трамвай' },
    blurb: { en: 'Tango, waltz and the long way home.', ru: 'Танго, вальс и долгая дорога домой.' },
    tracks: ['tram', 'silhouette', 'fifth', 'coldcase'],
  },
  {
    id: 'basement',
    name: { en: 'The Basement', ru: 'Подвал' },
    blurb: { en: 'Organ, blues and no last orders.', ru: 'Орган, блюз и никакого последнего заказа.' },
    tracks: ['twoam', 'bourbon', 'neon', 'velvet', 'smoke'],
  },
];

const trackById = (id) => TRACKS.find((t) => t.id === id) || null;
const stationById = (id) => STATIONS.find((s) => s.id === id) || null;

/** Seconds one chorus of a track lasts, used to decide when to move the dial on. */
function chorusSeconds(track) {
  return (track.prog.length * track.meter * 60) / track.bpm;
}

/**
 * How many whole choruses to play before the next track.
 * Whole choruses only: cutting a progression off mid-turnaround sounds like a mistake,
 * which on a radio is exactly what it would be.
 */
function chorusesFor(track, targetSeconds = 100) {
  return Math.max(1, Math.round(targetSeconds / chorusSeconds(track)));
}

export {
  TRACKS, STATIONS, trackById, stationById, chorusSeconds, chorusesFor,
};
