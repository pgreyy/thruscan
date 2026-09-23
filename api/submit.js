// api/submit.js
//
// The two things visitors send in: a project worth listing, and something they
// have written or made about Thru. Both are one POST into an Airtable table
// and wait for approval, so they are one function rather than two.
//
// They were two files, which cost two of the twelve functions a Hobby
// deployment is allowed. That limit is the only reason they are together; if
// they ever need to diverge, splitting them back out is a small change.
//
//   POST /api/submit  { kind: 'project',   name, yourTwitter, projectName, ... }
//   POST /api/submit  { kind: 'community', name, yourTwitter, contentTitle, ... }

const TABLES = {
  project: 'Project%20Suggestions',
  community: 'Community%20Submissions',
}

/** What each kind requires, and how its fields are named in Airtable. */
const SHAPES = {
  project: {
    required: ['name', 'projectName'],
    missing: 'Name and project name are required',
    fields: (b) => ({
      Name: b.name,
      'Your Twitter': b.yourTwitter || '',
      'Project Name': b.projectName,
      'Project Twitter': b.projectTwitter || '',
      'Project Website': b.projectWebsite || '',
      'Founder Details': b.founderDetails || '',
      'Your Relationship': b.yourRelationship || '',
      Status: 'Pending',
    }),
  },
  community: {
    required: ['name', 'contentTitle', 'contentLink'],
    missing: 'Name, title and link are required',
    fields: (b) => ({
      Name: b.name,
      'Your Twitter': b.yourTwitter || '',
      'Content Title': b.contentTitle,
      'Content Link': b.contentLink,
      Description: b.description || '',
      'Content Type': b.contentType || 'Other',
      Status: 'Pending',
    }),
  },
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = null } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Send JSON' })

  const shape = SHAPES[body.kind]
  if (!shape) return res.status(400).json({ error: 'Unknown kind' })
  if (shape.required.some((k) => !body[k])) return res.status(400).json({ error: shape.missing })

  const apiKey = process.env.AIRTABLE_API_KEY
  const baseId = process.env.AIRTABLE_BASE_ID

  try {
    const response = await fetch(`https://api.airtable.com/v0/${baseId}/${TABLES[body.kind]}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: shape.fields(body) }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => null)
      return res.status(500).json({ error: err?.error?.message || 'Airtable error' })
    }
    return res.status(200).json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
