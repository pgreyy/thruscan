// extension/src/lib/vault.js
//
// The encrypted store of secrets. Everything that could move funds, a recovery
// phrase or a private key, is kept only as ciphertext in chrome.storage.local,
// encrypted with a key derived from the user's password. The password itself
// is never stored.
//
//   PBKDF2-SHA256, 600,000 rounds, 16-byte random salt  ->  AES-GCM-256 key
//   AES-GCM, 12-byte random IV per save
//
// Both are WebCrypto built-ins, so no third-party code sits between the
// password and the cipher.

const ROUNDS = 600_000
const enc = new TextEncoder()
const dec = new TextDecoder()

export const b64 = {
  encode: (bytes) => btoa(String.fromCharCode(...bytes)),
  decode: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
}

export const hex = {
  encode: (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
  decode: (s) => {
    const clean = String(s).trim().replace(/^0x/, '')
    if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) throw new Error('That is not hex.')
    return Uint8Array.from(clean.match(/.{2}/g) ?? [], (h) => parseInt(h, 16))
  },
}

async function keyFrom(password, salt, rounds) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: rounds, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Encrypt a JSON-able object. */
export async function seal(password, payload) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await keyFrom(password, salt, ROUNDS)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload))))
  return { v: 1, kdf: 'pbkdf2-sha256', rounds: ROUNDS, salt: b64.encode(salt), iv: b64.encode(iv), ct: b64.encode(ct) }
}

/** Decrypt, or throw "Wrong password." */
export async function open(password, sealed) {
  try {
    const key = await keyFrom(password, b64.decode(sealed.salt), sealed.rounds ?? ROUNDS)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.decode(sealed.iv) }, key, b64.decode(sealed.ct))
    return JSON.parse(dec.decode(pt))
  } catch {
    throw new Error('Wrong password.')
  }
}
