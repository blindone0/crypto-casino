'use strict';
// Cheats and hackers, found in the record and answered on the chain.
//
// WHAT THIS READS
//
// Every game writes its every step to the token chain (src/events.js), so the history a
// cheat has to leave behind is the same history everything else leaves: rounds, clicks,
// timings, commitments and reveals, in one order with the money. scan() replays that
// record for the concrete, cheap tells first — a jigsaw solved faster than a person can
// drag, a solve the log never showed being assembled, clicks with no human gaps between
// them, a run of mines luck that a fair layout would not produce in a lifetime — and
// reports each with the block heights that hold the evidence.
//
// WHAT THIS DOES ABOUT IT: FREEZE FIRST, BAN ON REVIEW
//
// A finding is a reason to look, not a verdict. flag() freezes the account — no bets, no
// transfers, but the player can still log in and see exactly why, with the blocks cited —
// and writes a `flag` transaction to the chain, so the freeze is on the record with its
// evidence. A person reviews it. Confirmed, ban() writes a `ban` and seize() moves what
// the account holds to the house — the one place lost bets already go — with a `seize`
// that names the ban it rests on. Dismissed, unflag() writes an `unflag` and thaws the
// account. Every decision is on the chain either way, and a wrong flag costs a wait,
// not money.
//
// THE ONE EXCEPTION TO THE CENTRAL CLAIM
//
// "The operator cannot move your tokens" is the token's central claim and it stays true
// of every transfer: a `seize` is not a transfer and is not signed by the player. It is
// kept as narrow as it can be made — it may move balance only to the house key, only
// after a `ban` of the same key that is already on the chain, and both verifiers refuse
// anything else (src/tokenchain.js applyTx and verifyChain, public/chainverify.js). The
// supply does not change: a seize is a move, not a mint.

const U = require('./util');
const tokenchain = require('./tokenchain');
const events = require('./events');

const now = () => Math.floor(Date.now() / 1000);

/** Below this many milliseconds between drops, over enough of them, a hand is not a hand. */
const HUMAN_GAP_MS = 80;
const SCRIPT_MIN_MOVES = 20;
/** Mines luck this improbable, over at least this many cashed rounds, is worth a look. */
const LUCK_FLOOR = 1e-6;
const LUCK_MIN_ROUNDS = 10;
const LUCK_WINDOW = 30;

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** The chance a fair layout lets k picks through with m mines in 25 tiles. */
function survival(mines, picks) {
  let p = 1;
  for (let i = 0; i < picks; i += 1) p *= (25 - mines - i) / (25 - i);
  return p;
}

const heights = (evs) => [...new Set(evs.map((e) => e.height).filter((h) => h !== null && h !== undefined))];

/**
 * Read the record for the tells above. Reports, never acts.
 *
 * Returns { findings, rounds, players }. A finding names the player, the round, what
 * was seen, and the blocks holding it, so a reviewer can go straight to the evidence.
 */
function scan(db) {
  const findings = [];
  const rounds = db.all(
    `SELECT r.g, r.r, r.user_id, r.pubkey, u.username
       FROM token_rounds r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.closed_at IS NOT NULL ORDER BY r.opened_at DESC LIMIT 5000`,
  );
  const byUser = new Map();
  const add = (round, kind, detail, evs) => findings.push({
    kind, g: round.g, r: round.r, userId: round.user_id, username: round.username || null,
    pubkey: round.pubkey || null, detail, blocks: heights(evs),
  });

  for (const round of rounds) {
    const log = events.history(db, round.g, round.r);
    if (!log.length) continue;

    // The record itself: a sequence with a hole in it, or time running backwards, is a
    // fault in the operator's log before it is anything about the player.
    const gap = log.some((e, i) => e.s !== i);
    const backwards = log.some((e, i) => i > 0 && e.ms < log[i - 1].ms);
    if (gap || backwards) add(round, 'record', gap ? 'a sequence number is missing' : 'receipt times run backwards', log);

    if (round.g === 'jigsaw') {
      const open = log.find((e) => e.k === 'o');
      const finish = log.find((e) => e.k === 'f');
      const drops = log.filter((e) => e.k === 'p');
      if (open && finish) {
        const pieces = Number(open.a[2]) * Number(open.a[3]);
        const [, multiplier, , tooFast] = finish.a;
        if (tooFast) add(round, 'jigsaw-too-fast', `solved in ${finish.a[0]}s, under the human floor for ${pieces} pieces`, [open, finish]);
        if (multiplier > 0 && drops.length < pieces) {
          add(round, 'jigsaw-unplaced', `solved with ${drops.length} drops on the record for ${pieces} pieces`, [open, finish]);
        }
      }
      if (drops.length >= SCRIPT_MIN_MOVES) {
        const gaps = drops.slice(1).map((e, i) => e.ms - drops[i].ms);
        const mid = median(gaps);
        if (mid < HUMAN_GAP_MS) add(round, 'jigsaw-scripted', `${drops.length} drops with a median gap of ${mid}ms`, drops.slice(0, 3));
      }
    }

    if (round.g === 'mines' && round.user_id) {
      const open = log.find((e) => e.k === 'o');
      const cashed = log.find((e) => e.k === 'c');
      if (open && cashed) {
        const picks = log.filter((e) => e.k === 'r').length;
        const mines = Number(open.a[1]);
        const bucket = byUser.get(round.user_id) || { round, rounds: [] };
        bucket.rounds.push({ p: survival(mines, picks), evs: [open, cashed] });
        byUser.set(round.user_id, bucket);
      }
    }
  }

  // Mines: not one round, which is just luck, but a run of them that a fair layout would
  // not allow in a lifetime of play.
  for (const bucket of byUser.values()) {
    const recent = bucket.rounds.slice(0, LUCK_WINDOW);
    if (recent.length < LUCK_MIN_ROUNDS) continue;
    const p = recent.reduce((acc, r) => acc * r.p, 1);
    if (p < LUCK_FLOOR) {
      add(bucket.round, 'mines-improbable',
        `${recent.length} cashed rounds in a row at a combined chance of ${p.toExponential(2)}`,
        recent.flatMap((r) => r.evs));
    }
  }

  return { findings, rounds: rounds.length, players: byUser.size };
}

// ------------------------------------------------------------------ actions
function userAndKey(db, userId) {
  const user = db.get('SELECT * FROM users WHERE id=?', userId);
  if (!user) throw new U.NotFound('no such user');
  const key = tokenchain.keyFor(db, userId);
  if (!key) throw new U.BadRequest('that account has no token key, and so nothing on the chain to answer');
  return { user, pubkey: key.pubkey };
}

/** Freeze, on the record: no bets and no transfers, and the reason and blocks to show. */
function flag(db, cfg, { userId, why, blocks = [], actor }) {
  return db.tx(() => {
    const { user, pubkey } = userAndKey(db, userId);
    if (user.banned) throw new U.BadRequest('that account is banned already');
    const reason = String(why || '').slice(0, 200);
    if (!reason) throw new U.BadRequest('say why');
    const cited = [...new Set(blocks.map(Number).filter((h) => Number.isSafeInteger(h) && h >= 0))].sort((a, b) => a - b);
    const block = tokenchain.appendBlock(db, [{ type: 'flag', who: pubkey, why: reason, blocks: cited }]);
    db.run('UPDATE users SET frozen=1, frozen_why=?, frozen_blocks=? WHERE id=?',
      reason, JSON.stringify(cited), userId);
    db.audit(actor, 'anticheat.flag', { userId, why: reason, blocks: cited, height: block.height });
    return { userId, height: block.height, frozen: true };
  });
}

/** Thaw, on the record. A wrong flag cost a wait, and this is the end of it. */
function unflag(db, cfg, { userId, actor }) {
  return db.tx(() => {
    const { user, pubkey } = userAndKey(db, userId);
    if (user.banned) throw new U.BadRequest('a banned account is not thawed; it is banned');
    if (!user.frozen) throw new U.BadRequest('that account is not frozen');
    const block = tokenchain.appendBlock(db, [{ type: 'unflag', who: pubkey }]);
    db.run('UPDATE users SET frozen=0, frozen_why=NULL, frozen_blocks=NULL WHERE id=?', userId);
    db.audit(actor, 'anticheat.unflag', { userId, height: block.height });
    return { userId, height: block.height, frozen: false };
  });
}

/** Ban, on the record. Sessions end; the account may not log in again. */
function ban(db, cfg, { userId, why, actor }) {
  return db.tx(() => {
    const { user, pubkey } = userAndKey(db, userId);
    if (user.banned) throw new U.BadRequest('that account is banned already');
    const reason = String(why || user.frozen_why || '').slice(0, 200);
    if (!reason) throw new U.BadRequest('say why');
    const block = tokenchain.appendBlock(db, [{ type: 'ban', who: pubkey, why: reason }]);
    db.run('UPDATE users SET banned=1, frozen=1, ban_height=?, frozen_why=COALESCE(frozen_why, ?) WHERE id=?',
      block.height, reason, userId);
    db.run('DELETE FROM sessions WHERE user_id=?', userId);
    db.audit(actor, 'anticheat.ban', { userId, why: reason, height: block.height });
    return { userId, height: block.height, banned: true };
  });
}

/**
 * Move what a banned account holds to the house, on the record, citing the ban.
 *
 * Only after a ban, only to the house: applyTx refuses anything else, and so do both
 * verifiers. Loans the account owes are the lender's (src/loans.js) and are settled
 * before this is called for what remains.
 */
function seize(db, cfg, { userId, actor }) {
  return db.tx(() => {
    const { user, pubkey } = userAndKey(db, userId);
    if (!user.banned || !Number.isInteger(user.ban_height)) throw new U.BadRequest('seize follows a ban, never precedes one');
    const amount = tokenchain.balanceOf(db, pubkey);
    if (amount <= 0) return { userId, amount: 0, height: null };
    const house = db.kvGet('token.houseKey');
    if (!house) throw new Error('the house has no key');
    const block = tokenchain.appendBlock(db, [{
      type: 'seize', from: pubkey, to: house.publicRaw, amount, ban: user.ban_height,
    }]);
    db.audit(actor, 'anticheat.seize', { userId, amount, height: block.height, ban: user.ban_height });
    return { userId, amount, height: block.height };
  });
}

/** Every account under review or banned, for the panel. */
function flagged(db) {
  return db.all(
    `SELECT u.id, u.username, u.frozen, u.banned, u.frozen_why, u.frozen_blocks, u.ban_height, k.pubkey
       FROM users u LEFT JOIN token_keys k ON k.user_id = u.id
      WHERE u.frozen = 1 OR u.banned = 1 ORDER BY u.banned, u.id`,
  ).map((u) => ({
    id: u.id,
    username: u.username,
    frozen: !!u.frozen,
    banned: !!u.banned,
    why: u.frozen_why || null,
    blocks: u.frozen_blocks ? JSON.parse(u.frozen_blocks) : [],
    banHeight: u.ban_height ?? null,
    pubkey: u.pubkey || null,
    balance: u.pubkey ? tokenchain.balanceOf(db, u.pubkey) : 0,
  }));
}

module.exports = {
  scan, flag, unflag, ban, seize, flagged, survival,
  HUMAN_GAP_MS, SCRIPT_MIN_MOVES, LUCK_FLOOR, LUCK_MIN_ROUNDS, now,
};
