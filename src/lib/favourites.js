// src/lib/favourites.js
//
// Tokens someone wants to keep an eye on.
//
// The front page shows four tokens, chosen by size, which is a reasonable
// guess and never the right answer for any particular person. A favourite is
// how you say otherwise: it takes one of those four slots, in front of
// whatever the page would have picked.
//
// Kept in this browser rather than on chain. It is a preference, not a
// possession: there is nothing here anyone else needs to verify, nothing worth
// paying state for, and nothing that should cost a signature to change.

const KEY = 'thruscan.favourites.v1'
const MAX = 4

const listeners = new Set()
const tell = () => listeners.forEach((fn) => { try { fn() } catch { /* keep going */ } })

export function favourites() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((m) => typeof m === 'string').slice(0, MAX) : []
  } catch { return [] }
}

export const isFavourite = (mint) => favourites().includes(mint)

/** Returns the list as it now stands. Oldest drops out once there are four. */
export function toggleFavourite(mint) {
  if (!mint) return favourites()
  const have = favourites()
  const next = have.includes(mint) ? have.filter((m) => m !== mint) : [mint, ...have].slice(0, MAX)
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private mode */ }
  tell()
  return next
}

export function onFavouritesChange(fn) {
  listeners.add(fn)
  // Another tab is still this person, so a favourite set there belongs here.
  const cross = (e) => { if (e.key === KEY) fn() }
  window.addEventListener('storage', cross)
  return () => { listeners.delete(fn); window.removeEventListener('storage', cross) }
}

/**
 * Put the favourites first, then whatever the page would have shown, and stop
 * at `count`. A favourite that is not in `all` is simply not shown: it may be
 * a token this page does not carry prices for.
 */
export function withFavouritesFirst(all, count = 4) {
  const picked = favourites()
  const byMint = new Map((all ?? []).filter((t) => t.mint).map((t) => [t.mint, t]))
  const front = picked.map((m) => byMint.get(m)).filter(Boolean)
  const rest = (all ?? []).filter((t) => !front.includes(t))
  return [...front, ...rest].slice(0, count)
}
