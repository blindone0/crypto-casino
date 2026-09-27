'use strict';
// Jurisdiction control: decide which countries may reach the site.
//
// Every real operator needs this, because which markets you may legally serve is set by
// your licence, not by your preferences. It runs in two modes:
//   allow - only the listed countries get in, everyone else is refused
//   deny  - the listed countries are refused, everyone else gets in
//
// Country resolution, in priority order:
//   1. A header set by your edge proxy. Cloudflare sets CF-IPCountry; nginx with the
//      GeoIP2 module can set anything you like. This is the accurate, zero-maintenance
//      option and needs no database inside the app. Requires trustProxy, because a
//      header is only trustworthy if a proxy you control is the one setting it.
//   2. A local CIDR table (data/geo-ranges.txt), lines of "<cidr> <CC>". Works offline.
//      Populate it from the RIPE/ARIN delegated-extended files if you have no proxy.
//   3. Unknown. Handled by geo.onUnknown, which should be 'deny' if the restriction
//      actually matters to you: an unresolvable IP is the easiest way around a filter.
//
// Enforcement is skipped entirely for loopback and private addresses so that local
// development, health checks and an internal reverse proxy are never locked out.
const fs = require('node:fs');
const path = require('node:path');

// ------------------------------------------------------------------ parsing
/** IPv4 dotted quad -> 32-bit integer, or null. */
function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i += 1) {
    const part = Number(m[i]);
    if (part > 255) return null;
    n = n * 256 + part;
  }
  return n;
}

/** IPv6 (including ::ffff:1.2.3.4) -> BigInt, or null. */
function ipv6ToBig(ip) {
  let s = ip;
  // IPv4-mapped addresses are compared as IPv4 elsewhere; here expand them properly.
  const v4 = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(s);
  if (v4) {
    const n = ipv4ToInt(v4[2]);
    if (n === null) return null;
    s = v4[1] + [(n >>> 16) & 0xffff, n & 0xffff].map((x) => x.toString(16)).join(':');
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = halves.length === 2
    ? [...head, ...new Array(fill).fill('0'), ...tail]
    : head;
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  return out;
}

/** Normalise what Node hands us: ::ffff:1.2.3.4 is really an IPv4 address. */
function normaliseIp(ip) {
  const s = String(ip || '').trim().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(s);
  return mapped ? mapped[1] : s;
}

/** Loopback, link-local and RFC1918 space: never geo-filtered. */
function isPrivate(ip) {
  const s = normaliseIp(ip);
  if (s === '::1' || s === '' || s === '0.0.0.0') return true;
  const n = ipv4ToInt(s);
  if (n !== null) {
    const [a, b] = s.split('.').map(Number);
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const lower = s.toLowerCase();
  return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

/** Parse "1.2.3.0/24" or "2001:db8::/32" into a matcher record. */
function parseCidr(cidr) {
  const [addr, bitsRaw] = String(cidr).split('/');
  const bits = Number(bitsRaw);
  const v4 = ipv4ToInt(addr);
  if (v4 !== null) {
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    return { v: 4, base: (v4 & mask) >>> 0, mask };
  }
  const v6 = ipv6ToBig(addr);
  if (v6 !== null) {
    if (!Number.isInteger(bits) || bits < 0 || bits > 128) return null;
    const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
    return { v: 6, base: v6 & mask, mask };
  }
  return null;
}

// ------------------------------------------------------------------ ranges
/**
 * Load a CIDR-to-country table. Format, one per line, # for comments:
 *   5.8.0.0/16 RU
 *   2a02:6b8::/32 RU
 */
function loadRanges(file) {
  const v4 = [];
  const v6 = [];
  if (!file || !fs.existsSync(file)) return { v4, v6, count: 0 };
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const clean = line.split('#')[0].trim();
    if (!clean) continue;
    const [cidr, cc] = clean.split(/\s+/);
    if (!cidr || !cc) continue;
    const parsed = parseCidr(cidr);
    if (!parsed) continue;
    const entry = { ...parsed, cc: cc.toUpperCase().slice(0, 2) };
    (entry.v === 4 ? v4 : v6).push(entry);
  }
  v4.sort((a, b) => a.base - b.base);
  return { v4, v6, count: v4.length + v6.length };
}

function lookupRanges(ranges, ip) {
  const s = normaliseIp(ip);
  const n = ipv4ToInt(s);
  if (n !== null) {
    for (const r of ranges.v4) if (((n & r.mask) >>> 0) === r.base) return r.cc;
    return null;
  }
  const big = ipv6ToBig(s);
  if (big === null) return null;
  for (const r of ranges.v6) if ((big & r.mask) === r.base) return r.cc;
  return null;
}

// ------------------------------------------------------------------ policy
/**
 * Build the request filter. Returns { check(req, ip), countryOf(req, ip), active, stats }.
 * `check` returns null to allow, or a { status, country, reason } object to refuse.
 */
function createGeo(cfg, logger = console) {
  const g = cfg.geo || {};
  const productionOnly = g.productionOnly !== false;
  const isProduction = process.env.NODE_ENV === 'production';
  // The whole filter is inert unless it is switched on AND (if productionOnly) we are
  // actually in production. That keeps local development and tests unfiltered.
  const active = !!g.enabled && g.mode !== 'off' && (!productionOnly || isProduction);

  const file = g.rangesFile
    ? (path.isAbsolute(g.rangesFile) ? g.rangesFile : path.join(cfg.root, g.rangesFile))
    : null;
  const ranges = active ? loadRanges(file) : { v4: [], v6: [], count: 0 };
  const list = new Set((g.countries || []).map((c) => String(c).toUpperCase().slice(0, 2)));
  const header = String(g.countryHeader || 'cf-ipcountry').toLowerCase();

  if (active) {
    logger.log(`[geo] ${g.mode} mode, ${list.size} country(ies), `
      + `${ranges.count} local range(s), header "${header}"`);
    if (!cfg.trustProxy && ranges.count === 0) {
      logger.warn('[geo] trustProxy is off and no local ranges are loaded, so no country '
        + 'can ever be resolved; every request will hit the onUnknown policy');
    }
  }

  function countryOf(req, ip) {
    // A header is only trustworthy when a proxy we control sets it.
    if (cfg.trustProxy && req?.headers?.[header]) {
      const cc = String(req.headers[header]).toUpperCase().slice(0, 2);
      if (/^[A-Z]{2}$/.test(cc)) return cc;
    }
    if (ranges.count) return lookupRanges(ranges, ip);
    return null;
  }

  function check(req, ip) {
    if (!active) return null;
    if (g.bypassPrivate !== false && isPrivate(ip)) return null;

    const country = countryOf(req, ip);
    if (country === null) {
      return g.onUnknown === 'deny'
        ? { status: 451, country: null, reason: 'country could not be determined' }
        : null;
    }
    const listed = list.has(country);
    const blocked = g.mode === 'allow' ? !listed : listed;
    return blocked
      ? { status: 451, country, reason: `service is not available in ${country}` }
      : null;
  }

  return {
    active,
    check,
    countryOf,
    stats: () => ({
      active,
      mode: g.mode,
      countries: [...list],
      localRanges: ranges.count,
      header,
      onUnknown: g.onUnknown,
      productionOnly,
      isProduction,
    }),
  };
}

module.exports = {
  createGeo, loadRanges, lookupRanges, parseCidr,
  ipv4ToInt, ipv6ToBig, isPrivate, normaliseIp,
};
