// api/moderate.js
//
// The approval queue behind the discovery agent. Lists what the agent found,
// and lets you approve or reject each item.
//

// Environment variables:
//   MODERATOR_PASSWORD  anything long and random
//   AIRTABLE_API_KEY    already set
//   AIRTABLE_BASE_ID    already set
//
// Actions:
//   GET  /api/moderate?password=...              list pending items
//   POST /api/moderate  { password, id, action: 'approve'|'reject', summary?, type?, pinned? }
//
// Approving writes directly into Community Submissions with status Approved,
// so there is no second approval step inside Airtable. Passing pinned: true
// keeps the item at the top of the feed regardless of how many clicks it has.
//
// Approval also tries to find a header image for the card by reading the
// page's own Open Graph tags, the same way a link preview works anywhere else.

export const config = { runtime: 'nodejs' }

const TABLE = 'Discoveries'
const COMMUNITY_TABLE = 'Community Submissions'
const AIRTABLE_API = 'https://api.airtable.com/v0'

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).send(JSON.stringify(body))
}

function airtableHeaders() {
  return {
    Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
    'Content-Type': 'application/json',
  }
}

/**
 * Compare in a way that does not leak the answer through timing. Overkill for
 * a hobby project, cheap enough to just do.
 */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function listPending() {
  const url = new URL(`${AIRTABLE_API}/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}`)
  url.searchParams.set('filterByFormula', "{Status} = 'pending'")
  url.searchParams.set('pageSize', '50')
  url.searchParams.set('sort[0][field]', 'FoundAt')
  url.searchParams.set('sort[0][direction]', 'desc')

  const res = await fetch(url.toString(), { headers: airtableHeaders() })
  if (!res.ok) {
    // Airtable says exactly what is wrong (unknown field, missing table, bad
    // key). Passing it through beats a generic message you cannot act on.
    const detail = await res.text().catch(() => '')
    throw new Error(`Airtable ${res.status}: ${detail.slice(0, 300)}`)
  }

  const data = await res.json()
  return (data.records ?? []).map((r) => ({
    id: r.id,
    title: r.fields.Title ?? '',
    link: r.fields.Link ?? '',
    source: r.fields.Source ?? '',
    type: r.fields.Type ?? 'Other',
    summary: r.fields.Summary ?? '',
    reason: r.fields.Reason ?? '',
    confidence: r.fields.Confidence ?? 0,
    foundAt: r.fields.FoundAt ?? null,
  }))
}

async function getRecord(id) {
  const res = await fetch(
    `${AIRTABLE_API}/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}/${id}`,
    { headers: airtableHeaders() }
  )
  if (!res.ok) return null
  const data = await res.json()
  return data.fields ?? null
}

async function setStatus(id, status) {
  await fetch(`${AIRTABLE_API}/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}/${id}`, {
    method: 'PATCH',
    headers: airtableHeaders(),
    body: JSON.stringify({ fields: { Status: status, DecidedAt: new Date().toISOString() } }),
  })
}

/**
 * Read a page's Open Graph image so cards can have a header picture instead of
 * being plain text. Returns null on anything unexpected — a missing image is a
 * plainer card, never a failed approval.
 */
async function findHeaderImage(link) {
  if (!link) return null

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)

    const res = await fetch(link, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ThruScan/1.0 (link preview)' },
    })
    clearTimeout(timer)
    if (!res.ok) return null

    // Only the head matters, and some pages are enormous.
    const html = (await res.text()).slice(0, 200000)

    const patterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    ]

    for (const re of patterns) {
      const found = html.match(re)?.[1]
      if (!found) continue

      // Some sites give a path rather than a full URL.
      const absolute = found.startsWith('http') ? found : new URL(found, link).toString()
      if (absolute.length <= 500) return absolute
    }

    return null
  } catch {
    return null
  }
}

export default async function handler(req, res) {
  const password =
    req.method === 'GET'
      ? req.query?.password
      : (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}).password

  if (!process.env.MODERATOR_PASSWORD) {
    return json(res, 503, { ok: false, error: 'moderation is not configured' })
  }
  if (!sameSecret(password ?? '', process.env.MODERATOR_PASSWORD)) {
    return json(res, 401, { ok: false, error: 'wrong password' })
  }

  if (req.method === 'GET') {
    try {
      return json(res, 200, { ok: true, items: await listPending() })
    } catch (err) {
      return json(res, 502, { ok: false, error: err.message || 'could not read the queue' })
    }
  }

  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'use GET or POST' })

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}
  const { id, action, summary, type, pinned } = body

  if (!id || !['approve', 'reject'].includes(action)) {
    return json(res, 400, { ok: false, error: 'need an id and an action' })
  }

  try {
    if (action === 'reject') {
      // Rejected rows stay in the table on purpose. They are what stops the
      // same link reappearing, and they are the raw material for teaching the
      // classifier your taste later on.
      await setStatus(id, 'rejected')
      return json(res, 200, { ok: true, action: 'rejected' })
    }

    const fields = await getRecord(id)
    if (!fields) return json(res, 404, { ok: false, error: 'not found' })

    const image = await findHeaderImage(fields.Link ?? '')

    // Write straight to Airtable rather than bouncing through
    // submit-community. That endpoint hardcodes a Pending status, which would
    // mean approving something here and then approving it again in Airtable.
    const create = await fetch(
      `${AIRTABLE_API}/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(COMMUNITY_TABLE)}`,
      {
        method: 'POST',
        headers: airtableHeaders(),
        body: JSON.stringify({
          fields: {
            Name: fields.Source || 'Discovered',
            'Content Title': fields.Title ?? '',
            'Content Link': fields.Link ?? '',
            'Content Type': type ?? fields.Type ?? 'Other',
            Description: summary ?? fields.Summary ?? '',
            Status: 'Approved',
            Pinned: Boolean(pinned),
            Clicks: 0,
            ...(image ? { Image: image } : {}),
          },
        }),
      }
    )

    if (!create.ok) {
      const detail = await create.text().catch(() => '')
      return json(res, 502, { ok: false, error: `Airtable ${create.status}: ${detail.slice(0, 300)}` })
    }

    await setStatus(id, 'approved')
    return json(res, 200, { ok: true, action: 'approved' })
  } catch {
    return json(res, 502, { ok: false, error: 'that did not go through' })
  }
}
