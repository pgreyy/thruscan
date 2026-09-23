// src/lib/notify.js
//
// Telling someone something happened to them.
//
// The hard case is a sale. The buyer signs the transaction, so they see it land
// and could be told by the page they are standing on. The seller signs nothing:
// their Pal leaves escrow and their token account is credited by someone else's
// transaction, on a device that may not even be open. Nothing in the seller's
// own transaction history mentions it, which is why a sale could happen and
// leave no trace anywhere the seller looks.
//
// So notifications are not events the site emits when it does something. They
// are read from the chain: the market keeps its last 64 sales in a ring, each
// with a buyer, a seller, a price and a slot. Anything in that ring naming you
// that you have not been shown yet is a notification. That works on a device
// that was closed at the time, on a different browser, and for a seller who was
// asleep.
//
// What is remembered here is only which ones have been shown, per address, in
// this browser. The events themselves live on chain and are re-read every time.

const KEY = (address) => `thruscan.notes.${address || 'anon'}`
const MAX = 60

const listeners = new Set()
const notify = () => listeners.forEach((fn) => { try { fn() } catch { /* keep going */ } })

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function read(address) {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(address)) || '{}')
    return { items: Array.isArray(raw.items) ? raw.items : [], started: raw.started ?? null }
  } catch { return { items: [], started: null } }
}

function write(address, state) {
  try { localStorage.setItem(KEY(address), JSON.stringify(state)) } catch { /* private mode */ }
  notify()
}

export const items = (address) => read(address).items
export const unreadCount = (address) => read(address).items.filter((n) => !n.read).length

/**
 * Add, unless this exact thing is already there. Ids are built from what
 * happened rather than when it was noticed, so the same sale seen on three
 * devices is one notification on each, and re-reading the ring never doubles
 * anything up.
 */
export function add(address, note) {
  const state = read(address)
  if (state.items.some((n) => n.id === note.id)) return false
  state.items = [{ read: false, at: Date.now(), ...note }, ...state.items].slice(0, MAX)
  write(address, state)
  return true
}

export function addMany(address, notes) {
  const state = read(address)
  const have = new Set(state.items.map((n) => n.id))
  const fresh = notes.filter((n) => !have.has(n.id))
  if (!fresh.length) return 0
  state.items = [...fresh.map((n) => ({ read: false, at: Date.now(), ...n })), ...state.items]
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, MAX)
  write(address, state)
  return fresh.length
}

export function markAllRead(address) {
  const state = read(address)
  if (!state.items.some((n) => !n.read)) return
  state.items = state.items.map((n) => ({ ...n, read: true }))
  write(address, state)
}

export function clear(address) {
  write(address, { items: [], started: read(address).started })
}

/**
 * The first time an address is seen in this browser, only the last few days of
 * history are worth telling them about: everything older is something they
 * already know, and a wall of it on first load is noise. Returns the cutoff.
 */
export function historyCutoff(address, days = 7) {
  const state = read(address)
  if (!state.started) {
    state.started = Date.now()
    write(address, state)
  }
  return Math.min(state.started, Date.now()) - days * 86_400_000
}

/* ---------- asking the watcher to look again ----------
 *
 * After a purchase the buyer should not wait out a polling interval to be told
 * what they just did. Rather than have the page add its own notification, which
 * would then arrive twice when the watcher found the same sale on chain, the
 * page asks the watcher to look now. One source, no duplicates. */

const pokes = new Set()

export function onRefreshRequest(fn) {
  pokes.add(fn)
  return () => pokes.delete(fn)
}

export function requestRefresh() {
  pokes.forEach((fn) => { try { fn() } catch { /* keep going */ } })
}
