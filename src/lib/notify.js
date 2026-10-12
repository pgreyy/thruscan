// src/lib/notify.js
//
// Notifications (Update 02, 5b): what happened to the connected wallet.
//
// Four sources feed this store, all for one address on one network:
//   1. the wallet's own transactions, when the tx flow lands or fails;
//   2. wall messages addressed to it, found by the wall poll;
//   3. tokens it received, found when a balance rises without its own doing;
//   4. creator fees on tokens it launched, when they go from zero to more.
//
// Kept in localStorage per network and address:
//   thruscan_notifs:<network>:<address>         newest first, at most 100
//   thruscan_notif_seen_at:<network>:<address>  "Mark all read" sets it to now
//
// An item is unread while it is newer than seen_at and has not been tapped.
// Opening the panel marks nothing read. Items are de-duplicated by signature
// (or the event's own key) plus type, so the same event found twice, or on a
// second poll, is one notification.

import { network } from './networks.js'

const NET = network.id
const LIST_KEY = (address) => `thruscan_notifs:${NET}:${address}`
const SEEN_KEY = (address) => `thruscan_notif_seen_at:${NET}:${address}`
const FEES_KEY = (address) => `thruscan_notif_fees:${NET}:${address}`
const MAX = 100

/** The filter chips, and which types each one shows. */
export const FILTERS = [
  { id: 'all', label: 'All', types: null },
  { id: 'wall', label: 'Wall', types: ['wall'] },
  { id: 'trades', label: 'Trades', types: ['trade'] },
  { id: 'fees', label: 'Fees', types: ['fees'] },
]

const listeners = new Set()
const changed = (address, fresh = []) => listeners.forEach((fn) => { try { fn(address, fresh) } catch { /* keep going */ } })

/** Called with (address, newItems) whenever the store changes. */
export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch { return fallback }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private mode: this visit only */ }
}

export function items(address) {
  if (!address) return []
  const list = readJson(LIST_KEY(address), [])
  return Array.isArray(list) ? list : []
}

/** When "Mark all read" was last pressed, or null for an address never seen. */
export function seenAt(address) {
  if (!address) return null
  const v = Number(readJson(SEEN_KEY(address), null))
  return Number.isFinite(v) && v > 0 ? v : null
}

export const isUnread = (n, seen) => !n.read && (n.added ?? n.at ?? 0) > (seen ?? 0)

export function unreadCount(address) {
  const seen = seenAt(address)
  return items(address).filter((n) => isUnread(n, seen)).length
}

/** The id an event is known by: its signature (or its own key) plus its type. */
export const idOf = (n) => `${n.sig ?? n.key}:${n.type}`

/**
 * Add notifications. Returns the ones that were new.
 *
 * The first time an address is seen in this browser, seen_at starts at now and
 * whatever the first scan finds (wall messages and fees from before) goes in
 * as already read: worth listing, not worth a badge.
 */
export function add(address, notes) {
  if (!address || !notes?.length) return []
  const firstRun = seenAt(address) === null
  if (firstRun) writeJson(SEEN_KEY(address), Date.now())
  const list = items(address)
  const have = new Set(list.map(idOf))
  const now = Date.now()
  const fresh = []
  for (const n of notes) {
    const id = idOf(n)
    if (have.has(id)) continue
    have.add(id)
    fresh.push({ ...n, id, at: n.at ?? now, added: now + fresh.length, read: firstRun && !n.own ? true : !!n.read })
  }
  if (!fresh.length) return []
  const next = [...fresh, ...list].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, MAX)
  writeJson(LIST_KEY(address), next)
  changed(address, fresh.filter((n) => !n.read))
  return fresh
}

export function markRead(address, id) {
  const list = items(address)
  const i = list.findIndex((n) => n.id === id)
  if (i < 0 || list[i].read) return
  list[i] = { ...list[i], read: true }
  writeJson(LIST_KEY(address), list)
  changed(address)
}

export function markAllRead(address) {
  if (!address) return
  writeJson(SEEN_KEY(address), Date.now())
  changed(address)
}

/** Whether the creator-fee alert for a launch is armed: true until it fires,
 *  and armed again once the fees go back to zero (a claim). */
export function feeArmed(address, launchId) {
  const map = readJson(FEES_KEY(address), {})
  return map?.[launchId] !== false
}
export function setFeeArmed(address, launchId, armed) {
  const map = readJson(FEES_KEY(address), {}) || {}
  if ((map[launchId] !== false) === armed) return
  map[launchId] = armed
  writeJson(FEES_KEY(address), map)
}

/* ---------- own transactions ----------
 * The tx flow (lib/txflow.js) and the few signing paths that do not use it
 * call this when a transaction lands or fails. The time is remembered so a
 * balance that rises because of it is not also reported as "received". */

let lastOwnTx = 0
export const ownTxRecently = (ms = 30_000) => Date.now() - lastOwnTx < ms

/**
 * { address, type, title, body, sig, ok, to }
 * type: 'trade' (swap, buy, sell), 'fees' (claim), 'wall', or 'tx' (the rest).
 */
export function notifyTx({ address, type = 'tx', side, title, body, sig, ok = true, to, key }) {
  lastOwnTx = Date.now()
  if (!address) return
  add(address, [{
    type, side, title, body, sig, key: key ?? (sig ? undefined : `tx:${Date.now()}`), ok,
    to: to ?? (sig ? `/tx/${sig}` : undefined), own: true, at: Date.now(),
  }])
}

/* ---------- asking the watchers to look again ---------- */

const pokes = new Set()

export function onRefreshRequest(fn) {
  pokes.add(fn)
  return () => pokes.delete(fn)
}

export function requestRefresh() {
  pokes.forEach((fn) => { try { fn() } catch { /* keep going */ } })
}
