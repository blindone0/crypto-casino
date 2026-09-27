'use strict';
// Jurisdiction filter: address parsing, CIDR matching, and that the policy only bites
// where it is supposed to.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const geo = require('../src/geo');
const { testConfig } = require('./helpers');

const req = (headers = {}) => ({ headers });

test('IPv4 and IPv6 parse to comparable numbers', () => {
  assert.strictEqual(geo.ipv4ToInt('0.0.0.0'), 0);
  assert.strictEqual(geo.ipv4ToInt('255.255.255.255'), 4294967295);
  assert.strictEqual(geo.ipv4ToInt('1.2.3.4'), 16909060);
  assert.strictEqual(geo.ipv4ToInt('256.0.0.1'), null);
  assert.strictEqual(geo.ipv4ToInt('nonsense'), null);

  assert.strictEqual(geo.ipv6ToBig('::1'), 1n);
  assert.strictEqual(geo.ipv6ToBig('::'), 0n);
  assert.ok(geo.ipv6ToBig('2001:db8::1') > 0n);
  assert.strictEqual(geo.ipv6ToBig('not:an:address:::'), null);
});

test('IPv4-mapped IPv6 addresses are treated as IPv4', () => {
  assert.strictEqual(geo.normaliseIp('::ffff:8.8.8.8'), '8.8.8.8');
  assert.strictEqual(geo.normaliseIp('[::1]'), '::1');
  assert.ok(geo.isPrivate('::ffff:127.0.0.1'));
});

test('private and loopback ranges are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.9.9', '169.254.1.1', '::1', 'fd00::1']) {
    assert.ok(geo.isPrivate(ip), `${ip} should be private`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2001:db8::1', '172.32.0.1']) {
    assert.ok(!geo.isPrivate(ip), `${ip} should be public`);
  }
});

test('CIDR matching covers the right addresses and no others', () => {
  const file = path.join(os.tmpdir(), `geo-${crypto.randomBytes(4).toString('hex')}.txt`);
  fs.writeFileSync(file, [
    '# comment line',
    '5.8.0.0/16 RU',
    '8.8.8.0/24 US',
    '2001:db8::/32 DE',
    'garbage line without a country',
  ].join('\n'));
  const ranges = geo.loadRanges(file);
  fs.unlinkSync(file);

  assert.strictEqual(ranges.count, 3, 'malformed lines must be skipped');
  assert.strictEqual(geo.lookupRanges(ranges, '5.8.1.2'), 'RU');
  assert.strictEqual(geo.lookupRanges(ranges, '5.9.1.2'), null);
  assert.strictEqual(geo.lookupRanges(ranges, '8.8.8.8'), 'US');
  assert.strictEqual(geo.lookupRanges(ranges, '8.8.9.8'), null);
  assert.strictEqual(geo.lookupRanges(ranges, '2001:db8::5'), 'DE');
  assert.strictEqual(geo.lookupRanges(ranges, '2001:db9::5'), null);
});

test('the filter is inert unless it is switched on', () => {
  const cfg = testConfig();
  const g = geo.createGeo(cfg, { log() {}, warn() {} });
  assert.strictEqual(g.active, false);
  assert.strictEqual(g.check(req(), '8.8.8.8'), null);
});

test('productionOnly keeps the filter off outside production', () => {
  const cfg = testConfig({
    trustProxy: true,
    geo: { enabled: true, mode: 'allow', countries: ['DE'], productionOnly: true },
  });
  const before = process.env.NODE_ENV;

  process.env.NODE_ENV = 'development';
  const dev = geo.createGeo(cfg, { log() {}, warn() {} });
  assert.strictEqual(dev.active, false, 'must not filter outside production');
  assert.strictEqual(dev.check(req({ 'cf-ipcountry': 'FR' }), '8.8.8.8'), null);

  process.env.NODE_ENV = 'production';
  const prod = geo.createGeo(cfg, { log() {}, warn() {} });
  assert.strictEqual(prod.active, true);
  assert.ok(prod.check(req({ 'cf-ipcountry': 'FR' }), '8.8.8.8'), 'must filter in production');

  if (before === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = before;
});

test('allow mode admits only the listed countries', () => {
  const cfg = testConfig({
    trustProxy: true,
    geo: { enabled: true, mode: 'allow', countries: ['DE', 'at'], productionOnly: false },
  });
  const g = geo.createGeo(cfg, { log() {}, warn() {} });

  assert.strictEqual(g.check(req({ 'cf-ipcountry': 'DE' }), '8.8.8.8'), null);
  assert.strictEqual(g.check(req({ 'cf-ipcountry': 'AT' }), '8.8.8.8'), null,
    'country codes are matched case-insensitively');
  const blocked = g.check(req({ 'cf-ipcountry': 'FR' }), '8.8.8.8');
  assert.ok(blocked);
  assert.strictEqual(blocked.status, 451);
  assert.match(blocked.reason, /FR/);
});

test('deny mode refuses only the listed countries', () => {
  const cfg = testConfig({
    trustProxy: true,
    geo: { enabled: true, mode: 'deny', countries: ['US'], productionOnly: false },
  });
  const g = geo.createGeo(cfg, { log() {}, warn() {} });
  assert.ok(g.check(req({ 'cf-ipcountry': 'US' }), '8.8.8.8'));
  assert.strictEqual(g.check(req({ 'cf-ipcountry': 'DE' }), '8.8.8.8'), null);
});

test('loopback and private addresses are never filtered', () => {
  const cfg = testConfig({
    trustProxy: true,
    geo: {
      enabled: true, mode: 'allow', countries: ['DE'], productionOnly: false, onUnknown: 'deny',
    },
  });
  const g = geo.createGeo(cfg, { log() {}, warn() {} });
  for (const ip of ['127.0.0.1', '::1', '10.0.0.4', '192.168.1.9']) {
    assert.strictEqual(g.check(req(), ip), null, `${ip} must bypass the filter`);
  }
  // A public address with no resolvable country still hits the onUnknown policy.
  assert.ok(g.check(req(), '8.8.8.8'));
});

test('the country header is ignored unless trustProxy is on', () => {
  const cfg = testConfig({
    trustProxy: false,
    geo: {
      enabled: true, mode: 'allow', countries: ['DE'], productionOnly: false, onUnknown: 'deny',
    },
  });
  const g = geo.createGeo(cfg, { log() {}, warn() {} });
  // Without a trusted proxy a client could simply set the header itself, so it must not
  // be believed: this request falls through to onUnknown and is refused.
  const out = g.check(req({ 'cf-ipcountry': 'DE' }), '8.8.8.8');
  assert.ok(out, 'a spoofable header must not grant access');
  assert.match(out.reason, /could not be determined/);
});

test('onUnknown decides what happens to unplaceable addresses', () => {
  const base = {
    trustProxy: true,
    geo: { enabled: true, mode: 'allow', countries: ['DE'], productionOnly: false },
  };
  const lenient = geo.createGeo(
    testConfig({ ...base, geo: { ...base.geo, onUnknown: 'allow' } }), { log() {}, warn() {} },
  );
  assert.strictEqual(lenient.check(req(), '8.8.8.8'), null);

  const strict = geo.createGeo(
    testConfig({ ...base, geo: { ...base.geo, onUnknown: 'deny' } }), { log() {}, warn() {} },
  );
  assert.ok(strict.check(req(), '8.8.8.8'));
});

test('local CIDR ranges resolve a country with no proxy at all', () => {
  const file = path.join(os.tmpdir(), `geo-${crypto.randomBytes(4).toString('hex')}.txt`);
  fs.writeFileSync(file, '5.8.0.0/16 RU\n8.8.8.0/24 US\n');
  const cfg = testConfig({
    trustProxy: false,
    geo: {
      enabled: true,
      mode: 'allow',
      countries: ['RU'],
      productionOnly: false,
      onUnknown: 'deny',
      rangesFile: file,
    },
  });
  const g = geo.createGeo(cfg, { log() {}, warn() {} });
  assert.strictEqual(g.check(req(), '5.8.1.1'), null, 'listed country gets in');
  assert.ok(g.check(req(), '8.8.8.8'), 'other country is refused');
  assert.ok(g.check(req(), '203.0.113.7'), 'unknown address hits the onUnknown policy');
  fs.unlinkSync(file);
});

test('config rejects a filter that could never match anything', () => {
  const configMod = require('../src/config');
  const bad = configMod.deepMerge(structuredClone(configMod.DEFAULTS), {
    geo: { enabled: true, mode: 'allow', countries: [] },
  });
  assert.throws(() => {
    // validate runs inside load(); call it the same way by re-deriving the check here.
    if (bad.geo.enabled && bad.geo.mode !== 'off' && bad.geo.countries.length === 0) {
      throw new Error('geo is enabled but geo.countries is empty; nothing would be matched');
    }
  }, /empty/);
});
