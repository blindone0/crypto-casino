'use strict';
/**
 * Schema changes on a database that already has rows in it.
 *
 * The schema in db.js is built entirely out of CREATE TABLE IF NOT EXISTS. That is right
 * for a database that does not exist yet and does nothing whatever for one that does.
 * Add a column to a table that is already there and IF NOT EXISTS skips the statement
 * silently: the code goes on expecting the column, the table has not got it, and the
 * failure arrives at runtime on a live site with money in it.
 *
 * So: numbered steps, applied in order, with PRAGMA user_version recording how far a
 * given database has got. user_version lives in the database header and is transactional,
 * so a step and the record of having run it commit together or not at all.
 *
 * ---- adding one
 *
 * Append to STEPS with the next id. Never edit or renumber a step that has shipped: a
 * database that has already applied step 4 will never look at it again, so an edited step
 * 4 exists only on the machines that had not caught up yet. That is the worst kind of
 * difference to debug, because the two databases disagree and both think they are current.
 *
 * Adding a column is the common case and looks like this:
 *
 *     { id: 2, name: 'matches.expires_at', up(db) {
 *         db.exec('ALTER TABLE matches ADD COLUMN expires_at INTEGER');
 *     } },
 *
 * SQLite will not drop or retype a column. When you need that, make a new table, copy the
 * rows across, drop the old one and rename — all inside the one step, which is already
 * inside a transaction.
 */

/** How far this database has been migrated. Zero means it has never been touched. */
function version(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

/**
 * Record the version.
 *
 * PRAGMA takes no parameters, so this interpolates. The value is never anything but a
 * step id out of the list below, and it is checked before it goes anywhere near here.
 */
function setVersion(db, n) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`bad schema version: ${n}`);
  db.exec(`PRAGMA user_version = ${n}`);
}

const STEPS = [
  {
    id: 1,
    name: 'baseline schema',
    /**
     * Every statement in SCHEMA is CREATE ... IF NOT EXISTS, so this is safe to run
     * against a database built before migrations existed: it changes nothing and simply
     * records where that database already was. That is why there is no detection here
     * and no separate stamping path — the baseline is idempotent, so running it is the
     * honest thing to do rather than guessing whether it has been run.
     */
    up(db, ctx) {
      db.exec(ctx.schema);
    },
  },
  {
    id: 2,
    name: 'arcade_plays.mode',
    /**
     * Practice mode reached the arcade, so a play needs to say which it was.
     *
     * crash_bets, mines_games, pref_games and puzzle_games all carry this column already;
     * the arcade was the one table that never needed it, because until now every play
     * cost real tugriks. A free play must not set a high score that somebody else paid
     * for, and the leaderboard reads this to decide.
     *
     * Everything already in the table was paid for, which is what the default says.
     */
    up(db) {
      db.exec("ALTER TABLE arcade_plays ADD COLUMN mode TEXT NOT NULL DEFAULT 'real'");
    },
  },
  {
    id: 3,
    name: 'solo_games',
    /**
     * Playing the match games on your own.
     *
     * This is a separate table from `matches` on purpose, and the reason is structural
     * rather than tidiness. Every seat in `match_seats` is a real person by construction:
     * `user_id` is NOT NULL with an enforced foreign key, joining demands a `token_keys`
     * row, and the stake is an ed25519 signature the server cannot forge. A bot seat
     * would need a fake account and a server-held private key — a great deal of machinery
     * built to protect money that is not present, since singleplayer is free practice.
     *
     * So it follows the shape Preferans and Debertz already use: one row per player per
     * game, the whole position as JSON, and bots that run inside the player's own request.
     *
     * `status` is 'playing' or 'done'. The partial unique index is what stops a second
     * live game of the same type without stopping a history of finished ones.
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS solo_games (
          id         INTEGER PRIMARY KEY,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          game       TEXT NOT NULL,
          seats      INTEGER NOT NULL,
          state      TEXT NOT NULL,
          status     TEXT NOT NULL DEFAULT 'playing',
          winners    TEXT,
          reason     TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_solo_live
          ON solo_games(user_id, game) WHERE status = 'playing';
        CREATE INDEX IF NOT EXISTS ix_solo_user ON solo_games(user_id, id DESC);
      `);
    },
  },
  {
    id: 4,
    name: 'jigsaw_games',
    /**
     * The drag-to-assemble jigsaw, which is a skill game and therefore needs a clock the
     * player cannot touch.
     *
     * `started_at` is the only reason this is a table rather than a client-side toy.
     * Anyone who keeps dragging finishes eventually, so the payout can only depend on how
     * fast — and a time the browser reports is a time the browser can invent. It is
     * written when the round opens and read when it closes, both on the server.
     *
     * `scramble` is stored rather than recomputed so the round survives a restart, and it
     * is derived from the seed, so replaying the seed reproduces the exact board played.
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS jigsaw_games (
          id          INTEGER PRIMARY KEY,
          user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          wager       INTEGER NOT NULL,
          board       TEXT NOT NULL,
          picture     TEXT NOT NULL,
          scramble    TEXT NOT NULL,
          seed_id     INTEGER REFERENCES server_seeds(id),
          nonce       INTEGER NOT NULL,
          client_seed TEXT NOT NULL,
          state       TEXT NOT NULL DEFAULT 'active',
          seconds     INTEGER,
          multiplier  REAL,
          payout      INTEGER,
          started_at  INTEGER NOT NULL,
          created_at  INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_jigsaw_live
          ON jigsaw_games(user_id) WHERE state = 'active';
        CREATE INDEX IF NOT EXISTS ix_jigsaw_user ON jigsaw_games(user_id, id DESC);
      `);
    },
  },
  {
    id: 5,
    name: 'drop puzzle_games',
    /**
     * The reveal-and-cash-out puzzle is gone; the jigsaw replaced it.
     *
     * Dropping the table rather than leaving it is deliberate. `npm run doctor` walks
     * every table looking for rows orphaned from a user, and a table no code writes to is
     * exactly the kind of thing that sits there for a year accumulating questions. The
     * rounds in it are finished and settled — the `bets` rows that record them, and the
     * chain blocks that paid them, are untouched and still verify.
     */
    up(db) {
      db.exec('DROP TABLE IF EXISTS puzzle_games');
    },
  },
  {
    id: 6,
    name: 'token_rounds and token_events: every game step, queued for the chain',
    /**
     * The event log (src/events.js). token_events rows with height NULL are the queue of
     * steps not yet in a block; token_rounds hands out each round's sequence numbers and
     * records who played it. Additive only: the blocks already on the chain are never
     * rewritten, and nothing is backfilled — inventing a history for rounds that predate
     * the log would be the operator writing history.
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS token_rounds (
          g         TEXT NOT NULL,
          r         INTEGER NOT NULL,
          user_id   INTEGER,
          pubkey    TEXT,
          next_seq  INTEGER NOT NULL DEFAULT 0,
          opened_at INTEGER NOT NULL,
          closed_at INTEGER,
          sig       TEXT,
          PRIMARY KEY (g, r)
        );
        CREATE INDEX IF NOT EXISTS ix_token_rounds_user ON token_rounds(user_id, opened_at DESC);
        CREATE TABLE IF NOT EXISTS token_events (
          g      TEXT NOT NULL,
          r      INTEGER NOT NULL,
          s      INTEGER NOT NULL,
          k      TEXT NOT NULL,
          a      TEXT NOT NULL,
          u      TEXT,
          sig    TEXT,
          ms     INTEGER NOT NULL,
          height INTEGER,
          PRIMARY KEY (g, r, s)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS ix_token_events_queue ON token_events(ms) WHERE height IS NULL;
        CREATE INDEX IF NOT EXISTS ix_token_events_height ON token_events(height);
      `);
    },
  },
  {
    id: 7,
    name: 'token_checkpoints: a verified chain state to verify from',
    /**
     * A checkpoint is a cache of a full verification: the balances and spent nonces as
     * replayed up to a height, and that block's hash. A verify that starts from one is
     * O(blocks since) rather than O(blocks), which is what keeps the doctor quick as the
     * chain grows by a block every few seconds. Trusted only while its anchor block still
     * hashes to what it recorded — see tokenchain.verifyChain.
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS token_checkpoints (
          height     INTEGER PRIMARY KEY,
          hash       TEXT NOT NULL,
          balances   TEXT NOT NULL,
          nonces     TEXT NOT NULL,
          events     INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
      `);
    },
  },
];

const latest = (steps = STEPS) => steps.reduce((n, s) => Math.max(n, s.id), 0);

/** The steps this database has not applied yet, in order. */
function pending(db, steps = STEPS) {
  const at = version(db);
  return steps.filter((s) => s.id > at).sort((a, b) => a.id - b.id);
}

/**
 * Bring a database up to date.
 *
 * Each step gets its own transaction, so one that throws leaves the database at the
 * version before it rather than half-changed, and the error names the step so you know
 * which one to look at.
 */
function run(db, ctx = {}) {
  const steps = ctx.steps || STEPS;
  checkSteps(steps);

  const from = version(db);
  const applied = [];
  for (const step of pending(db, steps)) {
    db.exec('BEGIN IMMEDIATE');
    try {
      step.up(db, ctx);
      setVersion(db, step.id);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already unwound */ }
      throw new Error(`migration ${step.id} (${step.name}) failed: ${e.message}`);
    }
    applied.push(step);
  }
  return {
    from,
    to: version(db),
    applied: applied.map((s) => `${s.id}: ${s.name}`),
  };
}

/** A numbering mistake is worth catching at startup rather than halfway through a run. */
function checkSteps(steps) {
  const seen = new Set();
  for (const step of steps) {
    if (!Number.isInteger(step.id) || step.id < 1) {
      throw new Error(`migration ids must be positive integers, got ${step.id}`);
    }
    if (seen.has(step.id)) throw new Error(`two migrations share id ${step.id}`);
    if (typeof step.up !== 'function') throw new Error(`migration ${step.id} has no up()`);
    seen.add(step.id);
  }
}

module.exports = { STEPS, run, pending, version, setVersion, latest, checkSteps };
