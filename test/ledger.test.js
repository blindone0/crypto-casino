'use strict';
// Money handling. These are the tests that matter most: a bug here is not a wrong
// colour on a button, it is money appearing or disappearing.
const test = require('node:test');
const assert = require('node:assert');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const ledger = require('../src/ledger');
const auth = require('../src/auth');
const U = require('../src/util');

function setup(overrides) {
  const cfg = testConfig(overrides);
  const db = openTestDb(cfg);
  const user = auth.register(db, cfg, { username: 'player', password: 'longpassword1' });
  return { cfg, db, user };
}

test('the ledger always balances against account totals', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));

  const house = ledger.houseAccount(db);
  const acct = ledger.userAccount(db, user.id);
  db.tx(() => ledger.mint(db, house.id, 1000000, 'bankroll.in', 'seed'));
  db.tx(() => ledger.transfer(db, house.id, acct.id, 250000, 'test', null));
  db.tx(() => ledger.transfer(db, acct.id, house.id, 100000, 'test', null));

  const audit = ledger.auditBalances(db);
  assert.ok(audit.ok, `accounts ${audit.accounts} != ledger ${audit.ledger}`);
  assert.strictEqual(audit.accounts, 1000000);
  assert.strictEqual(ledger.balanceOf(db, acct.id), 150000);
});

test('a transfer that would go negative writes nothing at all', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));

  const house = ledger.houseAccount(db);
  const acct = ledger.userAccount(db, user.id);
  db.tx(() => ledger.mint(db, house.id, 500, 'bankroll.in', null));

  const ledgerRowsBefore = db.get('SELECT COUNT(*) AS n FROM ledger').n;
  assert.throws(
    () => db.tx(() => ledger.transfer(db, acct.id, house.id, 1, 'overdraft', null)),
    /insufficient funds/,
  );
  // The whole transaction must roll back, leaving no half-written pair.
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM ledger').n, ledgerRowsBefore);
  assert.strictEqual(ledger.balanceOf(db, acct.id), 0);
  assert.ok(ledger.auditBalances(db).ok);
});

test('a throw mid-transaction unwinds every write in it', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));

  const house = ledger.houseAccount(db);
  const acct = ledger.userAccount(db, user.id);
  db.tx(() => ledger.mint(db, house.id, 1000, 'bankroll.in', null));

  assert.throws(() => db.tx(() => {
    ledger.transfer(db, house.id, acct.id, 400, 'first', null);
    ledger.transfer(db, house.id, acct.id, 300, 'second', null);
    throw new Error('boom');
  }), /boom/);

  assert.strictEqual(ledger.balanceOf(db, acct.id), 0);
  assert.strictEqual(ledger.bankroll(db), 1000);
  assert.ok(ledger.auditBalances(db).ok);
});

test('max win per bet is capped at the configured slice of bankroll', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));
  db.tx(() => ledger.mint(db, ledger.houseAccount(db).id, 100 * U.UNIT, 'bankroll.in', null));

  // 1% of a 100-unit bankroll is 1 unit of max profit.
  assert.strictEqual(ledger.maxProfitAllowed(db, cfg), U.UNIT);

  // A 1-credit bet at 2x would win 1 credit of profit: exactly at the cap, so allowed.
  assert.doesNotThrow(() => ledger.checkBetLimits(db, cfg, user, U.UNIT, 2));
  // At 3x it would win 2 credits: over the cap, so refused.
  assert.throws(() => ledger.checkBetLimits(db, cfg, user, U.UNIT, 3), /table limit/);
});

test('bet limits respect the minimum, the maximum and a self-imposed cap', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));
  db.tx(() => ledger.mint(db, ledger.houseAccount(db).id, 10000 * U.UNIT, 'bankroll.in', null));

  assert.throws(() => ledger.checkBetLimits(db, cfg, user, 1, 2), /minimum bet/);
  assert.throws(() => ledger.checkBetLimits(db, cfg, user, cfg.risk.maxBetUnits + 1, 2), /table maximum/);

  db.run('UPDATE users SET max_bet_cap=? WHERE id=?', U.UNIT, user.id);
  const capped = db.get('SELECT * FROM users WHERE id=?', user.id);
  assert.throws(() => ledger.checkBetLimits(db, cfg, capped, 2 * U.UNIT, 2), /self-imposed/);
});

test('frozen and self-excluded accounts cannot bet', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));
  db.tx(() => ledger.mint(db, ledger.houseAccount(db).id, 10000 * U.UNIT, 'bankroll.in', null));

  db.run('UPDATE users SET frozen=1 WHERE id=?', user.id);
  assert.throws(
    () => ledger.checkBetLimits(db, cfg, db.get('SELECT * FROM users WHERE id=?', user.id), U.UNIT, 2),
    /frozen/,
  );
  db.run('UPDATE users SET frozen=0, self_excluded_until=? WHERE id=?',
    Math.floor(Date.now() / 1000) + 3600, user.id);
  assert.throws(
    () => ledger.checkBetLimits(db, cfg, db.get('SELECT * FROM users WHERE id=?', user.id), U.UNIT, 2),
    /self-exclusion/,
  );
});

test('capPayout clamps an unbounded win to what the house can afford', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  db.tx(() => ledger.mint(db, ledger.houseAccount(db).id, 100 * U.UNIT, 'bankroll.in', null));

  const small = ledger.capPayout(db, cfg, U.UNIT, U.UNIT + 1000);
  assert.strictEqual(small.capped, false);
  assert.strictEqual(small.payout, U.UNIT + 1000);

  const huge = ledger.capPayout(db, cfg, U.UNIT, 500 * U.UNIT);
  assert.strictEqual(huge.capped, true);
  assert.strictEqual(huge.payout, U.UNIT + ledger.maxProfitAllowed(db, cfg));
  assert.ok(huge.payout < ledger.bankroll(db), 'the cap must always be payable');
});

test('recordBet writes the round down and moves nothing', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));
  db.tx(() => ledger.mint(db, ledger.houseAccount(db).id, 1000 * U.UNIT, 'bankroll.in', null));

  // `settleBet` used to move the stake and the payout through the credit ledger as well
  // as writing the row. It is `recordBet` now and only writes the row: the money moved on
  // the token chain before this was called, because the only currency is the tugrik and
  // the operator cannot move one without the player's signature.
  const bankBefore = ledger.bankroll(db);
  db.tx(() => ledger.recordBet(db, cfg, {
    user, game: 'dice', wager: U.UNIT, multiplier: 1.98, payout: 198000000,
    edgeUnits: 1000000, seedId: null, nonce: 1, clientSeed: 'c', detail: { t: 1 },
  }));

  assert.strictEqual(ledger.bankroll(db), bankBefore, 'recording a bet moves no credits');
  const bet = db.get('SELECT * FROM bets ORDER BY id DESC LIMIT 1');
  assert.strictEqual(bet.profit, 98000000);
  assert.strictEqual(bet.edge_units, 1000000);
  assert.strictEqual(bet.client_seed, 'c', 'the fairness record is the point of the row');
  assert.ok(ledger.auditBalances(db).ok);
});

test('a round with no fairness seed behind it still records', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));
  // The arcade and a settled match are money moving without a dice roll, and `edge_units`
  // and `client_seed` are NOT NULL. Defaulting them here is what stops a settlement
  // throwing on columns it was never going to fill.
  db.tx(() => ledger.recordBet(db, cfg, {
    user, game: 'match', wager: 5 * U.UNIT, multiplier: 2, payout: 10 * U.UNIT,
  }));
  const bet = db.get('SELECT * FROM bets ORDER BY id DESC LIMIT 1');
  assert.strictEqual(bet.edge_units, 0);
  assert.strictEqual(bet.client_seed, '');
  assert.strictEqual(bet.profit, 5 * U.UNIT);
});

test('affiliate commission and rakeback still work when they are switched on', (t) => {
  // Both ship switched off: they pay into a credit balance that no longer exists, and
  // paying them in tugriks would mean extra chain blocks per bet for an acquisition
  // mechanic this site does not need. The mechanism is kept and tested so turning them
  // back on is a config change rather than a rewrite.
  const { cfg, db, user } = setup({
    referralCommission: 0.20, rakeback: { enabled: true, rate: 0.05 },
  });
  t.after(() => cleanup(cfg, db));
  db.tx(() => ledger.mint(db, ledger.houseAccount(db).id, 1000 * U.UNIT, 'bankroll.in', null));

  db.run('UPDATE users SET referred_by=? WHERE id=?', user.id, user.id);
  const withRef = db.get('SELECT * FROM users WHERE id=?', user.id);

  const edge = 1000000;
  db.tx(() => ledger.recordBet(db, cfg, {
    user: withRef, game: 'dice', wager: U.UNIT, multiplier: 0, payout: 0,
    edgeUnits: edge, seedId: null, nonce: 1, clientSeed: 'c', detail: {},
  }));

  assert.strictEqual(ledger.affiliateAccount(db, user.id).balance, Math.floor(edge * 0.20));
  assert.strictEqual(ledger.userAccount(db, user.id, 'rakeback').balance, Math.floor(edge * 0.05));
  assert.ok(ledger.auditBalances(db).ok, 'both come out of the house, so the books still balance');
});

test('house stats report actual and theoretical revenue separately', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));
  db.tx(() => ledger.mint(db, ledger.houseAccount(db).id, 1000 * U.UNIT, 'bankroll.in', null));
  db.tx(() => ledger.transfer(db, ledger.houseAccount(db).id,
    ledger.userAccount(db, user.id).id, 100 * U.UNIT, 'topup', null));

  for (let i = 0; i < 10; i += 1) {
    db.tx(() => ledger.recordBet(db, cfg, {
      user, game: 'dice', wager: U.UNIT, multiplier: i < 5 ? 1.98 : 0,
      payout: i < 5 ? 198000000 : 0, edgeUnits: 1000000,
      seedId: null, nonce: i, clientSeed: 'c', detail: {},
    }));
  }
  const s = ledger.houseStats(db, 0);
  assert.strictEqual(s.bets, 10);
  assert.strictEqual(s.wagered, 10 * U.UNIT);
  assert.strictEqual(s.ggrTheoretical, 10000000);
  assert.strictEqual(s.ggrActual, s.wagered - s.paid);
  assert.strictEqual(s.perGame[0].game, 'dice');
});

test('a nonce is never handed out twice on the same seed', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));
  const seed = auth.activeSeed(db, user.id);
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const n = db.tx(() => auth.claimNonce(db, seed.id));
    assert.ok(!seen.has(n), `nonce ${n} was reused`);
    seen.add(n);
  }
  assert.strictEqual(seen.size, 500);
});

test('rotating a seed reveals the old one and it matches its published hash', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));
  const fair = require('../src/fair');

  const before = auth.activeSeed(db, user.id);
  const { revealed, active } = auth.rotateSeed(db, user.id);
  assert.strictEqual(revealed.id, before.id);
  assert.strictEqual(fair.sha256hex(revealed.seed), revealed.seed_hash);
  assert.notStrictEqual(active.seed_hash, revealed.seed_hash);
  assert.strictEqual(active.nonce, 0, 'a fresh seed starts its counter at zero');
});

test('operator cannot withdraw capital that backs player balances', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));
  const adminApi = require('../src/admin');

  db.tx(() => ledger.mint(db, ledger.houseAccount(db).id, 100 * U.UNIT, 'bankroll.in', null));
  db.tx(() => ledger.transfer(db, ledger.houseAccount(db).id,
    ledger.userAccount(db, user.id).id, 30 * U.UNIT, 'topup', null));

  // Bankroll is 70, players hold 30, so free capital is 40.
  assert.throws(() => adminApi.removeBankroll(db, 60 * U.UNIT, 'test', null), /free capital/);
  assert.doesNotThrow(() => adminApi.removeBankroll(db, 40 * U.UNIT, 'test', null));
  assert.ok(ledger.auditBalances(db).ok);
});

test('money math never loses or invents units', () => {
  assert.strictEqual(U.parseAmount('1'), 100000000);
  assert.strictEqual(U.parseAmount('0.00000001'), 1);
  assert.strictEqual(U.formatAmount(U.parseAmount('123.45678901')), '123.45678901');
  assert.throws(() => U.parseAmount('1e5'), /invalid amount/);
  assert.throws(() => U.parseAmount('-1'), /invalid amount/);
  assert.throws(() => U.parseAmount('0.000000001'), /invalid amount/);
  // Multiplication always truncates downward, so rounding never favours the player.
  assert.strictEqual(U.mulUnits(3, 1.5), 4);
  assert.strictEqual(U.mulUnits(100000000, 1.98), 198000000);
});
