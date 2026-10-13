// src/lib/walletSession.js
//
// Keeping the browser wallet unlocked across page refreshes, for a while.
//
// The password-encrypted key in localStorage (wallet.js) is unchanged. What
// this adds is a short-lived second copy, so a refresh does not ask for the
// password again:
//
//   - A fresh AES-GCM key is generated for each unlock with WebCrypto, marked
//     non-extractable, and stored as a CryptoKey object in IndexedDB. Script on
//     the page can ask the browser to use it, but can never read its bytes.
//   - The private key (and the recovery phrase, if any) is encrypted with it,
//     and the ciphertext sits beside it with the address and an expiry time.
//     Nothing raw ever goes to localStorage, sessionStorage or IndexedDB.
//   - On load the copy is used only if it has not expired and its address is
//     the stored wallet's. Otherwise it is deleted.
//
// The expiry is inactivity-based: it moves forward each time the wallet
// signs. "This tab only" keeps the copy for the current tab alone (it is
// found through a tab id in sessionStorage, which other tabs do not share),
// so it survives a refresh of that tab and nothing else.
//
// Locking, removing or replacing the wallet, or a wrong password deletes
// every copy. Lock messages go to the other open tabs over a
// BroadcastChannel, with a storage event as the fallback.

const DB_NAME = 'thruscan-wallet'
const STORE = 'session'
const AUTOLOCK_KEY = 'thruscan.wallet.autolock'
const TAB_KEY = 'thruscan.wallet.tab'
const SIGNAL_KEY = 'thruscan.wallet.signal'

export const AUTOLOCK_OPTIONS = [
  { id: '15m', label: '15 minutes', ms: 15 * 60_000 },
  { id: '1h', label: '1 hour', ms: 60 * 60_000 },
  { id: '8h', label: '8 hours', ms: 8 * 60 * 60_000 },
  { id: 'tab', label: 'This tab only', ms: 8 * 60 * 60_000 },
]
const DEFAULT_AUTOLOCK = '1h'

export function autoLock() {
  try {
    const v = localStorage.getItem(AUTOLOCK_KEY)
    return AUTOLOCK_OPTIONS.some((o) => o.id === v) ? v : DEFAULT_AUTOLOCK
  } catch { return DEFAULT_AUTOLOCK }
}
export const autoLockOption = (id = autoLock()) => AUTOLOCK_OPTIONS.find((o) => o.id === id)

/** How long the wallet stays unlocked, in words, for the in-app copy. */
export function autoLockWords(id = autoLock()) {
  if (id === 'tab') return 'until this tab is closed'
  return `for ${autoLockOption(id).label} after you last sign anything`
}

export function setAutoLockPref(id) {
  try { localStorage.setItem(AUTOLOCK_KEY, id) } catch { /* private mode: default stays */ }
}

function tabId() {
  try {
    let id = sessionStorage.getItem(TAB_KEY)
    if (!id) {
      id = crypto.randomUUID()
      sessionStorage.setItem(TAB_KEY, id)
    }
    return id
  } catch { return null }
}

/* ---------- IndexedDB ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx(mode, fn) {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode)
      const store = t.objectStore(STORE)
      let result
      Promise.resolve(fn(store)).then((r) => { result = r })
      t.oncomplete = () => resolve(result)
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
  } finally {
    db.close()
  }
}
const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })

const recordId = (mode) => (mode === 'tab' ? `tab:${tabId()}` : 'shared')

/* ---------- the session copy ---------- */

/** Wrap and store an unlocked key. Returns the expiry time. */
export async function saveSession({ address, privateKey, phrase = null }) {
  const mode = autoLock()
  const opt = autoLockOption(mode)
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const phraseBytes = phrase ? new TextEncoder().encode(phrase) : new Uint8Array(0)
  const plain = new Uint8Array(32 + phraseBytes.length)
  plain.set(privateKey, 0)
  plain.set(phraseBytes, 32)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))
  plain.fill(0)
  const expiresAt = Date.now() + opt.ms
  await clearSessions()
  await tx('readwrite', (s) => s.put({ address, key, iv, ct, expiresAt, mode, ms: opt.ms }, recordId(mode)))
  return expiresAt
}

/** The stored key for `address`, if one is there and still in date. Anything
 *  expired or for another address is deleted rather than kept. */
export async function restoreSession(address) {
  if (!address) return null
  const mode = autoLock()
  const id = recordId(mode)
  let rec
  try { rec = await tx('readonly', (s) => req(s.get(id))) } catch { return null }
  if (!rec) return null
  if (rec.address !== address || !(rec.expiresAt > Date.now()) || rec.mode !== mode) {
    await clearSessions()
    return null
  }
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, rec.key, rec.ct))
    const privateKey = plain.slice(0, 32)
    const phrase = plain.length > 32 ? new TextDecoder().decode(plain.slice(32)) : null
    plain.fill(0)
    return { privateKey, phrase, expiresAt: rec.expiresAt }
  } catch {
    await clearSessions()
    return null
  }
}

/** Move the expiry forward from now, after a signature. Returns it. */
export async function touchSession() {
  const id = recordId(autoLock())
  try {
    return await tx('readwrite', async (s) => {
      const rec = await req(s.get(id))
      if (!rec) return null
      rec.expiresAt = Date.now() + rec.ms
      s.put(rec, id)
      return rec.expiresAt
    })
  } catch { return null }
}

/** Delete every stored copy, this tab's and any other's. */
export async function clearSessions() {
  try { await tx('readwrite', (s) => s.clear()) } catch { /* nothing stored */ }
}

/* ---------- telling the other tabs ---------- */

let channel = null
try { channel = new BroadcastChannel('thruscan-wallet') } catch { channel = null }

export function broadcast(type) {
  const msg = { type, at: Date.now() }
  if (channel) channel.postMessage(msg)
  else {
    try { localStorage.setItem(SIGNAL_KEY, JSON.stringify(msg)) } catch { /* private mode */ }
  }
}

/** fn({ type: 'lock' | 'unlock' }) for messages from other tabs. */
export function onBroadcast(fn) {
  const onMsg = (e) => { if (e.data?.type) fn(e.data) }
  const onStorage = (e) => {
    if (e.key !== SIGNAL_KEY || !e.newValue) return
    try { fn(JSON.parse(e.newValue)) } catch { /* not ours */ }
  }
  channel?.addEventListener('message', onMsg)
  window.addEventListener('storage', onStorage)
  return () => { channel?.removeEventListener('message', onMsg); window.removeEventListener('storage', onStorage) }
}
