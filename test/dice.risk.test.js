'use strict';
// The four risk levels the dice panel offers.
//
// These exist because the panel stopped letting a player type an arbitrary win chance.
// The property that makes presets safe to offer at all is that the house edge does not
// move between them: a player picking Wild and a player picking Safe face exactly the
// same margin, and only their variance differs. If that ever stopped being true, one of
// the four would quietly be a better bet than the others, and the panel would be steering
// people towards it without saying so.
const test = require('node:test');
const assert = require('node:assert');
const fair = require('../src/fair');

// Win chance in hundredths of a percent, matching the values in the client panel.
const LEVELS = [
  ['safe', 7500],
  ['normal', 5000],
  ['risky', 2500],
  ['wild', 500],
];
const EDGE = 0.01;

test('every risk level carries the same house edge', () => {
  for (const [name, hundredths] of LEVELS) {
    const chance = hundredths / 10000;
    const mult = fair.payoutMultiplier(chance, EDGE);
    // Expected return per unit staked: chance of winning times what a win pays.
    const expected = chance * mult;
    assert.ok(
      Math.abs(expected - (1 - EDGE)) < 1e-9,
      `${name}: expected return ${expected}, wanted ${1 - EDGE}`,
    );
  }
});

test('every risk level is inside the range the server will accept', () => {
  // src/games/dice.js refuses anything outside 1%-95%, and it keeps doing so whatever the
  // panel offers. A preset the server would reject is a dead end by construction.
  for (const [name, hundredths] of LEVELS) {
    const winCount = fair.diceWinCount(hundredths, 'under');
    assert.ok(winCount >= 100, `${name}: ${winCount} is below the 1% floor`);
    assert.ok(winCount <= 9500, `${name}: ${winCount} is above the 95% ceiling`);
  }
});

test('riskier levels pay more, in order', () => {
  const mults = LEVELS.map(([, h]) => fair.payoutMultiplier(h / 10000, EDGE));
  for (let i = 1; i < mults.length; i += 1) {
    assert.ok(mults[i] > mults[i - 1],
      `level ${i} pays ${mults[i]}, which is not more than ${mults[i - 1]}`);
  }
});

// ---------------------------------------------------------------------------
// The house can only pay what it holds.
//
// Dice and limbo were the only two games that never capped their payout, and the failure
// was not a quiet overpayment: the chain refused a transfer the house could not cover, so
// the entire bet came back as "insufficient token balance" to a player holding 995
// tugriks. That is the worst shape a bug can take here — it reads as the player's fault.
const crypto = require('node:crypto');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const bankMod = require('../src/bank');
const tc = require('../src/tokenchain');
const matches = require('../src/match');
const dice = require('../src/games/dice');

const TUG = 100000000;

function setup() {
  const cfg = testConfig();
  const db = openTestDb(cfg);
  db.run(
    `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
     VALUES(1,'alice','alice','x','seed','rc1',0)`,
  );
  const priv = tc.privateKeyFromSeed(crypto.randomBytes(32).toString('hex'));
  const pub = tc.rawPublicKey(crypto.createPublicKey(priv));
  tc.registerKey(db, 1, pub, cfg);
  return { cfg, db, priv, pub, user: db.get('SELECT * FROM users WHERE id=1') };
}

const sign = (db, priv, pub, amount) => {
  const tx = {
    type: 'transfer', from: pub, to: matches.houseKey(db).publicRaw, amount,
    nonce: tc.nextNonce(db, pub),
  };
  const sig = crypto.sign(null, Buffer.from(tc.canonical(tc.transferPayload(tx))), priv).toString('hex');
  return { from: pub, nonce: tx.nonce, sig };
};

test('a win the house cannot cover pays what it can, instead of refusing the bet', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));

  // A nearly empty house and the longest odds on the board: a 5% chance paying 19.8x on a
  // one-tugrik stake wants 19.8 out of a house holding a fraction of that.
  const houseBefore = tc.balanceOf(db, matches.houseKey(db).publicRaw);
  assert.ok(houseBefore < 19 * TUG, 'the point of the test is a house that cannot cover it');

  let out = null;
  assert.doesNotThrow(() => {
    out = dice.play(
      { db, cfg, user, bank: bankMod.bankFor(db, cfg, sign(db, priv, pub, TUG)) },
      { amount: '1', target: 500, mode: 'under' },
    );
  }, 'the round must settle rather than throw');

  assert.ok(out.betId, 'the round is recorded either way');
  // Whether this particular roll won is down to the seed; what must hold is that the
  // house was never asked for more than it had.
  assert.ok(out.payout <= houseBefore + TUG,
    `paid ${out.payout} from a house holding ${houseBefore} plus the ${TUG} stake`);
  assert.strictEqual(tc.verifyChain(db).ok, true, 'and the chain still verifies');
});
