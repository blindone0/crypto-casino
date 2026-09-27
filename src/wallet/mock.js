'use strict';
// Mock wallet driver. No blockchain, no node, no real money.
// Deposits are injected through the API and gain one confirmation per poll, which makes
// the whole deposit-to-credit path testable end to end. This is the default driver so a
// fresh install runs immediately; switch to bitcoind/monero/manual for real funds.
const crypto = require('node:crypto');

function create({ cfg, logger = console }) {
  // txid -> { address, txid, vout, amountUnits, confirmations }
  const pool = new Map();

  return {
    name: 'mock',
    isMock: true,
    label: 'Mock (testing only)',

    async newAddress(userId, index) {
      const tag = crypto.randomBytes(12).toString('hex');
      return { address: `mock1q${tag}${index}`, index };
    },

    /** Each poll ages every pending deposit by one confirmation. */
    async listDeposits() {
      const out = [];
      for (const d of pool.values()) {
        if (d.confirmations < cfg.wallet.minConfirmations + 3) d.confirmations += 1;
        out.push({ ...d });
      }
      return out;
    },

    async send(address, units) {
      const txid = crypto.randomBytes(32).toString('hex');
      logger.log(`[wallet:mock] pretend-sent ${units} units to ${address} as ${txid}`);
      return { txid };
    },

    async info() {
      return { driver: 'mock', pending: pool.size, height: 0, note: 'no real chain' };
    },

    validateAddress(addr) {
      return typeof addr === 'string' && addr.length >= 8 && addr.length <= 128;
    },

    /** Test hook: pretend a payment landed on one of our addresses. */
    simulate(address, amountUnits) {
      const txid = crypto.randomBytes(32).toString('hex');
      pool.set(txid, { address, txid, vout: 0, amountUnits, confirmations: 0 });
      return { txid, amountUnits, address };
    },
  };
}

module.exports = { create };
