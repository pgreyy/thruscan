// src/lib/tokenmeta.js
//
// A picture and a few links for a launched token.
//
// The launchpad's registry has a fixed 253 byte record per launch, holding the
// name, ticker, creator, mint, vaults and curve. There is no room in it for a
// picture, and widening it would mean migrating a registry with live curves in
// it. So this lives beside the chain rather than on it, and is honest about
// which is which:
//
//   on chain      who created the launch, and everything that affects money
//   beside it     what it looks like and where to find its community
//
// What makes the off-chain half trustworthy is that it cannot be written by
// anyone else. Changing a token's picture takes a signature from the key the
// registry records as that launch's creator, over a message naming the mint,
// the exact values and the minute it was signed. The server checks the
// signature against the chain before it stores anything. No password, no
// account, nothing ThruScan could quietly override.
//
// This file is imported by both sides so there is exactly one definition of the
// message being signed. Two definitions of a canonical message is how signature
// checks come to fail for reasons nobody can reproduce.

export const META_TAG = 'thruscan.token-meta.v1'
export const SIGNATURE_WINDOW_MS = 10 * 60 * 1000

export const EMPTY_META = { image: '', x: '', telegram: '', website: '' }

/** The exact bytes both sides agree on. Field order is part of the contract. */
export function metaMessage({ mint, image, x, telegram, website, signedAt }) {
  return [
    META_TAG,
    mint,
    image ?? '',
    x ?? '',
    telegram ?? '',
    website ?? '',
    String(signedAt),
  ].join('\n')
}

/* ---------- what counts as a value ----------
 *
 * Handles are stored as handles, not links, so the site decides where an X
 * handle points rather than storing someone else's idea of it. Pasting the full
 * URL works because people paste what they have. */

export function cleanHandle(input, { hosts }) {
  let v = (input ?? '').trim()
  if (!v) return ''
  v = v.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
  for (const host of hosts) {
    if (v.toLowerCase().startsWith(`${host}/`)) { v = v.slice(host.length + 1); break }
  }
  v = v.split(/[/?#]/)[0].replace(/^@/, '')
  return v
}

export const cleanX = (v) => cleanHandle(v, { hosts: ['x.com', 'twitter.com'] })
export const cleanTelegram = (v) => cleanHandle(v, { hosts: ['t.me', 'telegram.me'] })

export function cleanWebsite(input) {
  const v = (input ?? '').trim()
  if (!v) return ''
  if (/^https?:\/\//i.test(v)) return v
  return `https://${v}`
}

/** Normalise everything at once, the way it will be signed and stored. */
export function cleanMeta(meta) {
  return {
    image: (meta?.image ?? '').trim(),
    x: cleanX(meta?.x),
    telegram: cleanTelegram(meta?.telegram),
    website: cleanWebsite(meta?.website),
  }
}

const HANDLE = /^[A-Za-z0-9_]{1,32}$/

/** Returns a reason to refuse, or null. Run on both sides, deliberately. */
export function metaProblem(meta) {
  const m = meta ?? EMPTY_META
  if (m.image && !/^https:\/\/\S{1,280}$/i.test(m.image)) return 'The picture has to be an https link.'
  if (m.x && !HANDLE.test(m.x)) return 'An X handle is letters, numbers and underscores.'
  if (m.telegram && !HANDLE.test(m.telegram)) return 'A Telegram handle is letters, numbers and underscores.'
  if (m.website && !/^https?:\/\/[^\s.]+\.[^\s]{2,200}$/i.test(m.website)) return 'That website address does not look right.'
  return null
}

export const xUrl = (handle) => (handle ? `https://x.com/${handle}` : null)
export const telegramUrl = (handle) => (handle ? `https://t.me/${handle}` : null)

/* ---------- reading ----------
 *
 * One request returns every token's metadata, because the launchpad shows a
 * list and twenty requests for twenty rows is how a page gets slow. The whole
 * set is a few kilobytes: the registry holds 64 launches. */

let cached = null
let cachedAt = 0
const TTL_MS = 20_000

export async function allTokenMeta({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < TTL_MS) return cached
  try {
    const r = await fetch('/api/token-meta')
    const j = await r.json()
    if (!j.ok) throw new Error(j.error || 'no metadata')
    cached = j.meta ?? {}
    cachedAt = Date.now()
    return cached
  } catch {
    return cached ?? {}
  }
}

export async function tokenMetaFor(mint, opts) {
  const all = await allTokenMeta(opts)
  return all[mint] ?? null
}

/** Force the next read to go out again, after a write. */
export function forgetTokenMeta() { cached = null; cachedAt = 0 }

/* ---------- writing ---------- */

/**
 * Sign and store. `sign` is passed in rather than imported so this module stays
 * usable from the server, which has no wallet and must never import one.
 */
export async function saveTokenMeta({ mint, meta, address, sign }) {
  const clean = cleanMeta(meta)
  const problem = metaProblem(clean)
  if (problem) throw new Error(problem)

  const signedAt = Date.now()
  const signature = await sign(metaMessage({ mint, ...clean, signedAt }))

  const r = await fetch('/api/token-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mint, ...clean, address, signedAt, signature }),
  })
  const j = await r.json().catch(() => null)
  if (!r.ok || !j?.ok) throw new Error(j?.error || `Could not save (${r.status}).`)
  forgetTokenMeta()
  return j.meta
}
