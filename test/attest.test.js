'use strict';
// The round, signed once.
//
// The browser folds each event a game's response shows it into a running hash and signs
// the hash in the request that closes the round; the server folds its own log the same
// way and checks the signature. What this file holds to: the two folds agree byte for
// byte (the browser's fold is run here, in Node, against the server's), a real round
// closed with a good signature carries it on the chain, a signature over a record with a
// step missing does not verify, and a round is never refused for lacking one.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { testConfig, openTestDb, cleanup, ROOT } = require('./helpers');
const tc = require('../src/tokenchain');
const events = require('../src/events');
const bankMod = require('../src/bank');
const matches = require('../src/match');
const mines = require('../src/games/mines');
const jigsaw = require('../src/games/jigsaw');

const TUG = 100000000;
const BROWSER = pathToFileURL(path.join(ROOT, 'public', 'tokenkeys.js')).href;

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

/** The browser's side of it: fold what the responses showed, sign with the wallet key. */
async function browserSign(priv, g, r, shownEvents) {
  const tk = await import(BROWSER);
  let h = await tk.sha256Hex(tk.ROUND_SEED);
  for (const ev of shownEvents) h = await tk.foldEvent(h, ev);
  const payload = tk.roundPayload({ g, r, n: shownEvents.length, h });
  // crypto.subtle cannot sign with a Node key object, so the signature itself is made
  // with Node over the same canonical bytes the browser would sign.
  const sig = crypto.sign(null, Buffer.from(tk.canonical(payload)), priv).toString('hex');
  return { sig, h, n: shownEvents.length };
}

test('the browser fold and the server fold agree, event for event', async (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  const tk = await import(BROWSER);
  const seen = [];
  db.tx(() => {
    seen.push(events.shown(events.emit(db, cfg, { g: 'mines', r: 5, k: 'o', a: [100, 3, 'abcd'] })));
    seen.push(events.shown(events.emit(db, cfg, { g: 'mines', r: 5, k: 'r', a: [7] })));
    seen.push(events.shown(events.emit(db, cfg, { g: 'mines', r: 5, k: 'r', a: [12, [1, 2]] })));
  });
  assert.ok(!('u' in seen[0]) && seen[0].a.length === 3, 'shown without the receipt time or the actor');
  let h = await tk.sha256Hex(tk.ROUND_SEED);
  for (const ev of seen) h = await tk.foldEvent(h, ev);
  const server = events.digest(db, 'mines', 5);
  assert.strictEqual(server.n, 3);
  assert.strictEqual(server.h, h);
  assert.strictEqual(tc.sha256(tc.ROUND_SEED), await tk.sha256Hex(tk.ROUND_SEED));
  assert.deepStrictEqual(
    tk.roundPayload({ g: 'mines', r: 5, n: 3, h }),
    tc.roundPayload({ g: 'mines', r: 5, n: 3, h }),
  );
});

test('Мины: a round cashed out with a good signature carries it, on the event and on the chain', async (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));
  const ctx = (spend) => ctxFor(cfg, db, user, spend);

  const seen = [];
  const opened = mines.start(ctx(sign(db, priv, pub, 10 * TUG)), { amount: '10', mines: 3 });
  seen.push(opened.event);
  assert.deepStrictEqual(Object.keys(opened.event).sort(), ['a', 'g', 'k', 'r', 's']);
  const g = db.get("SELECT * FROM mines_games WHERE user_id=1 AND state='active'");
  const layout = JSON.parse(g.mines);
  const safe = [...Array(25).keys()].filter((i) => !layout.includes(i)).slice(0, 2);
  seen.push(mines.reveal(ctx(), { tile: safe[0] }).event);
  seen.push(mines.reveal(ctx(), { tile: safe[1] }).event);
  assert.deepStrictEqual(seen.map((e) => e.s), [0, 1, 2]);

  const { sig } = await browserSign(priv, 'mines', g.id, seen);
  const cashed = mines.cashout(ctx(), { roundSig: sig });
  assert.strictEqual(cashed.attested, true);

  const log = events.history(db, 'mines', g.id);
  assert.strictEqual(log[3].k, 'c');
  assert.strictEqual(log[3].sig, sig, 'the signature rides on the cashout event');
  assert.strictEqual(events.round(db, 'mines', g.id).sig, sig, 'and on the round');
  events.flush(db, cfg, { force: true });
  const chain = events.fromChain(db, 'mines', g.id);
  assert.strictEqual(chain[3].sig, sig, 'and reaches the chain');
  assert.ok(tc.verifyChain(db).ok, 'where a signed event verifies like any other');

  // Anyone can check it later from the chain alone: fold the events before the
  // cashout, and verify against the player's key on the round.
  let h = tc.sha256(tc.ROUND_SEED);
  for (const ev of chain.slice(0, 3)) h = tc.foldEvent(h, { ...ev, a: ev.a.slice(0, -1) });
  assert.ok(tc.verifyRoundSignature(pub, tc.roundPayload({ g: 'mines', r: g.id, n: 3, h }), sig));
});

test('a signature over a record with a step missing does not verify, and the round is paid anyway', async (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));
  const ctx = (spend) => ctxFor(cfg, db, user, spend);
  const seen = [];
  seen.push(mines.start(ctx(sign(db, priv, pub, 10 * TUG)), { amount: '10', mines: 3 }).event);
  const g = db.get("SELECT * FROM mines_games WHERE user_id=1 AND state='active'");
  const layout = JSON.parse(g.mines);
  const safe = [...Array(25).keys()].filter((i) => !layout.includes(i)).slice(0, 2);
  seen.push(mines.reveal(ctx(), { tile: safe[0] }).event);
  mines.reveal(ctx(), { tile: safe[1] });   // this one the browser "never saw"

  const { sig } = await browserSign(priv, 'mines', g.id, seen);
  const cashed = mines.cashout(ctx(), { roundSig: sig });
  assert.strictEqual(cashed.attested, false);
  assert.ok(cashed.payout > 0, 'the round is paid: attestation never gates the money');
  const log = events.history(db, 'mines', g.id);
  assert.strictEqual(log[log.length - 1].sig, undefined, 'nothing is stored that did not verify');
  assert.strictEqual(events.round(db, 'mines', g.id).sig, null);

  // No signature at all is the same round, unattested.
  seen.length = 0;
  seen.push(mines.start(ctx(sign(db, priv, pub, 10 * TUG)), { amount: '10', mines: 3 }).event);
  const g2 = db.get("SELECT * FROM mines_games WHERE user_id=1 AND state='active'");
  const safe2 = [...Array(25).keys()].filter((i) => !JSON.parse(g2.mines).includes(i))[0];
  mines.reveal(ctx(), { tile: safe2 });
  assert.strictEqual(mines.cashout(ctx(), {}).attested, false);
  assert.throws(() => mines.cashout(ctx(), { roundSig: 'zz' }), /no active mines round/, 'nothing left to close');
});

test('the jigsaw: every drop is shown back, a reopened round hands the record over, and solve carries the signature', async (t) => {
  const { cfg, db, priv, pub, user } = setup();
  t.after(() => cleanup(cfg, db));
  const ctx = (spend) => ctxFor(cfg, db, user, spend);
  const seen = [];
  const opened = jigsaw.start(ctx(sign(db, priv, pub, 1 * TUG)), { amount: '1', board: 'medium' });
  seen.push(opened.event);
  for (let i = 0; i < opened.pieces; i += 1) {
    seen.push(jigsaw.place(ctx(), { slot: i, piece: i }).event);
  }
  // The browser that reopens the round gets the same events the first one saw.
  const back = jigsaw.current(ctx());
  assert.deepStrictEqual(back.events, seen);

  const { sig } = await browserSign(priv, 'jigsaw', opened.id, seen);
  const out = jigsaw.solve(ctx(), { arrangement: [...Array(opened.pieces).keys()], roundSig: sig });
  assert.strictEqual(out.attested, true);
  const log = events.history(db, 'jigsaw', opened.id);
  assert.strictEqual(log[log.length - 1].k, 'f');
  assert.strictEqual(log[log.length - 1].sig, sig);
  assert.strictEqual(events.round(db, 'jigsaw', opened.id).sig, sig);
  events.flush(db, cfg, { force: true });
  assert.ok(tc.verifyChain(db).ok);
});
