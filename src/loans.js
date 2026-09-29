'use strict';
// The Биржа: lending tugriks between members of the chain.
//
// THE CONSTRAINT THAT SHAPES THE WHOLE DESIGN
//
// A lender's key lives only in their browser, and the token's central claim is that the
// operator cannot sign a transfer out of a player's account. An order book means the
// lender is offline when a borrower takes their offer, so nobody is there to sign the
// loan out. Therefore posting an offer ESCROWS the funds: the lender signs a transfer into
// the house key at post time — exactly the signature a match stake is — and taking the
// offer is a server-signed release from escrow to the borrower, exactly as a settled
// match pays its winner. Withdrawing an untaken offer is the refund a cancelled match
// gets. No new signing power anywhere.
//
// THE MONEY MOVEMENTS, AND THE TWO NEW TRANSACTIONS THEY NEED
//
//   post offer      lender signs     an ordinary `transfer` into the house key
//   withdraw offer  server signs     the ordinary escrow refund
//   take offer      server signs     `loan`  — house -> borrower, naming the offer, the
//                                              lender, the rate and the due date
//   repay           borrower signs   `repay` — borrower -> lender, naming the loan, under
//                                              a payload type of its own so the signature
//                                              cannot be replayed as anything else
//   default         server signs     `seize` — src/anticheat.js's, widened to a lender
//
// THE SECOND DELIBERATE EXCEPTION TO THE CENTRAL CLAIM
//
// A seize to a lender is a debit without the borrower's signature. It is held to four
// words, each of which both verifiers check: only against a `loan` already on the chain,
// only after its due date by the block clock, only up to what is outstanding, and only up
// to what the borrower holds. What is short after that freezes the account with the debt
// on record; repaying in full thaws it. Interest is fixed at post time and written into
// the offer, so the repayment figure is on the chain before anyone commits.
//
// THE CREDIT LINE IS THE CHAIN HISTORY
//
// Eligible to borrow when, from the record alone: no flag or ban, at least `minRounds`
// finished rounds, and no default open. The cap is max(firstLoanFloor, repaidMultiple x
// everything ever repaid). All of it is dials under cfg.credit, computed by one function,
// creditOf, so the panel and the Биржа show the same number a lender sees.

const U = require('./util');
const tokenchain = require('./tokenchain');
const events = require('./events');

const now = () => Math.floor(Date.now() / 1000);
const TUG = 100000000;

const DEFAULTS = {
  enabled: true,
  minAmount: 10 * TUG,
  maxAmount: 5000 * TUG,
  maxRate: 0.5,            // fifty percent for the term, whatever the term
  maxTermDays: 30,
  minRounds: 5,            // finished rounds on the record before a first loan
  firstLoanFloor: 100 * TUG,
  repaidMultiple: 3,
};
const settings = (cfg) => ({ ...DEFAULTS, ...((cfg && cfg.credit) || {}) });

/** What a loan costs in full: the principal plus the interest fixed when it was offered. */
const owed = (principal, rate) => principal + Math.floor(principal * rate);

// ----------------------------------------------------------------- lobby
function keyOf(db, userId) {
  const key = tokenchain.keyFor(db, userId);
  if (!key) throw new U.BadRequest('create a token wallet first');
  return key.pubkey;
}

/**
 * The credit line, from the record. One function, so every screen agrees.
 */
function creditOf(db, cfg, userId) {
  const s = settings(cfg);
  const user = db.get('SELECT frozen, banned FROM users WHERE id=?', userId);
  const finished = db.get(
    'SELECT COUNT(*) AS n FROM token_rounds WHERE user_id=? AND closed_at IS NOT NULL', userId,
  ).n;
  const repaid = db.get(
    "SELECT COALESCE(SUM(repaid),0) AS n FROM loans WHERE borrower_id=? AND state='repaid'", userId,
  ).n;
  const open = db.all("SELECT * FROM loans WHERE borrower_id=? AND state IN ('open','defaulted')", userId);
  const defaulted = open.some((l) => l.state === 'defaulted' || l.due <= now());
  const outstanding = open.reduce((n, l) => n + (owed(l.principal, l.rate) - l.repaid), 0);
  const cap = Math.max(s.firstLoanFloor, Math.floor(s.repaidMultiple * repaid));
  let why = null;
  if (!user) why = 'no such account';
  else if (user.banned || user.frozen) why = 'the account is under review';
  else if (finished < s.minRounds) why = `${finished} of ${s.minRounds} finished rounds on the record`;
  else if (defaulted) why = 'a loan is in default';
  return {
    eligible: why === null,
    why,
    cap,
    available: why === null ? Math.max(0, cap - outstanding) : 0,
    finished,
    repaid,
    outstanding,
    openLoans: open.length,
  };
}

const offerView = (o) => ({
  id: o.id,
  lender: o.lender_pubkey.slice(0, 8),
  lenderId: o.lender_id,
  amount: o.amount,
  rate: o.rate,
  termDays: o.term_days,
  repay: owed(o.amount, o.rate),
  state: o.state,
  createdAt: o.created_at,
});

const loanView = (l) => ({
  id: l.id,
  offerId: l.offer_id,
  lenderId: l.lender_id,
  lender: l.lender_pubkey,
  borrowerId: l.borrower_id,
  borrower: l.borrower_pubkey.slice(0, 8),
  principal: l.principal,
  rate: l.rate,
  owed: owed(l.principal, l.rate),
  repaid: l.repaid,
  outstanding: owed(l.principal, l.rate) - l.repaid,
  due: l.due,
  overdue: l.state === 'open' && l.due <= now(),
  state: l.state,
  loanHeight: l.loan_height,
});

function lobby(db, cfg, user) {
  const s = settings(cfg);
  const open = db.all("SELECT * FROM loan_offers WHERE state='open' ORDER BY rate ASC, id ASC LIMIT 100");
  const mineOffers = user ? db.all("SELECT * FROM loan_offers WHERE lender_id=? AND state='open' ORDER BY id DESC", user.id) : [];
  const borrowed = user ? db.all('SELECT * FROM loans WHERE borrower_id=? ORDER BY id DESC LIMIT 50', user.id) : [];
  const lent = user ? db.all('SELECT * FROM loans WHERE lender_id=? ORDER BY id DESC LIMIT 50', user.id) : [];
  const key = user ? tokenchain.keyFor(db, user.id) : null;
  return {
    enabled: s.enabled && cfg.token.enabled,
    symbol: cfg.token.symbol,
    dials: {
      minAmount: s.minAmount, maxAmount: s.maxAmount, maxRate: s.maxRate,
      maxTermDays: s.maxTermDays, minRounds: s.minRounds,
    },
    houseKey: tokenchain.houseKeyRaw(db),
    pubkey: key ? key.pubkey : null,
    nextNonce: key ? tokenchain.nextNonce(db, key.pubkey) : 0,
    balance: key ? tokenchain.balanceOf(db, key.pubkey) : 0,
    credit: user ? creditOf(db, cfg, user.id) : null,
    offers: open.map(offerView),
    myOffers: mineOffers.map(offerView),
    borrowed: borrowed.map(loanView),
    lent: lent.map(loanView),
  };
}

// --------------------------------------------------------------- lending
function requireOpen(db, cfg, user) {
  const s = settings(cfg);
  if (!cfg.token.enabled) throw new U.BadRequest('the site token is disabled');
  if (!s.enabled) throw new U.BadRequest('the exchange is closed');
  if (user.frozen) throw new U.Forbidden('account frozen');
  return s;
}

/** Post an offer. The funds go into escrow now, under the lender's own signature. */
function postOffer(db, cfg, user, { amount, rate, termDays, spend }) {
  const s = requireOpen(db, cfg, user);
  const units = U.parseAmount(amount);
  const r = Number(rate);
  const days = U.toInt(termDays, { min: 1, max: s.maxTermDays, name: 'termDays' });
  if (units < s.minAmount || units > s.maxAmount) {
    throw new U.BadRequest(`an offer is ${U.formatAmount(s.minAmount)} to ${U.formatAmount(s.maxAmount)} ${cfg.token.symbol}`);
  }
  if (!Number.isFinite(r) || r < 0 || r > s.maxRate) throw new U.BadRequest(`the rate is 0 to ${s.maxRate * 100}% for the term`);
  const fixed = Math.round(r * 10000) / 10000;
  const pubkey = keyOf(db, user.id);
  if (!spend || String(spend.from || '').toLowerCase() !== pubkey) {
    throw new U.Forbidden('that key is not registered to this account');
  }
  return db.tx(() => {
    const { escrow } = require('./match');
    const block = escrow(db, spend, units);
    db.run(
      `INSERT INTO loan_offers(lender_id, lender_pubkey, amount, rate, term_days, state, escrow_height, created_at)
       VALUES(?,?,?,?,?,'open',?,?)`,
      user.id, pubkey, units, fixed, days, block.height, now(),
    );
    const id = db.get('SELECT last_insert_rowid() AS id').id;
    events.emit(db, cfg, { g: 'credit', r: id, k: 'o', a: ['offer', units, fixed, days], userId: user.id, pubkey });
    db.audit(`user:${user.id}`, 'credit.offer', { id, amount: units, rate: fixed, days, height: block.height });
    return { id, amount: units, rate: fixed, termDays: days, repay: owed(units, fixed), height: block.height };
  });
}

/** Take an untaken offer back. The escrow refund a cancelled match gets. */
function withdrawOffer(db, cfg, user, offerId) {
  requireOpen(db, cfg, user);
  return db.tx(() => {
    const o = db.get('SELECT * FROM loan_offers WHERE id=?', Number(offerId));
    if (!o) throw new U.NotFound('no such offer');
    if (o.lender_id !== user.id) throw new U.Forbidden('not your offer');
    if (o.state !== 'open') throw new U.BadRequest('that offer is no longer open');
    const { houseTransfer } = require('./match');
    const block = tokenchain.appendBlock(db, [houseTransfer(db, o.lender_pubkey, o.amount)]);
    db.run("UPDATE loan_offers SET state='withdrawn' WHERE id=?", o.id);
    events.emit(db, cfg, { g: 'credit', r: o.id, k: 'q', a: ['withdrawn'] });
    events.close(db, { g: 'credit', r: o.id });
    db.audit(`user:${user.id}`, 'credit.withdraw', { id: o.id, height: block.height });
    return { id: o.id, refunded: o.amount, height: block.height };
  });
}

/** Take an offer: the escrow releases to the borrower with a `loan` on the chain. */
function takeOffer(db, cfg, user, offerId) {
  requireOpen(db, cfg, user);
  const pubkey = keyOf(db, user.id);
  return db.tx(() => {
    const o = db.get('SELECT * FROM loan_offers WHERE id=?', Number(offerId));
    if (!o) throw new U.NotFound('no such offer');
    if (o.state !== 'open') throw new U.BadRequest('that offer is no longer open');
    if (o.lender_id === user.id) throw new U.BadRequest('you cannot take your own offer');
    const line = creditOf(db, cfg, user.id);
    if (!line.eligible) throw new U.BadRequest(`not eligible to borrow: ${line.why}`);
    if (o.amount > line.available) {
      throw new U.BadRequest(`your credit line has ${U.formatAmount(line.available)} ${cfg.token.symbol} left`);
    }
    const due = now() + o.term_days * 86400;
    db.run(
      `INSERT INTO loans(offer_id, lender_id, lender_pubkey, borrower_id, borrower_pubkey, principal, rate, due,
                         repaid, state, created_at)
       VALUES(?,?,?,?,?,?,?,?,0,'open',?)`,
      o.id, o.lender_id, o.lender_pubkey, user.id, pubkey, o.amount, o.rate, due, now(),
    );
    const id = db.get('SELECT last_insert_rowid() AS id').id;
    const block = tokenchain.appendBlock(db, [{
      type: 'loan', from: tokenchain.houseKeyRaw(db), to: pubkey, amount: o.amount,
      id, offer: o.id, lender: o.lender_pubkey, rate: o.rate, due,
    }]);
    db.run('UPDATE loans SET loan_height=? WHERE id=?', block.height, id);
    db.run("UPDATE loan_offers SET state='taken', taken_at=? WHERE id=?", now(), o.id);
    events.emit(db, cfg, { g: 'credit', r: o.id, k: 'p', a: ['taken', id, pubkey.slice(0, 8), due] });
    db.audit(`user:${user.id}`, 'credit.take', { offer: o.id, loan: id, amount: o.amount, due, height: block.height });
    return { loanId: id, principal: o.amount, rate: o.rate, owed: owed(o.amount, o.rate), due, height: block.height };
  });
}

/**
 * Repay, in part or in full, under the borrower's own signature bound to this loan.
 * Paying the last of it closes the loan and thaws an account frozen for it.
 */
function repay(db, cfg, user, { loanId, tx }) {
  if (!cfg.token.enabled) throw new U.BadRequest('the site token is disabled');
  const pubkey = keyOf(db, user.id);
  return db.tx(() => {
    const l = db.get('SELECT * FROM loans WHERE id=?', Number(loanId));
    if (!l) throw new U.NotFound('no such loan');
    if (l.borrower_id !== user.id) throw new U.Forbidden('not your loan');
    if (l.state === 'repaid') throw new U.BadRequest('that loan is settled');
    const clean = {
      type: 'repay',
      from: String(tx?.from || '').toLowerCase(),
      to: l.lender_pubkey,
      amount: Number(tx?.amount),
      nonce: Number(tx?.nonce),
      loan: l.id,
      sig: String(tx?.sig || '').toLowerCase(),
    };
    if (clean.from !== pubkey) throw new U.Forbidden('that key is not registered to this account');
    const left = owed(l.principal, l.rate) - l.repaid;
    if (!Number.isSafeInteger(clean.amount) || clean.amount <= 0) throw new U.BadRequest('bad amount');
    if (clean.amount > left) throw new U.BadRequest(`only ${U.formatAmount(left)} ${cfg.token.symbol} is outstanding`);
    if (!Number.isSafeInteger(clean.nonce) || clean.nonce < 0) throw new U.BadRequest('bad nonce');
    if (!tokenchain.verifyRepaySignature(clean)) throw new U.BadRequest('signature does not match this repayment');
    if (db.get('SELECT 1 FROM token_nonces WHERE pubkey=? AND nonce=?', clean.from, clean.nonce)) {
      throw new U.BadRequest('that nonce has already been used');
    }
    if (tokenchain.balanceOf(db, clean.from) < clean.amount) throw new U.BadRequest('not enough tugriks');
    db.run('INSERT INTO token_nonces(pubkey, nonce, created_at) VALUES(?,?,?)', clean.from, clean.nonce, now());
    const block = tokenchain.appendBlock(db, [clean]);
    const repaid = l.repaid + clean.amount;
    const done = repaid >= owed(l.principal, l.rate);
    db.run("UPDATE loans SET repaid=?, state=?, settled_at=? WHERE id=?",
      repaid, done ? 'repaid' : 'open', done ? now() : null, l.id);
    if (done) thawIfSettled(db, user.id);
    events.emit(db, cfg, { g: 'credit', r: l.offer_id, k: done ? 'c' : 'p', a: ['repaid', l.id, clean.amount, repaid] });
    if (done) events.close(db, { g: 'credit', r: l.offer_id });
    db.audit(`user:${user.id}`, 'credit.repay', { loan: l.id, amount: clean.amount, repaid, done, height: block.height });
    return { loanId: l.id, repaid, outstanding: owed(l.principal, l.rate) - repaid, settled: done, height: block.height };
  });
}

/** An account frozen for a debt is thawed when no debt is left open. */
function thawIfSettled(db, userId) {
  const user = db.get('SELECT * FROM users WHERE id=?', userId);
  if (!user || !user.frozen || user.banned) return;
  if (!String(user.frozen_why || '').startsWith('loan ')) return;
  const stillOwed = db.get(
    "SELECT COUNT(*) AS n FROM loans WHERE borrower_id=? AND state='defaulted'", userId,
  ).n;
  if (stillOwed) return;
  db.run('UPDATE users SET frozen=0, frozen_why=NULL, frozen_blocks=NULL WHERE id=?', userId);
  db.audit('system', 'credit.thaw', { userId });
}

/**
 * Defaults: a loan past due is collected from what the borrower holds, on the chain,
 * and what is short freezes the account with the debt on record.
 *
 * Runs with the match sweeper. One seize per loan: the rest is the borrower's to repay,
 * and repaying in full is what thaws them.
 */
function sweepDefaults(db, cfg, at = now()) {
  const out = { seized: 0, frozen: 0, amount: 0 };
  if (!cfg.token.enabled || !settings(cfg).enabled) return out;
  const late = db.all("SELECT * FROM loans WHERE state='open' AND due <= ? AND seized_at IS NULL", at);
  for (const l of late) {
    try {
      db.tx(() => {
        const left = owed(l.principal, l.rate) - l.repaid;
        const held = tokenchain.balanceOf(db, l.borrower_pubkey);
        const amount = Math.min(left, held);
        let height = null;
        if (amount > 0) {
          const block = tokenchain.appendBlock(db, [{
            type: 'seize', from: l.borrower_pubkey, to: l.lender_pubkey, amount, loan: l.id, at: l.loan_height,
          }]);
          height = block.height;
          out.seized += 1;
          out.amount += amount;
        }
        const repaid = l.repaid + amount;
        const done = repaid >= owed(l.principal, l.rate);
        db.run("UPDATE loans SET repaid=?, seized_at=?, state=?, settled_at=? WHERE id=?",
          repaid, at, done ? 'repaid' : 'defaulted', done ? at : null, l.id);
        if (!done) {
          const short = owed(l.principal, l.rate) - repaid;
          db.run("UPDATE users SET frozen=1, frozen_why=?, frozen_blocks=? WHERE id=? AND banned=0",
            `loan ${l.id} in default: ${U.formatAmount(short)} ${cfg.token.symbol} still owed`,
            JSON.stringify(height === null ? [l.loan_height] : [l.loan_height, height]), l.borrower_id);
          out.frozen += 1;
        }
        events.emit(db, cfg, { g: 'credit', r: l.offer_id, k: done ? 'c' : 'x', a: ['default', l.id, amount, repaid] });
        if (done) events.close(db, { g: 'credit', r: l.offer_id });
        db.audit('system', 'credit.default', { loan: l.id, seized: amount, short: done ? 0 : owed(l.principal, l.rate) - repaid, height });
      });
    } catch (e) {
      out.failed = (out.failed || 0) + 1;
    }
  }
  return out;
}

/** A defaulted loan the borrower comes back to: repay() works on it like any other. */
function reopenForRepay(l) { return l; }

/** For the doctor: what the escrow owes to untaken offers, and what is past due. */
function health(db) {
  const offered = db.get("SELECT COALESCE(SUM(amount),0) AS n FROM loan_offers WHERE state='open'").n;
  const pastDue = db.get("SELECT COUNT(*) AS n FROM loans WHERE state='open' AND due <= ? AND seized_at IS NULL", now()).n;
  const defaulted = db.get("SELECT COUNT(*) AS n FROM loans WHERE state='defaulted'").n;
  const open = db.get("SELECT COUNT(*) AS n FROM loans WHERE state='open'").n;
  return { offered, pastDue, defaulted, open };
}

module.exports = {
  DEFAULTS, settings, owed, creditOf, lobby, postOffer, withdrawOffer, takeOffer, repay,
  sweepDefaults, health, thawIfSettled, reopenForRepay,
};
