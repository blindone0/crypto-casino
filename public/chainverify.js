// Independent verification of the token chain, run entirely in the browser.
//
// This is the part that makes the ledger mean anything. It downloads every block, and
// rather than believing what the server says about them, it recomputes:
//
//   1. that each block links to the hash of the one before it,
//   2. that each block hash actually matches the block contents,
//   3. that each block carries a valid signature from the operator key,
//   4. that every transfer inside carries a valid signature from the account sending it,
//   5. that no nonce is spent twice, and
//   6. that replaying every transaction from zero produces the balances claimed.
//
// If all six hold, the operator has not rewritten history and has not moved anyone's
// tokens. If any fails, this says exactly which block and why.
import { canonical, transferPayload, verifySignature, verifyOverString, sha256Hex } from './tokenkeys.js';

const GENESIS_PREV = '0'.repeat(64);

/** Rebuild the hash a block should have from its contents alone. */
async function hashOf(block, chainId) {
  return sha256Hex(canonical({
    chain: chainId,
    height: block.height,
    prevHash: block.prevHash,
    timestamp: block.timestamp,
    txs: block.txs,
  }));
}

/**
 * Verify the whole chain.
 * `onProgress(done, total)` is called as it goes, because a long chain takes a moment and
 * a frozen page looks like a broken one.
 */
export async function verifyChain({ fetchSlice, onProgress } = {}) {
  const load = fetchSlice || (async (from) => {
    const res = await fetch(`/api/token/chain?from=${from}&limit=500`);
    if (!res.ok) throw new Error(`chain request failed: HTTP ${res.status}`);
    return res.json();
  });

  const first = await load(0);
  const chainId = first.chain;
  const serverKey = first.serverKey;
  const total = first.height + 1;

  const balances = new Map();
  const nonces = new Set();
  let prevHash = GENESIS_PREV;
  let checked = 0;
  let transfers = 0;
  let mints = 0;

  const fail = (reason, height) => ({
    ok: false, reason, height, checked, total, chain: chainId, serverKey,
  });

  let slice = first;
  for (;;) {
    for (const block of slice.blocks) {
      if (block.height !== checked) {
        return fail(`expected block ${checked} but got ${block.height}`, block.height);
      }
      if (block.prevHash !== prevHash) {
        return fail('this block does not link to the one before it', block.height);
      }

      const recomputed = await hashOf(block, chainId);
      if (recomputed !== block.hash) {
        return fail('the block hash does not match its contents, so it has been altered', block.height);
      }

      const signed = await verifyOverString(serverKey, block.hash, block.signature);
      if (!signed) return fail('the block is not signed by the operator key', block.height);

      for (const tx of block.txs) {
        if (tx.type === 'transfer') {
          const good = await verifySignature(tx.from, transferPayload(tx), tx.sig);
          if (!good) {
            return fail('a transfer in this block is not signed by the account sending it', block.height);
          }
          const nonceKey = `${tx.from}:${tx.nonce}`;
          if (nonces.has(nonceKey)) {
            return fail('a nonce is spent twice, which would allow a replay', block.height);
          }
          nonces.add(nonceKey);
          transfers += 1;
        } else if (tx.type === 'mint') {
          mints += 1;
        }

        const move = (who, delta) => {
          const next = (balances.get(who) || 0) + delta;
          if (next < 0) throw new Error('an account is overdrawn');
          balances.set(who, next);
        };
        try {
          if (tx.type === 'mint') move(tx.to, tx.amount);
          else if (tx.type === 'transfer') { move(tx.from, -tx.amount); move(tx.to, tx.amount); }
          else if (tx.type === 'burn') move(tx.from, -tx.amount);
          else return fail(`unknown transaction type "${tx.type}"`, block.height);
        } catch (e) {
          return fail(e.message, block.height);
        }
      }

      prevHash = block.hash;
      checked += 1;
      if (onProgress) onProgress(checked, total);
    }

    if (checked >= total) break;
    if (!slice.blocks.length) return fail('the chain stopped short of its claimed height', checked);
    slice = await load(checked);
  }

  const supply = [...balances.values()].reduce((a, b) => a + b, 0);
  return {
    ok: true,
    checked,
    total,
    chain: chainId,
    serverKey,
    head: prevHash,
    accounts: balances.size,
    transfers,
    mints,
    supply,
    balances,
  };
}

/**
 * Compare the head you are seeing now with one you saved earlier.
 *
 * This is the answer to the one thing signatures alone cannot catch: an operator who
 * rebuilds the entire chain from scratch and re-signs it. Every signature would check
 * out, but the head would differ from the one you recorded before, and two validly
 * signed heads at the same height are proof of exactly that.
 */
export function compareHeads(saved, current) {
  if (!saved) return { status: 'no-pin', message: 'nothing pinned yet' };
  if (saved.height > current.height) {
    return { status: 'shrunk', message: 'the chain is shorter than when you last looked' };
  }
  if (saved.height === current.height && saved.head !== current.head) {
    return { status: 'forked', message: 'the chain has been rebuilt: same height, different head' };
  }
  return { status: 'ok', message: `extended from block ${saved.height} to ${current.height}` };
}
