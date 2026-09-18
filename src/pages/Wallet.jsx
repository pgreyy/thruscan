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
import { newPhrase, accountFromPhrase, phraseProblem } from './seed.js'

const STORE_KEY = 'thruscan.wallet.v1'
const ENDPOINT = '/api/wallet'
const TOKEN_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq'
const SIGNATURE_DOMAIN_EOA_CREATE = 5

/* Thru's own faucet, which hands out native THRU rather than a test token.
   Permissionless: the recipient is whoever pays the fee, so a wallet claims for
   itself and nobody can direct someone else's claim elsewhere. Capped at 10,000
   per transaction and repeatable.

   WITHDRAW: [u32 op = 1][u32 faucet_account_idx][u64 amount]

   Recovered by decoding a transaction the CLI produced, then confirmed against
   a second one with a different amount. */
const NATIVE_FAUCET_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPr6'
const NATIVE_FAUCET_ACCOUNT = 'taxoImN8fTEOxXYnvgC6JZ0lN0n0qvZERwz_vlOjX3MkIn'
const NATIVE_FAUCET_MAX = 10_000n

/* The EOA program: account creation, deletion, and native THRU transfer. Its
   address is thirty-two zero bytes. */
const EOA_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

/* ---------- small helpers ---------- */

const toBytes = (a) => Pubkey.from(a).toBytes()

/** Thru sorts a transaction's accounts by their raw public key bytes, not by
 *  the string they print as. Instruction indices are computed against that
 *  order, so anything that names accounts by index has to sort first. */
function sortAddresses(list) {
  return [...new Set(list)].sort((a, b) => {
    const x = toBytes(a)
    const y = toBytes(b)
    for (let i = 0; i < 32; i++) {
      if (x[i] !== y[i]) return x[i] - y[i]
    }
    return 0
  })
}

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

async function persist(address, publicKey, privateKey, password, phrase = null) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await keyFromPassword(password, salt)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, privateKey))

  /* The phrase is stored under the same password as the key, with its own
     nonce. It is not derivable from the key, so a wallet that loses it can
     never get it back, which is why it is kept at all rather than shown once
     and discarded. A wallet imported from raw hex has none, and says so. */
  let phraseIv = null
  let phraseCt = null
  if (phrase) {
    const piv = crypto.getRandomValues(new Uint8Array(12))
    const bytes = new TextEncoder().encode(phrase)
    phraseCt = b64.encode(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: piv }, key, bytes)))
    phraseIv = b64.encode(piv)
  }

  localStorage.setItem(STORE_KEY, JSON.stringify({
    v: 2,
    address,
    publicKey: b64.encode(publicKey),
    salt: b64.encode(salt),
    iv: b64.encode(iv),
    ct: b64.encode(ct),
    phraseIv,
    phraseCt,
    createdAt: new Date().toISOString(),
  }))
}

/** Make a new wallet. The key exists only in this tab until it is persisted,
 *  and the caller decides whether to also register it on chain. */
export async function createWallet(password) {
  if (!password || password.length < 8) throw new Error('Use a password of at least 8 characters.')

  /* Born from a phrase rather than from raw randomness, so it can be written
     down and carried. Same scheme Thru's own HD wallet uses, so the phrase is
     not ThruScan-specific. */
  const phrase = newPhrase()
  const pair = accountFromPhrase(phrase)
  await persist(pair.address, pair.publicKey, pair.privateKey, password, phrase)
  session = { address: pair.address, publicKey: pair.publicKey, privateKey: pair.privateKey, phrase }
  return { address: pair.address, phrase }
}

/** Restore from twelve words, on any device. */
export async function importPhrase(phrase, password) {
  if (!password || password.length < 8) throw new Error('Use a password of at least 8 characters.')
  const problem = phraseProblem(phrase)
  if (problem) throw new Error(problem)

  const pair = accountFromPhrase(phrase)
  const clean = String(phrase).trim().toLowerCase().split(/\s+/).join(' ')
  await persist(pair.address, pair.publicKey, pair.privateKey, password, clean)
  session = { address: pair.address, publicKey: pair.publicKey, privateKey: pair.privateKey, phrase: clean }
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
  let phrase = null
  if (stored.phraseCt && stored.phraseIv) {
    try {
      const bytes = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64.decode(stored.phraseIv) }, key, b64.decode(stored.phraseCt),
      )
      phrase = new TextDecoder().decode(bytes)
    } catch { /* the key decrypted, so a phrase that will not is not fatal */ }
  }

  session = { address: stored.address, publicKey: b64.decode(stored.publicKey), privateKey, phrase }
  return { address: stored.address }
}

/** The whole point of holding your own key is being able to take it with you. */
export function exportPrivateKey() {
  if (!session) throw new Error('Unlock the wallet first.')
  return bytesToHex(session.privateKey)
}

/**
 * The twelve words, if this wallet has them.
 *
 * Wallets made before phrases existed, and any imported from raw hex, do not.
 * They are still perfectly usable; they just cannot be moved by writing
 * something down, which is worth telling their owner rather than hiding.
 */
export function exportPhrase() {
  if (!session) throw new Error('Unlock the wallet first.')
  return session.phrase ?? null
}

export function hasPhrase() {
  const stored = storedWallet()
  return Boolean(stored?.phraseCt)
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

/**
 * Register, wait for the account to actually appear, then fund it.
 *
 * The wait is not optional. Creation lands a slot or two after it is submitted,
 * and a claim sent before then fails as though the account did not exist,
 * because it does not. `onStep` lets the page say which of the three things is
 * happening rather than showing one long spinner.
 */
export async function registerAndFund(onStep = () => {}) {
  onStep('registering')
  const { already, address } = await registerOnChain()

  if (!already) {
    onStep('waiting')
    let live = false
    for (let i = 0; i < 12 && !live; i++) {
      await new Promise((r) => setTimeout(r, 1800))
      live = await accountExists(address)
    }
    if (!live) throw new Error('The account did not appear. It may still land; try refreshing in a moment.')
  }

  // Funding is a nicety, not a requirement, so a failure here should not look
  // like a failure to register. The wallet still works at a zero fee.
  try {
    if ((await nativeBalance()) === 0n) {
      onStep('funding')
      await claimNativeThru()
    }
  } catch { /* leave it unfunded rather than failing the whole flow */ }

  return { address }
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
export async function signAndSend({
  program, readWrite = [], readOnly = [], data,
  computeUnits = 300_000_000, stateUnits = 60_000, memoryUnits = 60_000,
}) {
  const { address, privateKey } = requireSession()
  const { nonce, startSlot, chainId, balance } = await api('prepare', { address })

  // Pay a real fee when there is a balance to pay it from, and zero when there
  // is not. A fee above the balance fails the transaction outright rather than
  // being taken from elsewhere, so a brand new account has to start at zero.
  // Alphanet accepts zero today; funding the wallet means it does not have to.
  const fee = BigInt(balance ?? 0) > 0n ? 1n : 0n

  const { rawTransaction } = await new TransactionBuilder().buildAndSign({
    feePayer: { publicKey: address, privateKey },
    program,
    accounts: { readWriteAccounts: readWrite, readOnlyAccounts: readOnly },
    header: {
      fee,
      nonce: BigInt(nonce),
      startSlot: BigInt(startSlot),
      expiryAfter: 100,
      chainId,
      computeUnits,
      stateUnits,
      memoryUnits,
    },
    instructionData: data,
  })

  const { signature } = await api('submit', { raw: b64.encode(rawTransaction) })
  return signature
}

/**
 * Claim native THRU from Thru's own faucet, signed and paid for by this wallet.
 *
 * This is the step that takes the wallet off its training wheels. Until it has
 * a native balance it cannot pay a fee at all, so every transaction has to go
 * out at zero, which alphanet allows and mainnet will not. One claim and the
 * wallet is paying its own way through the same code path it will use later.
 *
 * Nothing about it is sponsored. The faucet pays whoever paid the fee, so a
 * wallet can only ever claim for itself.
 */
export async function claimNativeThru(amount = NATIVE_FAUCET_MAX) {
  const capped = amount > NATIVE_FAUCET_MAX ? NATIVE_FAUCET_MAX : amount

  const data = new Uint8Array(16)
  const dv = new DataView(data.buffer)
  dv.setUint32(0, 1, true)          // WITHDRAW
  dv.setUint32(4, 2, true)          // the faucet account, the only read-write, at index 2
  dv.setBigUint64(8, capped, true)

  return signAndSend({
    program: NATIVE_FAUCET_PROGRAM,
    readWrite: [NATIVE_FAUCET_ACCOUNT],
    data,
    computeUnits: 300_000,
    stateUnits: 10_000,
    memoryUnits: 10_000,
  })
}

/** Claim tUSD. The endpoint opens the token account first if there is not one. */
export async function claimTusd() {
  const { address } = requireSession()
  return api('faucet', { owner: address })
}

/* ---------- giving it back ----------
 *
 * A testnet faucet is a shared tap, and someone who is done with 9,000 tUSD is
 * holding it away from everyone else. Both of these are signed by the wallet
 * itself, which is the whole point: nobody can push a return on your behalf.
 *
 * The two work differently because the two assets are different.
 *
 * tUSD is burned. ThruScan's sponsor is the mint authority, so the faucet does
 * not hold a pile it hands out; it mints on demand and the supply goes up. The
 * exact opposite of that is a burn, which takes the tokens out of existence and
 * puts the supply back where it was. Sending them to some "faucet wallet"
 * instead would only move the pile somewhere else.
 *
 *   BURN: [0x04][account u16][mint u16][authority u16][amount u64]
 *
 * recovered from a live transaction: two read-write accounts, one 115 bytes
 * (a mint) and one 73 (a token account), with the indices in that order.
 *
 * THRU really is transferred, because Thru's own faucet is an account with a
 * balance, and putting THRU back into it is the thing that lets the next person
 * draw it out.
 *
 *   TRANSFER: [u32 op = 1][u64 amount][u16 from_idx][u16 to_idx]
 *
 * recovered by decoding twelve live transfers: the op and the trailing index
 * pair were identical across all of them and the u64 tracked the amount.
 */

const TOKEN_OP_BURN = 0x04

/** Burn tokens the wallet holds. Used to hand tUSD back to the faucet. */
export async function burnToken(mint, amount) {
  const { address } = requireSession()
  const account = await deriveTokenAccount(mint, address)

  const readWrite = sortAddresses([mint, account])
  const at = (a) => 2 + readWrite.indexOf(a)

  const data = new Uint8Array(15)
  const dv = new DataView(data.buffer)
  dv.setUint8(0, TOKEN_OP_BURN)
  dv.setUint16(1, at(account), true)
  dv.setUint16(3, at(mint), true)
  dv.setUint16(5, 0, true)             // the authority is the fee payer, index 0
  dv.setBigUint64(7, BigInt(amount), true)

  return signAndSend({
    program: TOKEN_PROGRAM,
    readWrite,
    data,
    computeUnits: 1_000_000,
    stateUnits: 20_000,
    memoryUnits: 20_000,
  })
}

/** Send native THRU somewhere. Used to put it back in Thru's faucet. */
export async function sendNativeThru(to, amount) {
  const data = new Uint8Array(16)
  const dv = new DataView(data.buffer)
  dv.setUint32(0, 1, true)             // TRANSFER
  dv.setBigUint64(4, BigInt(amount), true)
  dv.setUint16(12, 0, true)            // from: the fee payer
  dv.setUint16(14, 2, true)            // to: the only read-write account

  return signAndSend({
    program: EOA_PROGRAM,
    readWrite: [to],
    data,
    computeUnits: 300_000,
    stateUnits: 10_000,
    memoryUnits: 10_000,
  })
}

/** Put native THRU back in the faucet everyone draws from. */
export async function returnNativeThru(amount) {
  return sendNativeThru(NATIVE_FAUCET_ACCOUNT, amount)
}

/**
 * Make the three accounts a launch needs.
 *
 * All three need creation state proofs, which a browser cannot produce, so
 * ThruScan makes them. It does not make the launch: that one is signed here,
 * because thrupad records the launch transaction's fee payer as the creator and
 * pays the fees to them.
 */
export async function createLaunchAccounts({ symbol, quoteMint, padProgram }) {
  const { address } = requireSession()
  return api('pad-accounts', { owner: address, symbol, quoteMint, padProgram })
}

/* ---------- names ----------
   Claiming is sponsored, because registering under a root needs that root's
   authority and ThruScan holds it. Records are not: the name service checks the
   DOMAIN's owner, which is the visitor, so only they can write to their own
   name. That split is a feature. It means ThruScan can hand out names it cannot
   afterwards edit. */

const NAME_SERVICE_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUF'
const KEY_FIELD = 32
const VALUE_FIELD = 256

export async function checkName(name) {
  return api('name-check', { name })
}

export async function claimName(name) {
  const { address } = requireSession()
  return api('name-register', { name, owner: address })
}

/**
 * APPEND_RECORD, signed by the name's owner.
 *
 *   [u32 2][u16 domain][u16 authority][u32 key_len][32 key][u32 value_len][256 value]
 *
 * The domain is the only read-write account, so it is at index 2, and the
 * authority is the fee payer at 0.
 */
export async function setNameRecord(domainAccount, key, value) {
  const keyBytes = new TextEncoder().encode(key)
  const valueBytes = new TextEncoder().encode(value)
  if (!keyBytes.length || keyBytes.length > KEY_FIELD) throw new Error('Record keys are 1 to 32 bytes.')
  if (valueBytes.length > VALUE_FIELD) throw new Error('Record values are at most 256 bytes.')

  const data = new Uint8Array(4 + 4 + 4 + KEY_FIELD + 4 + VALUE_FIELD)
  const dv = new DataView(data.buffer)
  dv.setUint32(0, 2, true)
  dv.setUint16(4, 2, true)
  dv.setUint16(6, 0, true)
  dv.setUint32(8, keyBytes.length, true)
  data.set(keyBytes, 12)
  dv.setUint32(12 + KEY_FIELD, valueBytes.length, true)
  data.set(valueBytes, 12 + KEY_FIELD + 4)

  return signAndSend({
    program: NAME_SERVICE_PROGRAM,
    readWrite: [domainAccount],
    data,
  })
}

/** The wallet's own native balance, in base units. */
export async function nativeBalance() {
  const { address } = requireSession()
  const { balance } = await api('prepare', { address })
  return BigInt(balance ?? 0)
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
