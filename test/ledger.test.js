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

test('settleBet moves the stake, pays the win and records the edge', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));
  db.tx(() => ledger.mint(db, ledger.houseAccount(db).id, 1000 * U.UNIT, 'bankroll.in', null));
  db.tx(() => ledger.transfer(db, ledger.houseAccount(db).id,
    ledger.userAccount(db, user.id).id, 10 * U.UNIT, 'topup', null));

  const before = ledger.userAccount(db, user.id).balance;
  db.tx(() => ledger.settleBet(db, cfg, {
    user, game: 'dice', wager: U.UNIT, multiplier: 1.98, payout: 198000000,
    edgeUnits: 1000000, seedId: null, nonce: 1, clientSeed: 'c', detail: { t: 1 },
  }));

  const after = ledger.userAccount(db, user.id).balance;
  assert.strictEqual(after - before, 98000000, 'net should be payout minus stake');
  const bet = db.get('SELECT * FROM bets ORDER BY id DESC LIMIT 1');
  assert.strictEqual(bet.profit, 98000000);
  assert.strictEqual(bet.edge_units, 1000000);
  assert.ok(ledger.auditBalances(db).ok);
});

test('a losing bet leaves the stake with the house', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));
  db.tx(() => ledger.mint(db, ledger.houseAccount(db).id, 1000 * U.UNIT, 'bankroll.in', null));
  db.tx(() => ledger.transfer(db, ledger.houseAccount(db).id,
    ledger.userAccount(db, user.id).id, 10 * U.UNIT, 'topup', null));

  const bankBefore = ledger.bankroll(db);
  db.tx(() => ledger.settleBet(db, cfg, {
    user, game: 'dice', wager: U.UNIT, multiplier: 0, payout: 0,
    edgeUnits: 1000000, seedId: null, nonce: 2, clientSeed: 'c', detail: {},
  }));
  // The house keeps the stake, minus the rakeback carved out of the edge.
  const rake = ledger.userAccount(db, user.id, 'rakeback').balance;
  assert.strictEqual(ledger.bankroll(db), bankBefore + U.UNIT - rake);
  assert.ok(rake > 0, 'rakeback should accrue');
  assert.ok(ledger.auditBalances(db).ok);
});

test('affiliate commission and rakeback come out of the edge, never the stake', (t) => {
  const cfg = testConfig({ referralCommission: 0.2, rakeback: { enabled: true, rate: 0.05 } });
  const db = openTestDb(cfg);
  t.after(() => cleanup(cfg, db));

  const boss = auth.register(db, cfg, { username: 'boss', password: 'longpassword1' });
  const player = auth.register(db, cfg, {
    username: 'player', password: 'longpassword1', referralCode: boss.referral_code,
  });
  assert.strictEqual(player.referred_by, boss.id);

  db.tx(() => ledger.mint(db, ledger.houseAccount(db).id, 1000 * U.UNIT, 'bankroll.in', null));
  db.tx(() => ledger.transfer(db, ledger.houseAccount(db).id,
    ledger.userAccount(db, player.id).id, 10 * U.UNIT, 'topup', null));

  const wager = U.UNIT;
  const edgeUnits = Math.floor(wager * 0.01);
  db.tx(() => ledger.settleBet(db, cfg, {
    user: player, game: 'dice', wager, multiplier: 0, payout: 0,
    edgeUnits, seedId: null, nonce: 1, clientSeed: 'c', detail: {},
  }));

  const commission = ledger.affiliateAccount(db, boss.id).balance;
  const rake = ledger.userAccount(db, player.id, 'rakeback').balance;
  assert.strictEqual(commission, Math.floor(edgeUnits * 0.2));
  assert.strictEqual(rake, Math.floor(edgeUnits * 0.05));
  assert.ok(commission + rake < edgeUnits, 'payouts must stay inside the edge');
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM referral_earnings').n, 1);
  assert.ok(ledger.auditBalances(db).ok);
});

test('house stats report actual and theoretical revenue separately', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));
  db.tx(() => ledger.mint(db, ledger.houseAccount(db).id, 1000 * U.UNIT, 'bankroll.in', null));
  db.tx(() => ledger.transfer(db, ledger.houseAccount(db).id,
    ledger.userAccount(db, user.id).id, 100 * U.UNIT, 'topup', null));

  for (let i = 0; i < 10; i += 1) {
    db.tx(() => ledger.settleBet(db, cfg, {
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
