// The look of each machine, for the renderers.
//
// symbols.js decides what is printed on the reels; style.css dresses the DOM cabinet
// when there is no WebGL. Neither reaches the two GL renderers, and for a long time that
// meant every theme was walnut, brass and a gold reel band with different pictures on
// it. This is the missing piece: one palette per theme that slot3d.js (the strip and the
// win glow), slotstrip.js (the printed cell) and cabinet3d.js (the lacquer, the bezel,
// the marquee light, the LEDs, the button) all read. The maths, paytable and RTP are the
// same on every machine; only the paint changes.
//
// Colours for WebGL are [r, g, b] in 0..1; colours for the canvas painter are CSS.

export const SLOT_THEMES = {
  classic: {
    case: [0.085, 0.078, 0.085],                 // black lacquer, a hair warm
    bezel: 'brass',
    accent: [1.0, 0.78, 0.32],                  // the LEDs and the win glow
    lamp: [1.0, 0.26, 0.14],                    // the spin button
    band: ['#15132c', '#0a0919', '#050410'],    // the printed strip: top, middle, bottom
    frame: '#e2bd63',                           // the hairline round each cell
    glow: 'rgba(255, 214, 120, 0.10)',          // the light behind a symbol
    marquee: {
      glow: [1.0, 0.78, 0.40],
      text: ['#fff3cd', '#e2bd63', '#9a7526'],
      small: '#c8a24a',
    },
  },
  afterdark: {
    case: [0.10, 0.05, 0.16],                   // violet lacquer
    bezel: 'steel',
    accent: [1.0, 0.31, 0.64],                  // neon pink
    lamp: [0.25, 0.85, 0.95],                   // and a cyan button
    band: ['#1c0b34', '#0e0519', '#07030d'],
    frame: '#3fd8f0',
    glow: 'rgba(255, 79, 163, 0.12)',
    marquee: {
      glow: [1.0, 0.35, 0.70],
      text: ['#ffd6f0', '#ff4fa3', '#a1105c'],
      small: '#3fd8f0',
    },
  },
  russian: {
    case: [0.17, 0.045, 0.035],                 // khokhloma: black-red lacquer
    bezel: 'brass',
    accent: [1.0, 0.66, 0.24],                  // amber
    lamp: [1.0, 0.20, 0.10],
    band: ['#1e0906', '#0f0403', '#070201'],
    frame: '#e8a83c',
    glow: 'rgba(232, 168, 60, 0.10)',
    marquee: {
      glow: [1.0, 0.60, 0.25],
      text: ['#ffe7b0', '#e8a83c', '#8a4a10'],
      small: '#e8a83c',
    },
  },
  noir: {
    case: [0.070, 0.075, 0.085],                // black, a hair cold
    bezel: 'steel',
    accent: [0.82, 0.88, 0.96],                 // cold white
    lamp: [1.0, 0.85, 0.60],                    // one warm thing on the machine
    band: ['#171a20', '#0c0e12', '#060708'],
    frame: '#cfd8e4',
    glow: 'rgba(214, 226, 240, 0.08)',
    marquee: {
      glow: [0.85, 0.90, 1.0],
      text: ['#f4f6fa', '#b9c2d0', '#78828f'],
      small: '#9eacbc',
    },
  },
  couch: {
    case: [0.06, 0.08, 0.16],                   // midnight blue lacquer
    bezel: 'brass',
    accent: [0.56, 0.65, 0.91],
    lamp: [1.0, 0.85, 0.45],                    // moon gold
    band: ['#0d1330', '#080c1c', '#04060e'],
    frame: '#8fa6e8',
    glow: 'rgba(143, 166, 232, 0.10)',
    marquee: {
      glow: [0.60, 0.70, 1.0],
      text: ['#e9eeff', '#8fa6e8', '#3a4a8a'],
      small: '#8fa6e8',
    },
  },
};

/** The palette for a theme key, and the classic one for anything unknown. */
export function slotPalette(key) {
  return SLOT_THEMES[key] || SLOT_THEMES.classic;
}
