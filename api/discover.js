// api/discover.js
//
// Finds people writing about Thru and queues it for your approval.
//
// Runs on a schedule, pulls from sources that need no paid API key, asks a
// model whether each result is genuinely about the Thru L1, and writes the
// plausible ones into an Airtable table called Discoveries with status
// "pending". Nothing reaches the Community page without you approving it.
//
// The hard part is not finding things, it is that "thru" is an ordinary
// English word. A search for it returns drive-thru menus and walk-thru videos
// forever. So retrieval uses only distinctive phrases, and a model then makes
// the actual relevance call. Anything it is unsure about is dropped rather
// than shown to you, because a noisy queue stops getting checked.
//
// Environment variables:
//   OPENAI_API_KEY      already set for the release summaries
//   AIRTABLE_API_KEY    already set for the submission forms
//   AIRTABLE_BASE_ID    already set
//   DISCOVER_SECRET     any random string; required to trigger this by hand
//   YOUTUBE_API_KEY     optional, adds YouTube results
//
// Schedule it by adding this to vercel.json:
//   { "crons": [{ "path": "/api/discover", "schedule": "0 7 * * *" }] }

export const config = { runtime: 'nodejs', maxDuration: 60 }

const TABLE = 'Discoveries'
const AIRTABLE_API = 'https://api.airtable.com/v0'

// Only phrases that are distinctive enough to be worth searching. Plain "thru"
// is deliberately absent — it would swamp everything else.
const QUERIES = [
  'Unto Labs',
  'ThruVM',
  'Thru alphanet',
  'Thru blockchain RISC-V',
  'thru.org alphanet',
]

const MODEL = 'gpt-4o-mini'
const CONFIDENCE_FLOOR = 0.6
const MAX_CANDIDATES = 40

/* ---------- sources ---------- */

async function safeJson(url, options) {
  try {
    const res = await fetch(url, {
      ...options,
      headers: { 'User-Agent': 'ThruScan/1.0 (community discovery)', ...(options?.headers ?? {}) },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function safeText(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'ThruScan/1.0 (community discovery)' } })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

// Google News RSS. Free, no key, and it indexes most crypto publications and
// personal blogs, which covers the article case without needing a feed list.
async function fromGoogleNews(query) {
  const xml = await safeText(
    `https://news.google.com/rss/search?q=${encodeURIComponent(`"${query}"`)}&hl=en-US&gl=US&ceid=US:en`
  )
  if (!xml) return []

  const items = []
  for (const block of xml.split('<item>').slice(1, 11)) {
    const title = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1]
    const link = block.match(/<link>(.*?)<\/link>/s)?.[1]
    const date = block.match(/<pubDate>(.*?)<\/pubDate>/s)?.[1]
    const source = block.match(/<source[^>]*>(.*?)<\/source>/s)?.[1]
    if (title && link) {
      items.push({ title: decodeEntities(title), link, source: source ?? 'News', publishedAt: date ?? null, kind: 'Article' })
    }
  }
  return items
}

// Hacker News via Algolia. Free, no key, and good at surfacing technical
// discussion that never reaches news aggregators.
async function fromHackerNews(query) {
  const data = await safeJson(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=(story,comment)&hitsPerPage=8`
  )
  if (!data?.hits) return []

  return data.hits
    .filter((h) => h.url || h.objectID)
    .map((h) => ({
      title: h.title || h.story_title || (h.comment_text ?? '').slice(0, 90),
      link: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      source: 'Hacker News',
      publishedAt: h.created_at ?? null,
      kind: 'Thread',
    }))
}

async function fromReddit(query) {
  const data = await safeJson(
    `https://www.reddit.com/search.json?q=${encodeURIComponent(`"${query}"`)}&sort=new&limit=8`
  )
  if (!data?.data?.children) return []

  return data.data.children.map(({ data: p }) => ({
    title: p.title,
    link: `https://reddit.com${p.permalink}`,
    source: `r/${p.subreddit}`,
    publishedAt: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
    kind: 'Thread',
  }))
}

// Repos and tools built on Thru. Unauthenticated GitHub search is rate limited
// but this runs once a day, so it fits comfortably.
async function fromGitHub(query) {
  const data = await safeJson(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&per_page=8`,
    { headers: { Accept: 'application/vnd.github+json' } }
  )
  if (!data?.items) return []

  return data.items
    .filter((r) => r.full_name !== 'Unto-Labs/thru')
    .map((r) => ({
      title: r.full_name,
      link: r.html_url,
      source: 'GitHub',
      publishedAt: r.updated_at ?? null,
      kind: 'Tool',
      extra: r.description ?? '',
    }))
}

async function fromYouTube(query) {
  const key = process.env.YOUTUBE_API_KEY
  if (!key) return []

  const data = await safeJson(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=6&q=${encodeURIComponent(query)}&key=${key}`
  )
  if (!data?.items) return []

  return data.items.map((v) => ({
    title: v.snippet.title,
    link: `https://youtube.com/watch?v=${v.id.videoId}`,
    source: v.snippet.channelTitle,
    publishedAt: v.snippet.publishedAt ?? null,
    kind: 'Video',
    extra: v.snippet.description ?? '',
  }))
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/* ---------- airtable ---------- */

function airtableHeaders() {
  return {
    Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
    'Content-Type': 'application/json',
  }
}

/** Every link already seen, approved or rejected, so nothing comes back twice. */
async function fetchSeenLinks() {
  const seen = new Set()
  let offset

  do {
    const url = new URL(`${AIRTABLE_API}/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}`)
    url.searchParams.set('pageSize', '100')
    url.searchParams.set('fields[]', 'Link')
    if (offset) url.searchParams.set('offset', offset)

    const data = await safeJson(url.toString(), { headers: airtableHeaders() })
    if (!data?.records) break

    for (const r of data.records) if (r.fields?.Link) seen.add(r.fields.Link)
    offset = data.offset
  } while (offset)

  return seen
}

async function insertDiscoveries(rows) {
  const errors = []

  // Airtable caps creates at 10 per request. Airtable rejects the whole batch
  // if a single field name does not match, so failures are reported rather
  // than swallowed — otherwise a typo looks like a successful empty run.
  for (let i = 0; i < rows.length; i += 10) {
    const res = await fetch(`${AIRTABLE_API}/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}`, {
      method: 'POST',
      headers: airtableHeaders(),
      body: JSON.stringify({ records: rows.slice(i, i + 10).map((fields) => ({ fields })) }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      errors.push(`${res.status}: ${detail.slice(0, 300)}`)
    }
  }

  return errors
}

/* ---------- classification ---------- */

const SYSTEM_PROMPT = `You screen content for ThruScan, a community explorer for Thru.

Thru is a Layer 1 blockchain by Unto Labs. It runs ThruVM on the RISC-V instruction set, has passkey-based embedded wallets and a managed fee-payer model, and is currently in alphanet with no token. Its founders are Liam Heeger and Will Yoo.

You will be given candidate items found by keyword search. Most are false positives, because "thru" is a common English word and "Unto Labs" can match unrelated companies. Be strict.

Mark an item relevant ONLY if it is substantively about this specific blockchain. Not relevant: anything using "thru" as a spelling of "through", drive-thru or walk-thru content, unrelated companies, price speculation with no substance, airdrop farming posts, and pure marketing copy.

Judge worth by whether a developer or curious reader would learn something.

Reply with JSON only, no markdown fences:
{"relevant": true|false, "confidence": 0.0-1.0, "type": "Article"|"Thread"|"Video"|"Tool"|"Other", "summary": "one sentence, max 25 words, plain language", "reason": "one short sentence explaining your call"}`

async function classify(item) {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Title: ${item.title}\nSource: ${item.source}\nURL: ${item.link}\n${item.extra ? `Description: ${item.extra.slice(0, 400)}` : ''}`,
          },
        ],
      }),
    })

    const data = await res.json()
    const raw = data?.choices?.[0]?.message?.content
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/* ---------- handler ---------- */

export default async function handler(req, res) {
  const secret = req.query?.secret ?? req.headers['x-discover-secret']
  const fromCron = Boolean(req.headers['x-vercel-cron'])

  // Vercel's own cron requests are trusted; anything else needs the secret, so
  // a stranger cannot run up your OpenAI bill by hitting the URL.
  if (!fromCron && secret !== process.env.DISCOVER_SECRET) {
    res.status(401).send(JSON.stringify({ ok: false, error: 'unauthorized' }))
    return
  }

  if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID || !process.env.OPENAI_API_KEY) {
    res.status(503).send(JSON.stringify({ ok: false, error: 'missing configuration' }))
    return
  }

  const seen = await fetchSeenLinks()

  // Gather everything first, then dedupe by URL, so one item found by three
  // sources is classified once rather than three times.
  const found = []
  for (const query of QUERIES) {
    const batches = await Promise.all([
      fromGoogleNews(query),
      fromHackerNews(query),
      fromReddit(query),
      fromGitHub(query),
      fromYouTube(query),
    ])
    for (const batch of batches) found.push(...batch)
  }

  const byLink = new Map()
  for (const item of found) {
    if (!item.link || seen.has(item.link) || byLink.has(item.link)) continue
    byLink.set(item.link, item)
  }

  const candidates = [...byLink.values()].slice(0, MAX_CANDIDATES)

  const queued = []
  let dropped = 0

  for (const item of candidates) {
    const verdict = await classify(item)
    if (!verdict) continue

    // Below the floor it never reaches you. A queue full of drive-thru videos
    // is a queue nobody opens.
    if (!verdict.relevant || (verdict.confidence ?? 0) < CONFIDENCE_FLOOR) {
      dropped++
      continue
    }

    queued.push({
      Title: item.title.slice(0, 250),
      Link: item.link,
      Source: item.source ?? '',
      Type: verdict.type ?? item.kind ?? 'Other',
      Summary: verdict.summary ?? '',
      Reason: verdict.reason ?? '',
      Confidence: Number(verdict.confidence ?? 0),
      Status: 'pending',
      FoundAt: new Date().toISOString(),
    })
  }

  const writeErrors = queued.length > 0 ? await insertDiscoveries(queued) : []

  res.setHeader('Content-Type', 'application/json')
  res.status(200).send(
    JSON.stringify({
      ok: true,
      scanned: found.length,
      unique: byLink.size,
      classified: candidates.length,
      queued: queued.length,
      dropped,
      // Non-empty means nothing reached Airtable, whatever the queued count says.
      writeErrors,
    })
  )
}
