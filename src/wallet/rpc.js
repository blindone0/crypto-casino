'use strict';
// Minimal JSON-RPC client shared by the node-backed wallet drivers.
// Uses the global fetch built into Node, so there is nothing to install.

/**
 * @param {object} opts
 * @param {string} opts.url      full endpoint, e.g. http://127.0.0.1:8332/wallet/casino
 * @param {string} [opts.user]   basic-auth user
 * @param {string} [opts.pass]   basic-auth password
 * @param {number} [opts.timeoutMs]
 */
function makeRpc({ url, user, pass, timeoutMs = 20000 }) {
  if (!url) throw new Error('wallet rpc url is not configured');
  const headers = { 'content-type': 'application/json' };
  if (user || pass) {
    headers.authorization = `Basic ${Buffer.from(`${user ?? ''}:${pass ?? ''}`).toString('base64')}`;
  }

  let id = 0;
  return async function call(method, params = []) {
    id += 1;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: ac.signal,
      });
    } catch (e) {
      throw new Error(`rpc ${method} unreachable: ${e.message}`);
    } finally {
      clearTimeout(t);
    }

    const text = await res.text();
    if (!res.ok && !text) throw new Error(`rpc ${method} HTTP ${res.status}`);

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`rpc ${method} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (body.error) {
      const msg = body.error.message || JSON.stringify(body.error);
      throw new Error(`rpc ${method}: ${msg}`);
    }
    return body.result;
  };
}

/** Decimal-string helper: integer units (1e8 scale) -> a coin amount safe for JSON-RPC. */
function unitsToCoinString(units, decimals = 8) {
  const s = String(Math.trunc(units)).padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  return `${whole}.${frac}`;
}

/** Coin amount (number or string, e.g. 0.00123) -> integer units at 1e8 scale. */
function coinToUnits(amount) {
  const s = typeof amount === 'string' ? amount : Number(amount).toFixed(8);
  const neg = s.trim().startsWith('-');
  const [w, f = ''] = s.trim().replace(/^[-+]/, '').split('.');
  const units = Number(w) * 1e8 + Number(f.slice(0, 8).padEnd(8, '0'));
  return neg ? -units : units;
}

module.exports = { makeRpc, unitsToCoinString, coinToUnits };
