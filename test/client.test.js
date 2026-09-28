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
