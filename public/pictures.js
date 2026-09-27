// Original artwork revealed underneath a puzzle. Drawn here as vectors rather than
// shipped as image files, for the same reason the slot symbols are: the site runs under a
// strict Content-Security-Policy with no remote assets, and vectors stay crisp at any
// tile size. Everything in this file is original work, so there is no third-party licence
// to honour and nothing that could belong to someone who never agreed to appear here.
//
// Each picture is a 120x120 scene designed to read well when it is only partly uncovered:
// strong silhouettes, high contrast, and something recognisable in every quadrant.

const frame = (inner, bg) => `
<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="pgSky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2a1a4d"/>
      <stop offset="55%" stop-color="#6b2a5e"/>
      <stop offset="100%" stop-color="#d1614a"/>
    </linearGradient>
    <linearGradient id="pgGold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffeaab"/>
      <stop offset="50%" stop-color="#d9b45a"/>
      <stop offset="100%" stop-color="#8a6f2e"/>
    </linearGradient>
    <linearGradient id="pgTeal" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1fd6c0"/>
      <stop offset="100%" stop-color="#11556b"/>
    </linearGradient>
    <linearGradient id="pgPlum" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3a1550"/>
      <stop offset="100%" stop-color="#150720"/>
    </linearGradient>
    <radialGradient id="pgGlow" cx="50%" cy="42%" r="58%">
      <stop offset="0%" stop-color="#ffe6a8" stop-opacity=".85"/>
      <stop offset="100%" stop-color="#ffe6a8" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="120" height="120" fill="${bg}"/>
  ${inner}
</svg>`;

const PICTURES = {
  /** Art-deco sunburst fan: strong radial lines, reads from any corner. */
  deco: () => frame(`
    <circle cx="60" cy="66" r="52" fill="url(#pgGlow)"/>
    <g stroke="url(#pgGold)" stroke-width="2.4" stroke-linecap="round">
      ${Array.from({ length: 13 }, (_, i) => {
    const a = (Math.PI * i) / 12;
    const x = 60 - Math.cos(a) * 46;
    const y = 96 - Math.sin(a) * 46;
    return `<path d="M60 96 L${x.toFixed(1)} ${y.toFixed(1)}"/>`;
  }).join('')}
    </g>
    <path d="M14 96a46 46 0 0 1 92 0z" fill="none" stroke="url(#pgGold)" stroke-width="3"/>
    <path d="M26 96a34 34 0 0 1 68 0" fill="none" stroke="url(#pgGold)" stroke-width="1.6" stroke-opacity=".7"/>
    <path d="M38 96a22 22 0 0 1 44 0" fill="none" stroke="url(#pgGold)" stroke-width="1.6" stroke-opacity=".5"/>
    <circle cx="60" cy="96" r="6" fill="url(#pgGold)"/>
    <rect x="8" y="100" width="104" height="3" rx="1.5" fill="url(#pgGold)"/>
    <circle cx="60" cy="26" r="7" fill="none" stroke="url(#pgGold)" stroke-width="2"/>
  `, '#140d20'),

  /** A peacock feather: an eye in the centre, barbs spreading out. */
  peacock: () => frame(`
    <ellipse cx="60" cy="58" rx="44" ry="50" fill="#0d3a44"/>
    <g stroke="url(#pgTeal)" stroke-width="1.5" stroke-linecap="round" stroke-opacity=".75">
      ${Array.from({ length: 22 }, (_, i) => {
    const a = (Math.PI * 2 * i) / 22;
    const x1 = 60 + Math.cos(a) * 18;
    const y1 = 58 + Math.sin(a) * 20;
    const x2 = 60 + Math.cos(a) * 46;
    const y2 = 58 + Math.sin(a) * 52;
    return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}"/>`;
  }).join('')}
    </g>
    <ellipse cx="60" cy="58" rx="26" ry="30" fill="url(#pgTeal)"/>
    <ellipse cx="60" cy="58" rx="17" ry="20" fill="#123a63"/>
    <ellipse cx="60" cy="58" rx="10" ry="12" fill="url(#pgGold)"/>
    <ellipse cx="60" cy="56" rx="4.5" ry="6" fill="#2a1030"/>
    <ellipse cx="57" cy="52" rx="2" ry="2.6" fill="#ffffff" fill-opacity=".8"/>
    <path d="M60 88v26" stroke="url(#pgTeal)" stroke-width="2.5" stroke-linecap="round"/>
  `, '#06212a'),

  /** Night skyline: silhouette buildings, moon, scattered lit windows. */
  skyline: () => frame(`
    <rect width="120" height="120" fill="url(#pgSky)"/>
    <circle cx="90" cy="26" r="13" fill="#ffeec2"/>
    <circle cx="85" cy="22" r="11" fill="url(#pgSky)" opacity=".92"/>
    ${[[6, 62, 16, 58], [24, 48, 14, 72], [40, 70, 12, 50], [54, 36, 18, 84],
    [74, 58, 13, 62], [89, 72, 11, 48], [102, 52, 14, 68]].map(
    ([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#150a22"/>`,
  ).join('')}
    <g fill="#ffd98a" fill-opacity=".85">
      ${[[9, 68], [15, 78], [27, 54], [33, 66], [43, 76], [58, 42], [64, 54], [58, 68],
    [77, 64], [83, 80], [92, 78], [105, 58], [111, 70]].map(
    ([x, y]) => `<rect x="${x}" y="${y}" width="3" height="4" rx=".6"/>`,
  ).join('')}
    </g>
    <rect y="112" width="120" height="8" fill="#0c0514"/>
    <g stroke="#ffd98a" stroke-opacity=".28" stroke-width="1">
      <path d="M0 112h120"/>
    </g>
  `, '#1b0f2e'),

  /** Geometric mandala: concentric rings, entirely symmetric. */
  mandala: () => frame(`
    <rect width="120" height="120" fill="url(#pgPlum)"/>
    <circle cx="60" cy="60" r="50" fill="none" stroke="url(#pgGold)" stroke-width="1.4" stroke-opacity=".6"/>
    <g stroke="url(#pgGold)" stroke-width="1.6" stroke-linecap="round">
      ${Array.from({ length: 12 }, (_, i) => {
    const a = (Math.PI * 2 * i) / 12;
    const x1 = 60 + Math.cos(a) * 16;
    const y1 = 60 + Math.sin(a) * 16;
    const x2 = 60 + Math.cos(a) * 46;
    const y2 = 60 + Math.sin(a) * 46;
    return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}"/>`;
  }).join('')}
    </g>
    ${Array.from({ length: 12 }, (_, i) => {
    const a = (Math.PI * 2 * i) / 12;
    const x = 60 + Math.cos(a) * 36;
    const y = 60 + Math.sin(a) * 36;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="url(#pgTeal)" fill-opacity=".85"/>`;
  }).join('')}
    <circle cx="60" cy="60" r="30" fill="none" stroke="url(#pgGold)" stroke-width="2"/>
    <circle cx="60" cy="60" r="20" fill="none" stroke="url(#pgTeal)" stroke-width="2.2"/>
    <circle cx="60" cy="60" r="11" fill="url(#pgGold)"/>
    <circle cx="60" cy="60" r="5" fill="#2a1030"/>
  `, '#150720'),
};

/** Markup for one picture; falls back to the deco fan if the key is unknown. */
export function pictureSvg(key) {
  const make = PICTURES[key] || PICTURES.deco;
  return make();
}

export const PICTURE_KEYS = Object.keys(PICTURES);
