'use strict';
// SQLite layer built on the bundled node:sqlite module (no native npm build needed).
//
// Money model: accounts.balance is the authoritative integer balance, guarded by
// CHECK(balance >= 0). Every mutation also appends a row to `ledger` inside the same
// transaction, so the ledger is a replayable audit trail and house profit is
// derivable from data rather than trusted.
//
// IMPORTANT: DatabaseSync is synchronous. Transaction bodies must contain NO await,
// or two HTTP requests could interleave inside one BEGIN/COMMIT.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;

CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY,
  username            TEXT NOT NULL UNIQUE,
  username_lower      TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player','admin')),
  client_seed         TEXT NOT NULL,
  referred_by         INTEGER REFERENCES users(id),
  referral_code       TEXT NOT NULL UNIQUE,
  self_excluded_until INTEGER NOT NULL DEFAULT 0,
  daily_deposit_cap   INTEGER NOT NULL DEFAULT 0,
  max_bet_cap         INTEGER NOT NULL DEFAULT 0,
  frozen              INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf        TEXT NOT NULL,
  ip          TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

-- owner_type house holds the bankroll, user holds player funds,
-- fees collects withdrawal fees, affiliate holds unpaid referral commission.
CREATE TABLE IF NOT EXISTS accounts (
  id         INTEGER PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('user','house','fees','affiliate','pending')),
  owner_id   INTEGER,
  kind       TEXT NOT NULL DEFAULT 'main',
  balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (owner_type, owner_id, kind)
);

CREATE TABLE IF NOT EXISTS ledger (
  id            INTEGER PRIMARY KEY,
  tx_id         TEXT NOT NULL,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  delta         INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  memo          TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ledger_tx ON ledger(tx_id);
CREATE INDEX IF NOT EXISTS ix_ledger_account ON ledger(account_id, id DESC);

-- Provably-fair seed chains. user_id NULL marks the shared chain used by crash rounds.
CREATE TABLE IF NOT EXISTS server_seeds (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  seed        TEXT NOT NULL,
  seed_hash   TEXT NOT NULL,
  nonce       INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  revealed_at INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_seeds_user ON server_seeds(user_id, active);

CREATE TABLE IF NOT EXISTS bets (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  game        TEXT NOT NULL,
  wager       INTEGER NOT NULL,
  multiplier  REAL NOT NULL,
  payout      INTEGER NOT NULL,
  profit      INTEGER NOT NULL,
  edge_units  INTEGER NOT NULL,
  seed_id     INTEGER REFERENCES server_seeds(id),
  nonce       INTEGER NOT NULL,
  client_seed TEXT NOT NULL,
  detail      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bets_user ON bets(user_id, id DESC);
CREATE INDEX IF NOT EXISTS ix_bets_game ON bets(game, id DESC);
CREATE INDEX IF NOT EXISTS ix_bets_time ON bets(created_at);

CREATE TABLE IF NOT EXISTS crash_rounds (
  id          INTEGER PRIMARY KEY,
  seed        TEXT NOT NULL,
  seed_hash   TEXT NOT NULL,
  nonce       INTEGER NOT NULL,
  crash_point REAL NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('betting','running','ended')),
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS crash_bets (
  id           INTEGER PRIMARY KEY,
  round_id     INTEGER NOT NULL REFERENCES crash_rounds(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  wager        INTEGER NOT NULL,
  auto_cashout REAL NOT NULL DEFAULT 0,
  cashed_at    REAL NOT NULL DEFAULT 0,
  payout       INTEGER NOT NULL DEFAULT 0,
  max_payout   INTEGER NOT NULL DEFAULT 0,
  state        TEXT NOT NULL CHECK (state IN ('placed','won','lost')),
  mode         TEXT NOT NULL DEFAULT 'real',
  created_at   INTEGER NOT NULL,
  UNIQUE (round_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_crashbets_round ON crash_bets(round_id);

-- Interactive mines rounds. The mine layout is derived from the seed at creation and
-- never sent to the client until the round is over.
CREATE TABLE IF NOT EXISTS mines_games (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wager       INTEGER NOT NULL,
  mine_count  INTEGER NOT NULL,
  mines       TEXT NOT NULL,
  picks       TEXT NOT NULL DEFAULT '[]',
  seed_id     INTEGER NOT NULL REFERENCES server_seeds(id),
  nonce       INTEGER NOT NULL,
  client_seed TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('active','lost','cashed')),
  mode        TEXT NOT NULL DEFAULT 'real',
  payout      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_mines_active ON mines_games(user_id, state);

-- One Preferans hand in progress. The bots' cards are stored server-side and never
-- sent to the client until the hand is over.
CREATE TABLE IF NOT EXISTS pref_games (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stake       INTEGER NOT NULL,
  hands       TEXT NOT NULL,
  talon       TEXT NOT NULL,
  trump       TEXT,
  state       TEXT NOT NULL CHECK (state IN ('trump','discard','playing','done')),
  mode        TEXT NOT NULL DEFAULT 'real',
  trick       TEXT NOT NULL DEFAULT '[]',
  leader      INTEGER NOT NULL DEFAULT 1,
  tricks_won  TEXT NOT NULL DEFAULT '[0,0,0]',
  trick_no    INTEGER NOT NULL DEFAULT 0,
  log         TEXT NOT NULL DEFAULT '[]',
  payout      INTEGER NOT NULL DEFAULT 0,
  seed_id     INTEGER NOT NULL REFERENCES server_seeds(id),
  nonce       INTEGER NOT NULL,
  client_seed TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_pref_active ON pref_games(user_id, state);

-- One puzzle round. The broken-piece layout comes from the seed at creation and is
-- never sent to the client until the round ends.
CREATE TABLE IF NOT EXISTS puzzle_games (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wager       INTEGER NOT NULL,
  difficulty  TEXT NOT NULL,
  picture     TEXT NOT NULL,
  broken      TEXT NOT NULL,
  picks       TEXT NOT NULL DEFAULT '[]',
  seed_id     INTEGER NOT NULL REFERENCES server_seeds(id),
  nonce       INTEGER NOT NULL,
  client_seed TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('active','lost','cashed')),
  mode        TEXT NOT NULL DEFAULT 'real',
  payout      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_puzzle_active ON puzzle_games(user_id, state);

-- One Debertz hand in progress. The bot's cards stay server-side until the hand ends.
CREATE TABLE IF NOT EXISTS debertz_games (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stake       INTEGER NOT NULL,
  hands       TEXT NOT NULL,
  upcard      TEXT NOT NULL,
  trump       TEXT,
  state       TEXT NOT NULL CHECK (state IN ('trump','playing','done')),
  mode        TEXT NOT NULL DEFAULT 'real',
  trick       TEXT NOT NULL DEFAULT '[]',
  turn        INTEGER NOT NULL DEFAULT 1,
  card_points TEXT NOT NULL DEFAULT '[0,0]',
  trick_no    INTEGER NOT NULL DEFAULT 0,
  last_winner INTEGER NOT NULL DEFAULT 1,
  log         TEXT NOT NULL DEFAULT '[]',
  payout      INTEGER NOT NULL DEFAULT 0,
  seed_id     INTEGER NOT NULL REFERENCES server_seeds(id),
  nonce       INTEGER NOT NULL,
  client_seed TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_debertz_active ON debertz_games(user_id, state);

-- The site token ledger: a hash-linked chain of signed blocks. The chain is the source
-- of truth; token_balances is a materialised view of it, updated in the same transaction
-- that appends a block so the two can never disagree.
CREATE TABLE IF NOT EXISTS token_blocks (
  height     INTEGER PRIMARY KEY,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE,
  txs        TEXT NOT NULL,
  signature  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS token_balances (
  pubkey     TEXT PRIMARY KEY,
  balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at INTEGER NOT NULL
);

-- Which account a player key belongs to. The private half never reaches the server.
CREATE TABLE IF NOT EXISTS token_keys (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pubkey     TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Spent nonces, so a captured signature cannot be replayed to send the same tokens twice.
CREATE TABLE IF NOT EXISTS token_nonces (
  pubkey     TEXT NOT NULL,
  nonce      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pubkey, nonce)
);

-- Play money. Deliberately NOT in the accounts/ledger tables: demo wins must never be
-- paid from the bankroll, and demo balances must never count as money owed to players.
CREATE TABLE IF NOT EXISTS demo_balances (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_bets (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game       TEXT NOT NULL,
  wager      INTEGER NOT NULL,
  multiplier REAL NOT NULL,
  payout     INTEGER NOT NULL,
  profit     INTEGER NOT NULL,
  nonce      INTEGER NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_demobets_user ON demo_bets(user_id, id DESC);

CREATE TABLE IF NOT EXISTS addresses (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  driver      TEXT NOT NULL,
  address     TEXT NOT NULL,
  deriv_index INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE (driver, address)
);
CREATE INDEX IF NOT EXISTS ix_addr_user ON addresses(user_id, driver);

CREATE TABLE IF NOT EXISTS deposits (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  driver        TEXT NOT NULL,
  address       TEXT NOT NULL,
  txid          TEXT NOT NULL,
  vout          INTEGER NOT NULL DEFAULT 0,
  amount_units  INTEGER NOT NULL,
  confirmations INTEGER NOT NULL DEFAULT 0,
  credited_at   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  UNIQUE (driver, txid, vout)
);
CREATE INDEX IF NOT EXISTS ix_dep_user ON deposits(user_id, id DESC);

CREATE TABLE IF NOT EXISTS withdrawals (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  driver       TEXT NOT NULL,
  address      TEXT NOT NULL,
  amount_units INTEGER NOT NULL,
  fee_units    INTEGER NOT NULL,
  send_units   INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending','approved','sent','rejected','failed')),
  txid         TEXT,
  admin_note   TEXT,
  requested_at INTEGER NOT NULL,
  decided_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_wd_state ON withdrawals(state, id);
CREATE INDEX IF NOT EXISTS ix_wd_user ON withdrawals(user_id, id DESC);

-- Operator profit leaving the site for a cold wallet. Separate from player withdrawals
-- so the books never mix customer money with owner money.
CREATE TABLE IF NOT EXISTS treasury_payouts (
  id           INTEGER PRIMARY KEY,
  label        TEXT,
  driver       TEXT NOT NULL,
  address      TEXT NOT NULL,
  amount_units INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('reserved','sent','failed','refunded')),
  txid         TEXT,
  note         TEXT,
  actor        TEXT,
  created_at   INTEGER NOT NULL,
  sent_at      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_treasury_state ON treasury_payouts(state, id DESC);

CREATE TABLE IF NOT EXISTS referral_earnings (
  id           INTEGER PRIMARY KEY,
  affiliate_id INTEGER NOT NULL REFERENCES users(id),
  player_id    INTEGER NOT NULL REFERENCES users(id),
  bet_id       INTEGER NOT NULL,
  amount_units INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ref_aff ON referral_earnings(affiliate_id, id DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_time ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return wrap(db);
}

/** Thin wrapper adding prepared-statement caching and a synchronous transaction helper. */
function wrap(db) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };

  let depth = 0;
  const api = {
    raw: db,
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    exec: (sql) => db.exec(sql),

    /**
     * Run fn inside an IMMEDIATE transaction. fn MUST be synchronous.
     * Nested calls join the outer transaction rather than starting a new one.
     */
    tx(fn) {
      if (depth > 0) {
        depth++;
        try { return fn(); } finally { depth--; }
      }
      db.exec('BEGIN IMMEDIATE');
      depth = 1;
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* already unwound */ }
        throw e;
      } finally {
        depth = 0;
      }
    },

    kvGet(key, fallback = null) {
      const row = api.get('SELECT value FROM kv WHERE key = ?', key);
      return row ? JSON.parse(row.value) : fallback;
    },
    kvSet(key, value) {
      api.run(
        'INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        key, JSON.stringify(value),
      );
    },
    audit(actor, action, detail, ip) {
      api.run(
        'INSERT INTO audit_log(actor,action,detail,ip,created_at) VALUES(?,?,?,?,?)',
        String(actor), String(action), JSON.stringify(detail ?? null), ip || null,
        Math.floor(Date.now() / 1000),
      );
    },
    close: () => db.close(),
  };
  return api;
}

module.exports = { open, SCHEMA };
