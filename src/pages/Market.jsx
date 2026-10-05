// src/pages/Market.jsx
//
// The front page: the launchpad as a market, at a glance.
//
// Numbers first, then the tokens by size, then the newest and what just
// happened. Everything here is read from the chain or the indexer; nothing is
// estimated, and where a number cannot be read the page says so in place
// rather than leaving a hole. The chain has been unreliable, so every block on
// this page has a loading state, an empty state and a down state, and all
// three look like the finished page with less in it.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getAccount } from '../lib/rpcClient.js'
import { decodePadRegistry, graduationProgress } from '../lib/pad.js'
import { decodeSwapRegistry } from '../lib/swap.js'
import { allTokenMeta } from '../lib/tokenmeta.js'
import { fetchFeed, shortId } from '../lib/feed.js'
import {
  THRUSWAP_REGISTRY, THRUPAD_PROGRAM, THRUPAD_REGISTRY, TUSD_MINT, WTHRU_MINT,
} from '../lib/addresses.js'
import { TokenIcon } from '../components/TokenMeta.jsx'
import { useChainData, CreateLaunchCard, NotLive, compactNumber } from './Dex.jsx'
import { Wordmark } from '../components/Wordmark.jsx'
import './market.css'

const TOKEN_DECIMALS = 6   // every launch mints at 6
const QUOTE_DEFAULT = 6
const TOP_ROWS = 8
const NEW_ROWS = 5
const FEED_ROWS = 8

/* ---------- formatting ---------- */

const num = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '–' : Number(n).toLocaleString('en-US'))

/** A price with sensible precision: 0.0000123, 0.0123, 1.23, 1,234. */
function price(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–'
  if (v === 0) return '0'
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 3 })
  return v.toLocaleString('en-US', { maximumSignificantDigits: 3 })
}

function pct(c) {
  if (c === null || !Number.isFinite(c)) return null
  if (c > 999) return '>+999%'
  const sign = c > 0 ? '+' : ''
  return `${sign}${Math.abs(c) >= 100 ? Math.round(c) : c.toFixed(1)}%`
}

/* Relative time from the indexer's nanoseconds, the same short form the
   Activity page uses. */
function ago(ns) {
  if (!ns) return '—'
  const ms = Number(BigInt(ns) / 1000000n)
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/* ---------- data ---------- */

/** Poll a reader. Keeps the last good value through a failed round, and
 *  reports the failure only while there is nothing good to show. */
function usePoll(read, ms) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const load = useCallback(async () => {
    try {
      const data = await read()
      setState({ data, error: null, loading: false })
    } catch (e) {
      setState((s) => (s.data ? { ...s, loading: false } : { data: null, error: String(e?.message ?? e), loading: false }))
    }
  }, [read])
  useEffect(() => {
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, ms)
    return () => clearInterval(id)
  }, [load, ms])
  return state
}

async function readJson(url) {
  const r = await fetch(url)
  let j
  try { j = await r.json() } catch { throw new Error(`The server answered ${r.status} with something that is not data.`) }
  if (!j?.ok) throw new Error(j?.error || `The server answered ${r.status}.`)
  return j
}

const readOverview = () => readJson('/api/rpc?action=overview')

const tokenAmount = (acct) => {
  const b64 = acct?.data?.base64
  if (!b64) return null
  const bin = atob(b64)
  if (bin.length < 72) return null
  let v = 0n
  for (let i = 71; i >= 64; i--) v = (v << 8n) | BigInt(bin.charCodeAt(i))
  return v
}

/** THRU in tUSD, from the WTHRU/tUSD pool's two vaults. */
async function readThruPrice() {
  if (!THRUSWAP_REGISTRY) return null
  const acct = await getAccount(THRUSWAP_REGISTRY)
  const pool = decodeSwapRegistry(acct?.data?.base64).pools
    .find((p) => [p.mintA, p.mintB].includes(WTHRU_MINT) && [p.mintA, p.mintB].includes(TUSD_MINT))
  if (!pool) return null
  const [wVault, tVault] = pool.mintA === WTHRU_MINT ? [pool.vaultA, pool.vaultB] : [pool.vaultB, pool.vaultA]
  const [w, t] = await Promise.all([getAccount(wVault).then(tokenAmount), getAccount(tVault).then(tokenAmount)])
  // One THRU is one WTHRU base unit; tUSD has 6 decimals.
  return w && t !== null ? Number(t) / 1e6 / Number(w) : null
}

const readActivity = async () => {
  const r = await fetchFeed({ group: 'all', limit: FEED_ROWS })
  if (r.problem) throw new Error(r.detail || 'The chain is not answering right now.')
  return r.items
}

/**
 * Recent trade prices for the launches on screen, for the Change column.
 *
 * One request per launch, so only for the rows shown, each on its own so one
 * slow history cannot hold up the rest, and slowly: these move when somebody
 * trades, and the price column beside them is already live.
 */
function useTradeSeries(launches) {
  const [series, setSeries] = useState({})
  const key = launches.map((l) => l.mint).join(',')
  useEffect(() => {
    if (!launches.length) return undefined
    let alive = true
    const load = () => launches.forEach(async (l) => {
      try {
        const q = new URLSearchParams({ action: 'launchtrades', quoteVault: l.quoteVault, tokenVault: l.tokenVault, pages: '1' })
        const j = await readJson(`/api/rpc?${q}`)
        const prices = j.trades
          .filter((t) => Number(t.tokens) > 0)
          .map((t) => (Number(t.quote) / 10 ** l.qd) / (Number(t.tokens) / 10 ** TOKEN_DECIMALS))
        if (alive) setSeries((s) => ({ ...s, [l.mint]: prices }))
      } catch { /* the next round tries again */ }
    })
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [key])  // eslint-disable-line react-hooks/exhaustive-deps
  return series
}

/** From the oldest trade read to the price the curve quotes now. */
function changeOf(prices, now) {
  if (!prices?.length || !prices[0] || !Number.isFinite(now)) return null
  return ((now - prices[0]) / prices[0]) * 100
}

/* ---------- pieces ---------- */

function Spark({ prices, now, trend }) {
  const pts = [...(prices ?? []), ...(Number.isFinite(now) ? [now] : [])].slice(-24)
  if (pts.length < 2) return <span className="mk-spark mk-spark-none" aria-hidden="true" />
  const lo = Math.min(...pts), hi = Math.max(...pts)
  const y = (v) => (hi === lo ? 10 : 18 - ((v - lo) / (hi - lo)) * 16)
  const d = pts.map((v, i) => `${((i / (pts.length - 1)) * 60).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return (
    <svg className={`mk-spark${trend > 0 ? ' up' : trend < 0 ? ' down' : ''}`} viewBox="0 0 60 20" aria-hidden="true">
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Change({ value }) {
  const text = pct(value)
  if (text === null) return <span className="dim">–</span>
  const flat = Math.abs(value) < 0.05
  return <span className={flat ? 'dim' : value > 0 ? 'mk-up' : 'mk-down'}>{flat ? '0.0%' : text}</span>
}

function Stat({ label, value, sub, title }) {
  return (
    <div className="mk-stat" title={title}>
      <dt>{label}</dt>
      <dd className="mono">{value}{sub && <small> {sub}</small>}</dd>
    </div>
  )
}

/** A table row that holds a message instead of data, so an empty or broken
 *  table keeps its header and its shape. */
function TableNote({ children, tone }) {
  return <div className={`mk-note${tone === 'bad' ? ' bad' : ''}`}>{children}</div>
}

function Skeleton({ rows, cols }) {
  return Array.from({ length: rows }, (_, i) => (
    <div key={i} className={`mk-tr ${cols} mk-skel`} aria-hidden="true">
      <span /><span><i /></span><span><i /></span><span><i /></span><span><i /></span><span><i /></span><span><i /></span>
    </div>
  ))
}

function TokenCell({ l, meta }) {
  return (
    <span className="mk-token">
      <TokenIcon meta={meta} symbol={l.symbol} mint={l.mint} size={32} />
      <span>
        <b>{l.name || l.symbol}</b>
        <i className="mono">${l.symbol}{l.graduated ? ' · graduated' : ''}</i>
      </span>
    </span>
  )
}

/* ---------- the page ---------- */

export function MarketHome() {
  const [creating, setCreating] = useState(false)
  const [meta, setMeta] = useState({})

  const pad = useChainData(
    THRUPAD_REGISTRY,
    decodePadRegistry,
    (d) => d.launches.flatMap((l) => [l.quoteVault, l.tokenVault]),
    (d) => [d.quoteMint, ...d.launches.map((l) => l.quoteMint)],
  )
  const overview = usePoll(readOverview, 5000)
  const thru = usePoll(readThruPrice, 30_000)
  const activity = usePoll(readActivity, 10_000)

  useEffect(() => {
    let alive = true
    const read = () => allTokenMeta().then((m) => { if (alive) setMeta(m) }).catch(() => {})
    read()
    const id = setInterval(() => { if (!document.hidden) read() }, 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const { data, balances, tickers, decimals } = pad

  /* Every launch with what the page shows about it worked out once. */
  const rows = useMemo(() => (data?.launches ?? []).map((l) => {
    const qd = decimals?.[l.quoteMint] ?? QUOTE_DEFAULT
    const vq = Number(l.vq), vt = Number(l.vt), sold = Number(l.tokensSold)
    const now = vt > 0 ? (vq / 10 ** qd) / (vt / 10 ** TOKEN_DECIMALS) : null
    const cap = vt > 0 ? (vq / vt) * (vt + sold) / 10 ** qd : null
    const held = balances?.[l.quoteVault] ?? 0n
    const raised = held > l.creatorFees ? held - l.creatorFees : 0n
    return {
      ...l,
      symbol: l.symbol || `#${l.id}`,
      qd,
      unit: tickers?.[l.quoteMint] || (l.quoteMint === TUSD_MINT ? 'tUSD' : 'THRU'),
      now,
      cap,
      trades: Number(l.tradeCount),
      progress: l.graduated ? 1 : graduationProgress(raised, data.gradThreshold),
    }
  }), [data, balances, tickers, decimals])

  const top = useMemo(() => [...rows].sort((a, b) => (b.cap ?? 0) - (a.cap ?? 0)).slice(0, TOP_ROWS), [rows])
  const newest = useMemo(() => [...rows].sort((a, b) => b.id - a.id).slice(0, NEW_ROWS), [rows])
  const series = useTradeSeries(top)

  const totals = useMemo(() => ({
    launches: data ? rows.length : null,
    graduated: data ? rows.filter((r) => r.graduated).length : null,
    trades: data ? rows.reduce((s, r) => s + r.trades, 0) : null,
  }), [data, rows])

  const ov = overview.data
  const padDown = !!pad.error
  const chainDown = !!overview.error && !ov

  if (!THRUPAD_PROGRAM || !THRUPAD_REGISTRY) {
    return (
      <div className="wrap-wide">
        <div className="mk-head"><Wordmark size="lg" /></div>
        <NotLive what="thrupad" />
      </div>
    )
  }

  return (
    <div className="wrap-wide mk">
      <div className="mk-head">
        <h1 className="mk-title"><Wordmark size="lg" /></h1>
        {!creating && (
          <button className="btn" onClick={() => setCreating(true)} disabled={padDown}
                  title={padDown ? 'A launch is written into the registry, so it cannot land until the registry reads again.' : undefined}>
            Create a token
          </button>
        )}
      </div>

      {creating && (
        <CreateLaunchCard
          nextId={data ? (data.launches.reduce((m, l) => Math.max(m, l.id), -1) + 1) : 0}
          registry={THRUPAD_REGISTRY}
          threshold={data?.gradThreshold}
          onClose={() => setCreating(false)}
          onLaunched={pad.reload}
        />
      )}

      {/* One line for the whole page's health, rather than an error in every
          block. The blocks below still say, in place, what they are missing. */}
      {(padDown || chainDown) && (
        <div className="mk-alert" role="status">
          <b>{padDown && chainDown ? 'The chain is not answering.' : padDown ? 'The launch registry cannot be read.' : 'The chain is not answering.'}</b>
          <span>
            {padDown
              ? ' Prices, launches and trading are unavailable until it reads again. This page retries by itself.'
              : ' Block height and speed are unavailable. This page retries by itself.'}
          </span>
          <code>{pad.error || overview.error}</code>
        </div>
      )}

      <dl className="mk-stats">
        <Stat label="Launches" value={num(totals.launches)} />
        <Stat label="Graduated" value={num(totals.graduated)} />
        <Stat label="Trades" value={num(totals.trades)} title="Every buy and sell on every launch" />
        <Stat label="THRU" value={price(thru.data)} sub={thru.data ? 'tUSD' : null} title="From the WTHRU/tUSD pool" />
        <Stat label="Block" value={num(ov?.finalized)} />
        <Stat label="Block time" value={ov?.blockTimeMs ? `${Math.round(ov.blockTimeMs)}` : '–'} sub={ov?.blockTimeMs ? 'ms' : null} />
      </dl>

      {/* Top tokens: the table everything else on the page hangs off. */}
      <section className="mk-panel">
        <header className="mk-panel-head">
          <h2>Top tokens</h2>
          <span className="fine">by market cap</span>
        </header>
        <div className="mk-table" role="table" aria-label="Top tokens by market cap">
          <div className="mk-tr mk-cols-top mk-th" role="row">
            <span>#</span><span>Token</span><span>Price</span>
            {/* Not "Change": that reads as 24 hours, and this is not. */}
            <span><span className="mk-wide">Over recent trades</span><span className="mk-narrow">Recent</span></span><span>Market cap</span><span>Curve</span><span>Trades</span>
          </div>
          {pad.loading && !data && <Skeleton rows={4} cols="mk-cols-top" />}
          {padDown && !data && (
            <TableNote tone="bad">Tokens cannot be listed while the launch registry is unreadable.</TableNote>
          )}
          {data && rows.length === 0 && (
            <TableNote>Nothing has launched yet. The first token created here will head this list.</TableNote>
          )}
          {top.map((l, i) => {
            const c = changeOf(series[l.mint], l.now)
            return (
              <Link key={l.id} to={`/launch/${l.id}`} className="mk-tr mk-cols-top" role="row">
                <span className="mk-rank mono">{i + 1}</span>
                <TokenCell l={l} meta={meta[l.mint]} />
                <span className="mono">{price(l.now)} <small>{l.unit}</small></span>
                <span className="mk-change mono"><Spark prices={series[l.mint]} now={l.now} trend={c} /><Change value={c} /></span>
                <span className="mono">{compactNumber(l.cap)} <small>{l.unit}</small></span>
                <span className="mk-curve">
                  {l.graduated
                    ? <span className="mk-grad">Graduated</span>
                    : <><span className="progress-track"><span className="progress-fill" style={{ width: `${Math.max(2, l.progress * 100)}%` }} /></span><small className="mono">{(l.progress * 100).toFixed(0)}%</small></>}
                </span>
                <span className="mono">{num(l.trades)}</span>
              </Link>
            )
          })}
        </div>
        {top.length > 0 && <p className="fine mk-foot">Change runs from the oldest of each token’s recent trades to the price its curve quotes now.</p>}
      </section>

      <div className="mk-pair">
        <section className="mk-panel">
          <header className="mk-panel-head"><h2>New launches</h2></header>
          <div className="mk-table" role="table" aria-label="Newest launches">
            <div className="mk-tr mk-cols-new mk-th" role="row"><span>Token</span><span>Price</span><span>Market cap</span><span>Trades</span></div>
            {pad.loading && !data && <Skeleton rows={3} cols="mk-cols-new" />}
            {padDown && !data && <TableNote tone="bad">Unavailable while the registry is unreadable.</TableNote>}
            {data && rows.length === 0 && <TableNote>No launches yet.</TableNote>}
            {newest.map((l) => (
              <Link key={l.id} to={`/launch/${l.id}`} className="mk-tr mk-cols-new" role="row">
                <TokenCell l={l} meta={meta[l.mint]} />
                <span className="mono">{price(l.now)} <small>{l.unit}</small></span>
                <span className="mono">{compactNumber(l.cap)}</span>
                <span className="mono">{num(l.trades)}</span>
              </Link>
            ))}
          </div>
        </section>

        <section className="mk-panel">
          <header className="mk-panel-head"><h2>Recent activity</h2><Link to="/activity" className="mk-more">All activity</Link></header>
          <div className="mk-table" role="table" aria-label="Recent activity">
            <div className="mk-tr mk-cols-act mk-th" role="row"><span>Event</span><span>Wallet</span><span>Time</span></div>
            {activity.loading && !activity.data && <Skeleton rows={3} cols="mk-cols-act" />}
            {activity.error && !activity.data && <TableNote tone="bad">Activity cannot be read right now.</TableNote>}
            {activity.data && activity.data.length === 0 && <TableNote>Nothing has happened on chain yet.</TableNote>}
            {(activity.data ?? []).map((a) => (
              <Link key={a.signature} to={`/tx/${a.signature}`} className="mk-tr mk-cols-act" role="row">
                <span className="mk-event"><b className={a.ok ? undefined : 'mk-down'}>{a.label}</b>{!a.ok && <small>failed</small>}</span>
                <span className="mono dim">{shortId(a.who)}</span>
                <span className="mono dim">{ago(a.time)}</span>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

export default MarketHome
