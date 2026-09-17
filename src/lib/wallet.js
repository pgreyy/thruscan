// src/lib/wallet.js
//
// An in-app wallet that lives in the browser.
//
// The private key is generated here, encrypted here with a password only the
// visitor knows, and stored in this browser's localStorage. It is never sent
// anywhere. The server sees a public key and a signature, and nothing else.
//
// ---------------------------------------------------------------------------
// HOW A BROWSER KEY GETS AN ACCOUNT
//
// A brand new key cannot pay its own way into existence: creating an account
// needs a state proof and a fee payer, and a key with no account has neither.
// Thru's EOA program solves this. CREATE_ACCOUNT takes an Ed25519 signature by
// the new key over a canonical message that names the chain and the fee payer:
//
//   "tn_eoa_create_v1" || chain_id(u16) || fee_payer[32] || eoa[32]
//
// So the sponsor pays and submits, while the new key alone authorises. Binding
// the fee payer into the message means the signature cannot be lifted into a
// different creation, and binding the chain means it cannot be replayed onto
// another network.
//
// That message is signed RAW, with no further domain separation, because it
// already carries its own 16-byte tag. This matters: signMessage() prepends the
// generic wallet tag, which produces a signature the EOA program rejects with
// user error 5. The equivalent that needs no extra dependency is
//
//   signWithDomain(message.slice(16), priv, pub, SignatureDomain.EOA_CREATE)
//
// since signWithDomain rebuilds M = DST || context and signs M with stock
// Ed25519. Verified byte-identical against a raw signature.
//
// ---------------------------------------------------------------------------
// AFTER THAT, THE WALLET IS ON ITS OWN
//
// A Thru transaction carries exactly one signature, the fee payer's. So the
// sponsor can never move a visitor's tokens: for a swap or a buy, the visitor
// must be the fee payer and sign it themselves. That is what makes this a real
// wallet rather than a shared pot with names on it.
//
// The fee is set to 0. A freshly created account holds no native balance, and
// any non-zero fee fails with INSUFFICIENT_FEE_PAYER_BALANCE (-509). Alphanet
// accepts a zero fee; when that changes, the wallet will need funding first.
//
// Everything on-chain goes through /api/wallet, because the node sends no CORS
// headers and a browser cannot call it directly.

import {
  Pubkey, TransactionBuilder, deriveProgramAddress, keys, eoa, signWithDomain,
} from '@thru/sdk'

const STORE_KEY = 'thruscan.wallet.v1'
const ENDPOINT = '/api/wallet'
const TOKEN_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq'
const SIGNATURE_DOMAIN_EOA_CREATE = 5

/* ---------- small helpers ---------- */

const toBytes = (a) => Pubkey.from(a).toBytes()

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

export function bytesToHex(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(hex) {
  const clean = String(hex).trim().replace(/^0x/, '')
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) throw new Error('Not valid hex.')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

const b64 = {
  encode: (bytes) => btoa(String.fromCharCode(...bytes)),
  decode: (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

/** A token account's address is fixed by its owner and mint, so the wallet can
 *  find every balance without anyone pasting anything. Seed is 32 zero bytes,
 *  which is what the CLI's derive-token-account uses. Checked against it. */
export async function deriveTokenAccount(mint, owner, seed = new Uint8Array(32)) {
  const digest = await sha256(concat(toBytes(owner), toBytes(mint), seed))
  return deriveProgramAddress({ programAddress: TOKEN_PROGRAM, seed: digest }).address
}

async function api(action, body = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  })
  let data
  try { data = await res.json() } catch { throw new Error(`The server replied with ${res.status}.`) }
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `Request failed (${res.status}).`)
  return data
}

/* ---------- encryption at rest ----------
   PBKDF2 to turn a password into a key, then AES-GCM. Both are in every
   browser's WebCrypto, so this pulls in no dependency and no code of mine is
   between the password and the cipher. The iteration count is deliberately
   high: this key sits in localStorage where anything running on the page can
   read the ciphertext, so the password is the only real barrier. */

const PBKDF2_ROUNDS = 310_000

async function keyFromPassword(password, salt) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/* ---------- stored wallet ---------- */

export function storedWallet() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed?.address ? parsed : null
  } catch { return null }
}

export function hasWallet() { return storedWallet() !== null }

/** Removes the wallet from this browser. The key is gone unless it was
 *  exported, which is why every caller should make the visitor confirm. */
export function forgetWallet() {
  localStorage.removeItem(STORE_KEY)
  locked()
}

/* ---------- the unlocked key, in memory only ---------- */

let session = null   // { address, publicKey, privateKey }

export function isUnlocked() { return session !== null }
export function currentAddress() { return session?.address ?? storedWallet()?.address ?? null }
export function locked() { if (session?.privateKey) session.privateKey.fill(0); session = null }

async function persist(address, publicKey, privateKey, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await keyFromPassword(password, salt)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, privateKey))
  localStorage.setItem(STORE_KEY, JSON.stringify({
    v: 1,
    address,
    publicKey: b64.encode(publicKey),
    salt: b64.encode(salt),
    iv: b64.encode(iv),
    ct: b64.encode(ct),
    createdAt: new Date().toISOString(),
  }))
}

/** Make a new wallet. The key exists only in this tab until it is persisted,
 *  and the caller decides whether to also register it on chain. */
export async function createWallet(password) {
  if (!password || password.length < 8) throw new Error('Use a password of at least 8 characters.')
  const pair = await keys.generateKeyPair()
  await persist(pair.address, pair.publicKey, pair.privateKey, password)
  session = { address: pair.address, publicKey: pair.publicKey, privateKey: pair.privateKey }
  return { address: pair.address }
}

/** Bring an existing key in, so a CLI identity and the browser can be the same
 *  account rather than two half-funded ones. */
export async function importWallet(privateKeyHex, password) {
  if (!password || password.length < 8) throw new Error('Use a password of at least 8 characters.')
  const privateKey = hexToBytes(privateKeyHex)
  if (privateKey.length !== 32) throw new Error('A Thru private key is 32 bytes, so 64 hex characters.')
  const publicKey = await keys.fromPrivateKey(privateKey)
  const address = Pubkey.from(publicKey).toString()
  await persist(address, publicKey, privateKey, password)
  session = { address, publicKey, privateKey }
  return { address }
}

export async function unlock(password) {
  const stored = storedWallet()
  if (!stored) throw new Error('There is no wallet in this browser.')
  const salt = b64.decode(stored.salt)
  const iv = b64.decode(stored.iv)
  const key = await keyFromPassword(password, salt)
  let privateKey
  try {
    privateKey = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64.decode(stored.ct)),
    )
  } catch {
    throw new Error('Wrong password.')
  }
  session = { address: stored.address, publicKey: b64.decode(stored.publicKey), privateKey }
  return { address: stored.address }
}

/** The whole point of holding your own key is being able to take it with you. */
export function exportPrivateKey() {
  if (!session) throw new Error('Unlock the wallet first.')
  return bytesToHex(session.privateKey)
}

function requireSession() {
  if (!session) throw new Error('Unlock the wallet first.')
  return session
}

/* ---------- on chain ---------- */

/** Ask the sponsor to bring this key's account into existence. The signature
 *  below is the only thing that authorises it, and it is made here. */
export async function registerOnChain() {
  const { address, publicKey, privateKey } = requireSession()

  const { chainId, sponsor, exists } = await api('prepare', { address })
  if (exists) return { already: true, address }

  const message = eoa.buildEOACreateMessage(chainId, toBytes(sponsor), publicKey)
  // Signed raw. See the note at the top: the message carries its own tag, so
  // slicing that tag off and re-adding it through the EOA_CREATE domain gives
  // exactly the raw signature the program verifies.
  const signature = await signWithDomain(
    message.slice(16), privateKey, publicKey, SIGNATURE_DOMAIN_EOA_CREATE,
  )

  const { signature: txn } = await api('create', {
    address,
    signature: b64.encode(signature),
  })
  return { already: false, address, txn }
}

/** Token accounts hold balances; the wallet address itself holds none. The
 *  sponsor opens them because creating an account needs a state proof, and
 *  ownership is recorded in the account rather than proved by a signature. */
export async function openTokenAccount(mint) {
  const { address } = requireSession()
  return api('open', { owner: address, mint })
}

export async function tokenBalances(mints) {
  const { address } = requireSession()
  const { balances } = await api('balances', { owner: address, mints })
  return balances
}

export async function accountExists(address) {
  const { exists } = await api('prepare', { address })
  return exists
}

/**
 * Sign a transaction with the visitor's own key and send it.
 *
 * `readWrite` and `readOnly` must already be in the sorted order the
 * instruction's indices were computed against; every builder in swap.js and
 * pad.js returns them that way, so pass them straight through.
 */
export async function signAndSend({ program, readWrite = [], readOnly = [], data, stateUnits = 60_000 }) {
  const { address, privateKey } = requireSession()
  const { nonce, startSlot, chainId } = await api('prepare', { address })

  const { rawTransaction } = await new TransactionBuilder().buildAndSign({
    feePayer: { publicKey: address, privateKey },
    program,
    accounts: { readWriteAccounts: readWrite, readOnlyAccounts: readOnly },
    header: {
      // Zero, because a new account has no native balance and any fee above it
      // fails the transaction outright rather than being taken from elsewhere.
      fee: 0n,
      nonce: BigInt(nonce),
      startSlot: BigInt(startSlot),
      expiryAfter: 100,
      chainId,
      computeUnits: 300_000_000,
      stateUnits,
      memoryUnits: 60_000,
    },
    instructionData: data,
  })

  const { signature } = await api('submit', { raw: b64.encode(rawTransaction) })
  return signature
}

/** Poll until the chain has a verdict, so the UI can say what happened rather
 *  than leaving a spinner running. */
export async function waitForResult(signature, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1500))
    try {
      const { status } = await api('status', { signature })
      if (status && status.settled) return status
    } catch { /* not indexed yet */ }
  }
  return { settled: false }
}
