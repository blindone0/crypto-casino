'use strict';
// The Биржа: lending between members of the chain, with every movement on it.
//
// What this file holds to: posting an offer escrows the lender's funds under the lender's
// own signature and the doctor's escrow check sees them; taking it releases the escrow to
// the borrower with a `loan` the chain records; repaying is the borrower's signature,
// bound to the loan; a loan past due is seized to the lender, at most what is outstanding
// and at most what is held, and what is short freezes the borrower until it is repaid;
// and the four words that make the lender's seize safe are refused, one at a time, by
// applyTx and by both verifiers. The supply is what it was after every step. The test
// that the operator cannot sign a transfer out of a player account is in
// tokenchain.test.js and unmodified.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { testConfig, openTestDb, cleanup, ROOT } = require('./helpers');
const tc = require('../src/tokenchain');
const events = require('../src/events');
const loans = require('../src/loans');
const matches = require('../src/match');
const doctor = require('../src/doctor');

const TUG = 100000000;
const DAY = 86400;
const BROWSER = pathToFileURL(path.join(ROOT, 'public', 'chainverify.js')).href;

function setup(overrides = {}) {
  const cfg = testConfig(overrides);
  const db = openTestDb(cfg);
  const keys = {};
  for (const [id, name] of [[1, 'alice'], [2, 'bob'], [3, 'carol']]) {
    db.run(
      `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
       VALUES(?,?,?,'x','seed',?,0)`, id, name, name, `rc${id}`,
    );
    const priv = tc.privateKeyFromSeed(crypto.randomBytes(32).toString('hex'));
    const pub = tc.rawPublicKey(crypto.createPublicKey(priv));
    db.tx(() => tc.registerKey(db, id, pub, cfg));
    keys[name] = { priv, pub, id };
  }
  db.tx(() => tc.appendBlock(db, [tc.treasuryTransfer(db, matches.houseKey(db).publicRaw, 500 * TUG)]));
  const user = (id) => db.get('SELECT * FROM users WHERE id=?', id);
  return { cfg, db, keys, user, house: matches.houseKey(db).publicRaw };
}

/** A signed transfer into escrow, the way the browser signs one. */
function spend(db, key, amount) {
  const tx = { type: 'transfer', from: key.pub, to: matches.houseKey(db).publicRaw, amount, nonce: tc.nextNonce(db, key.pub) };
  const sig = crypto.sign(null, Buffer.from(tc.canonical(tc.transferPayload(tx))), key.priv).toString('hex');
  return { from: key.pub, nonce: tx.nonce, sig };
}

/** A repayment signed by the borrower, bound to the loan. */
function repayTx(db, key, to, amount, loan) {
  const tx = { from: key.pub, to, amount, nonce: tc.nextNonce(db, key.pub), loan };
  const sig = crypto.sign(null, Buffer.from(tc.canonical(tc.repayPayload(tx))), key.priv).toString('hex');
  return { from: key.pub, amount, nonce: tx.nonce, sig };
}

/** An ordinary signed transfer between players. */
function send(db, key, to, amount) {
  const tx = { type: 'transfer', from: key.pub, to, amount, nonce: tc.nextNonce(db, key.pub) };
  const sig = crypto.sign(null, Buffer.from(tc.canonical(tc.transferPayload(tx))), key.priv).toString('hex');
  return tc.submitTransfer(db, { ...tx, sig });
}

/**
 * Make a loan past due. The chain's own due date is what a seize is checked against, so
 * the loan's block is rewritten to a due date in the past and re-signed, as an operator
 * could, the blocks after it relinked, and the checkpoints dropped; the table follows.
 */
function backdate(db, loan) {
  const past = Math.floor(Date.now() / 1000) - 100;
  const key = tc.serverKey(db);
  const first = db.get('SELECT * FROM token_blocks WHERE height=?', loan.height);
  const rest = db.all('SELECT * FROM token_blocks WHERE height > ? ORDER BY height', loan.height);
  const txs = JSON.parse(first.txs);
  txs[0].due = past;
  let prev = first.prev_hash;
  for (const b of [{ ...first, txs }, ...rest.map((r) => ({ ...r, txs: JSON.parse(r.txs) }))]) {
    const h = tc.blockHash({ height: b.height, prevHash: prev, timestamp: b.created_at, txs: b.txs });
    db.run('UPDATE token_blocks SET prev_hash=?, txs=?, hash=?, signature=? WHERE height=?',
      prev, JSON.stringify(b.txs), h, crypto.sign(null, Buffer.from(h), key.private).toString('hex'), b.height);
    prev = h;
  }
  db.run('DELETE FROM token_checkpoints');
  db.run('UPDATE loans SET due=? WHERE id=?', past, loan.loanId);
}

/** Finished rounds on the record, which is what a credit line is made of. */
function rounds(db, cfg, key, n) {
  for (let r = 0; r < n; r += 1) {
    db.tx(() => {
      events.emit(db, cfg, { g: 'dice', r: 1000 * key.id + r, k: 'f', a: [1], userId: key.id, pubkey: key.pub });
      events.close(db, { g: 'dice', r: 1000 * key.id + r });
    });
  }
}

async function bothVerify(db) {
  const server = tc.verifyChain(db);
  assert.ok(server.ok, server.reason);
  const { verifyChain } = await import(BROWSER);
  const browser = await verifyChain({ fetchSlice: async (from) => tc.chainSlice(db, from, 500) });
  assert.ok(browser.ok, browser.reason);
  assert.strictEqual(browser.head, server.head);
  return { server, browser };
}

const bal = (db, key) => tc.balanceOf(db, key.pub);

test('an offer escrows the lender\'s funds, the doctor sees them owed, and a withdrawal returns them', async (t) => {
  const { cfg, db, keys, user } = setup();
  t.after(() => cleanup(cfg, db));
  const alice = keys.alice;
  const supply = tc.supply(db).circulating;
  const owedBefore = matches.escrowHealth(db).owed;

  const offer = loans.postOffer(db, cfg, user(1), { amount: '100', rate: 0.1, termDays: 7, spend: spend(db, alice, 100 * TUG) });
  assert.strictEqual(offer.amount, 100 * TUG);
  assert.strictEqual(offer.repay, 110 * TUG, 'the repayment figure is fixed when the offer is posted');
  assert.strictEqual(bal(db, alice), cfg.token.welcomeGrant - 100 * TUG, 'escrowed, under her own signature');
  assert.strictEqual(matches.escrowHealth(db).owed, owedBefore + 100 * TUG, 'the doctor knows the escrow owes it');
  assert.ok(doctor.escrowCovered(db, cfg).ok);
  assert.match(doctor.loansHealthy(db, cfg).detail, /100\.00000000 offered/);

  const lobby = loans.lobby(db, cfg, user(2));
  assert.strictEqual(lobby.offers.length, 1);
  assert.strictEqual(lobby.offers[0].lender, alice.pub.slice(0, 8));
  assert.deepStrictEqual(loans.lobby(db, cfg, user(1)).myOffers.map((o) => o.id), [offer.id]);

  assert.throws(() => loans.withdrawOffer(db, cfg, user(2), offer.id), /not your offer/);
  const back = loans.withdrawOffer(db, cfg, user(1), offer.id);
  assert.strictEqual(back.refunded, 100 * TUG);
  assert.strictEqual(bal(db, alice), cfg.token.welcomeGrant);
  assert.strictEqual(matches.escrowHealth(db).owed, owedBefore);
  assert.throws(() => loans.withdrawOffer(db, cfg, user(1), offer.id), /no longer open/);

  // The dials hold.
  assert.throws(() => loans.postOffer(db, cfg, user(1), { amount: '1', rate: 0.1, termDays: 7, spend: spend(db, alice, 1 * TUG) }), /offer is/);
  assert.throws(() => loans.postOffer(db, cfg, user(1), { amount: '100', rate: 0.9, termDays: 7, spend: spend(db, alice, 100 * TUG) }), /rate is/);
  assert.throws(() => loans.postOffer(db, cfg, user(1), { amount: '100', rate: 0.1, termDays: 90, spend: spend(db, alice, 100 * TUG) }), /termDays/);
  assert.strictEqual(tc.supply(db).circulating, supply);
  await bothVerify(db);
});

test('taking an offer releases the escrow to the borrower with a loan on the chain; the record decides who may', async (t) => {
  const { cfg, db, keys, user, house } = setup();
  t.after(() => cleanup(cfg, db));
  const { alice, bob } = keys;
  const offer = loans.postOffer(db, cfg, user(1), { amount: '100', rate: 0.1, termDays: 7, spend: spend(db, alice, 100 * TUG) });

  assert.throws(() => loans.takeOffer(db, cfg, user(1), offer.id), /your own offer/);
  assert.throws(() => loans.takeOffer(db, cfg, user(2), offer.id), /not eligible.*0 of 5 finished rounds/);
  rounds(db, cfg, bob, 5);
  const line = loans.creditOf(db, cfg, 2);
  assert.strictEqual(line.eligible, true);
  assert.strictEqual(line.cap, cfg.credit.firstLoanFloor);

  const before = bal(db, bob);
  const loan = loans.takeOffer(db, cfg, user(2), offer.id);
  assert.strictEqual(loan.principal, 100 * TUG);
  assert.strictEqual(loan.owed, 110 * TUG);
  assert.ok(loan.due > Math.floor(Date.now() / 1000) + 6 * DAY);
  assert.strictEqual(bal(db, bob), before + 100 * TUG, 'released from escrow to the borrower');
  assert.strictEqual(matches.escrowHealth(db).owed, 0, 'and the escrow owes nothing for it now');

  const tx = JSON.parse(db.get('SELECT txs FROM token_blocks WHERE height=?', loan.height).txs)[0];
  assert.strictEqual(tx.type, 'loan');
  assert.strictEqual(tx.from, house, 'from the escrow key');
  assert.strictEqual(tx.to, bob.pub);
  assert.strictEqual(tx.lender, alice.pub);
  assert.strictEqual(tx.rate, 0.1);
  assert.strictEqual(tx.due, loan.due);

  const bobs = loans.lobby(db, cfg, user(2));
  assert.strictEqual(bobs.borrowed[0].outstanding, 110 * TUG);
  assert.strictEqual(bobs.credit.available, 0, 'the first line is spent');
  assert.strictEqual(loans.lobby(db, cfg, user(1)).lent[0].borrower, bob.pub.slice(0, 8));

  // Another offer is beyond the line now.
  loans.postOffer(db, cfg, user(3), { amount: '50', rate: 0.05, termDays: 3, spend: spend(db, keys.carol, 50 * TUG) });
  assert.throws(() => loans.takeOffer(db, cfg, user(2), 2), /credit line/);
  await bothVerify(db);
});

test('repaying is the borrower\'s signature bound to the loan, and the last of it closes the loan', async (t) => {
  const { cfg, db, keys, user } = setup();
  t.after(() => cleanup(cfg, db));
  const { alice, bob } = keys;
  const supply = tc.supply(db).circulating;
  loans.postOffer(db, cfg, user(1), { amount: '100', rate: 0.1, termDays: 7, spend: spend(db, alice, 100 * TUG) });
  rounds(db, cfg, bob, 5);
  const loan = loans.takeOffer(db, cfg, user(2), 1);
  const aliceBefore = bal(db, alice);

  // A signature over the wrong payload — a plain transfer — is not a repayment.
  const wrong = { type: 'transfer', from: bob.pub, to: alice.pub, amount: 50 * TUG, nonce: tc.nextNonce(db, bob.pub) };
  const wrongSig = crypto.sign(null, Buffer.from(tc.canonical(tc.transferPayload(wrong))), bob.priv).toString('hex');
  assert.throws(() => loans.repay(db, cfg, user(2), { loanId: loan.loanId, tx: { ...wrong, sig: wrongSig } }), /signature does not match/);
  assert.throws(() => loans.repay(db, cfg, user(1), { loanId: loan.loanId, tx: repayTx(db, alice, alice.pub, 1, loan.loanId) }), /not your loan/);
  assert.throws(() => loans.repay(db, cfg, user(2), { loanId: loan.loanId, tx: repayTx(db, bob, alice.pub, 200 * TUG, loan.loanId) }), /outstanding/);

  const part = loans.repay(db, cfg, user(2), { loanId: loan.loanId, tx: repayTx(db, bob, alice.pub, 50 * TUG, loan.loanId) });
  assert.strictEqual(part.settled, false);
  assert.strictEqual(part.outstanding, 60 * TUG);
  assert.strictEqual(bal(db, alice), aliceBefore + 50 * TUG);
  const paid = repayTx(db, bob, alice.pub, 60 * TUG, loan.loanId);
  const rest = loans.repay(db, cfg, user(2), { loanId: loan.loanId, tx: paid });
  assert.strictEqual(rest.settled, true);
  assert.strictEqual(rest.outstanding, 0);
  assert.strictEqual(bal(db, alice), aliceBefore + 110 * TUG, 'principal and the interest fixed at post time');
  assert.throws(() => loans.repay(db, cfg, user(2), { loanId: loan.loanId, tx: paid }), /settled/);
  assert.strictEqual(db.get('SELECT state FROM loans WHERE id=?', loan.loanId).state, 'repaid');
  assert.strictEqual(loans.creditOf(db, cfg, 2).cap, 3 * 110 * TUG, 'the line grows with what has been repaid');

  const tx = JSON.parse(db.get('SELECT txs FROM token_blocks WHERE height=?', rest.height).txs)[0];
  assert.strictEqual(tx.type, 'repay');
  assert.strictEqual(tx.loan, loan.loanId);
  assert.strictEqual(tc.supply(db).circulating, supply);
  const { server } = await bothVerify(db);
  assert.strictEqual(server.loans.get(loan.loanId).repaid, 110 * TUG, 'the verifier followed the loan to its end');
});

test('a loan past due is seized to the lender, capped at what is held; the shortfall freezes the borrower until repaid', async (t) => {
  const { cfg, db, keys, user } = setup();
  t.after(() => cleanup(cfg, db));
  const { alice, bob } = keys;
  const supply = tc.supply(db).circulating;
  loans.postOffer(db, cfg, user(1), { amount: '100', rate: 0.1, termDays: 1, spend: spend(db, alice, 100 * TUG) });
  rounds(db, cfg, bob, 5);
  const loan = loans.takeOffer(db, cfg, user(2), 1);
  // Bob spends nearly all of it elsewhere, keeping fifty.
  send(db, bob, keys.carol.pub, bal(db, bob) - 50 * TUG);
  assert.strictEqual(bal(db, bob), 50 * TUG);

  assert.deepStrictEqual(loans.sweepDefaults(db, cfg), { seized: 0, frozen: 0, amount: 0 }, 'not due yet');
  backdate(db, loan);
  assert.strictEqual(loans.creditOf(db, cfg, 2).eligible, false);

  const aliceBefore = bal(db, alice);
  const swept = loans.sweepDefaults(db, cfg);
  assert.deepStrictEqual(swept, { seized: 1, frozen: 1, amount: 50 * TUG });
  assert.strictEqual(bal(db, bob), 0, 'what was held went');
  assert.strictEqual(bal(db, alice), aliceBefore + 50 * TUG, 'to the lender');
  const row = db.get('SELECT * FROM loans WHERE id=?', loan.loanId);
  assert.strictEqual(row.state, 'defaulted');
  assert.strictEqual(row.repaid, 50 * TUG);
  const frozen = user(2);
  assert.strictEqual(frozen.frozen, 1);
  assert.match(frozen.frozen_why, /loan 1 in default: 60\.00000000/);
  assert.deepStrictEqual(JSON.parse(frozen.frozen_blocks), [loan.height, loan.height + 2]);
  const seize = JSON.parse(db.get('SELECT txs FROM token_blocks ORDER BY height DESC LIMIT 1').txs)[0];
  assert.deepStrictEqual(seize, { type: 'seize', from: bob.pub, to: alice.pub, amount: 50 * TUG, loan: loan.loanId, at: loan.height });
  assert.deepStrictEqual(loans.sweepDefaults(db, cfg), { seized: 0, frozen: 0, amount: 0 }, 'one seize per loan');
  assert.match(doctor.loansHealthy(db, cfg).detail, /1 in default/);
  await bothVerify(db);

  // Bob is given the means and pays the rest: the loan closes and the account thaws.
  send(db, keys.carol, bob.pub, 60 * TUG);
  const rest = loans.repay(db, cfg, user(2), { loanId: loan.loanId, tx: repayTx(db, bob, alice.pub, 60 * TUG, loan.loanId) });
  assert.strictEqual(rest.settled, true);
  assert.strictEqual(user(2).frozen, 0, 'repaying in full thaws the account');
  assert.strictEqual(user(2).frozen_why, null);
  assert.strictEqual(bal(db, alice), aliceBefore + 110 * TUG);
  assert.strictEqual(tc.supply(db).circulating, supply);
  await bothVerify(db);
});

test('the four words: a seize for a loan is refused when any of them fails, by applyTx and by both verifiers', async (t) => {
  const { cfg, db, keys, user, house } = setup();
  t.after(() => cleanup(cfg, db));
  const { alice, bob, carol } = keys;
  loans.postOffer(db, cfg, user(1), { amount: '100', rate: 0.1, termDays: 1, spend: spend(db, alice, 100 * TUG) });
  rounds(db, cfg, bob, 5);
  const loan = loans.takeOffer(db, cfg, user(2), 1);
  const seizeTx = (over = {}) => ({ type: 'seize', from: bob.pub, to: alice.pub, amount: 10 * TUG, loan: loan.loanId, at: loan.height, ...over });

  // Not yet due.
  assert.throws(() => db.tx(() => tc.appendBlock(db, [seizeTx()])), /before it is due/);
  backdate(db, loan);
  assert.ok(tc.verifyChain(db).ok, 'the rewritten chain verifies on its own terms');

  assert.throws(() => db.tx(() => tc.appendBlock(db, [seizeTx({ to: carol.pub })])), /from its borrower to its lender/);
  assert.throws(() => db.tx(() => tc.appendBlock(db, [seizeTx({ from: carol.pub, to: alice.pub })])), /from its borrower to its lender/);
  assert.throws(() => db.tx(() => tc.appendBlock(db, [seizeTx({ amount: 111 * TUG })])), /at most what is outstanding/);
  assert.throws(() => db.tx(() => tc.appendBlock(db, [seizeTx({ at: loan.height - 1 })])), /not on the chain/);
  assert.throws(() => db.tx(() => tc.appendBlock(db, [seizeTx({ loan: 99 })])), /not on the chain/);
  assert.throws(() => db.tx(() => tc.appendBlock(db, [seizeTx({ ban: 1 })])), /unknown field/);
  assert.throws(() => db.tx(() => tc.appendBlock(db, [{ type: 'loan', from: alice.pub, to: bob.pub, amount: 1, id: 9, offer: 9, lender: alice.pub, rate: 0, due: 1 }])), /from escrow, never from nowhere/);

  // Each one smuggled past applyTx is caught by both verifiers.
  const key = tc.serverKey(db);
  const smuggle = (tx) => {
    const tip = tc.head(db);
    const block = { height: tip.height + 1, prevHash: tip.hash, timestamp: Math.floor(Date.now() / 1000), txs: [tx] };
    const h = tc.blockHash(block);
    db.run('INSERT INTO token_blocks(height, prev_hash, hash, txs, signature, created_at) VALUES(?,?,?,?,?,?)',
      block.height, block.prevHash, h, JSON.stringify([tx]), crypto.sign(null, Buffer.from(h), key.private).toString('hex'), block.timestamp);
    return block.height;
  };
  const { verifyChain } = await import(BROWSER);
  const browser = () => verifyChain({ fetchSlice: async (from) => tc.chainSlice(db, from, 500) });
  for (const [bad, server, client] of [
    [seizeTx({ to: carol.pub }), /wrong way round/, /wrong way round/],
    [seizeTx({ amount: 111 * TUG }), /more than is outstanding/, /more than is outstanding/],
    [seizeTx({ loan: 99 }), /not on the chain/, /not on the chain/],
    [{ type: 'loan', from: alice.pub, to: bob.pub, amount: 1, id: 9, offer: 9, lender: alice.pub, rate: 0, due: 1 }, /not the escrow/, /not the escrow/],
  ]) {
    const h = smuggle(bad);
    const s = tc.verifyChain(db);
    assert.strictEqual(s.ok, false, JSON.stringify(bad));
    assert.match(s.reason, server);
    const b = await browser();
    assert.strictEqual(b.ok, false);
    assert.match(b.reason, client);
    assert.strictEqual(b.height, h);
    db.run('DELETE FROM token_blocks WHERE height=?', h);
  }

  // And the one that keeps all four words is accepted by all three.
  db.tx(() => tc.appendBlock(db, [seizeTx({ amount: 10 * TUG })]));
  assert.ok(tc.verifyChain(db).ok);
  assert.ok((await browser()).ok);
});

test('a checkpoint carries the loans, so a verify from it still holds a later repayment to what is owed', async (t) => {
  const { cfg, db, keys, user } = setup();
  t.after(() => cleanup(cfg, db));
  const { alice, bob } = keys;
  loans.postOffer(db, cfg, user(1), { amount: '100', rate: 0.1, termDays: 7, spend: spend(db, alice, 100 * TUG) });
  rounds(db, cfg, bob, 5);
  const loan = loans.takeOffer(db, cfg, user(2), 1);
  loans.repay(db, cfg, user(2), { loanId: loan.loanId, tx: repayTx(db, bob, alice.pub, 50 * TUG, loan.loanId) });
  const cp = db.tx(() => tc.writeCheckpoint(db));
  assert.ok(cp.written);
  assert.strictEqual(JSON.parse(tc.latestCheckpoint(db).loans)[loan.loanId].repaid, 50 * TUG);

  loans.repay(db, cfg, user(2), { loanId: loan.loanId, tx: repayTx(db, bob, alice.pub, 60 * TUG, loan.loanId) });
  const fast = tc.verifyChain(db, { checkpoint: true });
  assert.ok(fast.ok, fast.reason);
  assert.strictEqual(fast.from, cp.height);
  assert.strictEqual(fast.loans.get(loan.loanId).repaid, 110 * TUG);
  await bothVerify(db);
});
