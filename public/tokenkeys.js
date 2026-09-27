// Player-held token keys, derived in the browser from a word phrase.
//
// The private key never leaves this file, and never reaches the server. What the server
// gets is the public key and signatures; what it cannot do is produce a signature it does
// not have the private half for. That is the entire security model, and it is worth being
// precise about it rather than calling it "unhackable":
//
//   - Lose the phrase and the tokens are gone. Nobody can recover them, including the
//     operator. That is the cost of the operator not being able to touch them either.
//   - Anyone who sees the phrase owns the balance. Treat it like cash, not like a
//     password, because there is no reset.
//
// This is NOT a BIP-39 wallet and deliberately uses its own word list. A phrase from here
// will not restore in Electrum or a hardware wallet, and a BIP-39 phrase will not work
// here. Using the real BIP-39 list would invite someone to type their actual savings
// phrase into a casino, and the first person to do that would deserve better from us.
//
// 256 words means eight bits each, so sixteen words carry 128 bits of entropy, which is
// the same strength a twelve-word BIP-39 phrase carries.

const WORDS = [
  'able', 'acid', 'acre', 'aged', 'aide', 'ajar', 'alto', 'amber', 'ample', 'anchor',
  'angle', 'ankle', 'apple', 'apron', 'arbor', 'arena', 'armor', 'arrow', 'ashen', 'aspen',
  'attic', 'audio', 'aunt', 'avert', 'awake', 'axis', 'bacon', 'badge', 'bagel', 'baker',
  'balmy', 'banjo', 'barge', 'basin', 'baton', 'beach', 'beam', 'bench', 'berry', 'bison',
  'blade', 'blaze', 'blend', 'bliss', 'bloom', 'blunt', 'board', 'bolt', 'bonus', 'brave',
  'bread', 'brick', 'brisk', 'broad', 'brook', 'brush', 'bugle', 'bunch', 'cabin', 'cable',
  'cameo', 'candy', 'canoe', 'canvas', 'cargo', 'carve', 'cedar', 'chalk', 'charm', 'chess',
  'chill', 'choir', 'churn', 'cider', 'cinch', 'civic', 'clamp', 'clasp', 'clay', 'clever',
  'cliff', 'cloak', 'clove', 'coast', 'cocoa', 'comet', 'coral', 'couch', 'cove', 'cozy',
  'crane', 'crate', 'creek', 'crisp', 'crown', 'crumb', 'curl', 'cycle', 'daisy', 'dance',
  'dawn', 'decoy', 'delta', 'dense', 'depot', 'diner', 'ditch', 'dizzy', 'dock', 'donor',
  'dough', 'dove', 'draft', 'drift', 'drum', 'dusk', 'eagle', 'early', 'earth', 'easel',
  'ebony', 'echo', 'eject', 'elbow', 'elder', 'elfin', 'ember', 'emit', 'empty', 'enact',
  'envoy', 'equal', 'ethic', 'exile', 'extra', 'fable', 'fancy', 'fault', 'feast', 'fence',
  'ferry', 'fetch', 'fever', 'fiber', 'field', 'finch', 'flame', 'flask', 'fleet', 'flint',
  'flock', 'flute', 'foam', 'forge', 'fossil', 'frost', 'fudge', 'gable', 'gauge', 'gavel',
  'gecko', 'ghost', 'giant', 'ginger', 'glade', 'glass', 'glide', 'globe', 'glove', 'gnome',
  'grain', 'grape', 'grasp', 'grave', 'green', 'grove', 'gulf', 'gusto', 'hail', 'halo',
  'hasty', 'haven', 'hazel', 'hedge', 'helm', 'herb', 'hinge', 'hive', 'hollow', 'honey',
  'horn', 'hotel', 'humid', 'hunt', 'hymn', 'ideal', 'idle', 'igloo', 'image', 'inbox',
  'inch', 'index', 'ingot', 'inlet', 'irony', 'ivory', 'jazz', 'jelly', 'jewel', 'jolly',
  'judge', 'juice', 'jumbo', 'kayak', 'kettle', 'khaki', 'kiosk', 'kite', 'knack', 'knee',
  'knot', 'label', 'lace', 'lagoon', 'lance', 'lapel', 'larch', 'latch', 'lava', 'ledge',
  'lemon', 'lever', 'light', 'lilac', 'linen', 'lodge', 'lotus', 'lunar', 'lynx', 'maple',
  'marsh', 'mason', 'mecca', 'medal', 'melon', 'mercy', 'mesa', 'metal', 'mild', 'mint',
  'mirth', 'moat', 'mocha', 'molten', 'motto', 'mound',
];

// A byte indexes this list, so it must hold exactly 256 entries. With more, the extra
// words would validate but could never be generated; with fewer, the indexing breaks.
if (WORDS.length !== 256) throw new Error(`token wordlist must hold 256 words, has ${WORDS.length}`);
if (new Set(WORDS).size !== 256) throw new Error('token wordlist contains duplicates');

const PHRASE_LENGTH = 16;
const KDF_SALT = 'nullstake-token-v1';
const KDF_ROUNDS = 210000;

// PKCS8 and SPKI headers for Ed25519. Wrapping a raw key is a concatenation, not a
// dependency, which is why the format was chosen.
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/.{2}/g).map((b) => parseInt(b, 16)));

/** Whether this browser can do Ed25519 at all. Checked rather than assumed. */
async function supported() {
  try {
    const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    return !!k;
  } catch {
    return false;
  }
}

/** A fresh phrase from the browser CSPRNG. 16 words, 128 bits. */
function generatePhrase() {
  const bytes = crypto.getRandomValues(new Uint8Array(PHRASE_LENGTH));
  return [...bytes].map((b) => WORDS[b]).join(' ');
}

/** Normalise user input: lowercase, single spaces, nothing else. */
const normalise = (phrase) => String(phrase || '').toLowerCase().trim().replace(/\s+/g, ' ');

function validatePhrase(phrase) {
  const words = normalise(phrase).split(' ').filter(Boolean);
  if (words.length !== PHRASE_LENGTH) {
    return { ok: false, reason: `a phrase is ${PHRASE_LENGTH} words; this one has ${words.length}` };
  }
  const bad = words.filter((w) => !WORDS.includes(w));
  if (bad.length) return { ok: false, reason: `not words from this list: ${bad.slice(0, 3).join(', ')}` };
  return { ok: true, words };
}

/**
 * Stretch the phrase into a 32-byte key seed.
 *
 * PBKDF2 with a high round count, because a phrase is typed by a human and a fast KDF
 * would make guessing cheap. This is the only place the phrase is used.
 */
async function seedFromPhrase(phrase) {
  const check = validatePhrase(phrase);
  if (!check.ok) throw new Error(check.reason);
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(normalise(phrase)), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: new TextEncoder().encode(KDF_SALT),
    iterations: KDF_ROUNDS,
    hash: 'SHA-512',
  }, material, 256);
  return new Uint8Array(bits);
}

/** The signing key pair for a phrase. The private key is non-extractable once imported. */
async function keyFromPhrase(phrase) {
  const seed = await seedFromPhrase(phrase);
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pkcs8.set(PKCS8_PREFIX, 0);
  pkcs8.set(seed, PKCS8_PREFIX.length);

  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  // The public half is recovered by signing a known value is not possible, so derive it
  // from the seed with a second import that IS extractable, then discard it.
  const extractable = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', extractable);
  const pub = b64urlToBytes(jwk.x);
  return { privateKey, publicKey: hex(pub) };
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Canonical JSON, byte-identical to the server's. Both sides must hash the same bytes. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

const transferPayload = (tx) => ({
  chain: 'nullstake-token-v1',
  type: 'transfer',
  from: tx.from,
  to: tx.to,
  amount: tx.amount,
  nonce: tx.nonce,
});

/** Sign a transfer. The result is what the server verifies and cannot manufacture. */
async function signTransfer(key, tx) {
  const bytes = new TextEncoder().encode(canonical(transferPayload(tx)));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, bytes);
  return hex(sig);
}

/** Verify a signature against a raw public key. Used by the chain verifier. */
async function verifySignature(pubHex, payload, sigHex) {
  try {
    const key = await crypto.subtle.importKey('raw', unhex(pubHex), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify(
      { name: 'Ed25519' }, key,
      unhex(sigHex), new TextEncoder().encode(canonical(payload)),
    );
  } catch {
    return false;
  }
}

/** Verify a signature over a plain string, which is how blocks are signed. */
async function verifyOverString(pubHex, text, sigHex) {
  try {
    const key = await crypto.subtle.importKey('raw', unhex(pubHex), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify(
      { name: 'Ed25519' }, key, unhex(sigHex), new TextEncoder().encode(text),
    );
  } catch {
    return false;
  }
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hex(digest);
}

export {
  WORDS, PHRASE_LENGTH, supported, generatePhrase, validatePhrase, normalise,
  seedFromPhrase, keyFromPhrase, signTransfer, verifySignature, verifyOverString,
  canonical, transferPayload, sha256Hex, hex, unhex,
};
