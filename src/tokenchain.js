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
/**
 * Replay the whole chain from genesis: check every link, every server signature, every
 * transfer signature, and that the balances the database reports match a fresh replay.
 *
 * The verifier page in the browser does exactly this, which is the point. This copy
 * exists so the server can check itself and so the test suite can assert it.
 */
function verifyChain(db) {
  const key = serverKey(db);
  const blocks = db.all('SELECT * FROM token_blocks ORDER BY height');
  const balances = new Map();
  const seenNonces = new Set();
  let prevHash = GENESIS_PREV;

  for (const [i, row] of blocks.entries()) {
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
  for (const tx of JSON.parse(blocks[0]?.txs || '[]')) {
    if (tx.type === 'mint') minted += tx.amount;
  }
  return {
    ok: true, blocks: blocks.length, accounts: balances.size, head: prevHash, minted,
  };
  function fail(reason) { return { ok: false, reason, blocks: blocks.length }; }
}

// -------------------------------------------------------------------- api
/** Register the public key a player derived from their phrase. */
function registerKey(db, userId, pubkey, cfg) {
  const key = String(pubkey || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new U.BadRequest('public key must be 32 bytes of hex');

  return db.tx(() => {
    const existing = db.get('SELECT * FROM token_keys WHERE user_id=?', userId);
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
      if (grant > 0 && balanceOf(db, treasury) >= grant) {
        appendBlock(db, [treasuryTransfer(db, key, grant)]);
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
  appendBlock, head, balanceOf, verifyChain, verifyTransferSignature,
  registerKey, submitTransfer, chainSlice, keyFor, nextNonce,
};
