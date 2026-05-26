export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { name, yourTwitter, projectName, projectTwitter, projectWebsite, founderDetails, yourRelationship } = req.body

  if (!name || !projectName) return res.status(400).json({ error: 'Name and project name are required' })

  const apiKey = process.env.AIRTABLE_API_KEY
  const baseId = process.env.AIRTABLE_BASE_ID

  try {
    const response = await fetch(`https://api.airtable.com/v0/${baseId}/Project%20Suggestions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          Name: name,
          'Your Twitter': yourTwitter || '',
          'Project Name': projectName,
          'Project Twitter': projectTwitter || '',
          'Project Website': projectWebsite || '',
          'Founder Details': founderDetails || '',
          'Your Relationship': yourRelationship || '',
          Status: 'Pending',
        }
      })
    })

    if (!response.ok) {
      const err = await response.json()
      return res.status(500).json({ error: err.error?.message || 'Airtable error' })
    }

    return res.status(200).json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
