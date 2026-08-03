// api/get-content.js
//
// Serves the Community page as a single ranked feed.
//
// Ranking, in order:
//   1. Pinned items, newest first — your editorial picks
//   2. Everything else by click count, so what readers actually open rises
//   3. Ties broken by recency, so new items are not buried at zero clicks
//
// Expected fields in Community Submissions:
//   Name, Your Twitter, Content Title, Content Link, Content Type,
//   Description, Image, Status, Pinned (checkbox), Clicks (number),
//   Submitted At

export const config = { runtime: 'nodejs' }

const TABLE = 'Community Submissions'
const AIRTABLE_API = 'https://api.airtable.com/v0'

function json(res, status, body, cacheSeconds = 0) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader(
    'Cache-Control',
    cacheSeconds > 0
      ? `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 4}`
      : 'no-store'
  )
  res.status(status).send(JSON.stringify(body))
}

export default async function handler(req, res) {
  const { AIRTABLE_API_KEY, AIRTABLE_BASE_ID } = process.env
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return json(res, 503, { ok: false, error: 'not configured' })
  }

  try {
    const url = new URL(`${AIRTABLE_API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}`)
    url.searchParams.set('filterByFormula', "{Status} = 'Approved'")
    url.searchParams.set('pageSize', '100')

    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    })

    if (!r.ok) {
      const detail = await r.text().catch(() => '')
      return json(res, 502, { ok: false, error: `Airtable ${r.status}: ${detail.slice(0, 200)}` })
    }

    const data = await r.json()

    const items = (data.records ?? [])
      .map((rec) => {
        const f = rec.fields ?? {}
        return {
          id: rec.id,
          title: f['Content Title'] ?? '',
          link: f['Content Link'] ?? '',
          type: f['Content Type'] ?? 'Other',
          description: f['Description'] ?? '',
          author: f['Name'] ?? '',
          twitter: (f['Your Twitter'] ?? '').replace(/^@/, ''),
          image: f['Image'] ?? null,
          pinned: Boolean(f['Pinned']),
          clicks: Number(f['Clicks'] ?? 0),
          submittedAt: f['Submitted At'] ?? null,
        }
      })
      // A row with no link renders as nothing useful, and blank rows are what
      // a half-failed write leaves behind.
      .filter((i) => i.link && i.title)

    const time = (i) => (i.submittedAt ? new Date(i.submittedAt).getTime() : 0)

    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if (a.pinned && b.pinned) return time(b) - time(a)
      if (b.clicks !== a.clicks) return b.clicks - a.clicks
      return time(b) - time(a)
    })

    return json(res, 200, { ok: true, items }, 60)
  } catch {
    return json(res, 502, { ok: false, error: 'could not read the list' })
  }
}
