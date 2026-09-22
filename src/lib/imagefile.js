// src/lib/imagefile.js
//
// Turning whatever someone drops on the page into something worth storing.
//
// A picture off a phone is a 4 MB JPEG, three thousand pixels on a side, and
// shown at 88 pixels. Uploading that is wasteful three times over: the upload,
// the storage, and every visitor who then downloads it to look at a thumbnail.
// So the browser does the work first. It crops to a square from the centre,
// scales to 400 pixels, and re-encodes as WebP.
//
// 400 is chosen for retina at the largest size the site shows a picture (about
// 120 CSS pixels), with room to grow. A photograph at that size lands around 20
// to 40 KB, which is small enough that the upload finishes before anyone has
// decided whether they like it.
//
// WebP is used where it is supported, which is everywhere that matters now, and
// the encoder falls back to JPEG if the canvas refuses it. Transparency is kept
// for PNG sources, because a logo with a white box around it looks broken.

export const MAX_SOURCE_BYTES = 12 * 1024 * 1024   // what we will even open
export const OUTPUT_SIZE = 400
export const MAX_UPLOAD_BYTES = 300 * 1024         // what the API accepts

const OK_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']

export function fileProblem(file) {
  if (!file) return 'No file.'
  if (!OK_TYPES.includes(file.type)) return 'PNG, JPEG, WebP, GIF or AVIF.'
  if (file.size > MAX_SOURCE_BYTES) return 'That image is larger than 12 MB.'
  return null
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image this browser can read.')) }
    img.src = url
  })
}

const canEncode = (type) => {
  try {
    const c = document.createElement('canvas')
    c.width = 1; c.height = 1
    return c.toDataURL(type).startsWith(`data:${type}`)
  } catch { return false }
}

/**
 * Square, scaled, compressed. Returns { blob, type, url, width } where `url` is
 * an object URL for previewing; the caller revokes it when done.
 *
 * Quality steps down rather than being fixed, because the size cap matters more
 * than the last few percent of fidelity at 400 pixels, and a screenshot full of
 * text compresses far worse than a photograph.
 */
export async function squareImage(file, size = OUTPUT_SIZE) {
  const problem = fileProblem(file)
  if (problem) throw new Error(problem)

  const img = await loadImage(file)
  const side = Math.min(img.naturalWidth, img.naturalHeight)
  if (!side) throw new Error('That image has no size.')

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(
    img,
    Math.round((img.naturalWidth - side) / 2), Math.round((img.naturalHeight - side) / 2), side, side,
    0, 0, size, size,
  )

  const type = canEncode('image/webp') ? 'image/webp' : 'image/jpeg'
  let blob = null
  for (const quality of [0.86, 0.75, 0.62, 0.5]) {
    blob = await new Promise((r) => canvas.toBlob(r, type, quality))
    if (blob && blob.size <= MAX_UPLOAD_BYTES) break
  }
  if (!blob) throw new Error('This browser could not encode the image.')
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error('That image is too detailed to compress. Try a simpler one.')

  return { blob, type, url: URL.createObjectURL(blob), width: size }
}

/**
 * Send it. The endpoint stores the bytes under their own hash, so uploading the
 * same picture twice costs one upload and returns the same URL.
 *
 * A 501 means no blob store is connected to the deployment yet. That is a
 * configuration state rather than a failure, so it is reported as one and the
 * caller offers the paste-a-link path instead.
 */
export class NoStoreError extends Error {
  constructor(message) { super(message); this.name = 'NoStoreError' }
}

export async function uploadImage(blob, { kind = 'pfp' } = {}) {
  const r = await fetch(`/api/upload?kind=${encodeURIComponent(kind)}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  })
  let body = null
  try { body = await r.json() } catch { /* fall through to status */ }
  if (r.status === 501) throw new NoStoreError(body?.error || 'Uploads are not switched on for this site yet.')
  if (!r.ok || !body?.ok) throw new Error(body?.error || `Upload failed (${r.status}).`)
  return body.url
}

/** Crop, compress and upload in one step. Returns the stored URL. */
export async function processAndUpload(file, opts) {
  const { blob, url } = await squareImage(file)
  try {
    return await uploadImage(blob, opts)
  } finally {
    URL.revokeObjectURL(url)
  }
}
