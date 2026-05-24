export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { tagName, publishedAt, releaseName } = req.body

  if (!tagName) {
    return res.status(400).json({ error: 'Missing tagName' })
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' })
  }

  const prompt = `You are a blockchain analyst writing for a non-technical Web3 audience. 

Thru is a new Layer 1 blockchain built by Unto Labs, founded by former Solana and Ethereum core engineers. It uses ThruVM — a virtual machine built on RISC-V architecture — and features passkey-based embedded wallets with no seed phrases required.

A new release was published:
- Version: ${tagName}
- Release name: ${releaseName || tagName}
- Published: ${new Date(publishedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}

Write a 2-3 sentence plain English summary of what this release likely means for the Thru network. Focus on what developers and users should know. Be concise, honest about uncertainty, and avoid hype. Do not use bullet points.`

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.7,
      }),
    })

    if (!response.ok) {
      const err = await response.json()
      return res.status(500).json({ error: err.error?.message || 'OpenAI error' })
    }

    const data = await response.json()
    const summary = data.choices?.[0]?.message?.content?.trim()
    return res.status(200).json({ summary })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
