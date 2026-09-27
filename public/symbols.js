// Slot symbol artwork, drawn as inline SVG.
//
// Everything is vector and self-contained on purpose: the site runs under a strict
// Content-Security-Policy with no CDN and no remote images, so sprite sheets and icon
// fonts are not an option. Vectors also stay sharp at any reel size and cost nothing
// to load.
//
// Gradients live in one shared <defs> block injected once, so a screen full of symbols
// reuses the same paint servers instead of redefining them per cell.

const DEFS_ID = 'slot-defs';

const DEFS = `
<defs>
  <linearGradient id="sgGold" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#ffeaab"/>
    <stop offset="45%" stop-color="#e6bf63"/>
    <stop offset="100%" stop-color="#9c7726"/>
  </linearGradient>
  <linearGradient id="sgSilver" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#f4f6fa"/>
    <stop offset="50%" stop-color="#b9c2d0"/>
    <stop offset="100%" stop-color="#78828f"/>
  </linearGradient>
  <linearGradient id="sgBronze" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#e8b892"/>
    <stop offset="50%" stop-color="#c08552"/>
    <stop offset="100%" stop-color="#7d5130"/>
  </linearGradient>
  <linearGradient id="sgRuby" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#ff9db0"/>
    <stop offset="45%" stop-color="#e03a5c"/>
    <stop offset="100%" stop-color="#8e132e"/>
  </linearGradient>
  <linearGradient id="sgEmerald" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#9dffd8"/>
    <stop offset="45%" stop-color="#2fc48e"/>
    <stop offset="100%" stop-color="#11694b"/>
  </linearGradient>
  <linearGradient id="sgSky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#cfe9ff"/>
    <stop offset="45%" stop-color="#57a8f0"/>
    <stop offset="100%" stop-color="#1d5794"/>
  </linearGradient>
  <linearGradient id="sgSheen" x1="0" y1="0" x2="0.3" y2="1">
    <stop offset="0%" stop-color="#ffffff" stop-opacity=".55"/>
    <stop offset="55%" stop-color="#ffffff" stop-opacity=".05"/>
    <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="sgNeonPink" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#ffc2e6"/>
    <stop offset="45%" stop-color="#ff4fa3"/>
    <stop offset="100%" stop-color="#a1105c"/>
  </linearGradient>
  <linearGradient id="sgNeonCyan" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#ccfaff"/>
    <stop offset="45%" stop-color="#3fd8f0"/>
    <stop offset="100%" stop-color="#14707f"/>
  </linearGradient>
  <linearGradient id="sgNeonViolet" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#e4ccff"/>
    <stop offset="45%" stop-color="#9b5cf6"/>
    <stop offset="100%" stop-color="#4a1d82"/>
  </linearGradient>
  <radialGradient id="sgNeonHalo" cx="50%" cy="45%" r="55%">
    <stop offset="0%" stop-color="#ff8ecb" stop-opacity=".85"/>
    <stop offset="70%" stop-color="#8b3fd8" stop-opacity=".18"/>
    <stop offset="100%" stop-color="#8b3fd8" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="sgHalo" cx="50%" cy="45%" r="55%">
    <stop offset="0%" stop-color="#fff3cc" stop-opacity=".9"/>
    <stop offset="70%" stop-color="#e6bf63" stop-opacity=".18"/>
    <stop offset="100%" stop-color="#e6bf63" stop-opacity="0"/>
  </radialGradient>
</defs>`;

/** Inject the shared gradients once per document. */
export function ensureSymbolDefs() {
  if (document.getElementById(DEFS_ID)) return;
  const holder = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  holder.setAttribute('id', DEFS_ID);
  holder.setAttribute('aria-hidden', 'true');
  holder.setAttribute('width', '0');
  holder.setAttribute('height', '0');
  holder.style.position = 'absolute';
  holder.innerHTML = DEFS;
  document.body.appendChild(holder);
}

const wrap = (inner) =>
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;

/** A card rank rendered as an engraved metal letter on a subtle plaque. */
function royal(letter, fill, pip) {
  return wrap(`
    <rect x="14" y="12" width="72" height="76" rx="10"
          fill="#0f0d0b" stroke="${fill === 'url(#sgGold)' ? '#8a6f2e' : '#4a4740'}" stroke-width="2"/>
    <rect x="18" y="16" width="64" height="30" rx="7" fill="url(#sgSheen)"/>
    <text x="50" y="62" text-anchor="middle"
          font-family="Hoefler Text, Baskerville, Georgia, serif"
          font-size="${letter.length > 1 ? 38 : 46}" font-weight="700"
          fill="${fill}" stroke="rgba(0,0,0,.35)" stroke-width="1">${letter}</text>
    <text x="50" y="82" text-anchor="middle" font-size="16" fill="${fill}" opacity=".75">${pip}</text>`);
}

const CLASSIC = {
  // --- low value: card ranks, cooler metals
  T: () => royal('10', 'url(#sgSilver)', '\u2663'),
  J: () => royal('J', 'url(#sgSilver)', '\u2666'),
  Q: () => royal('Q', 'url(#sgBronze)', '\u2665'),
  K: () => royal('K', 'url(#sgBronze)', '\u2660'),
  A: () => royal('A', 'url(#sgGold)', '\u2666'),

  // --- mid value: a bell
  BELL: () => wrap(`
    <ellipse cx="50" cy="50" rx="44" ry="44" fill="url(#sgHalo)"/>
    <path d="M50 16c-3 0-5 2-5 4v3c-11 3-18 13-18 25v12c0 7-3 11-7 14h60c-4-3-7-7-7-14V48c0-12-7-22-18-25v-3c0-2-2-4-5-4z"
          fill="url(#sgGold)" stroke="#6d5520" stroke-width="2" stroke-linejoin="round"/>
    <path d="M36 28c-4 5-6 12-6 20v12" fill="none" stroke="#fff6dc" stroke-opacity=".5" stroke-width="3" stroke-linecap="round"/>
    <ellipse cx="50" cy="80" rx="8" ry="6" fill="url(#sgGold)" stroke="#6d5520" stroke-width="2"/>`),

  // --- high value: a cut gem
  GEM: () => wrap(`
    <ellipse cx="50" cy="52" rx="44" ry="44" fill="url(#sgHalo)"/>
    <path d="M30 32h40l14 16-34 40-34-40z" fill="url(#sgEmerald)" stroke="#0c5a41" stroke-width="2" stroke-linejoin="round"/>
    <path d="M30 32l-14 16h68L70 32z" fill="#ffffff" fill-opacity=".22"/>
    <path d="M16 48h68L50 88z" fill="#000000" fill-opacity=".12"/>
    <path d="M30 32l6 16h28l6-16" fill="none" stroke="#e8fff5" stroke-opacity=".55" stroke-width="2"/>
    <path d="M36 48L50 88 64 48" fill="none" stroke="#e8fff5" stroke-opacity=".35" stroke-width="2"/>`),

  // --- top value: a crown
  CROWN: () => wrap(`
    <ellipse cx="50" cy="52" rx="44" ry="44" fill="url(#sgHalo)"/>
    <path d="M16 74l6-40 16 18 12-26 12 26 16-18 6 40z"
          fill="url(#sgGold)" stroke="#6d5520" stroke-width="2" stroke-linejoin="round"/>
    <rect x="16" y="74" width="68" height="12" rx="4" fill="url(#sgGold)" stroke="#6d5520" stroke-width="2"/>
    <circle cx="22" cy="32" r="5" fill="url(#sgRuby)" stroke="#6d5520" stroke-width="1.5"/>
    <circle cx="50" cy="24" r="5.5" fill="url(#sgRuby)" stroke="#6d5520" stroke-width="1.5"/>
    <circle cx="78" cy="32" r="5" fill="url(#sgRuby)" stroke="#6d5520" stroke-width="1.5"/>
    <circle cx="36" cy="80" r="3" fill="url(#sgEmerald)"/>
    <circle cx="50" cy="80" r="3" fill="url(#sgRuby)"/>
    <circle cx="64" cy="80" r="3" fill="url(#sgEmerald)"/>`),

  // --- wild: a star, the one symbol that should read instantly
  WILD: () => wrap(`
    <ellipse cx="50" cy="50" rx="46" ry="46" fill="url(#sgHalo)"/>
    <path d="M50 10l11 25 27 3-20 18 6 27-24-14-24 14 6-27-20-18 27-3z"
          fill="url(#sgGold)" stroke="#6d5520" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M50 10l11 25 27 3-20 18" fill="none" stroke="#fff6dc" stroke-opacity=".6" stroke-width="2.5" stroke-linecap="round"/>
    <text x="50" y="64" text-anchor="middle"
          font-family="Hoefler Text, Baskerville, Georgia, serif"
          font-size="22" font-weight="700" fill="#5a4413">W</text>`),

  // --- scatter: a radiant orb, deliberately unlike everything else
  SCAT: () => wrap(`
    <ellipse cx="50" cy="50" rx="46" ry="46" fill="url(#sgHalo)"/>
    <g stroke="url(#sgSky)" stroke-width="5" stroke-linecap="round">
      <path d="M50 6v14"/><path d="M50 80v14"/>
      <path d="M6 50h14"/><path d="M80 50h14"/>
      <path d="M19 19l10 10"/><path d="M71 71l10 10"/>
      <path d="M81 19L71 29"/><path d="M29 71l-10 10"/>
    </g>
    <circle cx="50" cy="50" r="22" fill="url(#sgSky)" stroke="#123f6b" stroke-width="2"/>
    <circle cx="43" cy="43" r="7" fill="#ffffff" fill-opacity=".55"/>`),
};

/**
 * After Dark: a late-night cocktail-bar theme. Deliberately suggestive of a nightclub
 * rather than explicit -- neon, glassware, a masquerade mask. The reel maths is identical
 * to the classic machine; only the artwork and the palette change.
 */
const AFTER_DARK = {
  T: () => neonRank('10', 'url(#sgNeonCyan)'),
  J: () => neonRank('J', 'url(#sgNeonCyan)'),
  Q: () => neonRank('Q', 'url(#sgNeonViolet)'),
  K: () => neonRank('K', 'url(#sgNeonViolet)'),
  A: () => neonRank('A', 'url(#sgNeonPink)'),

  // mid value: a cocktail
  BELL: () => wrap(`
    <ellipse cx="50" cy="50" rx="44" ry="44" fill="url(#sgNeonHalo)"/>
    <path d="M20 24h60L54 56v24h14v8H32v-8h14V56z"
          fill="url(#sgNeonCyan)" stroke="#0d5f6d" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M27 31h46L52 59z" fill="#ffffff" fill-opacity=".3"/>
    <circle cx="68" cy="22" r="6" fill="url(#sgNeonPink)" stroke="#8d0f4f" stroke-width="1.5"/>
    <path d="M68 16V8" stroke="#8d0f4f" stroke-width="2" stroke-linecap="round"/>`),

  // high value: lipstick
  GEM: () => wrap(`
    <ellipse cx="50" cy="50" rx="44" ry="44" fill="url(#sgNeonHalo)"/>
    <rect x="36" y="52" width="28" height="34" rx="4"
          fill="#2a2030" stroke="#6b5a78" stroke-width="2"/>
    <rect x="34" y="46" width="32" height="8" rx="3" fill="url(#sgNeonViolet)" stroke="#4a1d82" stroke-width="1.5"/>
    <path d="M40 46V24c0-4 4-8 10-8s10 4 10 8v22z"
          fill="url(#sgNeonPink)" stroke="#8d0f4f" stroke-width="2" stroke-linejoin="round"/>
    <path d="M44 44V26c0-3 2-5 5-5" fill="none" stroke="#ffd9ec" stroke-opacity=".6" stroke-width="2.5" stroke-linecap="round"/>`),

  // top value: a champagne coupe with bubbles
  CROWN: () => wrap(`
    <ellipse cx="50" cy="50" rx="44" ry="44" fill="url(#sgNeonHalo)"/>
    <path d="M26 30h48c0 16-10 26-24 26S26 46 26 30z"
          fill="url(#sgNeonPink)" stroke="#8d0f4f" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M31 34h38c-1 10-8 17-19 17s-18-7-19-17z" fill="#ffffff" fill-opacity=".28"/>
    <path d="M50 56v22" stroke="#8d0f4f" stroke-width="4" stroke-linecap="round"/>
    <ellipse cx="50" cy="82" rx="16" ry="5" fill="url(#sgNeonPink)" stroke="#8d0f4f" stroke-width="2"/>
    <circle cx="44" cy="20" r="3.5" fill="#ffd9ec" fill-opacity=".85"/>
    <circle cx="57" cy="14" r="2.5" fill="#ffd9ec" fill-opacity=".7"/>
    <circle cx="51" cy="24" r="2" fill="#ffd9ec" fill-opacity=".6"/>`),

  // wild: a masquerade mask
  WILD: () => wrap(`
    <ellipse cx="50" cy="50" rx="46" ry="46" fill="url(#sgNeonHalo)"/>
    <path d="M12 38c12-8 26-8 38-2 12-6 26-6 38 2 0 20-12 34-24 34-6 0-11-4-14-10-3 6-8 10-14 10C24 72 12 58 12 38z"
          fill="url(#sgNeonViolet)" stroke="#3c1470" stroke-width="2.5" stroke-linejoin="round"/>
    <ellipse cx="30" cy="44" rx="10" ry="7" fill="#120a1c"/>
    <ellipse cx="70" cy="44" rx="10" ry="7" fill="#120a1c"/>
    <path d="M12 38c12-8 26-8 38-2" fill="none" stroke="#f0d9ff" stroke-opacity=".55" stroke-width="2.5"/>
    <circle cx="50" cy="60" r="3.5" fill="url(#sgNeonPink)"/>`),

  // scatter: a mirror ball
  SCAT: () => wrap(`
    <ellipse cx="50" cy="52" rx="46" ry="46" fill="url(#sgNeonHalo)"/>
    <path d="M50 6v12" stroke="#7a7f99" stroke-width="3" stroke-linecap="round"/>
    <circle cx="50" cy="54" r="30" fill="url(#sgSilver)" stroke="#5b6472" stroke-width="2"/>
    <g stroke="#3f4653" stroke-width="1.4" stroke-opacity=".8">
      <path d="M20 54h60"/><path d="M24 40h52"/><path d="M24 68h52"/>
      <path d="M50 24v60"/><path d="M36 27v54"/><path d="M64 27v54"/>
    </g>
    <circle cx="40" cy="42" r="6" fill="#ffffff" fill-opacity=".55"/>
    <path d="M14 30l-8-8M86 30l8-8M14 78l-8 8M86 78l8 8"
          stroke="url(#sgNeonCyan)" stroke-width="3" stroke-linecap="round"/>`),
};

/** A card rank as a neon sign rather than engraved metal. */
function neonRank(letter, fill) {
  return wrap(`
    <rect x="14" y="12" width="72" height="76" rx="12"
          fill="#150d1c" stroke="#3c2a4d" stroke-width="2"/>
    <rect x="20" y="18" width="60" height="64" rx="9" fill="none"
          stroke="${fill}" stroke-width="2" stroke-opacity=".55"/>
    <text x="50" y="64" text-anchor="middle"
          font-family="Hoefler Text, Baskerville, Georgia, serif"
          font-size="${letter.length > 1 ? 36 : 44}" font-weight="700" fill="${fill}">${letter}</text>`);
}

const THEMES = { classic: CLASSIC, afterdark: AFTER_DARK };

export const THEME_KEYS = Object.keys(THEMES);

/** SVG markup for one symbol in the chosen theme; falls back to the key if unknown. */
export function symbolSvg(key, theme = 'classic') {
  const set = THEMES[theme] || CLASSIC;
  const make = set[key] || CLASSIC[key];
  return make ? make() : `<span>${key}</span>`;
}

export const SYMBOL_KEYS = Object.keys(CLASSIC);
