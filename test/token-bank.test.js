'use strict';
// Staking tugriks on the ordinary casino games.
//
// The claim this file exists to defend is narrow and worth stating exactly: **the operator
// cannot place a bet for you.** A tugrik stake is a transfer on the token chain, a transfer
// needs a signature only the player can produce, and a bet that arrives without one is
// refused rather than taken on trust. Without that, "bet with the site token" would mean
// handing the operator a key to every wallet on the site.
//
// The other thing checked here is that the tokens add up. The supply is fixed, so a game
// paying a win it cannot cover is not a rounding problem, it is a promise the chain would
// refuse to honour. Every test below replays the chain rather than reading a balance the
// code under test just wrote.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const bankMod = require('../src/bank');
const tc = require('../src/tokenchain');
const match = require('../src/match');

const TUG = 100000000;

function setup(overrides = {}) {
  const cfg = testConfig(overrides);
  const db = openTestDb(cfg);
  db.run(
    `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
     VALUES(1,'alice','alice','x','s','rc1',0)`,
  );
  db.run(
    `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
     VALUES(2,'bob','bob','x','s','rc2',0)`,
  );
  const user = { id: 1, username: 'alice', frozen: 0, self_excluded_until: 0 };
  const other = { id: 2, username: 'bob', frozen: 0, self_excluded_until: 0 };

  const keys = {};
  for (const [name, id] of [['alice', 1], ['bob', 2]]) {
    const priv = tc.privateKeyFromSeed(crypto.randomBytes(32).toString('hex'));
    const pub = tc.rawPublicKey(crypto.createPublicKey(priv));
    tc.registerKey(db, id, pub, cfg);
    keys[name] = { priv, pub };
  }
  return { cfg, db, user, other, keys };
}

/** Sign a stake the way public/app.js does before every tugrik bet. */
function sign(db, key, amount) {
  const tx = {
    type: 'transfer', from: key.pub, to: match.houseKey(db).publicRaw, amount,
    nonce: tc.nextNonce(db, key.pub),
  };
  const sig = crypto.sign(
    null, Buffer.from(tc.canonical(tc.transferPayload(tx))), key.priv,
  ).toString('hex');
  return { from: key.pub, nonce: tx.nonce, sig };
}

const bankWith = (db, cfg, spend) => bankMod.bankFor(db, cfg, 'token', spend);

/** Give the house something to pay wins out of. */
function fundHouse(db, cfg, amount) {
  const treasury = tc.treasuryKey(db);
  db.tx(() => tc.appendBlock(db, [
    tc.treasuryTransfer(db, match.houseKey(db).publicRaw, amount),
  ]));
  return amount;
}

test('the bank is chosen by the wallet named on the request', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  assert.strictEqual(bankMod.bankFor(db, cfg, 'token').mode, 'token');
  assert.strictEqual(bankMod.bankFor(db, cfg, 'demo').mode, 'demo');
  assert.strictEqual(bankMod.bankFor(db, cfg, 'real').mode, 'real');
  assert.strictEqual(bankMod.bankFor(db, cfg, 'nonsense').mode, 'real', 'anything odd is real money');
});

test('the balance is whatever the chain says it is', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));
  const bank = bankWith(db, cfg);
  assert.strictEqual(bank.balance(user.id), cfg.token.welcomeGrant);
  assert.strictEqual(bank.balance(999), 0, 'an account with no wallet holds nothing');
});

test('a bet without a signature is refused, and nothing moves', (t) => {
  const { cfg, db, user, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const before = tc.balanceOf(db, keys.alice.pub);

  const bank = bankWith(db, cfg, undefined);
  assert.throws(() => bank.takeStake(user, 10 * TUG), /must be signed/);
  assert.strictEqual(tc.balanceOf(db, keys.alice.pub), before, 'not a single tugrik moved');
});

test('a bet signed by somebody else is refused', (t) => {
  const { cfg, db, user, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const before = tc.balanceOf(db, keys.alice.pub);

  // Bob signs; the request claims to be Alice's.
  const bank = bankWith(db, cfg, sign(db, keys.bob, 10 * TUG));
  assert.throws(() => bank.takeStake(user, 10 * TUG), /not registered to this account/);
  assert.strictEqual(tc.balanceOf(db, keys.alice.pub), before);
});

test('a signature for one amount does not authorise another', (t) => {
  const { cfg, db, user, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const bank = bankWith(db, cfg, sign(db, keys.alice, 10 * TUG));
  assert.throws(() => bank.takeStake(user, 500 * TUG), /signature does not match/);
});

test('a signature cannot be replayed on a second bet', (t) => {
  const { cfg, db, user, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const spend = sign(db, keys.alice, 10 * TUG);

  bankWith(db, cfg, spend).takeStake(user, 10 * TUG);
  assert.throws(() => bankWith(db, cfg, spend).takeStake(user, 10 * TUG), /already been used/);
});

test('a signed stake moves from the player to the house, on the chain', (t) => {
  const { cfg, db, user, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const house = match.houseKey(db).publicRaw;
  const before = { mine: tc.balanceOf(db, keys.alice.pub), house: tc.balanceOf(db, house) };

  bankWith(db, cfg, sign(db, keys.alice, 25 * TUG)).takeStake(user, 25 * TUG);

  assert.strictEqual(tc.balanceOf(db, keys.alice.pub), before.mine - 25 * TUG);
  assert.strictEqual(tc.balanceOf(db, house), before.house + 25 * TUG);
  assert.strictEqual(tc.verifyChain(db).ok, true, 'and the chain still verifies');
});

test('a losing bet leaves the stake with the house and writes the round down', (t) => {
  const { cfg, db, user, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const house = match.houseKey(db).publicRaw;
  const before = tc.balanceOf(db, keys.alice.pub);

  const bank = bankWith(db, cfg, sign(db, keys.alice, 20 * TUG));
  bank.settle({
    user, game: 'dice', wager: 20 * TUG, multiplier: 0, payout: 0,
    detail: { roll: 9000 }, nonce: 1, stakeTaken: false,
  });

  assert.strictEqual(tc.balanceOf(db, keys.alice.pub), before - 20 * TUG);
  assert.strictEqual(tc.balanceOf(db, house), 20 * TUG);
  const row = db.get('SELECT * FROM token_bets WHERE user_id=1');
  assert.strictEqual(row.game, 'dice');
  assert.strictEqual(row.wager, 20 * TUG);
  assert.strictEqual(row.profit, -20 * TUG);
});

test('a winning bet is paid out of the house balance', (t) => {
  const { cfg, db, user, keys } = setup();
  t.after(() => cleanup(cfg, db));
  fundHouse(db, cfg, 1000 * TUG);
  const before = tc.balanceOf(db, keys.alice.pub);

  const bank = bankWith(db, cfg, sign(db, keys.alice, 10 * TUG));
  bank.settle({
    user, game: 'dice', wager: 10 * TUG, multiplier: 1.98, payout: Math.round(19.8 * TUG),
    detail: null, nonce: 2, stakeTaken: false,
  });

  // Staked ten, paid nineteen point eight: up nine point eight.
  assert.strictEqual(tc.balanceOf(db, keys.alice.pub), before - 10 * TUG + Math.round(19.8 * TUG));
  assert.strictEqual(tc.verifyChain(db).ok, true);
  assert.strictEqual(db.get('SELECT profit FROM token_bets WHERE nonce=2').profit,
    Math.round(19.8 * TUG) - 10 * TUG);
});

test('fractions of a tugrik survive, because the coin is divisible', (t) => {
  const { cfg, db, user, keys } = setup();
  t.after(() => cleanup(cfg, db));
  fundHouse(db, cfg, 1000 * TUG);
  const before = tc.balanceOf(db, keys.alice.pub);

  // One tugrik at 1.98x. On a whole-number coin this would have to round, and the
  // rounding would be a second house edge nobody published.
  const bank = bankWith(db, cfg, sign(db, keys.alice, 1 * TUG));
  bank.settle({
    user, game: 'dice', wager: 1 * TUG, multiplier: 1.98, payout: Math.round(1.98 * TUG),
    detail: null, nonce: 3, stakeTaken: false,
  });
  assert.strictEqual(
    tc.balanceOf(db, keys.alice.pub),
    before - 1 * TUG + Math.round(1.98 * TUG),
    'the player is up exactly 0.98 tugriks',
  );
});

test('the house cannot pay a win it does not hold', (t) => {
  const { cfg, db, user, keys } = setup();
  t.after(() => cleanup(cfg, db));
  // The house has nothing. The ceiling is therefore the stake itself.
  const bank = bankWith(db, cfg, sign(db, keys.alice, 10 * TUG));
  const capped = bank.capPayout(10 * TUG, 5000 * TUG);
  assert.strictEqual(capped.capped, true);
  assert.strictEqual(capped.payout, 10 * TUG, 'it can always give the stake back');

  fundHouse(db, cfg, 90 * TUG);
  const better = bank.capPayout(10 * TUG, 5000 * TUG);
  assert.strictEqual(better.payout, 100 * TUG, 'the house balance plus the stake');
  assert.strictEqual(bank.capPayout(10 * TUG, 40 * TUG).capped, false, 'a payable win is not capped');
});

test('the table limits and the account checks all apply', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));
  const bank = bankWith(db, cfg);

  assert.throws(() => bank.checkLimits(user, cfg.token.bet.min - 1), /minimum stake/);
  assert.throws(() => bank.checkLimits(user, cfg.token.bet.max + 1), /above the table maximum/);
  assert.throws(() => bank.checkLimits(user, 1.5), /minimum stake/);
  assert.throws(() => bank.checkLimits(user, cfg.token.welcomeGrant + TUG), /not enough tugriks/);
  assert.doesNotThrow(() => bank.checkLimits(user, 10 * TUG));

  assert.throws(() => bank.checkLimits({ ...user, frozen: 1 }, 10 * TUG), /frozen/);
  // Self-exclusion covers this wallet too. Someone who asked to be kept away from the
  // games asked to be kept away from all of them, in every currency.
  const excluded = { ...user, self_excluded_until: Math.floor(Date.now() / 1000) + 3600 };
  assert.throws(() => bank.checkLimits(excluded, 10 * TUG), /self-exclusion/);
});

test('an account with no wallet is told that, rather than that it is poor', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  db.run(
    `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
     VALUES(3,'carol','carol','x','s','rc3',0)`,
  );
  const carol = { id: 3, frozen: 0, self_excluded_until: 0 };
  assert.throws(
    () => bankWith(db, cfg).checkLimits(carol, 10 * TUG),
    /create a token wallet/,
  );
});

test('tugriks are conserved across a run of bets', (t) => {
  const { cfg, db, user, keys } = setup();
  t.after(() => cleanup(cfg, db));
  fundHouse(db, cfg, 500 * TUG);

  for (let i = 0; i < 6; i += 1) {
    const wager = (i + 1) * TUG;
    const win = i % 2 === 0;
    const bank = bankWith(db, cfg, sign(db, keys.alice, wager));
    bank.settle({
      user, game: 'slots', wager, multiplier: win ? 2 : 0,
      payout: win ? wager * 2 : 0, detail: null, nonce: 10 + i, stakeTaken: false,
    });
  }

  // Replay the chain from genesis rather than trusting the balances just written.
  const seen = new Map();
  const add = (k, d) => seen.set(k, (seen.get(k) || 0) + d);
  for (const block of db.all('SELECT txs FROM token_blocks ORDER BY height')) {
    for (const tx of JSON.parse(block.txs)) {
      if (tx.type === 'mint') add(tx.to, tx.amount);
      else if (tx.type === 'burn') add(tx.from, -tx.amount);
      else { add(tx.from, -tx.amount); add(tx.to, tx.amount); }
    }
  }
  let total = 0;
  for (const [pubkey, amount] of seen) {
    assert.strictEqual(tc.balanceOf(db, pubkey), amount, `balance disagrees for ${pubkey.slice(0, 10)}`);
    total += amount;
  }
  assert.strictEqual(total, cfg.token.maxSupply, 'tugriks were created or destroyed');
  assert.strictEqual(tc.verifyChain(db).ok, true);
});

test('play money and tugriks never touch each other', (t) => {
  const { cfg, db, user, keys } = setup();
  t.after(() => cleanup(cfg, db));
  const demo = bankMod.bankFor(db, cfg, 'demo');
  const tokenBefore = tc.balanceOf(db, keys.alice.pub);

  demo.settle({
    user, game: 'dice', wager: 100000, multiplier: 0, payout: 0,
    detail: null, nonce: 1, stakeTaken: false,
  });

  assert.strictEqual(tc.balanceOf(db, keys.alice.pub), tokenBefore, 'a demo bet moved no tugriks');
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM token_bets').n, 0);
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM demo_bets').n, 1);
});
