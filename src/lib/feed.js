// src/lib/feed.js
//
// Reading activity from the indexer.
//
// The difference from src/lib/activity.js is where the work happens. That one
// asks the chain for an account's transactions and decodes each of them in the
// browser, every time a page loads. This asks for rows that were decoded once,
// when they happened, and never again.
//
// The endpoint answers with an empty list and a reason when there is no
// indexer behind it, rather than an error, so a page can say something true
// instead of spinning.

const KIND_GROUPS = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'launch', label: 'Launches', kinds: ['launch'] },
  { id: 'trade', label: 'Trades', kinds: ['buy', 'sell', 'swap'] },
  { id: 'nft', label: 'NFTs', kinds: ['nft'] },
  { id: 'token', label: 'Tokens', kinds: ['token', 'mint', 'transfer', 'burn'] },
  { id: 'name', label: 'Names', kinds: ['name'] },
]

export { KIND_GROUPS }

/**
 * One page of activity.
 *
 * `kind` takes a single kind, because that is what the endpoint filters on. A
 * group covering several kinds is filtered here instead, which is honest about
 * the cost: it fetches a page and keeps part of it. Worth it for now, and the
 * right fix later is for the endpoint to take a list.
 */
export async function fetchFeed({ group = 'all', address = null, before = null, limit = 50 } = {}) {
  const g = KIND_GROUPS.find((x) => x.id === group) ?? KIND_GROUPS[0]
  const single = g.kinds && g.kinds.length === 1 ? g.kinds[0] : null

  const q = new URLSearchParams()
  if (single) q.set('kind', single)
  if (address) q.set('address', address)
  if (before) q.set('before', before)
  q.set('limit', String(limit))

  let r
  try {
    r = await fetch(`/api/activity?${q}`)
  } catch (e) {
    return { items: [], next: null, problem: 'offline', detail: String(e?.message ?? e) }
  }

  let body
  try {
    body = await r.json()
  } catch {
    return { items: [], next: null, problem: 'unreadable', detail: `The server answered ${r.status}.` }
  }

  if (!body.ok) {
    return {
      items: [],
      next: null,
      problem: body.error === 'no activity database' ? 'no-indexer' : 'error',
      detail: body.detail ?? body.error ?? 'Something went wrong.',
    }
  }

  /* A group covering several kinds is narrowed here. `all` keeps everything. */
  const items = g.kinds && g.kinds.length > 1
    ? body.items.filter((i) => g.kinds.includes(i.kind))
    : body.items

  return { items, next: body.next, problem: null, source: body.source }
}

/* The dot beside each row. Kept to three states rather than one colour per
   kind: a wall of colour reads as decoration, and the only distinction that
   changes what somebody does is whether it worked. */
export function toneOf(item) {
  if (!item.ok) return 'bad'
  if (item.kind === 'launch' || item.kind === 'graduate' || item.kind === 'migrate') return 'mark'
  return 'plain'
}

export const shortId = (s) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : '')
