// src/components/Feed.jsx
//
// What is happening on the chain, everyone's, newest first.
//
// This reads the indexer rather than the chain, which is the whole reason it
// can exist. A feed built on direct chain reads would have to fetch and decode
// every transaction on every page load, and the page would sit there saying
// "reading the chain" for as long as that took.
//
// Also used for one wallet, by passing `address`, which is the same query with
// a join.

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchFeed, toneOf, shortId, KIND_GROUPS } from '../lib/feed.js'

/* Relative time from the block's own nanoseconds. Kept short on purpose: this
   column sits next to twenty others and a full date in each would be noise. */
function when(ns) {
  if (!ns) return ''
  const ms = Number(BigInt(ns) / 1000000n)
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/* What to say when there is nothing.
 *
 * Empty and broken look identical from here and only one of them is worth
 * anybody's attention, so they get different words. Nothing about the indexer
 * appears in any of them: the feed reads the chain directly when there is no
 * indexer behind it, so an empty list means the chain is quiet, which on a
 * freshly reset network it genuinely is. */
function emptyMessage(problem, group) {
  switch (problem) {
    case 'offline':
      return 'Could not reach the site. Check your connection and try again.'
    case 'error':
    case 'unreadable':
      return 'The chain is not answering right now.'
    default:
      return group === 'all' ? 'Nothing has happened on chain yet.' : 'Nothing of this kind yet.'
  }
}

export function Feed({ address = null, title = 'Activity', limit = 30, showFilters = true, compact = false }) {
  const [group, setGroup] = useState('all')
  const [items, setItems] = useState([])
  const [next, setNext] = useState(null)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState(null)
  const [detail, setDetail] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await fetchFeed({ group, address, limit })
    setItems(r.items)
    setNext(r.next)
    setProblem(r.problem)
    setDetail(r.detail ?? null)
    setLoading(false)
  }, [group, address, limit])

  useEffect(() => { load() }, [load])

  const more = async () => {
    if (!next) return
    setLoading(true)
    const r = await fetchFeed({ group, address, before: next, limit })
    setItems((old) => {
      const seen = new Set(old.map((i) => i.signature))
      return [...old, ...r.items.filter((i) => !seen.has(i.signature))]
    })
    setNext(r.next)
    setLoading(false)
  }

  return (
    <section className={compact ? 'card feed-card feed-compact' : 'card feed-card'}>
      <div className="card-head">
        <h2 className="h2">{title}</h2>
        <button className="btn ghost" onClick={load} disabled={loading}>
          {loading ? 'Loading' : 'Refresh'}
        </button>
      </div>

      {showFilters && (
        <div className="feed-filters" role="tablist" aria-label="Filter activity">
          {KIND_GROUPS.map((g) => (
            <button
              key={g.id}
              role="tab"
              aria-selected={group === g.id}
              className={group === g.id ? 'feed-chip on' : 'feed-chip'}
              onClick={() => setGroup(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>
      )}

      {items.length === 0 && (
        <p className="fine feed-empty">
          {loading ? 'Loading.' : emptyMessage(problem, group)}
          {!loading && detail && problem && problem !== 'offline' && (
            <span className="feed-detail">{detail}</span>
          )}
        </p>
      )}

      {items.length > 0 && (
        <ol className="feed">
          {items.map((i) => (
            <li className="feed-row" key={i.signature}>
              <span className={`feed-dot feed-${toneOf(i)}`} aria-hidden="true" />
              <Link className="feed-what" to={`/tx/${i.signature}`}>
                <b>{i.label}</b>
                {!i.ok && <span className="feed-failed">failed</span>}
              </Link>
              <Link className="feed-who mono fine" to={`/account/${i.who}`}>{shortId(i.who)}</Link>
              <span className="feed-when fine" title={`slot ${i.slot}`}>{when(i.time) || `#${i.slot}`}</span>
            </li>
          ))}
        </ol>
      )}

      {next && (
        <button className="btn ghost feed-more" onClick={more} disabled={loading}>
          {loading ? 'Loading' : 'Show older'}
        </button>
      )}
    </section>
  )
}

export default Feed
