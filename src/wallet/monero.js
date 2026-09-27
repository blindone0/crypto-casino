'use strict';
// Monero driver, backed by monero-wallet-rpc. Each player gets a subaddress, which is
// the clean way to attribute incoming payments on Monero.
//
// Setup:
//   monerod --detach
//   monero-wallet-rpc --wallet-file casino --password '' \
//     --rpc-bind-port 18082 --disable-rpc-login --daemon-address 127.0.0.1:18081
//
//   "wallet": {
//     "driver": "monero",
//     "minConfirmations": 10,
//     "monero": { "url": "http://127.0.0.1:18082/json_rpc" }
//   }
//
// Bind the RPC to localhost only. monero-wallet-rpc uses HTTP digest auth when
// --rpc-login is set, which this client does not implement, so keep it on localhost
// with --disable-rpc-login, or front it with a proxy that adds basic auth.
const { makeRpc } = require('./rpc');

// 1 XMR = 1e12 atomic units; our internal scale is 1e8 per coin.
const ATOMIC_PER_UNIT = 10000;
const toUnits = (atomic) => Math.round(Number(atomic) / ATOMIC_PER_UNIT);
const toAtomic = (units) => Math.round(Number(units) * ATOMIC_PER_UNIT);

// Standard (4...) and subaddress (8...) are 95 chars; integrated addresses are 106.
const ADDRESS_RE = /^[48][0-9AB][1-9A-HJ-NP-Za-km-z]{93}(?:[1-9A-HJ-NP-Za-km-z]{11})?$/;

function create({ cfg, logger = console }) {
  const w = cfg.wallet.monero || {};
  const rpc = makeRpc({
    url: w.url || 'http://127.0.0.1:18082/json_rpc',
    user: w.user,
    pass: w.pass,
    timeoutMs: w.timeoutMs || 30000,
  });
  const accountIndex = w.accountIndex ?? 0;

  return {
    name: 'monero',
    label: w.label || 'Monero',

    async newAddress(userId, index) {
      const r = await rpc('create_address', { account_index: accountIndex, label: `user:${userId}` });
      return { address: r.address, index: r.address_index ?? index };
    },

    async listDeposits(addresses) {
      const watch = new Set(addresses);
      const r = await rpc('get_transfers', {
        in: true,
        pending: true,
        pool: true,
        account_index: accountIndex,
      });
      const entries = [...(r.in || []), ...(r.pending || []), ...(r.pool || [])];
      const out = [];
      for (const t of entries) {
        if (!t.address || !watch.has(t.address)) continue;
        const units = toUnits(t.amount);
        if (units <= 0) continue;
        out.push({
          address: t.address,
          txid: t.txid,
          vout: 0,
          amountUnits: units,
          confirmations: Math.max(0, t.confirmations ?? 0),
        });
      }
      return out;
    },

    async send(address, units) {
      const r = await rpc('transfer', {
        destinations: [{ amount: toAtomic(units), address }],
        account_index: accountIndex,
        priority: w.priority ?? 1,
        ring_size: 16,
        get_tx_key: false,
      });
      logger.log(`[wallet:monero] sent ${units} units to ${address} (${r.tx_hash})`);
      return { txid: r.tx_hash };
    },

    async info() {
      const [height, balance] = await Promise.all([
        rpc('get_height').catch(() => null),
        rpc('get_balance', { account_index: accountIndex }).catch(() => null),
      ]);
      return {
        driver: 'monero',
        height: height?.height ?? null,
        hotBalanceUnits: balance ? toUnits(balance.balance) : null,
        unlockedUnits: balance ? toUnits(balance.unlocked_balance) : null,
      };
    },

    validateAddress(addr) {
      return typeof addr === 'string' && ADDRESS_RE.test(addr.trim());
    },
  };
}

module.exports = { create, ADDRESS_RE, toUnits, toAtomic };
