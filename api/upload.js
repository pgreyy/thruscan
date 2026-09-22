// api/upload.js
//
// Somewhere to put a picture.
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
// Storage is Vercel Blob. If no store is connected to the project there is no
// token, and the endpoint says so with a 501 rather than pretending: the page
// then offers the old paste-a-link path, which still works and always will.

import { createHash } from 'node:crypto'

export const config = { runtime: 'nodejs', maxDuration: 15 }

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

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json(body)
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

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true })
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST an image.' })

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
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
