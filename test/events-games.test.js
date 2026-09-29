'use strict';
// Every game on the record: the card games, crash and the arcade.
//
// Мины and the jigsaw are covered beside their own tests; the matches and solo beside
// theirs. What is checked here is the same thing for each: a round opens with an `o`,
// every step is a `p`, and it closes with an `f` — and where a game hides something at
// the start (a deal, a seed), the hash on the record when it opened matches what the
// record reveals when it ends. That is the property that lets anyone prove the server
// never changed its mind mid-round.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const tc = require('../src/tokenchain');
const events = require('../src/events');
const bankMod = require('../src/bank');
const matches = require('../src/match');
const preferans = require('../src/games/preferans');
const debertz = require('../src/games/debertz');
const arcade = require('../src/arcade');
const crashMod = require('../src/games/crash');

const TUG = 100000000;

function setup(overrides = {}) {
  const cfg = testConfig(overrides);
  const db = openTestDb(cfg);
  db.run(
    `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
     VALUES(1,'alice','alice','x','seed','rc1',0)`,
  );
  const priv = tc.privateKeyFromSeed(crypto.randomBytes(32).toString('hex'));
  const pub = tc.rawPublicKey(crypto.createPublicKey(priv));
  tc.registerKey(db, 1, pub, cfg);
  tc.appendBlock(db, [tc.treasuryTransfer(db, matches.houseKey(db).publicRaw, 2000 * TUG)]);
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

const ctxFor = (cfg, db, user, spend) => ({
  db, cfg, user,
  bank: bankMod.bankFor(db, cfg, spend),
  bankFor: (s) => bankMod.bankFor(db, cfg, s),
});

const hash = (v) => tc.sha256(tc.canonical(v));

/** The record is one story on the chain too. */
function chainAgrees(db, cfg, g, r) {
  events.flush(db, cfg, { force: true });
  const chain = events.fromChain(db, g, r);
  const index = events.history(db, g, r);
  assert.deepStrictEqual(chain.map((e) => e.k), index.map((e) => e.k));
  const check = tc.verifyChain(db);
  assert.ok(check.ok, check.reason);
}

test('Преферанс: the deal is committed to on the record and revealed by the finish, every card between', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));
  const ctx = (spend) => ctxFor(cfg, db, user, spend);

  let v = preferans.start(ctx(sign(db, priv, pub, 10 * TUG)), { amount: '10' });
  const id = v.gameId;
  v = preferans.chooseTrump(ctx(), { trump: preferans.SUITS[0] });
  v = preferans.discard(ctx(), { cards: [v.hand[0], v.hand[1]] });
  let guard = 0;
  while (v.state === 'playing' && guard < 40) {
    guard += 1;
    assert.ok(v.yourTurn, 'the bots have played up to the player');
    const led = v.trick.length ? preferans.suitOf(v.trick[0].card) : null;
    const legal = preferans.legalPlays(v.hand, led, v.trump);
    v = preferans.playCard(ctx(), { card: legal[0] });
  }
  assert.strictEqual(v.state, 'done');

  const log = events.history(db, 'preferans', id);
  assert.strictEqual(log[0].k, 'o');
  assert.strictEqual(log[0].a[0], 10 * TUG);
  assert.strictEqual(log[0].u, pub.slice(0, 8));
  const finish = log[log.length - 1];
  assert.strictEqual(finish.k, 'f');
  const [tricks, multiplier, payout, tricksWon, hands, talon] = finish.a;
  assert.strictEqual(hash(hands), log[0].a[1], 'the hands dealt are the hands committed to');
  assert.strictEqual(hash(talon), log[0].a[2], 'and so is the talon');
  assert.strictEqual(tricksWon[preferans.PLAYER], tricks);
  assert.strictEqual(payout, v.payout);
  assert.ok(multiplier >= 0);
  const plays = log.filter((e) => e.k === 'p');
  assert.strictEqual(plays[0].a[1], 'trump');
  assert.strictEqual(plays[1].a[1], 'discard');
  const cards = plays.filter((e) => e.a[1] === 'card');
  assert.strictEqual(cards.length, preferans.HAND_SIZE * preferans.PLAYERS, 'every card played, by every seat');
  assert.ok(cards.some((e) => e.a[0] !== preferans.PLAYER), 'the bots\' plays are on the record');
  assert.ok(events.round(db, 'preferans', id).closed_at > 0);
  chainAgrees(db, cfg, 'preferans', id);
});

test('Деберц: the same, for one opponent and nine cards each', (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));
  const ctx = (spend) => ctxFor(cfg, db, user, spend);

  let v = debertz.start(ctx(sign(db, priv, pub, 10 * TUG)), { amount: '10' });
  const id = v.gameId;
  v = debertz.chooseTrump(ctx(), { trump: debertz.SUITS[0] });
  let guard = 0;
  while (v.state === 'playing' && guard < 40) {
    guard += 1;
    assert.ok(v.yourTurn);
    const legal = debertz.legalPlays(v.hand, v.trick, v.trump);
    v = debertz.playCard(ctx(), { card: legal[0] });
  }
  assert.strictEqual(v.state, 'done');

  const log = events.history(db, 'debertz', id);
  assert.strictEqual(log[0].k, 'o');
  assert.strictEqual(log[0].a[2], v.upcard, 'the upcard is on the record in the clear');
  const finish = log[log.length - 1];
  assert.strictEqual(finish.k, 'f');
  assert.strictEqual(hash(finish.a[4]), log[0].a[1], 'the hands dealt are the hands committed to');
  assert.strictEqual(finish.a[2], v.payout);
  const cards = log.filter((e) => e.k === 'p' && e.a[1] === 'card');
  assert.strictEqual(cards.length, debertz.HAND_SIZE * debertz.PLAYERS);
  assert.ok(cards.some((e) => e.a[0] === debertz.BOT));
  chainAgrees(db, cfg, 'debertz', id);
});

test('the arcade: a play opens with the cabinet and its cost, and closes with the score', (t) => {
  const { cfg, db, user } = setup();
  t.after(() => cleanup(cfg, db));
  const play = arcade.practicePlay(db, cfg, user, 'pong');
  const id = db.get('SELECT id FROM arcade_plays WHERE ticket=?', play.ticket).id;
  arcade.submitScore(db, cfg, user, { ticket: play.ticket, score: 1234 });
  const log = events.history(db, 'arcade', id);
  assert.deepStrictEqual(log.map((e) => e.k), ['o', 'f']);
  assert.deepStrictEqual(log[0].a.slice(0, 2), ['pong', 0]);
  assert.strictEqual(log[1].a[0], 1234);
  assert.ok(!JSON.stringify(log).includes(play.ticket), 'the ticket, the one secret a play has, stays off the record');
  chainAgrees(db, cfg, 'arcade', id);
});

test('crash: a round opens with its seed committed to, and a bet is a step in it', (t) => {
  const { cfg, db, priv, pub, user } = setup({ crash: { chainLength: 50, bettingMs: 60000 } });
  const quiet = { log() {}, warn() {}, error() {} };
  const crash = crashMod.createCrash({
    db, cfg, bankFor: (s) => bankMod.bankFor(db, cfg, s), logger: quiet,
  });
  t.after(() => { crash.stop(); cleanup(cfg, db); });

  crash.start();
  const opened = db.get("SELECT g, r, k, a FROM token_events WHERE g='crash' ORDER BY s LIMIT 1");
  assert.ok(opened, 'the first round is on the record');
  assert.strictEqual(opened.k, 'o');
  const round = db.get('SELECT * FROM crash_rounds ORDER BY id DESC LIMIT 1');
  assert.strictEqual(opened.r, round.id);
  assert.strictEqual(JSON.parse(opened.a)[0], round.seed_hash, 'the hash of the seed that decides the round');

  crash.placeBet(user, { amount: '5' }, sign(db, priv, pub, 5 * TUG));
  const log = events.history(db, 'crash', round.id);
  assert.deepStrictEqual(log.map((e) => e.k), ['o', 'p']);
  assert.deepStrictEqual(log[1].a.slice(0, 3), [pub.slice(0, 8), 5 * TUG, 0]);
  chainAgrees(db, cfg, 'crash', round.id);
});
