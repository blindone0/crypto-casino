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
