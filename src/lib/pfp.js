// src/lib/pfp.js
//
// Who someone looks like, resolved from the chain.
//
// A profile picture on ThruScan is one of two things, and both of them live on
// the name rather than here:
//
//   `avatar`  a link to an image. Any https link works; the site's own uploader
//             simply saves you finding a host for it. Shown as a circle.
//
//   `pfp`     an NFT, written as `thru:pixelpals/1945`. Shown as a hexagon,
//             because a hexagon is the shape that has come to mean "this is not
//             a picture I found, it is a thing I own".
//
// The hexagon is earned, not declared. Before drawing one, this checks the
// collection on chain and compares the current owner of that Pal against the
// owner of the name. Sell the Pal and the next person to load the page sees a
// circle, without you having to remember to change anything, because the claim
// was never stored: it was always being checked.
//
// Both records are read together, so someone can keep a picture and an NFT at
// once. The NFT wins while it is theirs, and the picture is what it falls back
// to when it is not.

import { checkName } from './wallet.js'
import { decodeDomain } from './names.js'
import { palsInOrder } from './pals/art.js'

export const AVATAR_KEY = 'avatar'
export const PFP_KEY = 'pfp'

/** `thru:pixelpals/1945`. Short enough to leave most of the 256 byte record spare. */
export const PIXEL_PALS = 'pixelpals'
export const formatNftPfp = (num, collection = PIXEL_PALS) => `thru:${collection}/${num}`

export function parseNftPfp(value) {
  const m = /^thru:([a-z0-9_-]+)\/(\d{1,7})$/i.exec((value ?? '').trim())
  if (!m) return null
  return { collection: m[1].toLowerCase(), num: Number(m[2]) }
}

const isHttps = (v) => /^https:\/\/\S+$/i.test((v ?? '').trim())

/* ---------- caches ----------
 *
 * A leaderboard asks for the same handful of names every few seconds, and a
 * page with twenty rows would otherwise make twenty identical requests. Each
 * cache holds a promise rather than a value, so calls that arrive while one is
 * in flight join it instead of starting another. */

function cache(ttl, fetcher) {
  const held = new Map()
  return (key) => {
    const now = Date.now()
    const hit = held.get(key)
    if (hit && now - hit.at < ttl) return hit.value
    const value = Promise.resolve(fetcher(key)).catch((e) => { held.delete(key); throw e })
    held.set(key, { at: now, value })
    if (held.size > 200) for (const [k, v] of held) if (now - v.at > ttl) held.delete(k)
    return value
  }
}

function decodeBase64(b64) {
  if (!b64) return null
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The domain account behind a bare label, or null when nobody holds it. */
export const nameDomain = cache(60_000, async (name) => {
  if (!name) return null
  const r = await checkName(name)
  if (!r?.ok || !r.taken) return null
  const domain = decodeDomain(decodeBase64(r.data))
  return domain ? { ...domain, account: r.account } : null
})

/** The whole collection, once, shared by every picture on the page. */
export const palsSnapshot = cache(30_000, async () => {
  const r = await fetch('/api/rpc?action=pals')
  const j = await r.json()
  if (!j.ok) throw new Error(j.error || 'Could not read the collection.')
  const map = palsInOrder((j.pals ?? []).map(([num, minter]) => ({ num, minter })))
  const art = []
  for (const [num, p] of map) art[num] = p
  const owners = Object.fromEntries((j.pals ?? []).map(([num, , owner]) => [num, owner]))
  return { art, owners }
})

export const EMPTY_PFP = { kind: 'none', url: null, pal: null, num: null, verified: false, owner: null }

/**
 * What to draw for a name. Never throws: a picture is decoration, and a page
 * that fails to load because a name service call timed out would be a worse
 * outcome than a page of identicons.
 */
export async function pfpForName(name) {
  try {
    const domain = await nameDomain(name)
    if (!domain) return EMPTY_PFP
    return await pfpForDomain(domain)
  } catch { return EMPTY_PFP }
}

export async function pfpForDomain(domain) {
  if (!domain) return EMPTY_PFP
  // The name service appends records. If a key were ever written twice, the
  // later write is the current value, so this takes the last match rather than
  // the first: reading the first is a bug that only appears once somebody
  // changes their picture.
  const value = (key) => {
    const hits = (domain.records ?? []).filter((r) => r.key === key)
    return hits.length ? hits[hits.length - 1].value : null
  }
  const picture = value(AVATAR_KEY)
  const claim = parseNftPfp(value(PFP_KEY))
  const fallback = isHttps(picture)
    ? { kind: 'image', url: picture.trim(), pal: null, num: null, verified: false, owner: domain.owner }
    : { ...EMPTY_PFP, owner: domain.owner }

  if (!claim || claim.collection !== PIXEL_PALS) return fallback

  try {
    const { art, owners } = await palsSnapshot()
    if (owners[claim.num] !== domain.owner || !art[claim.num]) return fallback
    return { kind: 'nft', url: null, pal: art[claim.num], num: claim.num, verified: true, owner: domain.owner }
  } catch {
    // The collection could not be read. Falling back to the picture is the
    // honest answer: an unverified hexagon is worse than no hexagon.
    return fallback
  }
}
