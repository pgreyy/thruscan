// api/media.js
//
// Pictures, and the small amount of data that points at them.
//
//   POST /api/media?kind=pfp     an image, as raw bytes          -> { url }
//   GET  /api/media              every token's picture and links -> { meta }
//   POST /api/media              one token's, with a signature   -> { meta }
//
// Two jobs in one file because a Hobby deployment may hold twelve functions
// and these two are small. They belong together in any case: one stores
// pictures, the other records which token a picture belongs to.
//
// ---------------------------------------------------------------------------
// PICTURES
//
// ThruScan's own data lives on chain, but a name service record holds 256
// bytes, which is a URL and not an image. Putting images on chain would mean
// paying for state forever to store something every browser already knows how
// to fetch and cache. So a picture is stored here and the chain holds the link,
// exactly as it did when the only option was pasting someone else's link. The
// difference is that you no longer have to find a host first.
//
// Three things make this safe to leave open:
//
//   The browser has already cropped and re-encoded the image to a 400 pixel
//   square before it arrives, so the body is tens of kilobytes. Anything over
//   MAX_BYTES is refused unread.
//
//   The bytes are checked against the magic numbers of the formats we accept,
//   not the Content-Type header, which anyone can write anything into.
//
//   The stored name is the SHA-256 of the bytes. The same picture uploaded
//   twice writes the same object, so re-uploading costs nothing and nobody can
//   fill the store by sending one file a thousand times. `addRandomSuffix` is
//   off precisely so that this holds.
//
// ---------------------------------------------------------------------------
// WHICH PICTURE BELONGS TO WHICH TOKEN
//
// The launchpad's registry has a fixed 253 byte record per launch, holding the
// name, ticker, creator, mint, vaults and curve. There is no room in it for a
// picture, and widening it would mean migrating a registry with live curves in
// it. So this half lives beside the chain rather than on it, and is honest
// about which is which: the chain says who created a launch, this says what it
// looks like.
//
// What makes the off-chain half trustworthy is that it cannot be written by
// anyone else. A write must carry an Ed25519 signature by the key the registry
// records as that launch's creator, over a message naming the mint, the exact
// values being stored and the moment it was signed (see src/lib/tokenmeta.js,
// which both sides import so there is one definition). This checks, in order:
// that the signature is recent, so an old one cannot be replayed; that it
// verifies against the claimed address; and that the registry on chain says
// that address created that mint. The server holds no secret that could
// authorise a write, which is the point: ThruScan cannot change someone's
// token either.
//
// Everything is kept in one small object rather than a file per token. The
// registry holds 64 launches, so the whole set is a few kilobytes: one request
// serves a page showing a list, and a write costs one store operation instead
// of one per reader.

import { createHash } from 'node:crypto'
import { verifyMessage, Pubkey } from '@thru/sdk'
import { resolveClient, withTimeout } from './rpc.js'
import { decodePadRegistry } from '../src/lib/pad.js'
import { THRUPAD_REGISTRY } from '../src/lib/addresses.js'
import { metaMessage, cleanMeta, metaProblem, SIGNATURE_WINDOW_MS } from '../src/lib/tokenmeta.js'

export const config = { runtime: 'nodejs', maxDuration: 20 }

const MAX_BYTES = 300 * 1024

// [extension, mime, offset, signature bytes]
const MAGIC = [
  ['webp', 'image/webp', 8, [0x57, 0x45, 0x42, 0x50]],                    // "WEBP" at 8, after RIFF....
  ['png', 'image/png', 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['jpg', 'image/jpeg', 0, [0xff, 0xd8, 0xff]],
  ['gif', 'image/gif', 0, [0x47, 0x49, 0x46, 0x38]],
]

function sniff(buf) {
  for (const [ext, mime, off, sig] of MAGIC) {
    if (buf.length < off + sig.length) continue
    let hit = true
    for (let i = 0; i < sig.length; i++) if (buf[off + i] !== sig[i]) { hit = false; break }
    if (hit) return { ext, mime }
  }
  return null
}

/* Vercel's Node runtime leaves a non-JSON body unparsed, so this reads the
   stream, and stops reading the moment it goes over the limit rather than
   buffering a body someone sent to waste memory. */
function readBody(req) {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body)
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BYTES) { reject(new Error('too-large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/* A brake rather than a lock. One function instance keeps a short memory of
   which addresses have been busy; instances come and go, so this will not stop
   a determined flood on its own. The hard stop is the plan's own monthly cap on
   writes, which cannot be exceeded into a bill. */
const recent = new Map()
const WINDOW_MS = 60_000
const PER_WINDOW = 20

function tooFast(ip) {
  const now = Date.now()
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
  hits.push(now)
  recent.set(ip, hits)
  if (recent.size > 500) for (const [k, v] of recent) if (!v.some((t) => now - t < WINDOW_MS)) recent.delete(k)
  return hits.length > PER_WINDOW
}

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

/* ---------- the two routes ---------- */

async function putImage(req, res) {
  if (!configured()) {
    return json(res, 501, { ok: false, error: 'Uploads are not switched on for this site yet.' })
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown'
  if (tooFast(ip)) return json(res, 429, { ok: false, error: 'Too many uploads just now. Wait a minute.' })

  let body
  try {
    body = await readBody(req)
  } catch (e) {
    return json(res, 413, { ok: false, error: e?.message === 'too-large' ? 'That image is over 300 KB.' : 'Could not read the upload.' })
  }
  if (!body?.length) return json(res, 400, { ok: false, error: 'Empty upload.' })
  if (body.length > MAX_BYTES) return json(res, 413, { ok: false, error: 'That image is over 300 KB.' })

  const kind = String(req.query?.kind || 'pfp').replace(/[^a-z]/g, '').slice(0, 12) || 'pfp'
  const found = sniff(body)
  if (!found) return json(res, 415, { ok: false, error: 'That is not a PNG, JPEG, WebP or GIF.' })

  const hash = createHash('sha256').update(body).digest('hex').slice(0, 40)
  const path = `${kind}/${hash}.${found.ext}`

  try {
    const { put } = await import('@vercel/blob')
    const blob = await put(path, body, {
      access: 'public',
      contentType: found.mime,
      addRandomSuffix: false,
      allowOverwrite: true,          // same bytes, same name; a rewrite is a no-op
      cacheControlMaxAge: 31_536_000, // the name is the hash, so it never goes stale
    })
    return json(res, 200, { ok: true, url: blob.url, bytes: body.length, type: found.mime })
  } catch (e) {
    const msg = String(e?.message ?? e)
    // A missing or stale token, and a store that has been deleted, are the same
    // thing from the page's point of view: uploads are not available, use a link.
    if (/token|store (not found|does not exist)|No token/i.test(msg)) {
      return json(res, 501, { ok: false, error: 'Uploads are not switched on for this site yet.' })
    }
    return json(res, 500, { ok: false, error: msg })
  }
}

async function writeMeta(req, res) {
  if (!configured()) {
    return json(res, 501, { ok: false, error: 'Token pictures are not switched on for this site yet.' })
  }

  let body = req.body
  if (Buffer.isBuffer(body)) body = body.toString('utf8')
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
    const ok = await verifyMessage(new Uint8Array(sig), message, Pubkey.from(address).toBytes())
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
  if (creator !== address) return json(res, 403, { ok: false, error: "Only the token's creator can change this." })

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

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true })

  if (req.method === 'GET') {
    const meta = await readIndex({ fresh: req.query?.fresh === '1' })
    return json(res, 200, { ok: true, meta, configured: configured() }, { cacheSeconds: 15 })
  }

  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET or POST.' })

  // An image arrives as its own bytes; everything else is JSON. The
  // Content-Type is only used to tell the two apart, never to trust what the
  // bytes are: that is what the magic-number check is for.
  const type = String(req.headers['content-type'] || '')
  return type.startsWith('image/') ? putImage(req, res) : writeMeta(req, res)
}
