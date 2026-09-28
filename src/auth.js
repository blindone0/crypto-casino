'use strict';
// Accounts, sessions, and per-player provably-fair seed chains.
//
// Session tokens are stored only as sha256(token), so a stolen database does not hand
// an attacker live sessions. CSRF uses a double-submit token that must arrive in the
// X-CSRF-Token header on every mutating request.
const crypto = require('node:crypto');
const U = require('./util');
const fair = require('./fair');
const ledger = require('./ledger');

const now = () => Math.floor(Date.now() / 1000);

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');

function makeReferralCode(db) {
  for (let i = 0; i < 50; i += 1) {
    const code = crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, '').slice(0, 7);
    if (code.length >= 6 && !db.get('SELECT 1 FROM users WHERE referral_code=?', code)) return code;
  }
  throw new Error('could not allocate a referral code');
}

// ------------------------------------------------------------- registration
function register(db, cfg, { username, password, referralCode, ip }) {
  const name = String(username ?? '').trim();
  const pass = String(password ?? '');
  if (!USERNAME_RE.test(name)) {
    throw new U.BadRequest('username must be 3-20 characters, letters, digits or underscore');
  }
  if (pass.length < MIN_PASSWORD || pass.length > MAX_PASSWORD) {
    throw new U.BadRequest(`password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters`);
  }
  const lower = name.toLowerCase();

  return db.tx(() => {
    if (db.get('SELECT 1 FROM users WHERE username_lower=?', lower)) {
      throw new U.BadRequest('username already taken');
    }
    let referrer = null;
    if (referralCode) {
      const r = db.get('SELECT id FROM users WHERE referral_code=?', String(referralCode).trim());
      if (r) referrer = r.id;
    }
    // First account created becomes the admin, so a fresh install is usable immediately.
    const isFirst = !db.get('SELECT 1 FROM users LIMIT 1');

    db.run(
      `INSERT INTO users(username,username_lower,password_hash,role,client_seed,referred_by,referral_code,created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      name, lower, U.hashPassword(pass), isFirst ? 'admin' : 'player',
      crypto.randomBytes(8).toString('hex'), referrer, makeReferralCode(db), now(),
    );
    const user = db.get('SELECT * FROM users WHERE username_lower=?', lower);

    ledger.userAccount(db, user.id);
    ledger.userAccount(db, user.id, 'rakeback');
    rotateSeed(db, user.id);

    // The welcome grant is NOT paid here, and that is deliberate rather than an omission.
    //
    // Tugriks live on a key the player holds, and the browser has to generate that key
    // before there is anywhere to put them. So the grant is paid by `registerKey` when
    // the client posts its new public key, moments after this returns — out of the
    // treasury, once per account, recorded in `token_grants`. See src/tokenchain.js.
    //
    // The server never sees the private half, which is the whole point, and is why this
    // cannot simply hand out a balance the way the old credit faucet did.
    db.audit(`user:${user.id}`, 'register', { username: name, referrer }, ip);
    return db.get('SELECT * FROM users WHERE id=?', user.id);
  });
}

// ------------------------------------------------------------------- login
function login(db, cfg, { username, password, ip }) {
  const lower = String(username ?? '').trim().toLowerCase();
  const user = db.get('SELECT * FROM users WHERE username_lower=?', lower);

  // Always run a scrypt comparison so a missing user and a wrong password take
  // the same time and cannot be told apart by timing.
  const stored = user ? user.password_hash : U.hashPassword(crypto.randomBytes(16).toString('hex'));
  const ok = U.verifyPassword(String(password ?? ''), stored);
  if (!user || !ok) throw new U.HttpError(401, 'wrong username or password');
  if (user.frozen) throw new U.Forbidden('account frozen');

  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  db.tx(() => {
    db.run(
      'INSERT INTO sessions(token_hash,user_id,csrf,ip,created_at,expires_at) VALUES(?,?,?,?,?,?)',
      tokenHash(token), user.id, csrf, ip || null, now(), now() + cfg.sessionTtlSec,
    );
    db.run('UPDATE users SET last_seen_at=? WHERE id=?', now(), user.id);
  });
  return { token, csrf, user };
}

function logout(db, token) {
  if (!token) return;
  db.run('DELETE FROM sessions WHERE token_hash=?', tokenHash(token));
}

/** Resolve the session cookie to a live user, or null. Also sweeps expired rows. */
function sessionFrom(db, token) {
  if (!token) return null;
  const s = db.get('SELECT * FROM sessions WHERE token_hash=?', tokenHash(token));
  if (!s) return null;
  if (s.expires_at < now()) {
    db.run('DELETE FROM sessions WHERE token_hash=?', s.token_hash);
    return null;
  }
  const user = db.get('SELECT * FROM users WHERE id=?', s.user_id);
  if (!user) return null;
  return { session: s, user };
}

function changePassword(db, user, { current, next }) {
  if (!U.verifyPassword(String(current ?? ''), user.password_hash)) {
    throw new U.BadRequest('current password is wrong');
  }
  const pass = String(next ?? '');
  if (pass.length < MIN_PASSWORD || pass.length > MAX_PASSWORD) {
    throw new U.BadRequest(`password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters`);
  }
  db.tx(() => {
    db.run('UPDATE users SET password_hash=? WHERE id=?', U.hashPassword(pass), user.id);
    // Invalidate every other session after a password change.
    db.run('DELETE FROM sessions WHERE user_id=?', user.id);
  });
}

// --------------------------------------------------------------- seed chain
/**
 * Retire the active seed (revealing it) and commit to a fresh one.
 * The reveal is what lets a player audit every bet they already made.
 */
function rotateSeed(db, userId) {
  return db.tx(() => {
    const prev = db.get('SELECT * FROM server_seeds WHERE user_id IS ? AND active=1', userId);
    if (prev) {
      db.run('UPDATE server_seeds SET active=0, revealed_at=? WHERE id=?', now(), prev.id);
    }
    const seed = fair.newServerSeed();
    db.run(
      'INSERT INTO server_seeds(user_id,seed,seed_hash,nonce,active,created_at) VALUES(?,?,?,0,1,?)',
      userId, seed, fair.sha256hex(seed), now(),
    );
    const next = db.get('SELECT * FROM server_seeds WHERE user_id IS ? AND active=1', userId);
    return { revealed: prev || null, active: next };
  });
}

function activeSeed(db, userId) {
  let row = db.get('SELECT * FROM server_seeds WHERE user_id IS ? AND active=1', userId);
  if (!row) {
    rotateSeed(db, userId);
    row = db.get('SELECT * FROM server_seeds WHERE user_id IS ? AND active=1', userId);
  }
  return row;
}

/**
 * Claim the next nonce on a seed. Must run inside the same transaction as the bet so
 * two concurrent bets can never share a nonce (which would duplicate an outcome).
 */
function claimNonce(db, seedId) {
  db.run('UPDATE server_seeds SET nonce = nonce + 1 WHERE id=?', seedId);
  return db.get('SELECT nonce FROM server_seeds WHERE id=?', seedId).nonce;
}

function setClientSeed(db, userId, seed) {
  const s = String(seed ?? '').trim();
  if (s.length < 1 || s.length > 64) throw new U.BadRequest('client seed must be 1-64 characters');
  if (!/^[\x20-\x7E]+$/.test(s)) throw new U.BadRequest('client seed must be printable ASCII');
  // Changing the client seed restarts the chain, so the old seed is revealed too.
  db.tx(() => {
    db.run('UPDATE users SET client_seed=? WHERE id=?', s, userId);
    rotateSeed(db, userId);
  });
  return s;
}

/** Public view of a user: never leaks the hash, the active seed, or internal caps. */
function publicUser(db, user) {
  const main = ledger.userAccount(db, user.id);
  const rake = ledger.userAccount(db, user.id, 'rakeback');
  const aff = ledger.affiliateAccount(db, user.id);
  const seed = activeSeed(db, user.id);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    balance: main.balance,
    rakeback: rake.balance,
    affiliateBalance: aff.balance,
    clientSeed: user.client_seed,
    serverSeedHash: seed.seed_hash,
    nonce: seed.nonce,
    referralCode: user.referral_code,
    selfExcludedUntil: user.self_excluded_until,
    maxBetCap: user.max_bet_cap,
    createdAt: user.created_at,
  };
}

module.exports = {
  register, login, logout, sessionFrom, changePassword,
  rotateSeed, activeSeed, claimNonce, setClientSeed,
  publicUser, tokenHash, USERNAME_RE,
};
