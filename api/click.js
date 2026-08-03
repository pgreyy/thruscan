// api/click.js
//
// Counts opens, which is what pushes unpinned items up the feed.
//
// Airtable has no atomic increment, so this reads then writes. Two clicks in
// the same instant can lose one, which does not matter for ranking — the
// ordering only needs to be roughly right, not exact.
//
// POST /api/click  { id }

export const config = { runtime: 'nodejs' }

const TABLE = 'Community Submissions'
const AIRTABLE_API = 'https://api.airtable.com/v0'

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') return res.status(405).send(JSON.stringify({ ok: false }))

  const { AIRTABLE_API_KEY, AIRTABLE_BASE_ID } = process.env
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return res.status(503).send(JSON.stringify({ ok: false }))

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}
  const id = body.id
  if (!id || typeof id !== 'string' || !id.startsWith('rec')) {
    return res.status(400).send(JSON.stringify({ ok: false }))
  }

  const headers = {
    Authorization: `Bearer ${AIRTABLE_API_KEY}`,
    'Content-Type': 'application/json',
  }

  try {
    const base = `${AIRTABLE_API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}/${id}`

    const current = await fetch(base, { headers })
    if (!current.ok) return res.status(404).send(JSON.stringify({ ok: false }))

    const record = await current.json()
    const clicks = Number(record.fields?.Clicks ?? 0) + 1

    await fetch(base, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ fields: { Clicks: clicks } }),
    })

    return res.status(200).send(JSON.stringify({ ok: true, clicks }))
  } catch {
    // Never let a counting failure block the reader; the link opens regardless.
    return res.status(200).send(JSON.stringify({ ok: false }))
  }
}
