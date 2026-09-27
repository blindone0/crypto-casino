'use strict';
// Shared helpers: integer money math, crypto, HTTP plumbing.
const crypto = require('node:crypto');

// ---------------------------------------------------------------- money
// All balances are integers in "units". 1 credit = 1e8 units (satoshi-style).
// Never use floats for balances. Max safe total is 2^53-1 units = ~90M credits.
const UNIT = 100000000;
const MAX_UNITS = Number.MAX_SAFE_INTEGER;

/** Parse a user-supplied decimal amount string into integer units. Throws on junk. */
function parseAmount(input) {
  const s = String(input ?? '').trim();
  if (!/^\d{1,12}(\.\d{1,8})?$/.test(s)) throw new BadRequest('invalid amount format');
  const [whole, frac = ''] = s.split('.');
  const units = Number(whole) * UNIT + Number(frac.padEnd(8, '0'));
  if (!Number.isSafeInteger(units) || units < 0) throw new BadRequest('amount out of range');
  return units;
}

/** Integer units -> fixed 8-decimal string. */
function formatAmount(units) {
  const n = Math.trunc(Number(units));
  const neg = n < 0;
  const a = Math.abs(n);
  const s = `${Math.trunc(a / UNIT)}.${String(a % UNIT).padStart(8, '0')}`;
  return neg ? `-${s}` : s;
}

/** Multiply integer units by a decimal multiplier, truncating down (house-favourable). */
function mulUnits(units, multiplier) {
  if (!Number.isFinite(multiplier) || multiplier < 0) throw new Error('bad multiplier');
  // Scale the multiplier to an integer (8dp) first so we avoid drifting floats.
  const scaled = Math.round(multiplier * 1e8);
  const out = Math.floor((units * scaled) / 1e8);
  if (!Number.isSafeInteger(out)) throw new BadRequest('payout overflow');
  return out;
}

// ---------------------------------------------------------------- crypto
const randomHex = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac256 = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();

/** Timing-safe string comparison that never throws on length mismatch. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) {
    // Still burn a comparison so the timing does not leak the length.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, keyHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), keyHex.length / 2, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- errors
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || message;
  }
}
class BadRequest extends HttpError { constructor(m, c) { super(400, m, c); } }
class Unauthorized extends HttpError { constructor(m = 'not signed in') { super(401, m); } }
class Forbidden extends HttpError { constructor(m = 'forbidden') { super(403, m); } }
class NotFound extends HttpError { constructor(m = 'not found') { super(404, m); } }
class TooMany extends HttpError { constructor(m = 'slow down') { super(429, m); } }

// ---------------------------------------------------------------- http
function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

const MAX_BODY = 64 * 1024;
// How much we are willing to read and throw away after rejecting a body, so that a
// normal client still receives the 413 instead of a connection reset.
const HARD_BODY_LIMIT = 4 * 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) {
        // Stop collecting, but do NOT destroy the socket here: the caller still has to
        // write a 413, and tearing the connection down now shows up at the client as a
        // connection reset instead of a readable error.
        aborted = true;
        chunks.length = 0;
        reject(new HttpError(413, 'request body too large'));
        // Keep draining so the client can finish its upload and actually read the 413
        // instead of seeing a connection reset. Abusive uploads still get cut off.
        req.on('data', (extra) => {
          size += extra.length;
          if (size > HARD_BODY_LIMIT) req.destroy();
        });
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('aborted', () => reject(new BadRequest('request aborted')));
    req.on('end', () => {
      if (aborted) return;
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new BadRequest('body must be a JSON object'));
        }
        resolve(parsed);
      } catch {
        reject(new BadRequest('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function cookieHeader(name, value, { maxAge, secure, httpOnly = true, sameSite = 'Strict' } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${sameSite}`];
  if (httpOnly) bits.push('HttpOnly');
  if (secure) bits.push('Secure');
  if (maxAge != null) bits.push(`Max-Age=${Math.trunc(maxAge)}`);
  return bits.join('; ');
}

/** Real client IP: trusts X-Forwarded-For only when the proxy flag is on. */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '0.0.0.0';
}

const nowSec = () => Math.floor(Date.now() / 1000);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Integer-only string check used for ids coming off the wire. */
function toInt(v, { min = -Infinity, max = Infinity, name = 'value' } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequest(`${name} must be an integer in range`);
  return n;
}

module.exports = {
  UNIT, MAX_UNITS, parseAmount, formatAmount, mulUnits,
  randomHex, sha256, hmac256, safeEqual, hashPassword, verifyPassword,
  HttpError, BadRequest, Unauthorized, Forbidden, NotFound, TooMany,
  sendJson, readJsonBody, parseCookies, cookieHeader, clientIp,
  nowSec, clamp, toInt, MAX_BODY, HARD_BODY_LIMIT,
};
