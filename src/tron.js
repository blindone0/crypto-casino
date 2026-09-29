'use strict';
// Tron: the staked match.
//
// WHY THIS IS NOT LIKE THE OTHER PLUGINS
//
// Every other match game is turn-based: one seat acts, `toMove` advances, and the clock
// charges the seat that is thinking. Tron is simultaneous and continuous, and the match
// framework has one rule a continuous game must not break: nothing server-side ever wakes
// up to touch a live board (src/solo.js says why). So the race has no timer. It has a
// start time, a tick length and a list of turns, each stamped with the tick at which it
// took effect, and every read replays the race from those inputs up to the moment of the
// read. The rules doing the replaying are public/games/tron-rules.js — the file the
// browser runs — loaded here with require(): one collision rule, and the server's copy
// of it is the one that settles the pot.
//
// What that buys: a turn is recorded at the tick the server receives it, the server is
// authoritative on every crash, and the whole race is a few hundred bytes of JSON anyone
// can replay. What it costs: the last act does not settle the match — a crash happens at
// a tick, not inside a request — so a result is claimed through the existing timeout
// route, which asks `resultNow` first (src/match.js), and the sweeper asks the same
// question of a table everyone has left.
//
// The clock is a dial rather than a bare Date.now() so a test can turn it by hand.

const U = require('./util');
const R = require('../public/games/tron-rules.js');

const TICK_MS = 70;
const ROUND_MS = 150 * 1000;     // a race nobody finishes ends here, shared by the living
const COUNTDOWN_MS = 3000;       // between the table filling and the first tick

/** The clock, as a dial. The tests turn it; the server leaves it alone. */
const clock = { now: () => Date.now() };

const tickAt = (state, ms) => Math.max(0, Math.floor((ms - state.startMs) / state.tickMs));
const lastTick = (state) => Math.floor(state.roundMs / state.tickMs);
const cap = (state, ms) => Math.min(tickAt(state, ms), lastTick(state));

/** The race as it stands at `ms`. */
const run = (state, ms) => R.replay(state.n, state.turns, cap(state, ms));

const allBut = (seat, n) => {
  const out = [];
  for (let s = 0; s < n; s += 1) if (s !== seat) out.push(s);
  return out;
};

/** The result, if the race has decided itself by `ms`: { winners, reason }, or null. */
function outcome(state, ms) {
  const sim = run(state, ms);
  if (sim.over) {
    return { winners: sim.winners, reason: sim.alive === 1 ? 'last-rider' : 'head-on' };
  }
  if (cap(state, ms) >= lastTick(state)) {
    return { winners: sim.riders.filter((r) => r.alive).map((r) => r.seat), reason: 'time' };
  }
  return null;
}

/**
 * The race as one seat sees it — which is all of it, since a light cycle hides nothing.
 * The inputs are what the browser rebuilds the race from; `sim` is the live simulation
 * the bots read in solo, and being no kind of JSON it never leaves the process.
 */
function viewAt(state, ms, sim) {
  return {
    ...state,
    nowMs: ms,
    tick: cap(state, ms),
    cols: R.COLS,
    rows: R.ROWS,
    colours: R.COLOURS,
    result: outcome(state, ms),
    sim,
  };
}

const TRON = {
  key: 'tron',
  name: 'Tron: Legacy',
  seats: { min: R.MIN_RIDERS, max: R.MAX_RIDERS, default: 2 },
  // The seat clocks never run (clockRuns is false), but the framework seats everyone
  // with one, so it is given a value that is never charged.
  clockMs: 5 * 60 * 1000,
  incrementMs: 0,

  create(cfg, seats) {
    return {
      n: seats,
      tickMs: TICK_MS,
      roundMs: ROUND_MS,
      startMs: clock.now() + COUNTDOWN_MS,
      turns: [],
    };
  },

  /** Nobody is "to move": everyone rides at once. This also keeps the seat clocks off. */
  toMove() { return null; },
  clockRuns() { return false; },

  /**
   * Any seat may act while the race is on, the fallen included: their act is a sync
   * that returns the race as it stands, so a rider who has crashed can still watch it
   * end. act() refuses an actual turn from a fallen rider on its own.
   */
  canAct(state, seat) {
    return seat >= 0 && seat < state.n && !outcome(state, clock.now());
  },

  act(state, seat, payload) {
    const now = clock.now();
    const done = outcome(state, now);
    if (payload.claim) {
      // The board saw the race end and asks for the result. Nothing is recorded.
      return done ? { state, note: 'claim', ...done } : { state, note: 'sync' };
    }
    if (done) throw new U.BadRequest('the race is over');
    const h = String(payload.turn ?? 'straight');
    if (h === 'straight') return { state, note: 'sync' };
    if (!R.HEADINGS.includes(h)) throw new U.BadRequest('a turn is n, e, s or w');
    const sim = run(state, now);
    if (!sim.riders[seat].alive) throw new U.BadRequest('you are out of the race');

    // The turn lands at the next tick. A second turn for the same tick replaces the
    // first, and the replay is asked whether the heading took: it refuses a reverse, and
    // a turn the rules refuse is not worth recording.
    const t = cap(state, now) + 1;
    const turns = state.turns
      .filter((x) => !(x.seat === seat && x.t === t))
      .concat([{ t, seat, h }]);
    const check = R.replay(state.n, turns, t);
    if (check.riders[seat].h !== h) {
      throw new U.BadRequest('you cannot reverse into your own trail');
    }
    return { state: { ...state, turns }, note: h };
  },

  view(state) {
    return viewAt(state, clock.now(), null);
  },

  /**
   * Whether the race has decided itself. src/match.js asks this before anything else
   * when a result is claimed or a quiet table is swept: with no seat ever on the clock,
   * it is the only way a Tron match ends.
   */
  resultNow(state) {
    return outcome(state, clock.now());
  },

  /** Never reached — no seat is ever on the clock — but the interface asks for it. */
  resultOnTimeout(state, seat, n) {
    return allBut(seat, n);
  },

  /**
   * Solo only: ride the machines' seats forward to now.
   *
   * The bots have no timer either, so their turns are decided when someone asks — the
   * player's own request, on its way in — for every tick since the last time anyone
   * asked. `decide(view, seat)` is src/bots.js, and what it returns is recorded as a
   * turn like any other, so a race with machines in it replays exactly like one without.
   * Returns null when there is nothing to ride, else { state } — with winners and a
   * reason once the race has decided itself.
   */
  catchUp(state, decide) {
    const now = clock.now();
    const upto = cap(state, now);
    const from = state.decided || 0;
    if (upto <= from) return null;

    const turns = state.turns.slice();
    const scheduled = turns.slice().sort((a, b) => a.t - b.t);
    const sim = R.replay(state.n, turns, from);
    let i = scheduled.findIndex((x) => x.t > from);
    if (i < 0) i = scheduled.length;

    for (let t = from; t < upto && !sim.over; t += 1) {
      for (let seat = 1; seat < state.n; seat += 1) {
        if (!sim.riders[seat].alive) continue;
        const choice = decide(viewAt({ ...state, turns }, now, sim), seat);
        const h = choice && choice.turn;
        if (h && h !== 'straight' && h !== sim.riders[seat].h && R.setHeading(sim, seat, h)) {
          turns.push({ t: t + 1, seat, h });
        }
      }
      // The player's own turns for the tick about to be stepped, recorded earlier.
      while (i < scheduled.length && scheduled[i].t <= t + 1) {
        R.setHeading(sim, scheduled[i].seat, scheduled[i].h);
        i += 1;
      }
      R.step(sim);
    }

    const next = { ...state, turns, decided: upto };
    const done = outcome(next, now);
    return done ? { state: next, ...done } : { state: next };
  },
};

module.exports = { TRON, clock, outcome, run, tickAt, TICK_MS, ROUND_MS, COUNTDOWN_MS };
