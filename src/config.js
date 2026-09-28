'use strict';
// Configuration. Every knob that decides whether the house makes money lives here.
// Values can be overridden by config.json (git-ignored) or CASINO_* env vars.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  // ---- server
  port: 8787,
  host: '127.0.0.1',
  publicUrl: 'http://localhost:8787',
  trustProxy: false,          // turn on ONLY behind nginx/caddy that sets X-Forwarded-For
  secureCookies: false,       // turn on when served over HTTPS
  dbFile: 'data/casino.db',

  // ---- branding
  siteName: 'Nullstake',
  // There is no site credit any more. The only money is the tugrik, whose ticker lives
  // in token.symbol below, and the only starting balance is token.welcomeGrant, paid out
  // of the treasury when a new account's wallet is created.
  defaultLocale: 'en',        // 'en' or 'ru'; players can switch and the choice sticks

  // ---- THE MARGIN ------------------------------------------------------
  // houseEdge is the theoretical hold per unit wagered. 0.01 = 1%.
  // Expected gross gaming revenue = totalWagered * houseEdge.
  // Raise it for more margin per bet, lower it to compete on price.
  houseEdge: {
    dice: 0.01,
    limbo: 0.01,
    crash: 0.01,
    mines: 0.01,
    // Slots run a wider edge than the originals because that is the market norm and
    // because their variance is far higher; 0.03 means a 97% return to player.
    slots: 0.03,
    // The jigsaw is pure SKILL — there is no chance in it at all, so unlike every other
    // game here the edge is not a mathematical property of the payout table. It is the
    // gap between the par time and how fast people actually are. Set wide for the same
    // reason Preferans is: someone much faster than par takes the full multiple every
    // round, and the entry fee is the only thing that makes that cost them anything.
    // Watch the per-game hold rather than trusting this number.
    jigsaw: 0.05,
    // Preferans is a game of SKILL, so this edge is not guaranteed the way the others
    // are. It is calibrated against the bot's own play: a player who plays better than
    // the bot erodes it, a weaker one loses more. Keep it wide to absorb that, and watch
    // the per-game hold in the admin panel.
    preferans: 0.05,
    // Debertz is skill-dependent for the same reason Preferans is, and the chooser wins
    // about four hands in five, so the edge is wide to absorb a player who is better
    // than the bot the payouts were priced against.
    debertz: 0.05,
  },

  // ---- RISK CONTROL ----------------------------------------------------
  // The house edge only pays out if the bankroll survives variance.
  // maxProfitFraction caps the biggest single win at a fraction of bankroll,
  // which is what actually stops one lucky player from busting the site.
  risk: {
    bankrollRiskFraction: 0.01, // one bet may never win more than 1% of bankroll
    maxBetUnits: 50 * 100000000, // hard ceiling per bet, regardless of bankroll
    minBetUnits: 1000,           // 0.00001 credit
    maxMultiplier: 10000,        // cap on limbo/crash multipliers
  },

  // ---- LOGGING ----------------------------------------------------------
  // quiet  only server faults, which is what a production log should be
  // info   every refused request too: method, path, status and the reason
  // debug  every request, with timing
  //
  // Refused requests are the ones worth seeing while building. A 400 is the server
  // telling a client it did something wrong, and with no log of it the only evidence is
  // a message in a browser that may already be gone. Override with CASINO_LOG.
  logLevel: 'info',

  // ---- SITE TOKEN -------------------------------------------------------
  // A hash-linked, signed ledger that any player can verify in their browser. Balances
  // are controlled by keys derived from a word phrase the player holds, so the operator
  // cannot move someone else's tokens. See src/tokenchain.js for what this does and,
  // just as importantly, what it does not do.
  token: {
    enabled: true,
    // The tugrik. Named after the Mongolian togrog, which Russian speakers have used as a
    // joking word for money for decades. Nothing by this name is listed as a crypto asset,
    // so the ticker is free; the ISO code MNT and the togrog sign are not, and are not used
    // here, because this is a play token and must never be mistaken for a national currency.
    symbol: 'TUG',
    name: 'Tugrik',

    // A tugrik is divisible to eight places, the same as everything else here and the
    // same as a bitcoin. Every figure below is in those hundred-millionths.
    //
    // It has to be divisible or it cannot be staked: a one-tugrik bet at 1.98x pays 1.98
    // tugriks, and a currency that can only hold whole numbers would have to round that,
    // which is a house edge nobody agreed to on top of the one that is published.
    decimals: 8,

    // THE SUPPLY IS FIXED at 21,000,000 tugriks. Every one of them is minted once, into
    // the treasury, in the genesis block. Nothing afterwards creates any: a welcome grant
    // is a transfer out of the treasury, not a mint, and the chain verifier refuses a mint
    // in any block but the first. That makes the cap something a player can check by
    // replaying the chain rather than something the operator promises.
    //
    // Changing this number on a chain that already exists does nothing. The genesis block
    // is signed and hashed, and every later block links to it, so the supply is settled
    // the first time the server starts and cannot be revised afterwards.
    maxSupply: 21000000 * 100000000,

    // Paid out of the treasury to each new wallet, first come first served. When the
    // treasury runs dry the grants stop; they do not resume by inventing more.
    welcomeGrant: 1000 * 100000000,

    // Staking tugriks on the ordinary casino games. The house pays wins out of what it
    // holds, so the real ceiling is its own balance rather than a number set here.
    bet: { min: 1 * 100000000, max: 2000 * 100000000 },
  },

  // ---- ARCADE -----------------------------------------------------------
  // A token-operated game room. Plays cost site tokens and pay nothing back: the games
  // run in the browser, so a score can never be trusted with money attached. Revenue is
  // the token sale, which is how the arcades this imitates actually earned.
  arcade: {
    enabled: true,
    tokenCost: 10 * 100000000,   // tugriks burned per play, in hundred-millionths
    playTtlSeconds: 7200,   // an open play older than this is a stale tab, not a long game
  },

  // ---- MATCHES ----------------------------------------------------------
  // Head-to-head games played for tokens. Unlike the arcade, these can pay out, because
  // the server holds the board and checks every move: the result is not a number the
  // player's machine reported. The rake is the operator's cut of the pot and is the only
  // place the house takes anything, so it is the number to tune.
  match: {
    enabled: true,
    rake: 0.05,             // taken once from the pot, on every settled match
    minStake: 10 * 100000000,
    maxStake: 5000 * 100000000,
    maxOpenPerUser: 3,      // stops one account papering the lobby with challenges
    // How long a game that has to be set up (placing a fleet) waits before the player who
    // did turn up can claim it. Without a deadline an absent player holds both stakes.
    setupSeconds: 180,
    // A challenge nobody accepts is cancelled and every stake refunded after this long.
    // Without it the stake sits in escrow until the host remembers to come back and press
    // cancel, which is to say for ever.
    openExpirySeconds: 24 * 3600,
    // How long a game sits with nobody moving before the server settles it unasked.
    //
    // Claiming a timeout is the players' job and this does not replace it: the clock
    // decides the result either way. This is for the case where there is nobody left to
    // claim, because every side closed the tab, and the stakes would otherwise be held
    // for ever. It is deliberately far longer than any clock, so a live game is never
    // touched by it.
    abandonSeconds: 3600,
    // How often the server records that it is alive. On the next start the gap since the
    // last one is the outage, and every match clock gets that time back — otherwise a
    // deploy charges whoever was on the clock for it, and a long enough outage would
    // have the sweeper end every game in progress at once.
    heartbeatSeconds: 15,
  },

  // ---- CRASH ROUND PACING ----------------------------------------------
  // Round length is a direct revenue lever: revenue is volume times edge, and volume is
  // rounds per hour times stake. Shorter betting windows mean more rounds, but too short
  // and players cannot place a bet in time. `growth` only controls how fast the
  // multiplier climbs in real time; it does NOT change the crash-point distribution,
  // which comes from the fairness engine.
  crash: {
    bettingMs: 7000,
    endedMs: 4000,
    tickMs: 100,
    growth: 0.07,      // e^(0.07t): 2x at about 10s, 10x at about 33s
    chainLength: 10000, // rounds per published commitment
  },

  // ---- GROWTH LEVERS ---------------------------------------------------
  // Referrals are the cheapest acquisition channel a small site has.
  // Commission is paid from house edge, so it is never a loss-maker:
  // keep referralCommission well below 1.0 or you give the margin away.
  // Both of these pay out of the house edge into a *credit* balance, and there is no
  // credit balance any more. Paying them in tugriks would mean extra chain blocks per bet
  // for an acquisition mechanic a non-commercial site does not need, so they are switched
  // off rather than removed: `payCommissions` becomes a no-op, and turning them back on —
  // in tugriks — stays a small change rather than a rewrite.
  referralCommission: 0,
  rakeback: {
    enabled: false,
    rate: 0.05,                 // share of the edge, if it is ever switched back on
  },

  // ---- responsible gambling (also keeps you out of trouble)
  limits: {
    selfExclusionMaxDays: 365,
    minAgeConfirmed: true,
  },

  // ---- JURISDICTION CONTROL --------------------------------------------
  // Which countries may reach the site. Enforced only in production (see
  // productionOnly) and never for loopback or private addresses, so local
  // development and health checks are unaffected.
  //
  //   mode 'allow' -> ONLY the countries listed below can reach the site
  //   mode 'deny'  -> the countries listed below are refused, everyone else is allowed
  //   mode 'off'   -> no filtering at all
  //
  // `countries` is intentionally empty: set it to the ISO-3166 alpha-2 codes your
  // licence actually covers. Country detection needs either a trusted proxy header
  // (Cloudflare sets CF-IPCountry; nginx GeoIP2 can set one) with trustProxy on, or a
  // local CIDR table in rangesFile. With neither, nothing can be resolved and every
  // request falls through to onUnknown.
  //
  // Set onUnknown to 'deny' if the restriction is meant to hold: an address you cannot
  // place is the simplest way around a filter (a VPN or proxy looks exactly like this).
  geo: {
    enabled: false,
    productionOnly: true,
    mode: 'off',
    countries: [],
    countryHeader: 'cf-ipcountry',
    rangesFile: 'data/geo-ranges.txt',
    onUnknown: 'allow',
    bypassPrivate: true,
  },

  // ---- security
  sessionTtlSec: 60 * 60 * 24 * 7,
  adminToken: '',               // generated on first run if empty
  rateLimits: {
    // route-prefix -> [max requests, window seconds]
    '/api/auth': [20, 60],
    '/api/bet': [300, 60],
    '/api/wallet': [30, 60],
    default: [600, 60],
  },
};

function deepMerge(base, extra) {
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) return extra ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = k in out && typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k])
      ? deepMerge(out[k], v)
      : v;
  }
  return out;
}

function load() {
  let cfg = structuredClone(DEFAULTS);
  const file = path.join(ROOT, 'config.json');
  if (fs.existsSync(file)) {
    try {
      cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      throw new Error(`config.json is not valid JSON: ${e.message}`);
    }
  }
  // Env overrides for the handful that matter in deployment.
  if (process.env.CASINO_PORT) cfg.port = Number(process.env.CASINO_PORT);
  if (process.env.CASINO_HOST) cfg.host = process.env.CASINO_HOST;
  if (process.env.CASINO_PUBLIC_URL) cfg.publicUrl = process.env.CASINO_PUBLIC_URL;
  if (process.env.CASINO_ADMIN_TOKEN) cfg.adminToken = process.env.CASINO_ADMIN_TOKEN;
  if (process.env.CASINO_DB) cfg.dbFile = process.env.CASINO_DB;
  if (process.env.CASINO_LOG) cfg.logLevel = String(process.env.CASINO_LOG).toLowerCase();
  if (process.env.CASINO_TRUST_PROXY) cfg.trustProxy = process.env.CASINO_TRUST_PROXY === '1';
  if (process.env.CASINO_SECURE_COOKIES) cfg.secureCookies = process.env.CASINO_SECURE_COOKIES === '1';

  validate(cfg);
  cfg.root = ROOT;
  cfg.dbPath = path.isAbsolute(cfg.dbFile) ? cfg.dbFile : path.join(ROOT, cfg.dbFile);
  // Where optional data files live, next to the database. The Балда dictionary is read
  // from here if the operator has supplied a bigger one than the built-in list.
  cfg.dataDir = path.dirname(cfg.dbPath);
  return cfg;
}

function validate(cfg) {
  for (const [game, edge] of Object.entries(cfg.houseEdge)) {
    if (!(edge >= 0 && edge < 0.5)) throw new Error(`houseEdge.${game} must be in [0, 0.5)`);
  }
  const r = cfg.risk;
  if (!(r.bankrollRiskFraction > 0 && r.bankrollRiskFraction <= 1)) {
    throw new Error('risk.bankrollRiskFraction must be in (0, 1]');
  }
  if (r.minBetUnits < 1 || r.maxBetUnits < r.minBetUnits) throw new Error('bad bet bounds');
  if (cfg.referralCommission < 0 || cfg.referralCommission >= 1) {
    throw new Error('referralCommission must be in [0, 1)');
  }
  const g = cfg.geo || {};
  if (!['off', 'allow', 'deny'].includes(g.mode ?? 'off')) {
    throw new Error("geo.mode must be 'off', 'allow' or 'deny'");
  }
  if (!['allow', 'deny'].includes(g.onUnknown ?? 'allow')) {
    throw new Error("geo.onUnknown must be 'allow' or 'deny'");
  }
  for (const c of g.countries || []) {
    if (!/^[A-Za-z]{2}$/.test(String(c))) {
      throw new Error(`geo.countries must be ISO-3166 alpha-2 codes; got "${c}"`);
    }
  }
  if (g.enabled && g.mode !== 'off' && (g.countries || []).length === 0) {
    throw new Error('geo is enabled but geo.countries is empty; nothing would be matched');
  }

  const giveaway = cfg.referralCommission + (cfg.rakeback.enabled ? cfg.rakeback.rate : 0);
  if (giveaway >= 1) throw new Error('referralCommission + rakeback would give away the whole edge');
}

/** Write config.json, creating it from defaults if absent. Used to persist the admin token. */
function save(patch) {
  const file = path.join(ROOT, 'config.json');
  let current = {};
  if (fs.existsSync(file)) current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = deepMerge(current, patch);
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

module.exports = { load, save, DEFAULTS, deepMerge, ROOT };
