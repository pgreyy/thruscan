// api/get-content.js
//
// Serves the Community page. Reads approved items from Community Submissions
// and splits them into two lists: featured, and everyone else.
//
// This replaces the older get-community endpoint for the page's own reads,
// mostly so the field names live in one file you can see rather than being
// split across two that disagree with each other.
//
// Expected fields in Community Submissions:
//   Name, Your Twitter, Content Title, Content Link, Content Type,
//   Description, Status, Featured (checkbox), Submitted At

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
    url.searchParams.set('sort[0][field]', 'Submitted At')
    url.searchParams.set('sort[0][direction]', 'desc')

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
          featured: Boolean(f['Featured']),
        }
      })
      // A row with no link cannot be rendered as anything useful, and blank
      // rows are what a half-failed write leaves behind.
      .filter((i) => i.link && i.title)

    return json(
      res,
      200,
      {
        ok: true,
        featured: items.filter((i) => i.featured),
        community: items.filter((i) => !i.featured),
      },
      60
    )
  } catch {
    return json(res, 502, { ok: false, error: 'could not read the list' })
  }
}
