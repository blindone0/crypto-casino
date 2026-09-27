'use strict';
// Manual driver: works on day one with any coin and no node at all.
//
// Deposits: every player is shown the same operator address plus a unique memo code.
// They pay, then submit the txid. The operator checks it in their own wallet and credits
// it from the admin panel (Admin -> Deposits -> Credit).
// Withdrawals: they queue as usual, the operator pays them by hand and marks them sent.
//
// This is the lowest-friction way to launch. Move to bitcoind or monero once volume
// makes the hand-work annoying.
const crypto = require('node:crypto');

function create({ cfg, logger = console }) {
  const w = cfg.wallet.manual || {};
  const depositAddress = w.depositAddress || '';

  return {
    name: 'manual',
    isManual: true,
    label: w.label || 'Manual review',
    depositNote: w.note
      || 'Send your deposit to the address above, then submit the transaction id. '
      + 'An operator credits it after checking the chain.',

    async newAddress(userId) {
      if (!depositAddress) {
        throw new Error('set wallet.manual.depositAddress in config.json before using the manual driver');
      }
      // The address is shared, so the memo is what identifies the payer.
      const memo = `u${userId}-${crypto.createHash('sha256')
        .update(`${userId}:${depositAddress}`).digest('hex').slice(0, 6)}`;
      return { address: depositAddress, index: userId, memo };
    },

    // Nothing to poll: crediting is an operator action.
    async listDeposits() { return []; },

    async send() {
      throw new Error('manual driver: pay this withdrawal by hand, then mark it sent in the admin panel');
    },

    async info() {
      return { driver: 'manual', depositAddress: depositAddress || null };
    },

    validateAddress(addr) {
      return typeof addr === 'string' && addr.trim().length >= 10 && addr.trim().length <= 128;
    },
  };
}

module.exports = { create };
