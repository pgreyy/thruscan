// api/moderate.js
//
// The approval queue behind the discovery agent. Lists what the agent found,
// and lets you approve or reject each item.
//
// Approving does not write to the Community table directly. It posts to the
// existing /api/submit-community endpoint instead, so the Airtable field names
// stay defined in exactly one place and this file never needs to know them.
//
// Environment variables:
//   MODERATOR_PASSWORD  anything long and random
//   AIRTABLE_API_KEY    already set
//   AIRTABLE_BASE_ID    already set
//
// Actions:
//   GET  /api/moderate?password=...              list pending items
//   POST /api/moderate  { password, id, action: 'approve'|'reject', summary?, type? }

export const config = { runtime: 'nodejs' }

const TABLE = 'Discoveries'
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
  const { id, action, summary, type } = body

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

    const origin = `https://${req.headers['x-forwarded-host'] ?? req.headers.host}`
    const submit = await fetch(`${origin}/api/submit-community`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: fields.Source || 'Discovered',
        yourTwitter: '',
        contentTitle: fields.Title ?? '',
        contentLink: fields.Link ?? '',
        description: summary ?? fields.Summary ?? '',
        contentType: type ?? fields.Type ?? 'Other',
      }),
    })

    const result = await submit.json().catch(() => ({}))
    if (!result.success) {
      return json(res, 502, { ok: false, error: 'could not add it to the community list' })
    }

    await setStatus(id, 'approved')
    return json(res, 200, { ok: true, action: 'approved' })
  } catch {
    return json(res, 502, { ok: false, error: 'that did not go through' })
  }
}
