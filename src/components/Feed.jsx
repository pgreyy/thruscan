// src/components/Feed.jsx
//
// What is happening on the chain, everyone's, newest first, as a transaction
// table: Event | Detail | Txn hash | From | To | Amount | Txn fee | Time.
//
// This reads the indexer rather than the chain, which is the whole reason it
// can exist. A feed built on direct chain reads would have to fetch and decode
// every transaction on every page load, and the page would sit there saying
// "reading the chain" for as long as that took. What the indexer does not hold,
// the token amounts, is read afterwards for the rows that need it, and kept.
//
// Also used for one wallet, by passing `address`, which is the same query with
// a join.
//
// One row of markup serves two layouts. Wide, it is a table row. Narrow, the
// same cells are regrouped into two lines (see the media query in
// feed-table.css), which is why the cells are named by what they hold rather
// than by where they sit.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  fetchFeed, toneOf, shortId, KIND_GROUPS,
  detailOf, targetOf, amountsOf, primaryAmount, feeOf, wantsEvents, loadEvents, eventsReady, loadNames,
} from '../lib/feed.js'
import './feed-table.css'

/* Relative time from the block's own nanoseconds. Kept short on purpose: this
   column sits next to seven others and a full date in each would be noise. */
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

/* The word in the Event column. The kind is already a word, so this mostly
   capitalises it; the few that differ are the ones whose internal name would
   read oddly in a table. */
const EVENT_WORD = {
  pad: 'Pad', launch: 'Launch', buy: 'Buy', sell: 'Sell', claim: 'Claim',
  graduate: 'Graduate', migrate: 'Migrate', swap: 'Swap',
  pool: 'Pool', liquidity: 'Liquidity', nft: 'NFT', name: 'Name',
  wall: 'Post', mint: 'Mint', burn: 'Burn', transfer: 'Transfer',
  faucet: 'Faucet', token: 'Token', account: 'Account',
  bundle: 'Bundle', oracle: 'Oracle', noop: 'Idle', other: 'Call',
}

/* A click on a link or a button inside a row is that link's, not the row's. */
const stop = (e) => e.stopPropagation()

function CopyHash({ value }) {
  const [done, setDone] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async (e) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(value)
      setDone(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setDone(false), 1400)
    } catch { /* the clipboard is not always there; the hash is still a link */ }
  }
  return (
    <button type="button" className={`act-copy${done ? ' done' : ''}`} onClick={copy} aria-label={done ? 'Copied' : 'Copy transaction hash'} title={done ? 'Copied' : 'Copy hash'}>
      {done
        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
        : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" /></svg>}
    </button>
  )
}

/* A wallet: its registered name when it has one, otherwise the short address.
   Beside the address the full one is in the tooltip. */
function Party({ address, names }) {
  if (!address) return <span className="act-none">–</span>
  const name = names.get(address)
  return (
    <Link to={`/account/${address}`} className={name ? 'act-name' : 'mono'} title={name ? `${name} · ${address}` : address} onClick={stop}>
      {name ?? shortId(address)}
    </Link>
  )
}

function Target({ target, names }) {
  if (target.wallet) return <Party address={target.address} names={names} />
  return (
    <Link to={`/account/${target.address}`} className={target.mono ? 'mono' : 'act-prog'} title={target.address} onClick={stop}>
      {target.label}
    </Link>
  )
}

function Row({ item, names, extra }) {
  const navigate = useNavigate()
  const target = targetOf(item, extra)
  const amounts = amountsOf(item, extra)
  const lead = primaryAmount(amounts)
  const fee = feeOf(item)
  const detail = detailOf(item)
  /* Amounts that still need the chain's token events are a short grey bar,
     not a dash: a dash would say "nothing moved" before anybody knows. */
  const pending = item.ok && wantsEvents(item) && !eventsReady(item.signature)
  const tone = toneOf(item)

  const open = () => {
    if (window.getSelection?.().toString()) return   // somebody was selecting text
    navigate(`/tx/${item.signature}`)
  }

  return (
    <div role="row" className={`act-tr${item.ok ? '' : ' failed'}`} onClick={open}>
      <div className="act-l1">
        <span role="cell" className="act-event">
          <span className={`feed-tag feed-${tone}`}>{EVENT_WORD[item.kind] ?? item.kind}</span>
          {!item.ok && <span className="feed-failed">Failed</span>}
        </span>
        <span role="cell" className="act-detail" title={detail}>{detail}</span>
        <span role="cell" className="act-hash">
          <Link to={`/tx/${item.signature}`} className="mono" title={item.signature} onClick={stop}>{item.signature.slice(0, 6)}…{item.signature.slice(-4)}</Link>
          <CopyHash value={item.signature} />
        </span>
        <span role="cell" className="act-time">{when(item.time) || '—'}</span>
      </div>
      <div className="act-l2">
        <span role="presentation" className="act-route">
          <span role="cell" className="act-from"><Party address={item.who} names={names} /></span>
          <span className="act-arrow" aria-hidden="true">→</span>
          <span role="cell" className="act-to"><Target target={target} names={names} /></span>
        </span>
        <span role="cell" className="act-amount">
          {pending
            ? <i className="act-pending" aria-label="Reading amounts" />
            : amounts.length === 0
              ? <span className="act-none">–</span>
              : (
                <>
                  {/* Wide: every figure. Narrow: the one that matters. */}
                  <span className="act-amounts-all">
                    {amounts.slice(0, 2).map((a) => <span key={a.label} className={a.delta > 0 ? 'act-in' : 'act-out'}>{a.text}</span>)}
                  </span>
                  <span className={`act-amount-lead ${lead.delta > 0 ? 'act-in' : 'act-out'}`}>{lead.text}</span>
                </>
              )}
        </span>
        <span role="cell" className="act-fee" title={fee ? 'Fee paid by the sender' : 'Not recorded for this transaction'}>
          {fee ?? <span className="act-none">–</span>}
        </span>
      </div>
    </div>
  )
}

function SkeletonRows({ n = 6 }) {
  return Array.from({ length: n }, (_, i) => (
    <div key={i} className="act-tr skel" aria-hidden="true">
      <div className="act-l1">
        <span className="act-event"><i /></span><span className="act-detail"><i /></span>
        <span className="act-hash"><i /></span><span className="act-time"><i /></span>
      </div>
      <div className="act-l2">
        <span className="act-route"><span className="act-from"><i /></span><span className="act-to"><i /></span></span>
        <span className="act-amount"><i /></span><span className="act-fee"><i /></span>
      </div>
    </div>
  ))
}

export function Feed({ address = null, title = 'Activity', limit = 30, showFilters = true }) {
  const [group, setGroup] = useState('all')
  const [items, setItems] = useState([])
  const [next, setNext] = useState(null)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState(null)
  const [detail, setDetail] = useState(null)
  const [names, setNames] = useState(() => new Map())
  const [extra, setExtra] = useState(null)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    const r = await fetchFeed({ group, address, limit })
    /* A failed poll leaves the rows that are already there. An empty list
       where a list was is worse than a list a few seconds old. */
    if (quiet && r.problem) { setLoading(false); return }
    setItems(r.items)
    setNext(r.next)
    setProblem(r.problem)
    setDetail(r.detail ?? null)
    setLoading(false)
  }, [group, address, limit])

  useEffect(() => { load() }, [load])

  /* Keeps itself current rather than offering a Refresh button. Quiet, so the
     list does not blank out every few seconds, and paused while the tab is
     hidden. */
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) load(true) }, 10000)
    return () => clearInterval(id)
  }, [load])

  /* Names, once and then each minute. Rows do not wait for them. */
  useEffect(() => {
    let alive = true
    const read = () => loadNames().then((m) => { if (alive) setNames(m) })
    read()
    const id = setInterval(read, 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  /* Token amounts for the rows that move tokens, only for signatures not
     already asked about, so the ten-second refresh costs nothing once a page
     is warm. */
  useEffect(() => {
    const sigs = items.filter(wantsEvents).map((i) => i.signature)
    if (!sigs.length) return undefined
    let alive = true
    loadEvents(sigs).then((store) => { if (alive) setExtra({ ...store }) })
    return () => { alive = false }
  }, [items])

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
    <section className="act-panel">
      <div className="act-top">
        <h2 className="act-title">{title}</h2>
        {showFilters && (
          <div className="feed-filters act-filters" role="tablist" aria-label="Filter activity">
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
      </div>

      <div role="table" aria-label={title} className="act-table">
        <div role="row" className="act-tr act-head">
          <div className="act-l1">
            <span role="columnheader" className="act-event">Event</span>
            <span role="columnheader" className="act-detail">Detail</span>
            <span role="columnheader" className="act-hash">Txn hash</span>
            <span role="columnheader" className="act-time">Time</span>
          </div>
          <div className="act-l2">
            <span role="presentation" className="act-route">
              <span role="columnheader" className="act-from">From</span>
              <span role="columnheader" className="act-to">To</span>
            </span>
            <span role="columnheader" className="act-amount">Amount</span>
            <span role="columnheader" className="act-fee">Txn fee</span>
          </div>
        </div>

        {items.length === 0 && loading && <SkeletonRows />}

        {items.length === 0 && !loading && (
          <div className={`act-note${problem ? ' bad' : ''}`} title={problem && problem !== 'offline' ? detail ?? undefined : undefined}>
            {emptyMessage(problem, group)}
          </div>
        )}

        {items.map((i) => <Row key={i.signature} item={i} names={names} extra={extra} />)}
      </div>

      {next && (
        <button className="btn ghost feed-more act-more" onClick={more} disabled={loading}>
          {loading ? 'Loading' : 'Show older'}
        </button>
      )}
    </section>
  )
}

export default Feed
