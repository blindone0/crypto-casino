'use strict';
// Bitcoin Core wallet driver. Also works unchanged against Litecoin Core, Dogecoin Core
// and Bitcoin Cash Node, which all speak the same wallet RPC.
//
// The node holds the keys and does all the cryptography, so this driver stays small and
// there is nothing to audit in our own signing code.
//
// Setup:
//   1. Run the node with an RPC user, txindex not required:
//        bitcoind -server -rpcuser=casino -rpcpassword=SECRET -rpcbind=127.0.0.1
//   2. Create a wallet:  bitcoin-cli createwallet casino
//   3. config.json:
//        "wallet": {
//          "driver": "bitcoind",
//          "minConfirmations": 2,
//          "bitcoind": {
//            "url": "http://127.0.0.1:8332",
//            "user": "casino", "pass": "SECRET",
//            "walletName": "casino",
//            "addressType": "bech32"
//          }
//        }
//
// The network fee for payouts comes out of the hot wallet; the flat
// wallet.withdrawalFeeUnits charged to the player is what covers it.
const { makeRpc, unitsToCoinString, coinToUnits } = require('./rpc');

// Permissive on purpose: the node rejects anything genuinely invalid at send time.
const ADDRESS_RE = /^(bc1|tb1|ltc1|bcrt1)[0-9ac-hj-np-z]{6,87}$|^[13mn2LDA9][a-km-zA-HJ-NP-Z1-9]{25,39}$/;

function create({ cfg, logger = console }) {
  const w = cfg.wallet.bitcoind || {};
  const base = (w.url || 'http://127.0.0.1:8332').replace(/\/+$/, '');
  const url = w.walletName ? `${base}/wallet/${encodeURIComponent(w.walletName)}` : base;
  const rpc = makeRpc({ url, user: w.user, pass: w.pass, timeoutMs: w.timeoutMs || 20000 });
  const addressType = w.addressType || 'bech32';

  return {
    name: 'bitcoind',
    label: w.label || 'Bitcoin',

    async newAddress(userId, index) {
      const address = await rpc('getnewaddress', [`user:${userId}`, addressType]);
      return { address, index };
    },

    /**
     * Recent receives, newest first. `listtransactions` keeps spent history, unlike
     * `listunspent`, so a deposit still reports correctly after the hot wallet is swept.
     * A very busy site should switch this to `listsinceblock` with a stored block hash.
     */
    async listDeposits(addresses) {
      const watch = new Set(addresses);
      const txs = await rpc('listtransactions', ['*', w.scanCount || 1000, 0, true]);
      const out = [];
      for (const t of txs) {
        if (t.category !== 'receive') continue;
        if (!watch.has(t.address)) continue;
        const units = coinToUnits(t.amount);
        if (units <= 0) continue;
        out.push({
          address: t.address,
          txid: t.txid,
          vout: t.vout ?? 0,
          amountUnits: units,
          confirmations: Math.max(0, t.confirmations ?? 0),
        });
      }
      return out;
    },

    async send(address, units) {
      const amount = Number(unitsToCoinString(units));
      // sendtoaddress(address, amount, comment, comment_to, subtractfeefromamount)
      const txid = await rpc('sendtoaddress', [address, amount, 'casino payout', '', false]);
      logger.log(`[wallet:bitcoind] sent ${amount} to ${address} (${txid})`);
      return { txid };
    },

    async info() {
      const [chain, balance] = await Promise.all([
        rpc('getblockchaininfo'),
        rpc('getbalance').catch(() => null),
      ]);
      return {
        driver: 'bitcoind',
        chain: chain.chain,
        height: chain.blocks,
        headers: chain.headers,
        synced: chain.blocks === chain.headers,
        hotBalanceUnits: balance == null ? null : coinToUnits(balance),
      };
    },

    validateAddress(addr) {
      return typeof addr === 'string' && ADDRESS_RE.test(addr.trim());
    },
  };
}

module.exports = { create, ADDRESS_RE };
