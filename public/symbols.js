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
  <linearGradient id="sgKhokhRed" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#ff7a5c"/>
    <stop offset="45%" stop-color="#cc2417"/>
    <stop offset="100%" stop-color="#78100c"/>
  </linearGradient>
  <linearGradient id="sgBirch" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#fdf3dc"/>
    <stop offset="55%" stop-color="#e4cfa2"/>
    <stop offset="100%" stop-color="#9c7e4e"/>
  </linearGradient>
  <linearGradient id="sgBrass" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#ffe9a8"/>
    <stop offset="40%" stop-color="#d79f3c"/>
    <stop offset="100%" stop-color="#7d5514"/>
  </linearGradient>
  <linearGradient id="sgGlass" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#e8f6ff" stop-opacity=".9"/>
    <stop offset="100%" stop-color="#9dc4d8" stop-opacity=".75"/>
  </linearGradient>
  <radialGradient id="sgRusHalo" cx="50%" cy="45%" r="55%">
    <stop offset="0%" stop-color="#ffd9a1" stop-opacity=".75"/>
    <stop offset="70%" stop-color="#cc2417" stop-opacity=".16"/>
    <stop offset="100%" stop-color="#cc2417" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="sgHalo" cx="50%" cy="45%" r="55%">
    <stop offset="0%" stop-color="#fff3cc" stop-opacity=".9"/>
    <stop offset="70%" stop-color="#e6bf63" stop-opacity=".18"/>
    <stop offset="100%" stop-color="#e6bf63" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="sgSmoke" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#d7dee7"/>
    <stop offset="55%" stop-color="#8d98a6"/>
    <stop offset="100%" stop-color="#4b535e"/>
  </linearGradient>
  <linearGradient id="sgSteel" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#ffffff"/>
    <stop offset="35%" stop-color="#c3ccd6"/>
    <stop offset="70%" stop-color="#7c8894"/>
    <stop offset="100%" stop-color="#d9e2ea"/>
  </linearGradient>
  <linearGradient id="sgWhisky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#f0b95e"/>
    <stop offset="55%" stop-color="#c2761f"/>
    <stop offset="100%" stop-color="#7a3f0d"/>
  </linearGradient>
  <radialGradient id="sgLamp" cx="50%" cy="38%" r="62%">
    <stop offset="0%" stop-color="#ffdca3" stop-opacity=".85"/>
    <stop offset="60%" stop-color="#b98a3f" stop-opacity=".22"/>
    <stop offset="100%" stop-color="#0a0a0c" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="sgNight" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#5f7ec9"/>
    <stop offset="50%" stop-color="#2b3a74"/>
    <stop offset="100%" stop-color="#111737"/>
  </linearGradient>
  <linearGradient id="sgAmberGlass" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#e8b06a"/>
    <stop offset="55%" stop-color="#b9762c"/>
    <stop offset="100%" stop-color="#6d3f12"/>
  </linearGradient>
  <linearGradient id="sgBlot" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#a8b8de"/>
    <stop offset="55%" stop-color="#5d6d9b"/>
    <stop offset="100%" stop-color="#2c3555"/>
  </linearGradient>
  <radialGradient id="sgStarField" cx="50%" cy="45%" r="60%">
    <stop offset="0%" stop-color="#7f9ae0" stop-opacity=".45"/>
    <stop offset="100%" stop-color="#0a0d1a" stop-opacity="0"/>
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

/**
 * Zolotoye Koltso: a khokhloma-lacquer machine. Black and red ground with gold
 * detailing, the way the painted woodenware actually looks. The symbols are a bowl of
 * kasha, painted eggs, vodka, an old bearded genie for the wild, and a balalaika for
 * the scatter, whose silhouette is the most distinctive thing on the reel.
 *
 * The genie is drawn as the folklore djinn, not as any named character. The archetype
 * is common property; a specific literary creation from 1938 is somebody's copyright.
 */
const RUSSIAN = {
  T: () => lacquerRank('10', 'url(#sgBirch)'),
  J: () => lacquerRank('J', 'url(#sgBirch)'),
  Q: () => lacquerRank('Q', 'url(#sgKhokhRed)'),
  K: () => lacquerRank('K', 'url(#sgKhokhRed)'),
  A: () => lacquerRank('A', 'url(#sgGold)'),

  // mid value: a bowl of kasha with a wooden spoon
  BELL: () => wrap(`
    <ellipse cx="50" cy="54" rx="44" ry="44" fill="url(#sgRusHalo)"/>
    <path d="M74 30c7 0 11 6 8 12s-11 7-14 2 0-14 6-14z" fill="#a9772f" stroke="#4d3314" stroke-width="1.8"/>
    <path d="M70 44L58 70" stroke="#a9772f" stroke-width="5" stroke-linecap="round"/>
    <path d="M18 54h64c0 16-14 26-32 26S18 70 18 54z"
          fill="url(#sgKhokhRed)" stroke="#5d0c08" stroke-width="2.5" stroke-linejoin="round"/>
    <ellipse cx="50" cy="54" rx="32" ry="9" fill="#f2e2be" stroke="#b39b6a" stroke-width="2"/>
    <ellipse cx="42" cy="53" rx="5" ry="3" fill="#d8c399"/>
    <ellipse cx="58" cy="55" rx="6" ry="3" fill="#d8c399"/>
    <ellipse cx="50" cy="50" rx="4" ry="2.4" fill="#e8d9b4"/>
    <path d="M24 64h52" stroke="url(#sgGold)" stroke-width="2" stroke-opacity=".75"/>
  `),

  // high value: painted eggs in a nest
  GEM: () => wrap(`
    <ellipse cx="50" cy="52" rx="44" ry="44" fill="url(#sgRusHalo)"/>
    <path d="M14 72c6-10 22-14 36-14s30 4 36 14c-8 10-22 14-36 14s-28-4-36-14z"
          fill="#6b4a22" stroke="#3e2a12" stroke-width="2"/>
    <ellipse cx="36" cy="52" rx="13" ry="17" fill="url(#sgKhokhRed)" stroke="#5d0c08" stroke-width="2"/>
    <ellipse cx="64" cy="50" rx="13" ry="17" fill="url(#sgGold)" stroke="#6d5520" stroke-width="2"/>
    <path d="M28 52h16M30 45h12M30 59h12" stroke="#ffd9a1" stroke-width="1.8" stroke-opacity=".8" stroke-linecap="round"/>
    <path d="M56 50h16M58 43h12M58 57h12" stroke="#7d5514" stroke-width="1.8" stroke-opacity=".7" stroke-linecap="round"/>
    <ellipse cx="32" cy="45" rx="3" ry="4" fill="#ffffff" fill-opacity=".45"/>
  `),

  // top value: vodka and a shot glass
  CROWN: () => wrap(`
    <ellipse cx="50" cy="52" rx="44" ry="44" fill="url(#sgRusHalo)"/>
    <rect x="28" y="34" width="26" height="52" rx="5" fill="url(#sgGlass)" stroke="#5c7f90" stroke-width="2"/>
    <rect x="36" y="14" width="10" height="22" rx="2" fill="url(#sgGlass)" stroke="#5c7f90" stroke-width="2"/>
    <rect x="34" y="10" width="14" height="7" rx="2" fill="url(#sgKhokhRed)" stroke="#5d0c08" stroke-width="1.5"/>
    <rect x="30" y="46" width="22" height="20" rx="2" fill="url(#sgKhokhRed)" stroke="#5d0c08" stroke-width="1.5"/>
    <path d="M34 52h14M34 58h10" stroke="#ffd9a1" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M62 56h20l-3 20c-.5 4-3 6-7 6s-6.5-2-7-6z"
          fill="url(#sgGlass)" stroke="#5c7f90" stroke-width="2" stroke-linejoin="round"/>
    <path d="M64 64h16l-2 12c-.3 2.5-2 4-6 4s-5.7-1.5-6-4z" fill="#dff0fa" fill-opacity=".85"/>
    <ellipse cx="72" cy="56" rx="10" ry="2.6" fill="#ffffff" fill-opacity=".5"/>
  `),

  // wild: an old bearded genie rising out of the lamp.
  // Drawn as the folklore djinn rather than any named character: the archetype is
  // common property, a specific literary creation from 1938 is not.
  WILD: () => wrap(`
    <ellipse cx="50" cy="50" rx="46" ry="46" fill="url(#sgRusHalo)"/>
    <path d="M18 84q8-10 22-10h20q14 0 22 10z" fill="url(#sgBrass)" stroke="#5c3f10" stroke-width="2"/>
    <path d="M70 76q14-2 16-10" fill="none" stroke="url(#sgBrass)" stroke-width="4" stroke-linecap="round"/>
    <path d="M34 74q-4-16 6-24t20 0q10 8 6 24z" fill="#cfd8e6" fill-opacity=".22"/>
    <circle cx="50" cy="34" r="13" fill="url(#sgBirch)" stroke="#6d4f22" stroke-width="2"/>
    <path d="M37 32q-3-14 13-14t13 14q-4-7-13-7t-13 7z" fill="url(#sgKhokhRed)" stroke="#5d0c08" stroke-width="1.8"/>
    <circle cx="50" cy="17" r="3.5" fill="url(#sgGold)"/>
    <circle cx="45" cy="33" r="1.9" fill="#2a1a10"/>
    <circle cx="55" cy="33" r="1.9" fill="#2a1a10"/>
    <path d="M38 42q12 26 24 0q-2 20-12 22t-12-22z" fill="#eef3f8" stroke="#9fb0c2" stroke-width="1.6"/>
    <path d="M44 48q6 6 12 0" fill="none" stroke="#9fb0c2" stroke-width="1.4"/>
    <path d="M30 24q-8-4-10-10M70 24q8-4 10-10" stroke="url(#sgGold)" stroke-width="2" stroke-linecap="round" stroke-opacity=".7"/>
  `),

  // scatter: the balalaika, the most recognisable silhouette on the reel
  SCAT: () => wrap(`
    <ellipse cx="50" cy="50" rx="46" ry="46" fill="url(#sgRusHalo)"/>
    <path d="M50 44L22 90h56z" fill="url(#sgBirch)" stroke="#6d4f22" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="50" cy="74" r="8" fill="#41240d"/>
    <rect x="46" y="12" width="8" height="34" rx="2" fill="#7a5322" stroke="#4a3013" stroke-width="1.8"/>
    <rect x="42" y="6" width="16" height="10" rx="3" fill="url(#sgGold)" stroke="#6d5520" stroke-width="1.8"/>
    <g stroke="#3a2a12" stroke-width="1.1" stroke-opacity=".85">
      <path d="M47 16v58"/><path d="M50 16v58"/><path d="M53 16v58"/>
    </g>
    <path d="M30 84h40" stroke="url(#sgKhokhRed)" stroke-width="3" stroke-linecap="round"/>
    <path d="M36 62c6-4 22-4 28 0" fill="none" stroke="url(#sgKhokhRed)" stroke-width="2" stroke-opacity=".8"/>
  `),
};

/** A card rank painted on a lacquered wooden plaque. */
function lacquerRank(letter, fill) {
  return wrap(`
    <rect x="14" y="12" width="72" height="76" rx="10"
          fill="#18100c" stroke="#5d3a18" stroke-width="2"/>
    <rect x="19" y="17" width="62" height="66" rx="7" fill="none"
          stroke="url(#sgGold)" stroke-width="1.6" stroke-opacity=".65"/>
    <path d="M24 24q10 8 0 16M76 24q-10 8 0 16M24 76q10-8 0-16M76 76q-10-8 0-16"
          fill="none" stroke="url(#sgKhokhRed)" stroke-width="2" stroke-opacity=".75"/>
    <text x="50" y="64" text-anchor="middle"
          font-family="Hoefler Text, Baskerville, Georgia, serif"
          font-size="${letter.length > 1 ? 36 : 44}" font-weight="700" fill="${fill}">${letter}</text>`);
}


/** A cigarette-card rank: plain board stock, a hairline rule, a serif letter. */
function smokeRank(letter, fill) {
  return wrap(`
    <rect x="14" y="12" width="72" height="76" rx="6" fill="#14161a" stroke="#3a4048" stroke-width="2"/>
    <rect x="19" y="17" width="62" height="66" rx="3" fill="none" stroke="#5a626d" stroke-width="1"/>
    <text x="50" y="64" text-anchor="middle"
          font-family="Hoefler Text, Baskerville, Georgia, serif"
          font-size="${letter.length > 1 ? 36 : 44}" font-weight="700" fill="${fill}">${letter}</text>`);
}

/**
 * Knife and Smoke.
 *
 * A hard-luck story told in objects: the last cigarette, the glass that went with it, the
 * ring that is still on, the knife, and the person at home who does not know yet. It is
 * noir iconography, which is to say it is about consequences.
 */
const NOIR = {
  T: () => smokeRank('10', 'url(#sgSmoke)'),
  J: () => smokeRank('J', 'url(#sgSmoke)'),
  Q: () => smokeRank('Q', 'url(#sgSilver)'),
  K: () => smokeRank('K', 'url(#sgSilver)'),
  A: () => smokeRank('A', 'url(#sgGold)'),

  // mid value: a cigarette burning down, which is the whole theme in one object
  BELL: () => wrap(`
    <path d="M14 52c-8-9 7-11 0-21s9-12 2-20" fill="none" stroke="url(#sgSmoke)"
          stroke-width="3" stroke-linecap="round" opacity=".55"/>
    <path d="M26 50c-7-8 6-10 0-18" fill="none" stroke="url(#sgSmoke)"
          stroke-width="2.4" stroke-linecap="round" opacity=".35"/>
    <rect x="18" y="60" width="48" height="11" rx="3" fill="#efe7d6" stroke="#b6ad98" stroke-width="1.6"/>
    <rect x="62" y="60" width="18" height="11" rx="3" fill="#c98b4a" stroke="#8a5b28" stroke-width="1.6"/>
    <path d="M66 60v11M71 60v11M76 60v11" stroke="#8a5b28" stroke-width="1" opacity=".5"/>
    <circle cx="19" cy="65.5" r="5" fill="#ff7a3c"/>
    <circle cx="19" cy="65.5" r="2.4" fill="#ffd9a8"/>
  `),

  // high value: the glass it was smoked over
  GEM: () => wrap(`
    <ellipse cx="50" cy="50" rx="42" ry="42" fill="url(#sgLamp)"/>
    <path d="M30 30h40l-5 50H35z" fill="rgba(210,228,245,.14)"
          stroke="url(#sgSteel)" stroke-width="2" stroke-linejoin="round"/>
    <path d="M33 50h34l-3 28H36z" fill="url(#sgWhisky)"/>
    <path d="M33 50h34l-1 6H34z" fill="#f4c877" opacity=".7"/>
    <rect x="40" y="53" width="13" height="11" rx="2" fill="#dceaf5" opacity=".55"
          transform="rotate(-12 46 58)"/>
    <path d="M35 34v42" stroke="#ffffff" stroke-width="2" opacity=".28"/>
    <ellipse cx="50" cy="82" rx="18" ry="3" fill="#000" opacity=".45"/>
  `),

  // higher value: the ring, still worn
  CROWN: () => wrap(`
    <ellipse cx="50" cy="58" rx="42" ry="42" fill="url(#sgLamp)"/>
    <ellipse cx="50" cy="60" rx="22" ry="22" fill="none" stroke="url(#sgGold)" stroke-width="7"/>
    <ellipse cx="50" cy="60" rx="22" ry="22" fill="none" stroke="#6b5220" stroke-width="1.4"/>
    <path d="M50 20l7 11-7 9-7-9z" fill="url(#sgSilver)" stroke="#7d8793" stroke-width="1.4"/>
    <path d="M43 31h14" stroke="#ffffff" stroke-width="1.2" opacity=".6"/>
    <path d="M36 48a20 20 0 0 1 12-9" fill="none" stroke="#fff6dc" stroke-width="2" opacity=".5"/>
  `),

  // wild: the switchblade
  WILD: () => wrap(`
    <path d="M46 62 L88 44 L90 54 L48 72 Z" fill="url(#sgSteel)" stroke="#5c6672" stroke-width="1.6"/>
    <path d="M48 66 L86 50" stroke="#ffffff" stroke-width="1.4" opacity=".55"/>
    <rect x="12" y="58" width="38" height="14" rx="6" fill="#23262b" stroke="#585d66" stroke-width="2"/>
    <circle cx="21" cy="65" r="2.4" fill="#8b929c"/>
    <circle cx="41" cy="65" r="2.4" fill="#8b929c"/>
    <path d="M27 58v14" stroke="#3a3e45" stroke-width="1.2"/>
    <text x="50" y="30" text-anchor="middle" font-family="Hoefler Text, Georgia, serif"
          font-size="19" font-weight="700" fill="url(#sgSilver)" letter-spacing="3">WILD</text>
  `),

  // scatter: someone waiting up, and the reason the rest of it matters.
  //
  // Drawn in profile and lit from behind, because a silhouette says it without the symbol
  // needing to be a picture of a person. The bright pane is doing the work: the figure was
  // a dark shape on a dark window before, and read as nothing at all.
  SCATTER: () => wrap(`
    <rect x="16" y="12" width="68" height="76" rx="4" fill="#0e1117" stroke="#3b434e" stroke-width="2"/>
    <rect x="22" y="18" width="56" height="50" rx="2" fill="#40538c"/>
    <rect x="22" y="18" width="56" height="50" rx="2" fill="url(#sgLamp)"/>
    <path d="M50 18v50M22 43h56" stroke="#20262f" stroke-width="3"/>
    <circle cx="46" cy="37" r="9.5" fill="#0c0e13"/>
    <path d="M55 32a5 5 0 1 1-.1 0z" fill="#0c0e13"/>
    <path d="M52 45c6 8 7 20 6 33H34c-7-10-6-24 4-33z" fill="#0c0e13"/>
    <path d="M44 55c-5 3-9 9-9 16" fill="none" stroke="#0c0e13"
          stroke-width="5" stroke-linecap="round"/>
    <rect x="22" y="68" width="56" height="4" fill="#4a525d"/>
    <path d="M22 72h56" stroke="#2a3038" stroke-width="2"/>
  `),
};

/** A tarot-ish rank: night blue, a star in each corner. */
function couchRank(letter, fill) {
  return wrap(`
    <rect x="14" y="12" width="72" height="76" rx="8" fill="#0d1120" stroke="#2f3a63" stroke-width="2"/>
    <rect x="19" y="17" width="62" height="66" rx="5" fill="none" stroke="url(#sgNight)" stroke-width="1.6"/>
    <path d="M25 24l1.6 3.4 3.4 1.6-3.4 1.6L25 34l-1.6-3.4L20 29l3.4-1.6z" fill="#8fa6e8" opacity=".8"/>
    <path d="M75 66l1.6 3.4L80 71l-3.4 1.6L75 76l-1.6-3.4L70 71l3.4-1.6z" fill="#8fa6e8" opacity=".8"/>
    <text x="50" y="64" text-anchor="middle"
          font-family="Hoefler Text, Baskerville, Georgia, serif"
          font-size="${letter.length > 1 ? 36 : 44}" font-weight="700" fill="${fill}">${letter}</text>`);
}

/**
 * The Couch.
 *
 * Drink, cards, the zodiac and the consulting room: four different ways of being told what
 * is going to happen to you, none of which is any better than the others at it. That joke
 * is the theme, and a casino is a reasonable place to make it.
 */
const COUCH = {
  T: () => couchRank('10', 'url(#sgSilver)'),
  J: () => couchRank('J', 'url(#sgSilver)'),
  Q: () => couchRank('Q', 'url(#sgNight)'),
  K: () => couchRank('K', 'url(#sgNight)'),
  A: () => couchRank('A', 'url(#sgGold)'),

  // mid value: the bottle and the glass beside it
  BELL: () => wrap(`
    <ellipse cx="50" cy="52" rx="42" ry="42" fill="url(#sgStarField)"/>
    <path d="M40 18h12v14l7 12v38a4 4 0 0 1-4 4H37a4 4 0 0 1-4-4V44l7-12z"
          fill="url(#sgAmberGlass)" stroke="#5c3510" stroke-width="2" stroke-linejoin="round"/>
    <rect x="38" y="14" width="16" height="7" rx="2" fill="#3a2a16" stroke="#6b5027" stroke-width="1.4"/>
    <rect x="35" y="54" width="22" height="18" rx="2" fill="#f0e4c8" stroke="#a89572" stroke-width="1.4"/>
    <path d="M39 60h14M39 65h10" stroke="#8a7a58" stroke-width="1.4"/>
    <path d="M66 58h16l-2 24H68z" fill="rgba(220,235,250,.18)" stroke="#9fb1c4" stroke-width="1.6"/>
    <path d="M67 70h14l-1 11H68z" fill="url(#sgWhisky)"/>
  `),

  // high value: a zodiac wheel, which is a paytable with better marketing
  GEM: () => wrap(`
    <ellipse cx="50" cy="50" rx="42" ry="42" fill="url(#sgStarField)"/>
    <circle cx="50" cy="50" r="34" fill="#0c1024" stroke="url(#sgGold)" stroke-width="2"/>
    <circle cx="50" cy="50" r="24" fill="none" stroke="url(#sgNight)" stroke-width="1.6"/>
    <circle cx="50" cy="50" r="9" fill="none" stroke="url(#sgGold)" stroke-width="1.6"/>
    <path d="M50 16v68M16 50h68M26 26l48 48M74 26L26 74" stroke="url(#sgGold)"
          stroke-width="1.1" opacity=".5"/>
    <circle cx="50" cy="26" r="2.6" fill="#ffe6a6"/>
    <circle cx="74" cy="50" r="2.6" fill="#ffe6a6"/>
    <circle cx="50" cy="74" r="2.6" fill="#ffe6a6"/>
    <circle cx="26" cy="50" r="2.6" fill="#ffe6a6"/>
    <circle cx="50" cy="50" r="3.4" fill="url(#sgGold)"/>
  `),

  // higher value: the moon everything is blamed on
  CROWN: () => wrap(`
    <ellipse cx="50" cy="50" rx="42" ry="42" fill="url(#sgStarField)"/>
    <path d="M62 20a32 32 0 1 0 0 60 26 26 0 0 1 0-60z" fill="url(#sgSilver)"/>
    <circle cx="44" cy="38" r="4" fill="#b9c2d0" opacity=".5"/>
    <circle cx="38" cy="56" r="5.5" fill="#b9c2d0" opacity=".4"/>
    <circle cx="50" cy="64" r="3" fill="#b9c2d0" opacity=".45"/>
    <path d="M76 26l2 4.6 4.6 2-4.6 2L76 39l-2-4.4-4.6-2 4.6-2z" fill="#ffe6a6"/>
    <path d="M22 62l1.6 3.4L27 67l-3.4 1.6L22 72l-1.6-3.4L17 67l3.4-1.6z" fill="#ffe6a6" opacity=".8"/>
  `),

  // wild: an inkblot, which is whatever you decide it is, which is the point
  WILD: () => wrap(`
    <g fill="url(#sgBlot)" stroke="#1b2133" stroke-width="1.2">
      <path d="M50 16c6 0 9 6 8 12s-6 9-4 14 9 5 12 11-1 13-6 16-12 1-14 6-1 9-1 9h-5z"/>
      <path d="M50 16c-6 0-9 6-8 12s6 9 4 14-9 5-12 11 1 13 6 16 12 1 14 6 1 9 1 9h5z"/>
      <ellipse cx="30" cy="46" rx="6" ry="4.5" transform="rotate(-25 30 46)"/>
      <ellipse cx="70" cy="46" rx="6" ry="4.5" transform="rotate(25 70 46)"/>
      <circle cx="24" cy="66" r="3"/>
      <circle cx="76" cy="66" r="3"/>
    </g>
    <path d="M50 16v68" stroke="#0a0d16" stroke-width="0.8" opacity=".35"/>
    <text x="50" y="96" text-anchor="middle" font-family="Hoefler Text, Georgia, serif"
          font-size="13" font-weight="700" fill="url(#sgSilver)" letter-spacing="3">WILD</text>
  `),

  // scatter: the prescription that follows the consultation
  SCATTER: () => wrap(`
    <ellipse cx="50" cy="52" rx="42" ry="42" fill="url(#sgStarField)"/>
    <rect x="32" y="16" width="30" height="10" rx="3" fill="#dfe6ee" stroke="#9aa6b5" stroke-width="1.6"/>
    <rect x="34" y="26" width="26" height="46" rx="4" fill="url(#sgAmberGlass)"
          stroke="#5c3510" stroke-width="2"/>
    <rect x="38" y="36" width="18" height="22" rx="2" fill="#f2ecdd" opacity=".9"/>
    <path d="M45 40v6h-5v4h5v6h4v-6h5v-4h-5v-6z" fill="#b03c3c"/>
    <ellipse cx="72" cy="70" rx="9" ry="6" fill="#eef2f7" stroke="#9aa6b5" stroke-width="1.4"
             transform="rotate(-18 72 70)"/>
    <path d="M65 71.5a9 6 0 0 0 14-3" fill="none" stroke="#9aa6b5" stroke-width="1.4"
          transform="rotate(-18 72 70)"/>
    <ellipse cx="24" cy="76" rx="9" ry="6" fill="#dbe6f2" stroke="#9aa6b5" stroke-width="1.4"
             transform="rotate(14 24 76)"/>
  `),
};

/**
 * A machine whose symbols are rendered images rather than drawings.
 *
 * The five above are vector artwork and stay exactly as they are. This one is different
 * in kind: the symbols are photographs of renders, made on the GPU in this machine and
 * served from public/symbols/rendered. It is a sixth machine, not a replacement — the
 * maths, paytable and RTP are identical to every other, as they are between all of them.
 *
 * There is no drawing function here because there is nothing to draw. Callers ask
 * symbolImage() for a URL and put it on the page or on a drum themselves.
 */
const RENDERED_KEYS = ['T', 'J', 'Q', 'K', 'A', 'BELL', 'GEM', 'CROWN', 'WILD', 'SCAT'];

/** Where a rendered symbol lives, or null for a theme that is drawn rather than rendered. */
export function symbolImage(key, theme = 'classic') {
  if (theme !== 'rendered') return null;
  return RENDERED_KEYS.includes(key) ? `/symbols/rendered/${key}.jpg` : null;
}

/** True for a theme whose symbols are images. */
export const isRenderedTheme = (theme) => theme === 'rendered';

const THEMES = {
  classic: CLASSIC, afterdark: AFTER_DARK, russian: RUSSIAN, noir: NOIR, couch: COUCH,
  // Falls back to the classic drawings anywhere that has not been taught about images,
  // so a missing branch degrades to a working machine rather than a blank one.
  rendered: CLASSIC,
};

export const THEME_KEYS = Object.keys(THEMES);

/** SVG markup for one symbol in the chosen theme; falls back to the key if unknown. */
export function symbolSvg(key, theme = 'classic') {
  const set = THEMES[theme] || CLASSIC;
  const make = set[key] || CLASSIC[key];
  return make ? make() : `<span>${key}</span>`;
}

/**
 * The same symbol, but carrying its own gradients.
 *
 * On the page the symbols reference the shared defs that ensureSymbolDefs() puts in the
 * document, which is right: one copy for the whole site. Inside an `<img src="data:...">`
 * there is no document to share — the SVG is its own isolated one — so every `url(#...)`
 * fill resolves to nothing and only the flat strokes survive. That is what a slot reel
 * drawn into a WebGL texture looked like: panels with outlines and no symbols on them.
 *
 * The artwork is untouched. This wraps a copy of the defs around it for the callers that
 * need to rasterise one on its own.
 */
export function symbolSvgStandalone(key, theme = 'classic') {
  const svg = symbolSvg(key, theme);
  const at = svg.indexOf('>');
  if (at < 0 || !svg.startsWith('<svg')) return svg;
  return `${svg.slice(0, at + 1)}${DEFS}${svg.slice(at + 1)}`;
}

export const SYMBOL_KEYS = Object.keys(CLASSIC);
