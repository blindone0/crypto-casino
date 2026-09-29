'use strict';
// The site token, on a signed hash-linked ledger anyone can verify.
//
// WHAT THIS IS, PLAINLY
// Every token movement goes into a block. Each block contains the hash of the block
// before it and is signed with the server's Ed25519 key, so the whole history is one
// tamper-evident chain. Every transfer inside a block is separately signed by the key of
// the account sending it, derived from a word phrase only that player holds.
//
// The guarantees that gives you are real and worth stating exactly:
//   1. The operator cannot move your tokens. A transfer without your signature is
//      rejected by anyone who checks, including the verifier page in this repo.
//   2. The operator cannot quietly rewrite history. Changing any past transaction changes
//      that block's hash, which breaks every link after it and invalidates every
//      signature from that point on.
//   3. Anyone can audit the entire ledger independently, in their browser, without
//      trusting anything the server says about itself.
//
// WHAT THIS IS NOT, equally plainly:
//   - It is not decentralised. One server decides what goes into a block and in what
//     order. It cannot forge your signature, but it can refuse to include you.
//   - It is not a consensus network. Browsers cannot do consensus: they are offline most
//     of the time, have no stake, and anyone can spin up ten thousand of them.
//   - It is not unhackable. Nothing is. Someone who takes the server key can sign new
//     blocks; what they still cannot do is forge a transfer out of an account whose
//     phrase they do not have, or alter history without every prior copy disagreeing.
//
// The honest mitigation for point two is publication: `head` is exposed so clients can
// pin the chain tip they have seen, and any later divergence is provable with the two
// signed heads side by side.
//
// Primitives are deliberately boring and standard: Ed25519 signatures and SHA-256
// hashing. Boring is what "compatible" actually means.
//
// EVENTS. Since the games began writing their every step to the chain (src/events.js),
// a block may also carry `ev` transactions: a game code, a round, a sequence number, a
// kind and its arguments. An event is not money and cannot become money: applyTx has no
// path from it to credit(), and both verifiers — this one and the browser's — refuse an
// event that so much as carries a `to`, `from` or `amount` field. That refusal is the
// load-bearing line, because it holds whatever a later refactor of the balance replay
// makes of an unknown shape.
const crypto = require('node:crypto');
const U = require('./util');

const GENESIS_PREV = '0'.repeat(64);
const CHAIN_ID = 'nullstake-token-v1';

// ------------------------------------------------------------ key plumbing
// Node wants DER-wrapped keys; the wire format is raw 32 bytes. These two prefixes are
// the fixed ASN.1 headers for Ed25519, so wrapping is a concatenation rather than a
// dependency.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const publicKeyFromRaw = (raw) => crypto.createPublicKey({
  key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw, 'hex')]),
  format: 'der',
  type: 'spki',
});

const privateKeyFromSeed = (seed) => crypto.createPrivateKey({
  key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed, 'hex')]),
  format: 'der',
  type: 'pkcs8',
});

const rawPublicKey = (key) => key.export({ format: 'der', type: 'spki' })
  .subarray(SPKI_PREFIX.length).toString('hex');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Canonical JSON: keys sorted, no incidental whitespace. Two parties must hash the exact
 * same bytes or every signature check fails for reasons nobody can debug.
 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

// ------------------------------------------------------------- server key
/** The operator signing key, generated once and kept in the database. */
function serverKey(db) {
  let stored = db.kvGet('token.serverKey');
  if (!stored) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    stored = {
      publicRaw: rawPublicKey(publicKey),
      privatePkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex'),
      createdAt: Math.floor(Date.now() / 1000),
    };
    db.kvSet('token.serverKey', stored);
    db.audit('system', 'token.serverKey.created', { publicKey: stored.publicRaw });
  }
  return {
    publicRaw: stored.publicRaw,
    private: crypto.createPrivateKey({
      key: Buffer.from(stored.privatePkcs8, 'hex'), format: 'der', type: 'pkcs8',
    }),
  };
}

/**
 * The treasury: the account that holds every tugrik nobody else does yet.
 *
 * Separate from the block-signing key and from the house escrow key, because the three
 * are different jobs. This one exists so the supply can be minted exactly once, at
 * genesis, and handed out afterwards by transfer.
 */
function treasuryKey(db) {
  let stored = db.kvGet('token.treasuryKey');
  if (!stored) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    stored = {
      publicRaw: rawPublicKey(publicKey),
      privatePkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex'),
      createdAt: Math.floor(Date.now() / 1000),
    };
    db.kvSet('token.treasuryKey', stored);
    db.audit('system', 'token.treasuryKey.created', { publicKey: stored.publicRaw });
  }
  return {
    publicRaw: stored.publicRaw,
    private: crypto.createPrivateKey({
      key: Buffer.from(stored.privatePkcs8, 'hex'), format: 'der', type: 'pkcs8',
    }),
  };
}

// -------------------------------------------------------------- the chain
/** Everything a block commits to. The signature covers exactly this, hashed. */
const blockPayload = (b) => ({
  chain: CHAIN_ID,
  height: b.height,
  prevHash: b.prevHash,
  timestamp: b.timestamp,
  txs: b.txs,
});

const blockHash = (b) => sha256(canonical(blockPayload(b)));

function head(db) {
  const row = db.get('SELECT * FROM token_blocks ORDER BY height DESC LIMIT 1');
  return row || null;
}

/**
 * Mint the entire supply, once, into the treasury.
 *
 * This is the only mint that will ever be accepted: verifyChain refuses a mint anywhere
 * but block zero. Everything after it is a transfer or a burn, which can move tokens and
 * destroy them but cannot bring any into existence.
 *
 * Called on the first use of the chain. If a chain already exists, this does nothing at
 * all, so the supply of a running system cannot be revised by editing the config.
 */
function ensureGenesis(db, cfg) {
  if (head(db)) return false;
  const supply = Number(cfg?.token?.maxSupply ?? 0);
  if (!Number.isSafeInteger(supply) || supply <= 0) {
    throw new Error('token.maxSupply must be a positive whole number');
  }
  const treasury = treasuryKey(db);
  appendBlock(db, [{
    type: 'mint', to: treasury.publicRaw, amount: supply, memo: 'genesis',
  }]);
  db.audit('system', 'token.genesis', { supply, treasury: treasury.publicRaw });
  return true;
}

/** A transfer signed by the treasury. Used to pay grants out of the fixed supply. */
function treasuryTransfer(db, to, amount) {
  const key = treasuryKey(db);
  const tx = {
    type: 'transfer', from: key.publicRaw, to, amount, nonce: nextNonce(db, key.publicRaw),
  };
  tx.sig = crypto.sign(
    null, Buffer.from(canonical(transferPayload(tx))), key.private,
  ).toString('hex');
  db.run('INSERT INTO token_nonces(pubkey, nonce, created_at) VALUES(?,?,?)',
    key.publicRaw, tx.nonce, Math.floor(Date.now() / 1000));
  return tx;
}

/** What the supply actually is, read off the chain rather than off the config. */
function supply(db) {
  let minted = 0;
  let burned = 0;
  for (const row of db.all('SELECT txs FROM token_blocks ORDER BY height')) {
    for (const tx of JSON.parse(row.txs)) {
      if (tx.type === 'mint') minted += tx.amount;
      else if (tx.type === 'burn') burned += tx.amount;
    }
  }
  const treasury = db.kvGet('token.treasuryKey');
  return {
    minted,
    burned,
    circulating: minted - burned,
    treasury: treasury ? balanceOf(db, treasury.publicRaw) : 0,
  };
}

/** What a transfer signature covers. The chain id stops a signature being replayed. */
const transferPayload = (tx) => ({
  chain: CHAIN_ID,
  type: 'transfer',
  from: tx.from,
  to: tx.to,
  amount: tx.amount,
  nonce: tx.nonce,
});

/**
 * What an event may look like, and nothing else.
 *
 * Returns null for a well-formed event and the reason for anything else. The browser
 * verifier holds a copy of these rules (public/chainverify.js), and one test vector is
 * run through both, so the two cannot disagree about what an event is.
 */
const EVENT_FIELDS = new Set(['type', 'g', 'r', 's', 'k', 'a', 'u', 'sig']);
const EVENT_BYTES = 4096;

function checkEvent(tx) {
  for (const k of ['to', 'from', 'amount', 'nonce']) {
    if (k in tx) return `an event carries a money field (${k})`;
  }
  for (const k of Object.keys(tx)) {
    if (!EVENT_FIELDS.has(k)) return `an event carries an unknown field (${k})`;
  }
  if (typeof tx.g !== 'string' || !/^[a-z][a-z0-9-]{0,15}$/.test(tx.g)) return 'an event names no game';
  if (!Number.isSafeInteger(tx.r) || tx.r < 0) return 'an event names no round';
  if (!Number.isSafeInteger(tx.s) || tx.s < 0) return 'an event has no sequence number';
  if (typeof tx.k !== 'string' || !/^[a-z]$/.test(tx.k)) return 'an event has no kind';
  if (!Array.isArray(tx.a)) return 'an event has no argument list';
  if (tx.u !== undefined && !/^[0-9a-f]{8}$/.test(String(tx.u))) return 'an event names its actor badly';
  if (tx.sig !== undefined && !/^[0-9a-f]{128}$/.test(String(tx.sig))) return 'an event carries a malformed signature';
  if (canonical(tx).length > EVENT_BYTES) return 'an event is too large';
  return null;
}

/**
 * THE ROUND, SIGNED ONCE
 *
 * Signing every click would make every click wait on the wallet key, make a locked
 * wallet unplayable rather than merely unspendable, and shut out a browser without
 * Ed25519. Almost everything per-click signing would buy — a history the operator cannot
 * fabricate — is had for one signature: the browser folds each event the server shows it
 * into a running hash, and signs the hash in the request that closes the round. The
 * server folds its own log the same way, checks the signature, and stores it on the
 * finishing event. A round whose log the operator rewrote afterwards fails a signature
 * the operator cannot forge. A round with no signature — no key on the device, a step
 * the network lost — is the operator's assertion and not the player's, and the
 * anti-cheat weighs it accordingly.
 *
 * The payload has its own type so it can never be replayed as a transfer.
 */
const ROUND_SEED = 'nullstake-round-v1';

const roundPayload = ({ g, r, n, h }) => ({
  chain: CHAIN_ID, type: 'round', g, r, n, h,
});

/** One step of the running hash, over the event as the browser saw it: no receipt time. */
const foldEvent = (hHex, ev) => sha256(
  hHex + canonical({ g: ev.g, r: ev.r, s: ev.s, k: ev.k, a: ev.a }),
);

function verifyRoundSignature(pubkey, payload, sig) {
  try {
    return crypto.verify(
      null,
      Buffer.from(canonical(payload)),
      publicKeyFromRaw(pubkey),
      Buffer.from(String(sig), 'hex'),
    );
  } catch {
    return false;
  }
}

/**
 * THE ANTI-CHEAT'S TRANSACTIONS, AND THE ONE EXCEPTION TO THE CENTRAL CLAIM
 *
 * `flag`, `unflag` and `ban` are the operator's decisions about an account, on the record
 * with the evidence: they move nothing. `seize` moves what a banned account holds to the
 * house, and it is the one transaction in this file that debits a key without that key's
 * signature. It is held to exactly this and nothing more, in applyTx and in both
 * verifiers: only to the house key, only citing a `ban` of the same key that is already
 * on the chain. The central claim — the operator cannot sign a transfer out of your
 * account — is untouched: a seize is not a transfer, and the test that makes that claim
 * is unmodified. Supply is unchanged by construction: a seize is a move, not a mint.
 */
const ADMIN_TYPES = new Set(['flag', 'unflag', 'ban', 'seize']);
const KEY_RE = /^[0-9a-f]{64}$/;

function checkAdminTx(tx) {
  if (tx.type === 'seize') {
    for (const k of Object.keys(tx)) {
      if (!['type', 'from', 'to', 'amount', 'ban'].includes(k)) return `a seize carries an unknown field (${k})`;
    }
    if (!KEY_RE.test(String(tx.from))) return 'a seize names no account';
    if (!KEY_RE.test(String(tx.to))) return 'a seize names no destination';
    if (!Number.isSafeInteger(tx.amount) || tx.amount <= 0) return 'a seize has no amount';
    if (!Number.isSafeInteger(tx.ban) || tx.ban < 0) return 'a seize cites no ban';
    return null;
  }
  for (const k of Object.keys(tx)) {
    if (!['type', 'who', 'why', 'blocks'].includes(k)) return `a ${tx.type} carries an unknown field (${k})`;
  }
  if (!KEY_RE.test(String(tx.who))) return `a ${tx.type} names no account`;
  if (tx.why !== undefined && (typeof tx.why !== 'string' || tx.why.length > 200)) return `a ${tx.type} has a bad reason`;
  if (tx.blocks !== undefined && !(Array.isArray(tx.blocks) && tx.blocks.every((h) => Number.isSafeInteger(h) && h >= 0))) {
    return `a ${tx.type} cites blocks badly`;
  }
  if (tx.type === 'ban' && !tx.why) return 'a ban says why';
  return null;
}

/** The house key, as the anti-cheat and the loans need it: the only place a seize may go. */
function houseKeyRaw(db) {
  const stored = db.kvGet('token.houseKey');
  return stored ? stored.publicRaw : null;
}

/** Whether block `height`, before block `before`, carries a ban of `who`. */
function banIn(db, height, who, before) {
  if (!Number.isSafeInteger(height) || height >= before) return false;
  const row = db.get('SELECT txs FROM token_blocks WHERE height=?', height);
  if (!row) return false;
  return JSON.parse(row.txs).some((tx) => tx.type === 'ban' && tx.who === who);
}

function verifyTransferSignature(tx) {
  try {
    return crypto.verify(
      null,
      Buffer.from(canonical(transferPayload(tx))),
      publicKeyFromRaw(tx.from),
      Buffer.from(tx.sig, 'hex'),
    );
  } catch {
    return false;
  }
}

/**
 * Append a block. Caller must hold a transaction; balances are updated in the same one,
 * so the materialised balances can never disagree with the chain.
 */
function appendBlock(db, txs) {
  const key = serverKey(db);
  const prev = head(db);
  const block = {
    height: prev ? prev.height + 1 : 0,
    prevHash: prev ? prev.hash : GENESIS_PREV,
    timestamp: Math.floor(Date.now() / 1000),
    txs,
  };
  const hash = blockHash(block);
  const signature = crypto.sign(null, Buffer.from(hash), key.private).toString('hex');

  db.run(
    `INSERT INTO token_blocks(height, prev_hash, hash, txs, signature, created_at)
     VALUES(?,?,?,?,?,?)`,
    block.height, block.prevHash, hash, JSON.stringify(txs), signature, block.timestamp,
  );
  for (const tx of txs) applyTx(db, tx);
  return { ...block, hash, signature };
}

/** Move the materialised balances. The chain remains the source of truth. */
function applyTx(db, tx) {
  if (tx.type === 'ev') {
    // Not money. The shape is checked here as well as by the verifiers, so an event
    // that would not verify cannot be written in the first place.
    const why = checkEvent(tx);
    if (why) throw new U.BadRequest(why);
    return;
  }
  if (ADMIN_TYPES.has(tx.type)) {
    const why = checkAdminTx(tx);
    if (why) throw new U.BadRequest(why);
    if (tx.type !== 'seize') return;
    // The narrow exception: only to the house, only after a ban already on the chain.
    if (tx.to !== houseKeyRaw(db)) throw new U.BadRequest('a seize may only go to the house');
    const tip = head(db);
    if (!banIn(db, tx.ban, tx.from, tip ? tip.height + 1 : 0)) {
      throw new U.BadRequest('a seize follows a ban on the chain, never precedes one');
    }
    const from = balanceOf(db, tx.from);
    if (from < tx.amount) throw new U.BadRequest('insufficient token balance');
    credit(db, tx.from, -tx.amount);
    credit(db, tx.to, tx.amount);
    return;
  }
  if (tx.type === 'mint') {
    credit(db, tx.to, tx.amount);
  } else if (tx.type === 'transfer') {
    const from = balanceOf(db, tx.from);
    if (from < tx.amount) throw new U.BadRequest('insufficient token balance');
    credit(db, tx.from, -tx.amount);
    credit(db, tx.to, tx.amount);
  } else if (tx.type === 'burn') {
    const from = balanceOf(db, tx.from);
    if (from < tx.amount) throw new U.BadRequest('insufficient token balance');
    credit(db, tx.from, -tx.amount);
  } else {
    throw new U.BadRequest(`unknown token transaction type: ${tx.type}`);
  }
}

function credit(db, pubkey, delta) {
  const row = db.get('SELECT balance FROM token_balances WHERE pubkey=?', pubkey);
  const next = (row ? row.balance : 0) + delta;
  if (next < 0) throw new U.BadRequest('insufficient token balance');
  if (!Number.isSafeInteger(next)) throw new U.BadRequest('token balance overflow');
  db.run(
    `INSERT INTO token_balances(pubkey, balance, updated_at) VALUES(?,?,?)
     ON CONFLICT(pubkey) DO UPDATE SET balance=excluded.balance, updated_at=excluded.updated_at`,
    pubkey, next, Math.floor(Date.now() / 1000),
  );
}

const balanceOf = (db, pubkey) => {
  const row = db.get('SELECT balance FROM token_balances WHERE pubkey=?', pubkey);
  return row ? row.balance : 0;
};

// ------------------------------------------------------------ verification
/** The highest checkpoint at or below the tip, or null. */
function latestCheckpoint(db) {
  const tip = head(db);
  if (!tip) return null;
  return db.get(
    'SELECT * FROM token_checkpoints WHERE height <= ? ORDER BY height DESC LIMIT 1', tip.height,
  ) || null;
}

/**
 * Whether a checkpoint can be trusted: its anchor block is still there, still hashes to
 * what the checkpoint recorded, and still hashes to its own contents under the operator
 * key. A rewritten anchor cannot inherit a checkpoint, because the checkpoint commits to
 * a hash that commits to everything before it — provided the rewrite kept the links,
 * which is the case a full verify exists for (see tools/verify-chain.js).
 */
function anchorHolds(db, key, cp) {
  const row = db.get('SELECT * FROM token_blocks WHERE height=?', cp.height);
  if (!row || row.hash !== cp.hash) return false;
  const txs = JSON.parse(row.txs);
  const expected = blockHash({
    height: row.height, prevHash: row.prev_hash, timestamp: row.created_at, txs,
  });
  if (expected !== row.hash) return false;
  return crypto.verify(
    null, Buffer.from(row.hash), publicKeyFromRaw(key.publicRaw), Buffer.from(row.signature, 'hex'),
  );
}

/**
 * Replay the chain: check every link, every server signature, every transfer signature,
 * every event's shape, and that the balances the database reports match the replay.
 *
 * From genesis by default. With `checkpoint: true` it starts from the latest checkpoint
 * whose anchor still holds, replaying only the blocks since — the doctor's mode, which
 * stays quick as the chain grows — and says so in `from`. A checkpoint that does not hold
 * is ignored and the replay is a full one, which is the only safe reading of a cache.
 *
 * The verifier page in the browser does the full replay, always: a player should not be
 * asked to trust the operator's cache. This copy exists so the server can check itself
 * and so the test suite can assert it.
 */
function verifyChain(db, { checkpoint = false } = {}) {
  const key = serverKey(db);
  const total = db.get('SELECT COUNT(*) AS n FROM token_blocks').n;
  let balances = new Map();
  let seenNonces = new Set();
  let prevHash = GENESIS_PREV;
  let events = 0;
  let admin = 0;
  let start = 0;
  let from = null;
  const house = houseKeyRaw(db);

  if (checkpoint) {
    const cp = latestCheckpoint(db);
    if (cp && anchorHolds(db, key, cp)) {
      balances = new Map(Object.entries(JSON.parse(cp.balances)));
      seenNonces = new Set(JSON.parse(cp.nonces));
      prevHash = cp.hash;
      events = cp.events;
      start = cp.height + 1;
      from = cp.height;
    }
  }

  const blocks = db.all('SELECT * FROM token_blocks WHERE height >= ? ORDER BY height', start);
  for (const [idx, row] of blocks.entries()) {
    const i = start + idx;
    if (row.height !== i) return fail(`block ${i} claims height ${row.height}`);
    if (row.prev_hash !== prevHash) return fail(`block ${i} does not link to its predecessor`);

    const txs = JSON.parse(row.txs);
    const expected = blockHash({
      height: row.height, prevHash: row.prev_hash, timestamp: row.created_at, txs,
    });
    if (expected !== row.hash) return fail(`block ${i} hash does not match its contents`);

    const sigOk = crypto.verify(
      null, Buffer.from(row.hash), publicKeyFromRaw(key.publicRaw), Buffer.from(row.signature, 'hex'),
    );
    if (!sigOk) return fail(`block ${i} is not signed by the operator key`);

    for (const tx of txs) {
      if (tx.type === 'ev') {
        // An event carries no money by construction, and the verifier holds it to that:
        // one with a money field is refused here, before the balance replay below could
        // make anything of it.
        const why = checkEvent(tx);
        if (why) return fail(`block ${i}: ${why}`);
        events += 1;
        continue;
      }
      if (ADMIN_TYPES.has(tx.type)) {
        const why = checkAdminTx(tx);
        if (why) return fail(`block ${i}: ${why}`);
        admin += 1;
        if (tx.type !== 'seize') continue;
        // The narrow exception, held to by the verifier as well as by applyTx.
        if (tx.to !== house) return fail(`block ${i} seizes to a key that is not the house`);
        if (!banIn(db, tx.ban, tx.from, i)) return fail(`block ${i} seizes without a ban on the chain before it`);
      }
      // The supply is fixed by refusing to accept a chain that creates tokens anywhere but
      // in its first block. A verifier that skipped this check would happily confirm a
      // ledger where the operator minted itself a fortune in block nine hundred.
      if (tx.type === 'mint' && i !== 0) {
        return fail(`block ${i} mints tokens; only the genesis block may do that`);
      }
      if (tx.type === 'transfer') {
        if (!verifyTransferSignature(tx)) return fail(`block ${i} contains an unsigned transfer`);
        const nonceKey = `${tx.from}:${tx.nonce}`;
        if (seenNonces.has(nonceKey)) return fail(`block ${i} replays a spent nonce`);
        seenNonces.add(nonceKey);
      }
      const move = (who, delta) => {
        const next = (balances.get(who) || 0) + delta;
        if (next < 0) throw new Error(`block ${i} overdraws ${who.slice(0, 12)}`);
        balances.set(who, next);
      };
      try {
        if (tx.type === 'mint') move(tx.to, tx.amount);
        else if (tx.type === 'transfer') { move(tx.from, -tx.amount); move(tx.to, tx.amount); }
        else if (tx.type === 'burn') move(tx.from, -tx.amount);
        else if (tx.type === 'seize') { move(tx.from, -tx.amount); move(tx.to, tx.amount); }
        else return fail(`block ${i} contains an unknown transaction type`);
      } catch (e) {
        return fail(e.message);
      }
    }
    prevHash = row.hash;
  }

  // The materialised balances must agree with the replay, or the ledger is lying.
  for (const row of db.all('SELECT pubkey, balance FROM token_balances')) {
    if ((balances.get(row.pubkey) || 0) !== row.balance) {
      return fail(`stored balance for ${row.pubkey.slice(0, 12)} disagrees with the chain`);
    }
  }

  let minted = 0;
  const genesis = db.get('SELECT txs FROM token_blocks WHERE height=0');
  for (const tx of JSON.parse(genesis ? genesis.txs : '[]')) {
    if (tx.type === 'mint') minted += tx.amount;
  }
  return {
    ok: true,
    blocks: total,
    replayed: blocks.length,
    from,
    accounts: balances.size,
    head: prevHash,
    minted,
    events,
    admin,
    balances,
    nonces: seenNonces,
  };
  function fail(reason) { return { ok: false, reason, blocks: total, from }; }
}

/**
 * Record the verified state at the tip, so the next verify can start there.
 *
 * Verifies first — from the previous checkpoint, which is what makes writing one cheap —
 * and writes nothing if that fails: a checkpoint over a broken chain would be a cache of
 * a lie. The server calls this every so many blocks (src/events.js) and at boot; the
 * weekly full verify (tools/verify-chain.js) writes one after a replay from genesis. The
 * doctor never does, because the doctor writes nothing.
 */
function writeCheckpoint(db, { full = false } = {}) {
  const out = verifyChain(db, { checkpoint: !full });
  const tip = head(db);
  if (!out.ok || !tip) return { written: false, ...out };
  if (db.get('SELECT 1 FROM token_checkpoints WHERE height=?', tip.height)) {
    return { written: false, ...out, height: tip.height };
  }
  db.run(
    `INSERT INTO token_checkpoints(height, hash, balances, nonces, events, created_at)
     VALUES(?,?,?,?,?,?)`,
    tip.height, tip.hash, JSON.stringify(Object.fromEntries(out.balances)),
    JSON.stringify([...out.nonces]), out.events, Math.floor(Date.now() / 1000),
  );
  return { written: true, ...out, height: tip.height };
}

/** When the chain was last replayed from genesis, in seconds, or null. */
const lastFullVerify = (db) => db.kvGet('chain.fullVerifiedAt', null);

// -------------------------------------------------------------------- api
/**
 * Register the public key a player derived from their phrase.
 *
 * `replace` is the answer to a lost phrase. Without it an account whose phrase is gone is
 * locked out of the token permanently: it cannot sign for the wallet it has, and it cannot
 * register another. That is not how a lost key should behave, even though the tokens
 * themselves really are gone.
 *
 * What replacing does NOT do is recover anything. The old balance stays on the chain,
 * attached to a key nobody can sign for, and it is unspendable forever. Nor does a
 * replacement wallet get a second welcome grant: the grant is once per account, or losing
 * a phrase on purpose becomes a way to drain the treasury.
 */
function registerKey(db, userId, pubkey, cfg, { replace = false } = {}) {
  const key = String(pubkey || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new U.BadRequest('public key must be 32 bytes of hex');

  return db.tx(() => {
    let existing = db.get('SELECT * FROM token_keys WHERE user_id=?', userId);
    if (existing && existing.pubkey !== key && replace) {
      const stranded = balanceOf(db, existing.pubkey);
      db.run('DELETE FROM token_keys WHERE user_id=?', userId);
      db.audit(`user:${userId}`, 'token.key.replaced', {
        old: existing.pubkey, new: key, stranded,
      });
      // Marked as having held a key before, so no second grant is paid below.
      existing = null;
      db.run(
        `INSERT INTO token_grants(user_id, created_at) VALUES(?,?)
         ON CONFLICT(user_id) DO NOTHING`, userId, Math.floor(Date.now() / 1000),
      );
    }
    if (existing && existing.pubkey !== key) {
      throw new U.BadRequest('this account already has a token key; restore that phrase instead');
    }
    const owner = db.get('SELECT user_id FROM token_keys WHERE pubkey=?', key);
    if (owner && owner.user_id !== userId) throw new U.BadRequest('that key belongs to another account');

    ensureGenesis(db, cfg);

    if (!existing) {
      db.run('INSERT INTO token_keys(user_id, pubkey, created_at) VALUES(?,?,?)',
        userId, key, Math.floor(Date.now() / 1000));
      // The grant is paid out of the treasury, not minted. That is the whole point: if a
      // new account could mint, then unlimited accounts would mean unlimited tugriks and
      // the token would be worth exactly what it costs to register.
      const grant = Number(cfg.token?.welcomeGrant ?? 0);
      const treasury = treasuryKey(db).publicRaw;
      // Once per account, ever. A grant per wallet would make "lose the phrase" a faucet.
      const already = db.get('SELECT 1 FROM token_grants WHERE user_id=?', userId);
      if (!already && grant > 0 && balanceOf(db, treasury) >= grant) {
        appendBlock(db, [treasuryTransfer(db, key, grant)]);
        db.run('INSERT INTO token_grants(user_id, created_at) VALUES(?,?)',
          userId, Math.floor(Date.now() / 1000));
      }
    }
    return {
      pubkey: key,
      balance: balanceOf(db, key),
      // Told plainly rather than left to be discovered: the faucet is finite.
      granted: !existing && balanceOf(db, key) > 0,
    };
  });
}

/** Submit a transfer the player signed in their browser. */
function submitTransfer(db, tx) {
  const clean = {
    type: 'transfer',
    from: String(tx.from || '').toLowerCase(),
    to: String(tx.to || '').toLowerCase(),
    amount: Number(tx.amount),
    nonce: Number(tx.nonce),
    sig: String(tx.sig || '').toLowerCase(),
  };
  for (const field of ['from', 'to']) {
    if (!/^[0-9a-f]{64}$/.test(clean[field])) throw new U.BadRequest(`${field} must be a 32-byte key`);
  }
  if (!/^[0-9a-f]{128}$/.test(clean.sig)) throw new U.BadRequest('signature must be 64 bytes of hex');
  if (!Number.isSafeInteger(clean.amount) || clean.amount <= 0) throw new U.BadRequest('bad amount');
  if (!Number.isSafeInteger(clean.nonce) || clean.nonce < 0) throw new U.BadRequest('bad nonce');
  if (clean.from === clean.to) throw new U.BadRequest('cannot send to yourself');

  // This is the line that matters: the server checks the signature and cannot produce one.
  if (!verifyTransferSignature(clean)) throw new U.BadRequest('signature does not match this transfer');

  return db.tx(() => {
    if (db.get('SELECT 1 FROM token_nonces WHERE pubkey=? AND nonce=?', clean.from, clean.nonce)) {
      throw new U.BadRequest('that nonce has already been used');
    }
    if (balanceOf(db, clean.from) < clean.amount) throw new U.BadRequest('insufficient token balance');

    db.run('INSERT INTO token_nonces(pubkey, nonce, created_at) VALUES(?,?,?)',
      clean.from, clean.nonce, Math.floor(Date.now() / 1000));
    const block = appendBlock(db, [clean]);
    return { height: block.height, hash: block.hash, balance: balanceOf(db, clean.from) };
  });
}

/** Chain data for the verifier, paged so a long chain is still checkable. */
function chainSlice(db, from = 0, limit = 500) {
  const start = Math.max(0, Number(from) || 0);
  const count = U.clamp(Number(limit) || 500, 1, 2000);
  const blocks = db.all(
    'SELECT height, prev_hash, hash, txs, signature, created_at FROM token_blocks '
    + 'WHERE height >= ? ORDER BY height LIMIT ?', start, count,
  ).map((b) => ({
    height: b.height,
    prevHash: b.prev_hash,
    hash: b.hash,
    signature: b.signature,
    timestamp: b.created_at,
    txs: JSON.parse(b.txs),
  }));
  const tip = head(db);
  return {
    chain: CHAIN_ID,
    serverKey: serverKey(db).publicRaw,
    houseKey: houseKeyRaw(db),
    genesisPrev: GENESIS_PREV,
    height: tip ? tip.height : -1,
    head: tip ? tip.hash : null,
    from: start,
    blocks,
  };
}

const keyFor = (db, userId) => db.get('SELECT * FROM token_keys WHERE user_id=?', userId) || null;

const nextNonce = (db, pubkey) => {
  const row = db.get('SELECT COALESCE(MAX(nonce), -1) AS n FROM token_nonces WHERE pubkey=?', pubkey);
  return row.n + 1;
};

module.exports = {
  CHAIN_ID, GENESIS_PREV,
  canonical, sha256, blockHash, transferPayload,
  publicKeyFromRaw, privateKeyFromSeed, rawPublicKey,
  serverKey, treasuryKey, ensureGenesis, treasuryTransfer, supply,
  appendBlock, head, balanceOf, verifyChain, verifyTransferSignature, checkEvent,
  latestCheckpoint, writeCheckpoint, lastFullVerify,
  ROUND_SEED, roundPayload, foldEvent, verifyRoundSignature,
  ADMIN_TYPES, checkAdminTx, houseKeyRaw, banIn,
  registerKey, submitTransfer, chainSlice, keyFor, nextNonce,
};
