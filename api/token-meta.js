// api/token-meta.js
//
// The picture and links for launched tokens, kept in one small file.
//
// Read:   GET  /api/token-meta            -> { ok, meta: { <mint>: {...} } }
// Write:  POST /api/token-meta            -> the creator's signature, checked
//
// Why one file rather than one per token: the registry holds 64 launches, so
// the whole set is a few kilobytes. One object means a page showing a list
// makes one request, and a write costs one store operation instead of one per
// reader. It also means there is a single thing to back up or throw away.
//
// ---------------------------------------------------------------------------
// What stops anyone writing anyone else's token
//
// The launchpad registry records the creator of each launch on chain. A write
// must carry an Ed25519 signature by that key over a message naming the mint,
// the exact values being stored and the moment it was signed (see
// src/lib/tokenmeta.js, which both sides import so there is one definition).
// This checks, in order:
//
//   the signature is recent, so an old one cannot be replayed,
//   the signature verifies against the claimed address,
//   the registry on chain says that address created that mint.
//
// The server holds no secret that could authorise a write, which is the point:
// ThruScan cannot change someone's token either.

import { verifyMessage, Pubkey } from '@thru/sdk'
import { resolveClient, withTimeout } from './rpc.js'
import { decodePadRegistry } from '../src/lib/pad.js'
import { THRUPAD_REGISTRY } from '../src/lib/addresses.js'
import { metaMessage, cleanMeta, metaProblem, SIGNATURE_WINDOW_MS } from '../src/lib/tokenmeta.js'

export const config = { runtime: 'nodejs', maxDuration: 20 }

const PATH = 'token-meta/index.json'
const READ_TTL_MS = 15_000

let memo = null            // { at, meta }

function json(res, status, body, { cacheSeconds = 0 } = {}) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', cacheSeconds > 0
    ? `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 4}`
    : 'no-store')
  res.status(status).json(body)
}

const configured = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN)

/** The stored object, or an empty one. Never throws: no file yet is normal. */
async function readIndex({ fresh = false } = {}) {
  if (!fresh && memo && Date.now() - memo.at < READ_TTL_MS) return memo.meta
  if (!configured()) return {}
  try {
    const { head } = await import('@vercel/blob')
    const info = await head(PATH).catch(() => null)
    if (!info?.url) { memo = { at: Date.now(), meta: {} }; return {} }
    const r = await fetch(`${info.url}?t=${info.uploadedAt ? new Date(info.uploadedAt).getTime() : ''}`)
    const meta = r.ok ? await r.json() : {}
    memo = { at: Date.now(), meta: meta && typeof meta === 'object' ? meta : {} }
    return memo.meta
  } catch {
    return memo?.meta ?? {}
  }
}

async function writeIndex(meta) {
  const { put } = await import('@vercel/blob')
  await put(PATH, JSON.stringify(meta), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
  })
  memo = { at: Date.now(), meta }
}

/** Who the chain says created this mint. Null when the mint is not a launch. */
async function creatorOf(mint) {
  const { client } = await resolveClient()
  const account = await withTimeout(client.accounts.get(THRUPAD_REGISTRY), 12_000)
  const registry = decodePadRegistry(account.data?.data)   // the decoder takes raw bytes too
  const launch = registry.launches.find((l) => l.mint === mint)
  return launch ? launch.creator : null
}

const toBytes = (address) => Pubkey.from(address).toBytes()

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true })

  if (req.method === 'GET') {
    const meta = await readIndex({ fresh: req.query?.fresh === '1' })
    return json(res, 200, { ok: true, meta, configured: configured() }, { cacheSeconds: 15 })
  }

  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET or POST.' })

  if (!configured()) {
    return json(res, 501, { ok: false, error: 'Token pictures are not switched on for this site yet.' })
  }

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = null } }
  if (!body || typeof body !== 'object') return json(res, 400, { ok: false, error: 'Send JSON.' })

  const { mint, address, signature, signedAt } = body
  if (typeof mint !== 'string' || !/^ta[A-Za-z0-9_-]{20,60}$/.test(mint)) {
    return json(res, 400, { ok: false, error: 'That is not a mint address.' })
  }
  if (typeof address !== 'string' || typeof signature !== 'string') {
    return json(res, 400, { ok: false, error: 'Missing the signature.' })
  }
  const when = Number(signedAt)
  if (!Number.isFinite(when) || Math.abs(Date.now() - when) > SIGNATURE_WINDOW_MS) {
    return json(res, 400, { ok: false, error: 'That signature is too old. Try again.' })
  }

  const meta = cleanMeta(body)
  const problem = metaProblem(meta)
  if (problem) return json(res, 400, { ok: false, error: problem })

  // 1. The signature is this address's, over exactly these values.
  try {
    const message = new TextEncoder().encode(metaMessage({ mint, ...meta, signedAt: when }))
    const sig = Buffer.from(signature, 'base64')
    if (sig.length !== 64) throw new Error('bad signature length')
    const ok = await verifyMessage(new Uint8Array(sig), message, toBytes(address))
    if (!ok) return json(res, 401, { ok: false, error: 'That signature does not match.' })
  } catch (e) {
    return json(res, 401, { ok: false, error: `Could not check the signature: ${String(e?.message ?? e)}` })
  }

  // 2. The chain says this address created this mint.
  let creator
  try {
    creator = await creatorOf(mint)
  } catch (e) {
    return json(res, 502, { ok: false, error: `Could not read the launchpad: ${String(e?.message ?? e)}` })
  }
  if (!creator) return json(res, 404, { ok: false, error: 'No launch on ThruScan has that mint.' })
  if (creator !== address) return json(res, 403, { ok: false, error: 'Only the token\'s creator can change this.' })

  // 3. Store it, re-reading first so a write does not undo someone else's.
  try {
    const all = await readIndex({ fresh: true })
    const next = { ...all, [mint]: { ...meta, updatedAt: Date.now() } }
    if (!meta.image && !meta.x && !meta.telegram && !meta.website) delete next[mint]
    await writeIndex(next)
    return json(res, 200, { ok: true, meta: next[mint] ?? null })
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message ?? e) })
  }
}
