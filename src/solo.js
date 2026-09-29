'use strict';
// Playing the match games on your own.
//
// WHY THIS IS NOT src/match.js
//
// Every seat in the match framework is a real person by construction, and not by accident:
// `match_seats.user_id` is NOT NULL with an enforced foreign key, joining demands a
// `token_keys` row, and the stake is an ed25519 signature the server cannot produce. A bot
// seat would need a fabricated account and a server-held private key — a great deal of
// machinery whose entire purpose is protecting money, for a mode that has none, since
// singleplayer is free practice.
//
// There is a second, independent reason. **Nothing server-side ever calls `act()`.** The
// only recurring timers send a heartbeat and sweep abandoned tables; neither touches a
// live board. A match advances only inside an authenticated request, so an opponent that
// moves "on its own" has nowhere to live.
//
// So this follows the shape the codebase already uses for exactly this problem — a person
// against server-side bots with no opponent account anywhere: Preferans and Debertz. One
// row per player per game, the position as JSON, and the bots run inside the player's own
// request, between their move and the response.
//
// WHAT IS REUSED
//
// The rules. Every game here is the same `matchgames.js` plugin the head-to-head tables
// use — `create`, `toMove`, `act`, `view` — so a rule fixed in multiplayer is fixed here
// for free, and the two can never drift into disagreeing about what is legal.
//
// `plugin.view(state, seat, seats)` is also what makes the bots honest. It is the only
// thing they are given, so hidden cards and unplaced ships are not ignored, they are
// absent. See src/bots.js.

const U = require('./util');
const { GAMES } = require('./matchgames');
const bots = require('./bots');
const events = require('./events');

const now = () => Math.floor(Date.now() / 1000);

/** The player always sits in seat 0. Every other seat is a bot. */
const PLAYER = 0;

/**
 * How many times the bot loop may go round before something is badly wrong.
 *
 * Preferans has the same guard and it has earned its place. The failure it catches is a
 * plugin that never advances the turn: without a ceiling that is an infinite loop inside
 * an HTTP request, which takes the server down rather than the game. Throwing loses one
 * round; spinning loses everything.
 */
const LOOP_GUARD = 400;

const parse = (row) => JSON.parse(row.state);

function requireGame(game) {
  const plugin = GAMES[game];
  if (!plugin) throw new U.BadRequest('no such game');
  return plugin;
}

/** How many seats this game should have on its own. Its default, unless it insists. */
function seatsFor(plugin) {
  const s = plugin.seats || {};
  return s.default || s.min || 2;
}

/**
 * What the player is allowed to see, plus the bookkeeping the table needs.
 *
 * Deliberately built from `plugin.view(state, PLAYER, seats)` and not from the state: the
 * response a solo player receives is the same shape, and carries the same secrets, as the
 * one a head-to-head player receives. A client written against one works against the other.
 */
function render(row, plugin) {
  const state = parse(row);
  const seats = row.seats;
  return {
    id: row.id,
    game: row.game,
    seat: PLAYER,
    seats,
    solo: true,
    status: row.status,
    winners: row.winners ? JSON.parse(row.winners) : null,
    reason: row.reason || null,
    // Whose turn it is, in the same terms the boards already understand.
    toMove: plugin.toMove ? plugin.toMove(state) : null,
    view: plugin.view(state, PLAYER, seats),
  };
}

/** The live game of this type, or null. */
function current(db, userId, game, cfg) {
  const plugin = requireGame(game);
  const row = db.get(
    "SELECT * FROM solo_games WHERE user_id=? AND game=? AND status='playing'",
    userId, game,
  );
  return row ? render(catchUp(db, cfg, row, plugin), plugin) : null;
}

/**
 * Start one, and let the bots move if they are first.
 *
 * A game already in progress is returned rather than replaced. Starting over is `quit`
 * followed by `start`, which is an explicit decision instead of an accident of pressing
 * the button twice.
 */
function start(db, cfg, user, game) {
  const plugin = requireGame(game);
  const existing = current(db, user.id, game);
  if (existing) return existing;

  const seats = seatsFor(plugin);
  const state = plugin.create(cfg, seats);
  const at = now();
  db.run(
    `INSERT INTO solo_games(user_id, game, seats, state, status, created_at, updated_at)
     VALUES(?,?,?,?,'playing',?,?)`,
    user.id, game, seats, JSON.stringify(state), at, at,
  );
  const id = db.get('SELECT last_insert_rowid() AS id').id;
  events.emit(db, cfg, {
    g: 'solo', r: id, k: 'o', a: [game, seats], userId: user.id,
    pubkey: db.get('SELECT pubkey FROM token_keys WHERE user_id=?', user.id)?.pubkey || null,
  });
  return advance(db, cfg, db.get('SELECT * FROM solo_games WHERE id=?', id), plugin);
}

/**
 * Who may act right now.
 *
 * `toMove` is not enough for two of these games. Дурак lets more than one seat act during
 * a bout, and морской бой has `toMove === null` for the whole setup phase while both
 * sides place their fleets — so a driver that only ever asked `toMove` would sit and wait
 * forever at the start of a battleship game.
 */
function actors(plugin, state, seats) {
  // `canAct(state, seat)` answers for one seat at a time and returns a boolean, so the
  // list is built by asking about each seat rather than by asking for a list. Reading it
  // as though it returned seats is the obvious mistake, and it fails quietly: every seat
  // would look unable to move and the game would simply stop.
  if (plugin.canAct) {
    const who = [];
    for (let seat = 0; seat < seats; seat += 1) {
      if (plugin.canAct(state, seat, seats)) who.push(seat);
    }
    return who;
  }
  const seat = plugin.toMove ? plugin.toMove(state) : null;
  return seat === null || seat === undefined ? [] : [seat];
}

/**
 * Apply one bot move.
 *
 * The fallback is the important part. A bot returning something illegal must not corrupt
 * the game or end the request: the engine is asked, it refuses, and the seat plays
 * whatever is legal instead. A bad bot should cost its own position, never the player's.
 */
function botMove(plugin, state, seat, cfg, game) {
  const view = plugin.view(state, seat, undefined);
  const payload = bots.choose(game, view, seat, cfg);
  if (payload) {
    try {
      return { out: plugin.act(state, seat, payload, cfg), payload };
    } catch {
      // Fall through and improvise.
    }
  }
  for (const attempt of fallbacks(game, view)) {
    try {
      return { out: plugin.act(state, seat, attempt, cfg), payload: attempt };
    } catch {
      // keep trying
    }
  }
  return null;
}

/**
 * Moves to try when the bot has nothing, in the order a stuck player would try them.
 *
 * These are not strategy. They exist so that a seat which cannot decide still does
 * something legal, because a seat that does nothing is a game that never ends.
 */
function fallbacks(game, view) {
  const out = [];
  if (game === 'chess') for (const m of (view.legal || [])) out.push({ move: m });
  if (game === 'balda') out.push({ pass: true });
  if (game === 'durak') {
    for (const c of (view.canBeat || [])) out.push({ play: 'defend', card: c });
    for (const c of (view.playable || [])) out.push({ play: 'attack', card: c });
    out.push({ play: 'take' }, { play: 'done' });
  }
  // 'next' first: at a showdown it is the only move the engine will take.
  if (game === 'poker') out.push({ play: 'next' }, { play: 'check' }, { play: 'fold' }, { play: 'call' });
  if (game === 'seabattle') {
    const shots = (view.theirs && view.theirs.shots) || [];
    for (let i = 0; i < shots.length; i += 1) {
      if (shots[i] === null || shots[i] === undefined) out.push({ cell: i });
    }
  }
  return out;
}

/** Write the position back, and finish the row if the game ended. */
function save(db, cfg, row, state, outcome) {
  const finished = outcome && outcome.winners;
  if (finished) {
    events.emit(db, cfg, { g: 'solo', r: row.id, k: 'f', a: [outcome.winners, outcome.reason || null] });
    events.close(db, { g: 'solo', r: row.id });
  }
  db.run(
    `UPDATE solo_games SET state=?, status=?, winners=?, reason=?, updated_at=? WHERE id=?`,
    JSON.stringify(state),
    finished ? 'done' : 'playing',
    finished ? JSON.stringify(outcome.winners) : null,
    finished ? (outcome.reason || null) : null,
    now(),
    row.id,
  );
  return db.get('SELECT * FROM solo_games WHERE id=?', row.id);
}

/**
 * A game that runs on its own clock is ridden forward before it is read or moved on.
 *
 * Tron's machines have no timer, any more than its riders do, so their turns since the
 * last request are decided now, by the same bots, and recorded (src/tron.js, catchUp).
 * Every other game has no such hook and comes back untouched.
 */
function catchUp(db, cfg, row, plugin) {
  if (!plugin.catchUp || row.status !== 'playing') return row;
  const decide = (view, seat) => bots.choose(row.game, view, seat, cfg);
  const out = plugin.catchUp(parse(row), decide);
  if (!out) return row;
  return save(db, cfg, row, out.state, out.winners ? out : null);
}

/**
 * Run every bot that can move, and stop when it is the player's turn again.
 *
 * One request, one transaction, one response holding the position *after* the opponents
 * have replied — which is what makes this feel like a game rather than a correspondence.
 */
function advance(db, cfg, row, plugin) {
  let state = parse(row);
  let outcome = null;
  let guard = 0;

  for (;;) {
    guard += 1;
    if (guard > LOOP_GUARD) {
      throw new Error(`solo: ${row.game} bot loop did not terminate`);
    }
    const who = actors(plugin, state, row.seats);
    if (!who.length) break;                      // nobody may move: the game is over
    if (who.includes(PLAYER)) break;             // the player's turn, so stop and answer

    const moved = botMove(plugin, state, who[0], cfg, row.game);
    if (!moved) break;                           // nothing legal at all; do not spin
    // The machines' moves go on the record too, or the replay has holes in it.
    events.emit(db, cfg, { g: 'solo', r: row.id, k: 'p', a: [who[0], moved.payload] });
    state = moved.out.state || state;
    if (moved.out.winners) { outcome = moved.out; break; }
  }

  const saved = save(db, cfg, row, state, outcome);
  return render(saved, plugin);
}

/**
 * The player moves, then the bots do.
 *
 * `plugin.act` validates: an illegal move throws BadRequest and nothing is written,
 * because the whole thing runs in one transaction.
 */
function move(db, cfg, user, game, payload) {
  const plugin = requireGame(game);
  return db.tx(() => {
    const row = db.get(
      "SELECT * FROM solo_games WHERE user_id=? AND game=? AND status='playing'",
      user.id, game,
    );
    if (!row) throw new U.BadRequest('no game in progress');

    // The machines ride first, up to now. If that ended the race there is nothing left
    // for the player to do but see the result.
    const live = catchUp(db, cfg, row, plugin);
    if (live.status !== 'playing') return render(live, plugin);

    const state = parse(live);
    const who = actors(plugin, state, live.seats);
    if (!who.includes(PLAYER)) throw new U.BadRequest('not your turn');

    const out = plugin.act(state, PLAYER, payload, cfg);
    // A sync — a Tron board asking how the race stands — is not a move and not recorded.
    if (out.note !== 'sync') events.emit(db, cfg, { g: 'solo', r: live.id, k: 'p', a: [PLAYER, payload] });
    const after = save(db, cfg, live, out.state || state, out.winners ? out : null);
    if (out.winners) return render(after, plugin);
    return advance(db, cfg, after, plugin);
  });
}

/** Abandon it. Nothing is at stake, so this needs no settlement — just a closed row. */
function quit(db, user, game) {
  requireGame(game);
  const row = db.get(
    "SELECT * FROM solo_games WHERE user_id=? AND game=? AND status='playing'",
    user.id, game,
  );
  if (!row) return { ok: true };
  db.run(
    "UPDATE solo_games SET status='done', reason='quit', updated_at=? WHERE id=?",
    now(), row.id,
  );
  events.emit(db, {}, { g: 'solo', r: row.id, k: 'q', a: [] });
  events.close(db, { g: 'solo', r: row.id });
  return { ok: true };
}

/** Which games can be played this way, for the lobby. */
const available = () => Object.keys(GAMES);

module.exports = { start, current, move, quit, available, PLAYER, LOOP_GUARD };
