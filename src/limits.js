'use strict';
// Rate limiting plus the player-controlled limits.
//
// The self-limit tools are not decoration: they reduce chargebacks and complaints, they
// are the first thing any payment provider or licensing body asks about, and a player who
// can set their own ceiling is far less likely to go to war with you over a bad night.
const U = require('./util');

const now = () => Math.floor(Date.now() / 1000);

/** Fixed-window counter in SQLite. Cheap and good enough for a single-process site. */
function hit(db, key, max, windowSec) {
  const t = now();
  const row = db.get('SELECT * FROM rate_limits WHERE key=?', key);
  if (!row || t - row.window_start >= windowSec) {
    db.run(
      `INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,1)
       ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start, count=1`,
      key, t,
    );
    return { ok: true, remaining: max - 1, resetIn: windowSec };
  }
  if (row.count >= max) {
    return { ok: false, remaining: 0, resetIn: windowSec - (t - row.window_start) };
  }
  db.run('UPDATE rate_limits SET count = count + 1 WHERE key=?', key);
  return { ok: true, remaining: max - row.count - 1, resetIn: windowSec - (t - row.window_start) };
}

/** Pick the tightest configured bucket whose prefix matches the path. */
function bucketFor(cfg, pathname) {
  let best = null;
  for (const [prefix, spec] of Object.entries(cfg.rateLimits)) {
    if (prefix === 'default') continue;
    if (pathname.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, spec };
    }
  }
  return best || { prefix: 'default', spec: cfg.rateLimits.default };
}

function enforce(db, cfg, ip, pathname) {
  const { prefix, spec } = bucketFor(cfg, pathname);
  const [max, windowSec] = spec;
  const r = hit(db, `${ip}|${prefix}`, max, windowSec);
  if (!r.ok) throw new U.TooMany(`too many requests, try again in ${r.resetIn}s`);
  return r;
}

/** Drop counters nobody is looking at any more. Called periodically by the server. */
function sweep(db) {
  db.run('DELETE FROM rate_limits WHERE window_start < ?', now() - 3600);
  db.run('DELETE FROM sessions WHERE expires_at < ?', now());
}

// ------------------------------------------------- player-controlled limits
function setSelfExclusion(db, cfg, user, days) {
  const d = U.toInt(days, { min: 1, max: cfg.limits.selfExclusionMaxDays, name: 'days' });
  const until = now() + d * 86400;
  // Only ever extends. A cooling-off period you can cancel is not a cooling-off period.
  const target = Math.max(until, user.self_excluded_until);
  db.tx(() => {
    db.run('UPDATE users SET self_excluded_until=? WHERE id=?', target, user.id);
    db.run('DELETE FROM sessions WHERE user_id=?', user.id);
    db.audit(`user:${user.id}`, 'selfExclude', { days: d, until: target });
  });
  return { until: target };
}

function setMaxBet(db, user, amount) {
  const units = amount === '' || amount == null ? 0 : U.parseAmount(amount);
  // Raising your own cap takes effect after 24h; lowering it is immediate.
  const raising = units === 0 || units > user.max_bet_cap;
  if (raising && user.max_bet_cap > 0) {
    const pending = { units, effectiveAt: now() + 86400 };
    db.kvSet(`pendingMaxBet:${user.id}`, pending);
    db.audit(`user:${user.id}`, 'maxBet.raiseQueued', pending);
    return { queued: true, ...pending };
  }
  db.run('UPDATE users SET max_bet_cap=? WHERE id=?', units, user.id);
  db.audit(`user:${user.id}`, 'maxBet.set', { units });
  return { queued: false, units };
}

/** Apply any queued cap increase whose 24h wait has elapsed. Called on each request. */
function applyPendingLimits(db, user) {
  const p = db.kvGet(`pendingMaxBet:${user.id}`);
  if (p && p.effectiveAt <= now()) {
    db.run('UPDATE users SET max_bet_cap=? WHERE id=?', p.units, user.id);
    db.run('DELETE FROM kv WHERE key=?', `pendingMaxBet:${user.id}`);
    return db.get('SELECT * FROM users WHERE id=?', user.id);
  }
  return user;
}

/** Enforce a daily deposit ceiling, if one is configured or the player set one. */
function checkDepositCap(db, cfg, user, units) {
  const cap = user.daily_deposit_cap || cfg.limits.maxDailyDepositUnits;
  if (!cap) return;
  const since = now() - 86400;
  const sum = db.get(
    'SELECT COALESCE(SUM(amount_units),0) AS n FROM deposits WHERE user_id=? AND created_at >= ?',
    user.id, since,
  ).n;
  if (sum + units > cap) {
    throw new U.BadRequest(`daily deposit limit reached (${U.formatAmount(cap)})`);
  }
}

function requireNotExcluded(user) {
  if (user.self_excluded_until > now()) {
    const days = Math.ceil((user.self_excluded_until - now()) / 86400);
    throw new U.Forbidden(`self-exclusion active for another ${days} day(s)`);
  }
}

/** Minutes played in the last 24h, for the session-time reminder in the UI. */
function playTimeToday(db, userId) {
  const since = now() - 86400;
  const row = db.get(
    'SELECT COUNT(*) AS bets, MIN(created_at) AS first, MAX(created_at) AS last FROM bets WHERE user_id=? AND created_at>=?',
    userId, since,
  );
  if (!row.bets) return { bets: 0, minutes: 0 };
  return { bets: row.bets, minutes: Math.round((row.last - row.first) / 60) };
}

module.exports = {
  hit, enforce, sweep, bucketFor,
  setSelfExclusion, setMaxBet, applyPendingLimits,
  checkDepositCap, requireNotExcluded, playTimeToday,
};
