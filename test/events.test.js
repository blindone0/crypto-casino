'use strict';
// Every game step, on the chain: the log, the flusher, and what they promise.
//
// The promises are narrow:
//   an event commits with the game write it belongs to, or not at all;
//   a recorded event reaches the chain — batched, in order, within seconds — and nothing
//   between a click and its block can lose it;
//   what the index says happened is what the chain says happened.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { testConfig, openTestDb, cleanup } = require('./helpers');
const tc = require('../src/tokenchain');
const events = require('../src/events');

function setup(overrides = {}) {
  const cfg = testConfig(overrides);
  const db = openTestDb(cfg);
  db.run(
    `INSERT INTO users(id,username,username_lower,password_hash,client_seed,referral_code,created_at)
     VALUES(1,'alice','alice','x','s','rc1',0)`,
  );
  const priv = tc.privateKeyFromSeed(crypto.randomBytes(32).toString('hex'));
  const pub = tc.rawPublicKey(crypto.createPublicKey(priv));
  db.tx(() => tc.registerKey(db, 1, pub, cfg));
  return { cfg, db, pub, priv };
}

const TUG = 100000000;

const ROUND = { g: 'mines', r: 7 };

test('an event gets the next sequence number of its round, and carries the actor and the time', (t) => {
  const { cfg, db, pub } = setup();
  t.after(() => cleanup(cfg, db));
  const before = Date.now();
  const first = db.tx(() => events.emit(db, cfg, { ...ROUND, k: 'o', a: [100, 3, 'abcd'], userId: 1, pubkey: pub }));
  const second = db.tx(() => events.emit(db, cfg, { ...ROUND, k: 'r', a: [12] }));
  const other = db.tx(() => events.emit(db, cfg, { g: 'mines', r: 8, k: 'o', a: [] }));

  assert.strictEqual(first.s, 0);
  assert.strictEqual(second.s, 1);
  assert.strictEqual(other.s, 0, 'each round counts from zero');
  assert.strictEqual(first.u, pub.slice(0, 8), 'the actor, as a hint');
  assert.strictEqual(second.u, pub.slice(0, 8), 'known from the round, not repeated by the caller');
  assert.strictEqual(other.u, undefined, 'no key, no hint');
  const ms = second.a[second.a.length - 1];
  assert.ok(ms >= before && ms <= Date.now(), 'the last argument is the server\'s receipt time');
  assert.deepStrictEqual(second.a.slice(0, -1), [12]);
  assert.strictEqual(tc.checkEvent(first), null, 'what emit returns is what the chain accepts');

  const round = events.round(db, 'mines', 7);
  assert.strictEqual(round.user_id, 1);
  assert.strictEqual(round.pubkey, pub);
  assert.strictEqual(round.next_seq, 2);
  assert.strictEqual(round.closed_at, null);
  db.tx(() => events.close(db, ROUND));
  assert.ok(events.round(db, 'mines', 7).closed_at > 0);
});

test('an event rolls back with the game write it belongs to', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  assert.throws(() => db.tx(() => {
    events.emit(db, cfg, { ...ROUND, k: 'o', a: [] });
    throw new Error('the game refused the move');
  }), /refused/);
  assert.deepStrictEqual(events.history(db, 'mines', 7), []);
  assert.strictEqual(events.round(db, 'mines', 7), null, 'not even the round row survives');
  assert.strictEqual(events.pending(db).count, 0);
});

test('an event the chain would refuse fails the request instead of waiting to break the chain', (t) => {
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  assert.throws(() => db.tx(() => events.emit(db, cfg, { g: 'Mines', r: 1, k: 'o', a: [] })), /names no game/);
  assert.throws(() => db.tx(() => events.emit(db, cfg, { ...ROUND, k: 'open', a: [] })), /no kind/);
  assert.strictEqual(events.pending(db).count, 0);
});

test('with events switched off nothing is recorded and nothing breaks', (t) => {
  const { cfg, db } = setup({ token: { events: { enabled: false } } });
  t.after(() => cleanup(cfg, db));
  assert.strictEqual(db.tx(() => events.emit(db, cfg, { ...ROUND, k: 'o', a: [] })), null);
  assert.strictEqual(events.pending(db).count, 0);
  assert.deepStrictEqual(events.flush(db, cfg), { blocks: 0, events: 0 });
});

test('the flusher appends a block when enough are waiting, or the oldest has waited long enough', (t) => {
  const { cfg, db, pub } = setup({ token: { events: { batchCount: 5, batchMs: 60000, maxPerBlock: 500 } } });
  t.after(() => cleanup(cfg, db));
  const blocks = () => db.get('SELECT COUNT(*) AS n FROM token_blocks').n;
  const base = blocks();

  for (let i = 0; i < 4; i += 1) db.tx(() => events.emit(db, cfg, { ...ROUND, k: 'r', a: [i] }));
  assert.deepStrictEqual(events.flush(db, cfg), { blocks: 0, events: 0 }, 'four is not a batch yet');
  assert.strictEqual(events.pending(db).count, 4);

  db.tx(() => events.emit(db, cfg, { ...ROUND, k: 'r', a: [4] }));
  assert.deepStrictEqual(events.flush(db, cfg), { blocks: 1, events: 5 }, 'five is');
  assert.strictEqual(blocks(), base + 1);
  assert.strictEqual(events.pending(db).count, 0);
  for (const e of events.history(db, 'mines', 7)) assert.strictEqual(e.height, base, 'every event knows its block');

  // One event, too young for a block on its own...
  db.tx(() => events.emit(db, cfg, { ...ROUND, k: 'c', a: [500] }));
  assert.deepStrictEqual(events.flush(db, cfg), { blocks: 0, events: 0 });
  // ...until it has waited long enough.
  db.run('UPDATE token_events SET ms = ms - 61000 WHERE height IS NULL');
  assert.deepStrictEqual(events.flush(db, cfg), { blocks: 1, events: 1 });

  const chain = tc.verifyChain(db);
  assert.ok(chain.ok, chain.reason);
  assert.strictEqual(chain.events, 6);
  assert.strictEqual(tc.balanceOf(db, pub), cfg.token.welcomeGrant, 'and no balance moved');
});

test('a backlog drains as several capped blocks, in order', (t) => {
  const { cfg, db } = setup({ token: { events: { batchCount: 25, batchMs: 5000, maxPerBlock: 100 } } });
  t.after(() => cleanup(cfg, db));
  for (let i = 0; i < 250; i += 1) {
    db.tx(() => events.emit(db, cfg, { g: 'jigsaw', r: 1 + (i % 3), k: 'p', a: [i] }));
  }
  assert.deepStrictEqual(events.flush(db, cfg), { blocks: 3, events: 250 });
  assert.strictEqual(events.pending(db).count, 0);
  const sizes = db.all('SELECT txs FROM token_blocks ORDER BY height DESC LIMIT 3')
    .map((b) => JSON.parse(b.txs).length).reverse();
  assert.deepStrictEqual(sizes, [100, 100, 50]);
  for (const r of [1, 2, 3]) {
    const seqs = events.fromChain(db, 'jigsaw', r).map((e) => e.s);
    assert.deepStrictEqual(seqs, seqs.map((_, i) => i), `round ${r} is complete and in order on the chain`);
  }
  assert.ok(tc.verifyChain(db).ok);
});

test('what the index says happened is what the chain says happened', (t) => {
  const { cfg, db, pub } = setup();
  t.after(() => cleanup(cfg, db));
  const picks = [3, 17, 8, 21];
  db.tx(() => events.emit(db, cfg, { ...ROUND, k: 'o', a: [100, 3, 'hash'], userId: 1, pubkey: pub }));
  for (const p of picks) db.tx(() => events.emit(db, cfg, { ...ROUND, k: 'r', a: [p] }));
  db.tx(() => events.emit(db, cfg, { ...ROUND, k: 'c', a: [250, 2.5, [1, 2, 3]] }));
  events.flush(db, cfg, { force: true });

  const index = events.history(db, 'mines', 7);
  const chain = events.fromChain(db, 'mines', 7);
  assert.strictEqual(chain.length, 6);
  assert.deepStrictEqual(chain.map((e) => e.k).join(''), 'orrrrc');
  assert.deepStrictEqual(chain.filter((e) => e.k === 'r').map((e) => e.a[0]), picks,
    'the pick sequence, rebuilt from the chain alone');
  for (let i = 0; i < 6; i += 1) {
    const { height: hi, ms, ...fromIndex } = index[i];
    const { height: hc, ...fromChainSide } = chain[i];
    assert.deepStrictEqual(fromIndex, fromChainSide);
    assert.strictEqual(hi, hc);
  }
});

test('a crash between a click and its block loses nothing', (t) => {
  // The queue is the table: the events are committed with the game's own transaction,
  // so a process that dies before the flusher runs leaves them exactly where the next
  // boot's flusher finds them.
  const { cfg, db } = setup();
  t.after(() => cleanup(cfg, db));
  for (let i = 0; i < 7; i += 1) db.tx(() => events.emit(db, cfg, { ...ROUND, k: 'r', a: [i] }));
  assert.strictEqual(events.pending(db).count, 7, 'waiting, durably');
  // "Restart": nothing in memory matters, the module holds no state. The boot's flusher
  // (server.stop()'s forced flush, or the timer) picks the queue up.
  const out = events.flush(db, cfg, { force: true });
  assert.deepStrictEqual(out, { blocks: 1, events: 7 });
  assert.strictEqual(events.fromChain(db, 'mines', 7).length, 7);
  assert.ok(tc.verifyChain(db).ok);
});

test('Мины: a round leaves its every step on the chain, the layout committed then revealed', (t) => {
  const { cfg, db, pub, priv } = setup();
  t.after(() => cleanup(cfg, db));
  const mines = require('../src/games/mines');
  const bankMod = require('../src/bank');
  const match = require('../src/match');

  const user = { ...db.get('SELECT * FROM users WHERE id=1'), frozen: 0, self_excluded_until: 0 };
  // The house needs something to pay a win out of.
  db.tx(() => tc.appendBlock(db, [
    tc.treasuryTransfer(db, match.houseKey(db).publicRaw, 100000 * TUG),
  ]));
  const sign = (amount) => {
    const tx = {
      type: 'transfer', from: pub, to: match.houseKey(db).publicRaw, amount, nonce: tc.nextNonce(db, pub),
    };
    const sig = crypto.sign(null, Buffer.from(tc.canonical(tc.transferPayload(tx))), priv).toString('hex');
    return { from: pub, nonce: tx.nonce, sig };
  };
  const bankFor = (spend) => bankMod.bankFor(db, cfg, spend);
  const ctx = (spend) => ({ db, cfg, user, bank: bankFor(spend), bankFor });

  mines.start(ctx(sign(10 * TUG)), { amount: '10', mines: 3 });
  const g = db.get("SELECT * FROM mines_games WHERE user_id=1 AND state='active'");
  const layout = JSON.parse(g.mines);
  const safe = [...Array(25).keys()].filter((i) => !layout.includes(i)).slice(0, 2);
  mines.reveal(ctx(), { tile: safe[0] });
  mines.reveal(ctx(), { tile: safe[1] });
  const cashed = mines.cashout(ctx());
  assert.strictEqual(cashed.state, 'cashed');

  const log = events.history(db, 'mines', g.id);
  assert.strictEqual(log.map((e) => e.k).join(''), 'orrc', 'opened, two reveals, cashed out');
  assert.strictEqual(log[0].a[0], 10 * TUG, 'the stake');
  assert.strictEqual(log[0].a[2], tc.sha256(tc.canonical(layout)),
    'the layout was committed to when the round opened');
  assert.deepStrictEqual(log[1].a[0], safe[0]);
  assert.deepStrictEqual(log[3].a[2], layout, 'and revealed when it ended, for anyone to hash');
  assert.strictEqual(log[3].a[0], cashed.payout);
  assert.strictEqual(log[0].u, pub.slice(0, 8));
  assert.ok(events.round(db, 'mines', g.id).closed_at > 0);
  assert.strictEqual(events.pending(db).count, 4, 'waiting for the flusher, not for a save');

  events.flush(db, cfg, { force: true });
  assert.strictEqual(events.fromChain(db, 'mines', g.id).map((e) => e.k).join(''), 'orrc');
  assert.ok(tc.verifyChain(db).ok);

  // A hit is on the record too, with the layout revealed the same way.
  mines.start(ctx(sign(10 * TUG)), { amount: '10', mines: 3 });
  const g2 = db.get("SELECT * FROM mines_games WHERE user_id=1 AND state='active'");
  const mine = JSON.parse(g2.mines)[0];
  const lost = mines.reveal(ctx(), { tile: mine });
  assert.strictEqual(lost.safe, false);
  const log2 = events.history(db, 'mines', g2.id);
  assert.strictEqual(log2.map((e) => e.k).join(''), 'orf');
  assert.deepStrictEqual(log2[2].a[2], JSON.parse(g2.mines));
});

test('an instant game is one event: its settlement, from the bank, with the roll in it', (t) => {
  const { cfg, db, pub, priv } = setup();
  t.after(() => cleanup(cfg, db));
  const bankMod = require('../src/bank');
  const match = require('../src/match');
  const user = { ...db.get('SELECT * FROM users WHERE id=1'), frozen: 0, self_excluded_until: 0 };
  db.tx(() => tc.appendBlock(db, [
    tc.treasuryTransfer(db, match.houseKey(db).publicRaw, 1000 * TUG),
  ]));
  const tx = {
    type: 'transfer', from: pub, to: match.houseKey(db).publicRaw, amount: 10 * TUG, nonce: tc.nextNonce(db, pub),
  };
  const spend = {
    from: pub, nonce: tx.nonce,
    sig: crypto.sign(null, Buffer.from(tc.canonical(tc.transferPayload(tx))), priv).toString('hex'),
  };

  const betId = db.tx(() => bankMod.bankFor(db, cfg, spend).settle({
    user, game: 'dice', wager: 10 * TUG, multiplier: 1.98, payout: Math.round(19.8 * TUG),
    edgeUnits: 0, seedId: null, nonce: 3, clientSeed: 'cs', detail: { roll: 42.17, target: 50 },
  }));
  const log = events.history(db, 'dice', betId);
  assert.strictEqual(log.length, 1, 'no intermediate state, so no intermediate events');
  assert.strictEqual(log[0].k, 'f');
  assert.deepStrictEqual(log[0].a.slice(0, 6), [10 * TUG, 1.98, Math.round(19.8 * TUG), null, 3, 'cs']);
  assert.deepStrictEqual(log[0].a[6], { roll: 42.17, target: 50 }, 'the outcome, for anyone replaying the seed');
  assert.strictEqual(log[0].u, pub.slice(0, 8));
  assert.strictEqual(events.pending(db).count, 1);
});
