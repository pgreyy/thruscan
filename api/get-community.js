export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const apiKey = process.env.AIRTABLE_API_KEY
  const baseId = process.env.AIRTABLE_BASE_ID

  try {
    const response = await fetch(
      `https://api.airtable.com/v0/${baseId}/Community%20Submissions?filterByFormula={Status}='Approved'&sort[0][field]=Submitted%20At&sort[0][direction]=desc`,
      {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      }
    )

    if (!response.ok) {
      const err = await response.json()
      return res.status(500).json({ error: err.error?.message || 'Airtable error' })
    }

    const data = await response.json()
    const records = data.records.map(r => ({
      id: r.id,
      name: r.fields['Name'] || '',
      twitter: r.fields['Your Twitter'] || '',
      title: r.fields['Content Title'] || '',
      link: r.fields['Content Link'] || '',
      description: r.fields['Description'] || '',
      type: r.fields['Content Type'] || '',
      submittedAt: r.fields['Submitted At'] || '',
    }))

    return res.status(200).json({ records })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
