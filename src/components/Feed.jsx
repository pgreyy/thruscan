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

import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  fetchFeed, shortId, KIND_GROUPS,
  detailOf, targetOf, amountsOf, primaryAmount, feeOf, wantsEvents, loadEvents, eventsReady, loadNames,
} from '../lib/feed.js'
import { network } from '../lib/networks.js'
import { relTime, fullUtc, clock, since } from '../lib/when.js'
import { Icon } from './Icon.jsx'
import { EventPill, StatusPill, Amount } from './Pill.jsx'
import './feed-table.css'

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

/* A click on a link or a button inside a row is that link's, not the row's. */
const stop = (e) => e.stopPropagation()

/* A wallet: its .id name when it has one, otherwise the short address, with
   the full address in the tooltip. Names are labels, not verification. */
function Party({ address, names }) {
  if (!address) return <span className="act-none">—</span>
  const name = names.get(address)
  return (
    <Link to={`/account/${address}`} className="mono" title={name ? `${name} · ${address}` : address} onClick={stop}>
      {name ?? shortId(address)}
    </Link>
  )
}

function Target({ target, names }) {
  if (!target.address) return <span className="act-none">—</span>
  if (target.wallet) return <Party address={target.address} names={names} />
  return (
    <Link to={`/account/${target.address}`} className="mono act-prog" title={target.address} onClick={stop}>
      {target.label}
    </Link>
  )
}

function Row({ item, names, extra, now }) {
  const navigate = useNavigate()
  const target = targetOf(item, extra)
  const amounts = amountsOf(item, extra)
  const lead = primaryAmount(amounts)
  const fee = feeOf(item)
  const failure = !item.ok && item.error !== null && item.error !== undefined ? ` · error ${item.error}` : ''
  const detail = detailOf(item) + failure
  /* Amounts that still need the chain's token events are a short grey bar,
     not a dash: a dash would say "nothing moved" before anybody knows. */
  const pending = item.ok && wantsEvents(item) && !eventsReady(item.signature)
  /* A failed transaction moved nothing, so its amount is the same dash as any
     empty cell; the label keeps the meaning for screen readers. */
  const notSent = !item.ok

  const open = () => {
    if (window.getSelection?.().toString()) return   // somebody was selecting text
    navigate(`/tx/${item.signature}`)
  }
  const onKey = (e) => { if (e.key === 'Enter') open() }

  return (
    <div role="row" tabIndex={0} className={`act-tr${item.ok ? '' : ' failed'}`} onClick={open} onKeyDown={onKey}>
      {/* Wide: one cell per column. */}
      <span role="cell" className="act-event">
        <EventPill kind={item.kind} />
        {!item.ok && <StatusPill ok={false} />}
      </span>
      <span role="cell" className="act-detail" title={detail}>{detail}</span>
      <span role="cell" className="act-hash">
        <Link to={`/tx/${item.signature}`} className="mono" title={item.signature} onClick={stop}>{item.signature.slice(0, 4)}…{item.signature.slice(-4)}</Link>
      </span>
      <span role="cell" className="act-from"><Party address={item.who} names={names} /></span>
      <span role="cell" className="act-to"><Target target={target} names={names} /></span>
      <span role="cell" className="act-amount">
        {notSent
          ? <span className="act-none" aria-label="Not sent">—</span>
          : pending
            ? <i className="skel-line" aria-label="Still reading the amount" />
            : amounts.length === 0
              ? <span className="act-none">—</span>
              : amounts.slice(0, 2).map((a) => <Amount key={a.label} delta={a.delta} text={a.text} />)}
      </span>
      <span role="cell" className="act-fee" title={fee ? 'Fee paid by the sender' : 'Not recorded for this transaction'}>
        {fee ?? <span className="act-none">—</span>}
      </span>
      <span role="cell" className="act-time" title={fullUtc(item.time)}>{item.time ? relTime(item.time, now) : '—'}</span>

      {/* Narrow: two lines, and the whole row is the target. */}
      <span className="act-c" aria-hidden="true">
        <span className="act-c1">
          <span className="act-c-what">
            <EventPill kind={item.kind} />
            {!item.ok && <StatusPill ok={false} />}
            <span className="act-c-detail">{detail ? ` · ${detail}` : ''}</span>
          </span>
          <span className="mono dim">{item.time ? relTime(item.time, now) : '—'}</span>
        </span>
        <span className="act-c2">
          <span className="mono act-c-amt">
            {notSent
              ? <span className="act-none">—</span>
              : pending ? <i className="skel-line" /> : lead ? <Amount delta={lead.delta} text={lead.text} /> : <span className="act-none">—</span>}
          </span>
          <span className="mono act-c-hash">{item.signature.slice(0, 4)}…</span>
        </span>
      </span>
    </div>
  )
}

function SkeletonRows({ n = 6 }) {
  return Array.from({ length: n }, (_, i) => (
    <div key={i} className="act-tr act-skel" aria-hidden="true">
      <span className="skel-line" style={{ width: 50 }} />
      <span className="skel-line" style={{ width: '60%' }} />
      <span className="skel-line" style={{ width: 70 }} />
    </div>
  ))
}

const GROUP_NOUN = { launch: 'launch', trade: 'trade', nft: 'NFT', token: 'token', wall: 'Wall', name: 'ThruID' }

/* `embedded` drops the page heading, for the Explorer's Activity tab, which
   has its own. `address` narrows the feed to one wallet. */
export function Feed({ address = null, limit = 30, showFilters = true, embedded = false }) {
  const [group, setGroup] = useState('all')
  const [items, setItems] = useState([])
  const [next, setNext] = useState(null)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState(null)
  const [detail, setDetail] = useState(null)
  const [source, setSource] = useState(null)
  const [names, setNames] = useState(() => new Map())
  const [extra, setExtra] = useState(null)
  const [updatedAt, setUpdatedAt] = useState(null)
  const [pollError, setPollError] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    const r = await fetchFeed({ group, address, limit })
    /* A failed poll leaves the rows that are already there. An empty list
       where a list was is worse than a list a few seconds old; the header
       line says the refresh failed instead. */
    if (quiet && r.problem) { setLoading(false); setPollError(true); return }
    setItems(r.items)
    setNext(r.next)
    setProblem(r.problem)
    setDetail(r.detail ?? null)
    setSource(r.source ?? null)
    setPollError(!!r.problem)
    if (!r.problem) setUpdatedAt(Date.now())
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

  const net = network.label.toLowerCase()
  const status = pollError && updatedAt
    ? <span className="act-status bad" role="status"><Icon name="failed" size={12} stroke={2.4} />Couldn&rsquo;t refresh · last update {clock(updatedAt)} · retrying</span>
    : updatedAt
      ? <span className="act-status" role="status"><span className="act-dot" aria-hidden="true" />Updated {since(updatedAt, now)}<span className="act-status-more"> · refreshes every 10 s</span></span>
      : null

  let empty = null
  if (items.length === 0 && !loading) {
    if (problem) {
      empty = (
        <div className="act-empty" title={problem !== 'offline' ? detail ?? undefined : undefined}>
          <b>{problem === 'offline' ? 'Can’t reach ThruScan' : 'Can’t reach the Thru network'}</b>
          <p>{emptyMessage(problem, group)} We will keep trying every 10 s.</p>
          <button className="btn secondary sm" onClick={() => load()}>Retry now</button>
        </div>
      )
    } else if (group === 'all') {
      empty = (
        <div className="act-empty">
          <b>Nothing has happened on {net} yet</b>
          <p>This list is live. New events appear here within 10 seconds of landing.</p>
        </div>
      )
    } else {
      empty = (
        <div className="act-empty">
          <b>No {GROUP_NOUN[group] ?? ''} activity in the last {limit} events</b>
          <p>{group === 'name' ? 'Names are registered less often than trades. ' : ''}Load older events or switch to All.</p>
          <div className="act-empty-actions">
            {next && <button className="btn secondary sm" onClick={more}>Show older</button>}
            <button className="btn tertiary sm" onClick={() => setGroup('all')}>Show all</button>
          </div>
        </div>
      )
    }
  }

  return (
    <section className="act">
      <div className="act-head-row">
        <div className="act-head-text">
          {!embedded && <h1 className="act-h1">Activity</h1>}
          <p className="act-lead">
            {address
              ? <>Transactions involving <Link className="mono" to={`/account/${address}`}>{shortId(address)}</Link> on Thru {net}. <Link to="/explorer?tab=activity">Show everyone&rsquo;s</Link></>
              : <>Everyone&rsquo;s launches, trades, swaps, mints and names on Thru {net}, read from the chain.</>}
          </p>
        </div>
        {status}
      </div>

      {showFilters && (
        <div className="chips act-chips" role="group" aria-label="Filter activity">
          {KIND_GROUPS.map((g) => (
            <button key={g.id} className="chip" aria-pressed={group === g.id} onClick={() => setGroup(g.id)}>{g.label}</button>
          ))}
        </div>
      )}

      {source === 'chain' && (
        <div className="notice" role="status">
          <Icon name="warning" size={18} />
          <span>Reading straight from the chain, which is slower. Older events and some filters may be incomplete.</span>
        </div>
      )}

      <div role="table" aria-label="Activity" className="act-table">
        <div role="row" className="act-tr act-th">
          <span role="columnheader">Event</span>
          <span role="columnheader">Detail</span>
          <span role="columnheader">Txn</span>
          <span role="columnheader">From</span>
          <span role="columnheader">To</span>
          <span role="columnheader" className="act-r">Amount</span>
          <span role="columnheader" className="act-r">Fee</span>
          <span role="columnheader" className="act-r">Time</span>
        </div>
        {items.length === 0 && loading && <SkeletonRows />}
        {empty}
        {items.map((i) => <Row key={i.signature} item={i} names={names} extra={extra} now={now} />)}
      </div>

      <div className="act-foot">
        <span>Amounts for token moves load after the row appears; grey bars mean &ldquo;still reading&rdquo;, not zero.</span>
        {next && (
          <button className="btn secondary act-more" onClick={more} disabled={loading}>
            {loading ? 'Loading' : 'Show older'}
          </button>
        )}
      </div>
    </section>
  )
}

export default Feed
