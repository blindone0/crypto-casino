'use strict';
// The client, checked without a browser.
//
// public/ is about ten thousand lines that no test had ever loaded, and it is where the
// two worst breakages of this project happened: a bad edit left every page blank, and a
// game added to the nav without a matching config entry printed "NaN%" at players.
//
// These are not behaviour tests — there is no DOM here and inventing one would be a test
// of the fake rather than of the site. They are the checks that would have caught those
// two bugs before anyone saw them: every file still parses, every translation key that is
// asked for exists in both languages, and every game listed in the client is actually
// known to the server it talks to.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(f, 'utf8');

/** Every .js the browser loads, whether from public/ or public/games/. */
function clientFiles() {
  const out = [];
  for (const dir of [PUBLIC, path.join(PUBLIC, 'games')]) {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.js')) out.push(path.join(dir, name));
    }
  }
  return out.sort();
}

const APP = read(path.join(PUBLIC, 'app.js'));
const I18N = read(path.join(PUBLIC, 'i18n.js'));

/**
 * The translation table, read as text rather than imported.
 *
 * These are ES modules inside a CommonJS package, so node cannot import them: the browser
 * decides that by the script tag, node by the extension, and they disagree. Reading the
 * source is the honest option, and for a flat table of literals it is enough.
 */
function strings() {
  const body = I18N.slice(I18N.indexOf('const STRINGS = {'));
  const entries = new Map();
  // Each entry starts at a two-space indented quoted key and runs to the next one.
  const starts = [...body.matchAll(/^ {2}'([a-zA-Z0-9.\-_]+)':/gm)];
  starts.forEach((m, i) => {
    const from = m.index;
    const to = i + 1 < starts.length ? starts[i + 1].index : body.length;
    entries.set(m[1], body.slice(from, to));
  });
  return entries;
}

const STRINGS = strings();

test('every client file still parses', () => {
  // The blank-page bug was valid-looking JavaScript that did not run, but its cousin --
  // an edit that leaves a file unparseable -- takes the whole site down just as silently,
  // because a module that fails to parse simply never executes.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-parse-'));
  try {
    for (const file of clientFiles()) {
      // .mjs so node parses it the way the browser does, as a module.
      const copy = path.join(tmp, `${path.basename(file, '.js')}.mjs`);
      fs.writeFileSync(copy, read(file));
      const res = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0,
        `${path.relative(PUBLIC, file)} does not parse:\n${res.stderr}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('every translation key that is asked for exists', () => {
  const missing = [];
  for (const file of clientFiles()) {
    const src = read(file);
    // Only files that take t() from the shared table. The board modules carry a small
    // label table of their own, so their t('fold') is not a key here; those get the
    // next test instead.
    if (/import \{[^}]*\bt\b[^}]*\} from '\.\/i18n\.js'/.test(src)) {
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9.\-_]+)'/g)) {
        // t('game.' + state.game) is a concatenation rather than a key. Its halves are
        // covered by the nav test, which walks the real game list.
        if (m[1].endsWith('.')) continue;
        if (!STRINGS.has(m[1])) missing.push(`${path.basename(file)}: ${m[1]}`);
      }
    }
    for (const m of src.matchAll(/'data-i18n(?:-ph|-title)?':\s*'([a-zA-Z0-9.\-_]+)'/g)) {
      if (!STRINGS.has(m[1])) missing.push(`${path.basename(file)}: ${m[1]} (data-i18n)`);
    }
  }
  assert.deepStrictEqual(missing, [], 'these keys are used but not translated');
});

test('every board that carries its own labels carries both languages', () => {
  // A board keeps its own labels rather than adding a dozen keys to the shared table. A
  // label present in one language and missing in the other renders as "undefined" on the
  // button, so the two sides have to hold exactly the same keys.
  const boards = clientFiles().filter((f) => /\blabels = \{/.test(read(f)));
  assert.ok(boards.length >= 3, 'the board modules were found');

  for (const file of boards) {
    const src = read(file);
    const body = src.slice(src.indexOf('labels = {'));
    const pick = (lang) => {
      const at = body.indexOf(`${lang}: {`);
      if (at < 0) return null;
      const close = body.indexOf('\n  },', at);
      return [...body.slice(at, close).matchAll(/(?:^|[{,\s])([a-zA-Z0-9_]+):/g)]
        .map((m) => m[1]).filter((k) => k !== lang);
    };
    const en = pick('en');
    const ru = pick('ru');
    const name = path.basename(file);
    assert.ok(en && ru, `${name}: labels needs both en and ru`);
    assert.deepStrictEqual(ru.slice().sort(), en.slice().sort(),
      `${name}: the two label tables do not hold the same keys`);
  }
});

test('every translation exists in both languages', () => {
  // A key with only English silently falls back, so a half-finished translation looks
  // fine to whoever added it and wrong to everyone reading the site in Russian.
  const half = [];
  for (const [key, body] of STRINGS) {
    if (!/\ben:/.test(body)) half.push(`${key} (no en)`);
    if (!/\bru:/.test(body)) half.push(`${key} (no ru)`);
  }
  assert.deepStrictEqual(half, []);
});

test('every game in the nav has a name and a price', () => {
  // This is the NaN% check. `match` was added to the nav without a houseEdge entry, so
  // the info panel multiplied undefined by 100 and showed players "NaN%".
  const list = APP.match(/^const GAMES = \[([^\]]+)\]/m);
  assert.ok(list, 'GAMES is declared in app.js');
  const games = [...list[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(games.length >= 8, 'the nav has games in it');

  const cfg = require('../src/config').load();

  // Games you play against the bankroll have an edge; the other two do not, and each of
  // those has its own panel that never looks the edge up.
  const NO_EDGE = { arcade: 'arcadeInfoPanel', match: 'matchInfoPanel' };
  for (const game of games) {
    assert.ok(STRINGS.has(`game.${game}`), `game.${game} has no name`);
    if (game in NO_EDGE) {
      assert.ok(APP.includes(`function ${NO_EDGE[game]}(`),
        `${game} takes no house edge, so it needs ${NO_EDGE[game]}`);
      assert.ok(!(game in cfg.houseEdge),
        `${game} has its own panel, so a houseEdge entry for it is dead config`);
    } else {
      assert.strictEqual(typeof cfg.houseEdge[game], 'number',
        `${game} is in the nav with no house edge, which renders as NaN%`);
    }
  }
});

test('every match game has a board, a name and a server', () => {
  const server = require('../src/match').GAMES;

  const map = APP.slice(APP.indexOf('const MATCH_BOARDS = {'));
  const boards = [...map.slice(0, map.indexOf('};')).matchAll(/(\w+): \(\) => import\('([^']+)'\)/g)];
  const byGame = new Map(boards.map((m) => [m[1], m[2]]));

  for (const key of Object.keys(server)) {
    assert.ok(byGame.has(key), `${key} is offered by the server with no board to play it on`);
    const file = path.join(PUBLIC, byGame.get(key).replace('./', ''));
    assert.ok(fs.existsSync(file), `${key}'s board ${byGame.get(key)} is not there`);
    assert.ok(STRINGS.has(`match.g.${key}`), `match.g.${key} has no name`);
  }
  for (const key of byGame.keys()) {
    assert.ok(key in server, `${key} has a board but the server does not offer it`);
  }
});

test('every arcade cabinet has a file behind it', () => {
  const map = APP.slice(APP.indexOf('pinball: () => import('));
  const cabs = [...map.slice(0, map.indexOf('};')).matchAll(/(\w+): \(\) => import\('([^']+)'\)/g)];
  assert.ok(cabs.length >= 3, 'the arcade has cabinets');
  for (const [, key, rel] of cabs) {
    assert.ok(fs.existsSync(path.join(PUBLIC, rel.replace('./', ''))), `${key}: ${rel} is missing`);
  }
});

test('nothing in the client reaches for a remote origin', () => {
  // The content security policy forbids it, so a stray URL is not a leak but it is a
  // feature that silently does nothing. Better to fail here than to wonder later.
  const allowed = /^(https?:\/\/(127\.0\.0\.1|localhost)|https?:\/\/www\.w3\.org)/;
  const bad = [];
  for (const file of clientFiles()) {
    for (const m of read(file).matchAll(/'(https?:\/\/[^']+)'/g)) {
      if (!allowed.test(m[1])) bad.push(`${path.basename(file)}: ${m[1]}`);
    }
  }
  assert.deepStrictEqual(bad, [], 'these would be blocked by the CSP at runtime');
});

// ------------------------------------------------------------- counted nouns
//
// The checks above read the client as text. These run a piece of it for real: i18n.js is
// copied to a .mjs so node will treat it as the module the browser already does, and the
// handful of browser globals it touches on the way in are stubbed.

let i18n;
test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-'));
  const copy = path.join(dir, 'i18n.mjs');
  fs.writeFileSync(copy, read(path.join(PUBLIC, 'i18n.js')));
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.document = {
    documentElement: {},
    querySelectorAll: () => [],
    dispatchEvent: () => {},
  };
  globalThis.CustomEvent = class { constructor(type, init) { Object.assign(this, init); } };
  i18n = await import(require('node:url').pathToFileURL(copy).href);
});

test('Russian agrees a noun with its number', () => {
  const ru = (n) => i18n.plural(n, 'players', 'ru');
  assert.strictEqual(ru(1), 'игрок');
  assert.strictEqual(ru(2), 'игрока');
  assert.strictEqual(ru(4), 'игрока');
  assert.strictEqual(ru(5), 'игроков');
  assert.strictEqual(ru(6), 'игроков');
  // The teens are the exception the rule is famous for: 11 is many, 21 is one.
  assert.strictEqual(ru(11), 'игроков');
  assert.strictEqual(ru(12), 'игроков');
  assert.strictEqual(ru(14), 'игроков');
  assert.strictEqual(ru(21), 'игрок');
  assert.strictEqual(ru(22), 'игрока');
  assert.strictEqual(ru(101), 'игрок');
  assert.strictEqual(ru(111), 'игроков');
  assert.strictEqual(ru(0), 'игроков');
});

test('English picks between two forms', () => {
  const en = (n) => i18n.plural(n, 'players', 'en');
  assert.strictEqual(en(1), 'player');
  assert.strictEqual(en(2), 'players');
  assert.strictEqual(en(0), 'players');
  assert.strictEqual(en(21), 'players');
});

test('the seat picker counts players in both languages', () => {
  // This is the bug: poker seats up to six, and the picker offered "5 игрока".
  i18n.setLocale('en');
  assert.strictEqual(i18n.t('match.nPlayers', { n: 2 }), '2 players');
  i18n.setLocale('ru');
  assert.strictEqual(i18n.t('match.nPlayers', { n: 2 }), '2 игрока');
  assert.strictEqual(i18n.t('match.nPlayers', { n: 5 }), '5 игроков');
  assert.strictEqual(i18n.t('match.nPlayers', { n: 6 }), '6 игроков');
  i18n.setLocale('en');
});

test('every plural set offers two English forms and three Russian', () => {
  for (const [name, set] of Object.entries(i18n.PLURALS)) {
    assert.strictEqual(set.en.length, 2, `${name}: English has two forms`);
    assert.strictEqual(set.ru.length, 3, `${name}: Russian has three`);
    for (const form of [...set.en, ...set.ru]) {
      assert.ok(form && form.trim() === form && form.length, `${name}: "${form}" is not a word`);
    }
  }
});

test('a counted noun is counted in every language that has the string', () => {
  // A {players} left in one language and spelled out in the other is exactly the drift
  // this is meant to prevent, so both sides have to carry the same placeholders.
  const sets = Object.keys(i18n.PLURALS);
  for (const [key, entry] of Object.entries(i18n.STRINGS)) {
    const used = (text) => sets.filter((s) => String(text).includes(`{${s}}`)).sort();
    assert.deepStrictEqual(used(entry.ru), used(entry.en),
      `${key}: the two languages do not count the same things`);
  }
});

test('nothing asks for a counted noun without a number', () => {
  // t() only agrees a noun when it was given a numeric n. A string using {players} that
  // is called without one would render the placeholder to the page.
  const sets = Object.keys(i18n.PLURALS);
  for (const [key, entry] of Object.entries(i18n.STRINGS)) {
    for (const lang of ['en', 'ru']) {
      if (sets.some((s) => String(entry[lang]).includes(`{${s}}`))) {
        assert.ok(String(entry[lang]).includes('{n}'),
          `${key} (${lang}) counts a noun but never mentions {n}`);
      }
    }
  }
});

test('the poker board names every hand the evaluator can rank', () => {
  // The server sends a hand as a category number so each language can name it. That only
  // works while the two lists agree, and they live in different files.
  const holdem = require('../src/holdem');
  const src = read(path.join(PUBLIC, 'games', 'pokerboard.js'));
  const body = src.slice(src.indexOf('const HANDS = {'));
  const list = (lang) => {
    const at = body.indexOf(`${lang}: [`);
    const close = body.indexOf('],', at);
    return [...body.slice(at, close).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };
  const en = list('en');
  const ru = list('ru');
  assert.strictEqual(en.length, holdem.CATEGORY_NAME.length,
    'the board names a different number of hands than the evaluator ranks');
  assert.strictEqual(ru.length, holdem.CATEGORY_NAME.length);
  // English is the evaluator's own wording, so a reorder on either side shows up here.
  assert.deepStrictEqual(en, holdem.CATEGORY_NAME);
});

test('no translation key is defined twice', () => {
  // A repeated key is not an error in JavaScript: the last one silently wins. Adding
  // 'match.why.stalemate' for дурак quietly took over the chess wording until this
  // caught it.
  const body = I18N.slice(I18N.indexOf('const STRINGS = {'));
  const seen = new Map();
  const dupes = [];
  for (const m of body.matchAll(/^ {2}'([a-zA-Z0-9.\-_]+)':/gm)) {
    if (seen.has(m[1])) dupes.push(m[1]);
    seen.set(m[1], true);
  }
  assert.deepStrictEqual(dupes, [], 'these keys are defined more than once');
});

test('every match result reason has wording', () => {
  // The client renders a result as t('match.why.' + reason), so a reason the server can
  // emit with no string behind it prints the raw key at the player.
  const games = read(path.join(__dirname, '..', 'src', 'matchgames.js'));
  const reasons = new Set([...games.matchAll(/reason: '([a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(reasons.size >= 5, 'reasons were found');
  const missing = [...reasons].filter((r) => !STRINGS.has(`match.why.${r}`));
  assert.deepStrictEqual(missing, [], 'these results would show as a raw key');
});

test('nothing sets a style attribute the policy will ignore', () => {
  // The page is served under `style-src 'self'` with no 'unsafe-inline', so the browser
  // drops a style attribute without a word. All forty-six of them in app.js were doing
  // nothing, which is why the slot drums came out flat: the custom property that told
  // each face where it sat on the cylinder never arrived.
  //
  // el() routes style through the CSSOM now, which the policy allows. What must not come
  // back is a raw setAttribute('style', ...).
  const bad = [];
  for (const file of clientFiles()) {
    for (const m of read(file).matchAll(/setAttribute\(\s*['"]style['"]/g)) {
      bad.push(`${path.basename(file)}: setAttribute('style', ...) at ${m.index}`);
    }
  }
  assert.deepStrictEqual(bad, [], 'these would be silently dropped by the CSP');
});

test('every helper that takes a style: applies it through the CSSOM', () => {
  // Both el() implementations have to handle it; admin.js had the same hole.
  for (const name of ['app.js', 'admin.js']) {
    const src = read(path.join(PUBLIC, name));
    assert.match(src, /k === 'style'/, `${name}: el() ignores style:`);
    assert.match(src, /setProperty\(/, `${name}: it does not use the CSSOM`);
  }
});

test('the served policy really does forbid inline style', () => {
  // If this ever gains 'unsafe-inline' the two tests above stop being about anything, so
  // it is worth pinning what they are defending against.
  const server = read(path.join(__dirname, '..', 'src', 'server.js'));
  const csp = server.slice(server.indexOf("'content-security-policy'"));
  const head = csp.slice(0, 400);
  assert.match(head, /style-src 'self'/);
  assert.ok(!/style-src 'self'[^;]*unsafe-inline/.test(head),
    "style-src has gained 'unsafe-inline'");
});

test('signing a stake survives a request with no body at all', () => {
  // Revealing a tile and cashing out are continuations of a round that was already paid
  // for, so they POST to /api/bet/... with no body. The wallet gate signs every request on
  // that prefix, and reading `.amount` off `undefined` threw
  // "Cannot read properties of undefined" — which is what cashing out of mines or the
  // puzzle did, silently, until somebody hit it.
  //
  // Checked in the source rather than by running it, because the function reaches for
  // IndexedDB and WebCrypto that do not exist here. The guard has to come before the first
  // property read, which is the whole of the bug.
  const src = read(path.join(PUBLIC, 'app.js'));
  const fn = src.slice(src.indexOf('async function signStakeFor'));
  const body = fn.slice(0, fn.indexOf('\n}'));

  const guard = body.indexOf('if (!payload) return undefined;');
  const firstRead = body.indexOf('payload.amount');
  assert.ok(guard > -1, 'signStakeFor must refuse a missing payload rather than read it');
  assert.ok(guard < firstRead,
    'the guard has to come before the first property read, or it does not guard anything');
});

// ---------------------------------------------------------------------------
// The Minesweeper presets are the real Windows densities.
//
// This grid is 5x5 and the Windows boards are not, so the mine COUNT cannot be copied
// across: ten mines on eighty-one tiles is a different game from ten on twenty-five.
// What carries over is the proportion, and that is the whole claim the labels make —
// press "Expert" and you should be playing Expert's odds, not a number someone liked.
//
// Pinned here because the three constants live in a click handler in app.js, where a
// plausible-looking edit ("3, 5, 8 feels better") would silently make the labels lie.

test('the mines presets match the Windows Minesweeper densities', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  // The three classic boards, straight from the game.
  const WINDOWS = [
    { name: 'Beginner', w: 9, h: 9, mines: 10, key: 'mines.beginner' },
    { name: 'Intermediate', w: 16, h: 16, mines: 40, key: 'mines.intermediate' },
    { name: 'Expert', w: 30, h: 16, mines: 99, key: 'mines.expert' },
  ];

  // MINES_TILES is the server's, so a change there has to be reflected here rather than
  // silently leaving the presets describing a board that no longer exists.
  const { MINES_TILES } = require('../src/fair');
  assert.strictEqual(MINES_TILES, 25, 'the preset numbers below assume a 25-tile grid');

  for (const board of WINDOWS) {
    const want = Math.round((board.mines / (board.w * board.h)) * MINES_TILES);

    // Found by string search rather than a built regex: the key contains a dot, and
    // three layers of escaping (shell, generator, regex) is how the first two attempts
    // at this line silently matched nothing.
    const needle = "key: '" + board.key + "', mines: ";
    const at = src.indexOf(needle);
    const m = at < 0 ? null : [needle, src.slice(at + needle.length).match(/^\d+/)[0]];
    assert.ok(m, `${board.name} is not declared as a preset in app.js`);

    const got = Number(m[1]);
    assert.strictEqual(got, want,
      `${board.name} is ${board.w}x${board.h} with ${board.mines} mines — `
      + `${((board.mines / (board.w * board.h)) * 100).toFixed(1)}% — which on `
      + `${MINES_TILES} tiles is ${want}, but the preset says ${got}`);

    // And it must be a legal choice: the server clamps to 1..24.
    assert.ok(got >= 1 && got <= 24, `${board.name} sets ${got} mines, outside 1..24`);
  }
});

test('the mines presets get harder from left to right', () => {
  // The row is colour-graded green to red by CSS nth-child, so the order in the markup
  // IS the difficulty cue. Reordering the array without reordering the colours would
  // put a red Beginner beside a green Expert.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const block = src.slice(src.indexOf('const PRESETS = ['));
  const nums = [...block.slice(0, block.indexOf(']')).matchAll(/mines:\s*(\d+)/g)]
    .map((m) => Number(m[1]));

  assert.strictEqual(nums.length, 3, `expected three presets, found ${nums.length}`);
  for (let i = 1; i < nums.length; i += 1) {
    assert.ok(nums[i] > nums[i - 1],
      `preset ${i} has ${nums[i]} mines, which is not more than the ${nums[i - 1]} before it`);
  }
});
