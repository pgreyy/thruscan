// src/lib/findToken.js
//
// Turning what somebody typed into a token.
//
// The search box used to know two shapes: a signature and an address. An
// address went to /account, which for a token mint is the wrong page. It
// shows the raw account rather than the chart, the price and the buy button,
// which is what somebody pasting a contract address is looking for.
//
// So the box now asks one question first: is this a token we know about? That
// costs a single account read, cached, and only when somebody presses enter.
//
// It has to survive the chain being unreachable. If the registry cannot be
// read, every lookup answers "no" and the caller falls back to what it did
// before. A search box that breaks because a node is down is worse than one
// that sends you to the account page.

import { getAccount } from './rpcClient'
import { decodePadRegistry } from './pad.js'
import { THRUPAD_REGISTRY } from './addresses.js'

const FRESH_MS = 30_000

let cache = { at: 0, launches: [] }
let inflight = null

/** Every launch the pad knows about, cached briefly. Empty if unreadable. */
export async function launches() {
  if (Date.now() - cache.at < FRESH_MS) return cache.launches
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const acct = await getAccount(THRUPAD_REGISTRY)
      const found = decodePadRegistry(acct?.data?.base64).launches ?? []
      cache = { at: Date.now(), launches: found }
      return found
    } catch {
      /* Unreachable or undecodable. Remember the miss for a moment so a burst
         of searches does not become a burst of failing requests, but keep
         whatever we had rather than throwing it away. */
      cache = { at: Date.now(), launches: cache.launches }
      return cache.launches
    } finally {
      inflight = null
    }
  })()

  return inflight
}

/** The launch for this mint address, or null. */
export async function tokenByMint(address) {
  if (!address) return null
  const all = await launches()
  return all.find((l) => l.mint === address) ?? null
}

/**
 * The launch for a ticker or a name, or null.
 *
 * Exact ticker first, because that is what somebody typing TOKN means. Then a
 * whole-name match. Never a partial one: sending somebody to a token whose
 * name merely contains what they typed is a guess wearing a confident face.
 * Ties go to the one that has sold most, which is the one they meant.
 */
export async function tokenByText(text) {
  const q = String(text ?? '').trim().toLowerCase()
  if (!q) return null
  const all = await launches()
  const sold = (l) => Number(l.tokensSold ?? 0n)

  const bySymbol = all.filter((l) => String(l.symbol ?? '').toLowerCase() === q)
  if (bySymbol.length) return bySymbol.sort((a, b) => sold(b) - sold(a))[0]

  const byName = all.filter((l) => String(l.name ?? '').toLowerCase() === q)
  if (byName.length) return byName.sort((a, b) => sold(b) - sold(a))[0]

  return null
}

/* Shapes, so the caller can decide what to try before spending a request.
   A Thru address and a signature share a prefix family but not a length:
   addresses are 32 bytes encoded, signatures 64. */
export const looksLikeSignature = (v) => /^ts[A-Za-z0-9_-]{40,}$/.test(v)
export const looksLikeAddress = (v) => /^ta[A-Za-z0-9_-]{40,}$/.test(v)
