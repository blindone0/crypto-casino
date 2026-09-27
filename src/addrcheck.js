'use strict';
// Address validation with real checksums, not just shape matching.
//
// This matters most for the treasury: a payout is irreversible, and the manual driver has
// no node to catch a bad address for you. Bitcoin-family addresses carry a checksum that
// catches every realistic typo, so we verify it before anything is sent.
const crypto = require('node:crypto');

// ----------------------------------------------------------------- bech32
// BIP-173 (bech32) and BIP-350 (bech32m). Segwit v0 uses bech32, v1+ uses bech32m.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

const hrpExpand = (hrp) => [
  ...[...hrp].map((c) => c.charCodeAt(0) >> 5),
  0,
  ...[...hrp].map((c) => c.charCodeAt(0) & 31),
];

/** Returns { hrp, data, encoding } or null. */
function bech32Decode(addr) {
  if (typeof addr !== 'string' || addr.length < 8 || addr.length > 90) return null;
  const lower = addr.toLowerCase();
  if (addr !== lower && addr !== addr.toUpperCase()) return null; // no mixed case
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) return null;

  const hrp = lower.slice(0, pos);
  const data = [];
  for (const ch of lower.slice(pos + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v === -1) return null;
    data.push(v);
  }
  const chk = polymod([...hrpExpand(hrp), ...data]);
  const encoding = chk === 1 ? 'bech32' : (chk === 0x2bc830a3 ? 'bech32m' : null);
  if (!encoding) return null;
  return { hrp, data: data.slice(0, -6), encoding };
}

/** Full segwit validation: checksum, witness version, program length, encoding match. */
function isValidSegwit(addr, hrps = ['bc', 'tb', 'bcrt', 'ltc', 'tltc']) {
  const d = bech32Decode(addr);
  if (!d || !hrps.includes(d.hrp) || d.data.length < 1) return false;

  const version = d.data[0];
  if (version > 16) return false;
  if (version === 0 && d.encoding !== 'bech32') return false;
  if (version !== 0 && d.encoding !== 'bech32m') return false;

  // Convert the 5-bit group payload back to bytes.
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const v of d.data.slice(1)) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) return false;
  if (out.length < 2 || out.length > 40) return false;
  if (version === 0 && out.length !== 20 && out.length !== 32) return false;
  return true;
}

// ------------------------------------------------------------ base58check
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(s) {
  if (typeof s !== 'string' || !s.length) return null;
  let num = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v === -1) return null;
    num = num * 58n + BigInt(v);
  }
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

/** Legacy P2PKH / P2SH: 25 bytes, last 4 being the doubled-SHA256 checksum. */
function isValidBase58Check(addr, versions = null) {
  const raw = base58Decode(String(addr || '').trim());
  if (!raw || raw.length !== 25) return false;
  const body = raw.subarray(0, 21);
  const check = raw.subarray(21);
  const want = sha256(sha256(body)).subarray(0, 4);
  if (!check.equals(want)) return false;
  if (versions && !versions.includes(body[0])) return false;
  return true;
}

// ----------------------------------------------------------------- monero
// Monero uses its own base58 (8-byte blocks) with a keccak-256 checksum. We do not carry
// a keccak implementation, so this checks the structure the network guarantees: a valid
// prefix byte, the exact length, and a legal alphabet. The wallet RPC rejects anything
// that gets past this, so a bad address fails at send rather than silently succeeding.
function isValidMonero(addr) {
  const s = String(addr || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return false;
  if (s.length !== 95 && s.length !== 106) return false;
  // Mainnet standard starts 4, subaddress 8, integrated 4 with 106 chars.
  return /^[48]/.test(s);
}

// ------------------------------------------------------------------ facade
/** Validate an address for a given wallet driver. */
function validate(driverName, addr) {
  const a = String(addr || '').trim();
  if (!a) return { ok: false, reason: 'empty address' };

  switch (driverName) {
    case 'bitcoind': {
      if (isValidSegwit(a)) return { ok: true, kind: 'segwit' };
      // 0x00 = P2PKH mainnet, 0x05 = P2SH mainnet, 0x6f/0xc4 = testnet, 0x30 = LTC P2PKH
      if (isValidBase58Check(a, [0x00, 0x05, 0x6f, 0xc4, 0x30, 0x32])) {
        return { ok: true, kind: 'legacy' };
      }
      return { ok: false, reason: 'checksum failed: this is not a valid Bitcoin address' };
    }
    case 'monero':
      return isValidMonero(a)
        ? { ok: true, kind: a.length === 106 ? 'integrated' : 'monero' }
        : { ok: false, reason: 'not a valid Monero address' };
    case 'mock':
      return a.length >= 8 ? { ok: true, kind: 'mock' } : { ok: false, reason: 'too short' };
    case 'manual':
    default:
      // Unknown chain: accept anything plausible, since we cannot check what we do not know.
      return a.length >= 10 && a.length <= 128
        ? { ok: true, kind: 'unchecked' }
        : { ok: false, reason: 'address length looks wrong' };
  }
}

module.exports = {
  validate, bech32Decode, isValidSegwit, isValidBase58Check, isValidMonero, base58Decode,
};
