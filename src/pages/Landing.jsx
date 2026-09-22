// src/pages/Landing.jsx
//
// ThruScan's front page: the chain and everything built on it, at a glance.
// One featured banner, the network's numbers, token prices, the newest blocks
// and transactions, and the launchpad. Everything is read live.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getAccount } from '../lib/rpcClient.js'
import { describe, timeAgo } from '../lib/activity.js'
import { decodeSwapRegistry } from '../lib/swap.js'
import { decodePadRegistry } from '../lib/pad.js'
import { THRUSWAP_REGISTRY, THRUPAD_REGISTRY, TUSD_MINT, WTHRU_MINT } from '../lib/addresses.js'
import { palFor, toSvg, GENESIS } from '../lib/pals/art.js'
import { Search } from './Home.jsx'
import { useMint } from '../lib/pals/useMint.js'
import './landing.css'

const REFRESH_MS = 5000
const num = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('en-US'))
const short = (s, a = 6, b = 4) => (s ? `${s.slice(0, a)}…${s.slice(-b)}` : '')

function bytesOf(b64) {
  if (!b64) return new Uint8Array()
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
const tokenAmount = (acct) => {
  const b = bytesOf(acct?.data?.base64)
  return b.length >= 72 ? new DataView(b.buffer).getBigUint64(64, true) : null
}

/** A price with sensible precision: 0.0001234, 1.234, 1,234. */
function price(v) {
  if (v === null || !Number.isFinite(v)) return '–'
  if (v === 0) return '0'
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 3 })
  return v.toLocaleString('en-US', { maximumSignificantDigits: 3 })
}

/* ---------- data ---------- */

function usePoll(fn, ms) { return usePollReload(fn, ms).data }

function usePollReload(fn, ms) {
  const [data, setData] = useState(null)
  const load = useCallback(async (attempt = 0) => {
    // Keep the last good value on a failure; on a first load, try again soon
    // rather than showing nothing until the next round.
    try { setData(await fn()) } catch { if (attempt < 3) setTimeout(() => load(attempt + 1), 2500) }
  }, [fn])
  useEffect(() => {
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, ms)
    return () => clearInterval(id)
  }, [load, ms])
  return { data, reload: load }
}

async function readOverview() {
  const r = await fetch('/api/rpc?action=overview')
  const j = await r.json()
  if (!j.ok) throw new Error(j.error)
  return j
}

async function readPals() {
  const r = await fetch('/api/rpc?action=pals&lite=1')
  const j = await r.json()
  if (!j.ok) throw new Error(j.error)
  return j
}

/** Trades between two vaults (a pool or a launch), oldest first. */
async function tradesOf(quoteVault, tokenVault) {
  try {
    const q = new URLSearchParams({ action: 'launchtrades', quoteVault, tokenVault, pages: '1' })
    const j = await (await fetch(`/api/rpc?${q}`)).json()
    return j.ok ? j.trades : []
  } catch { return [] }
}

/**
 * Prices: THRU from the WTHRU/tUSD pool, tUSD in THRU, and the launchpad's
 * biggest tokens, each with its recent trades for a small price line.
 */
async function readMarkets() {
  const [swapAcct, padAcct] = await Promise.all([
    getAccount(THRUSWAP_REGISTRY).catch(() => null),
    getAccount(THRUPAD_REGISTRY).catch(() => null),
  ])
  const tokens = []
  let thru = null
  try {
    const pools = decodeSwapRegistry(swapAcct?.data?.base64).pools
    const pool = pools.find((p) => [p.mintA, p.mintB].includes(WTHRU_MINT) && [p.mintA, p.mintB].includes(TUSD_MINT))
    if (pool) {
      const [wVault, tVault] = pool.mintA === WTHRU_MINT ? [pool.vaultA, pool.vaultB] : [pool.vaultB, pool.vaultA]
      const [w, t] = await Promise.all([getAccount(wVault).then(tokenAmount), getAccount(tVault).then(tokenAmount)])
      // One native THRU is one WTHRU base unit; tUSD has 6 decimals.
      if (w && t !== null) thru = Number(t) / 1e6 / Number(w)
      const pair = { quoteVault: tVault, tokenVault: wVault, qd: 6, td: 0 }
      tokens.push({ symbol: 'THRU', price: thru, unit: 'tUSD', pair, to: '/swap' })
      if (thru) tokens.push({ symbol: 'tUSD', price: 1 / thru, unit: 'THRU', pair, invert: true, to: '/swap' })
    }
  } catch { /* unknown */ }

  let launches = []
  try {
    launches = decodePadRegistry(padAcct?.data?.base64).launches.map((l) => {
      const vq = Number(l.vq), vt = Number(l.vt), sold = Number(l.tokensSold)
      const inTusd = l.quoteMint === TUSD_MINT
      const qd = inTusd ? 6 : 0   // WTHRU base units are whole THRU
      const price = vt > 0 ? (vq / 10 ** qd) / (vt / 1e6) : null
      const cap = vt > 0 ? (vq / vt) * (vt + sold) / 10 ** qd : null
      return { ...l, symbol: l.symbol || `#${l.id}`, price, cap, unit: inTusd ? 'tUSD' : 'THRU', qd }
    })
    launches.sort((a, b) => (b.cap ?? 0) - (a.cap ?? 0))
    for (const l of launches.filter((x) => !x.graduated).slice(0, 4 - tokens.length)) {
      tokens.push({ symbol: l.symbol, price: l.price, unit: l.unit, pair: { quoteVault: l.quoteVault, tokenVault: l.tokenVault, qd: l.qd, td: 6 }, to: `/launch/${l.id}` })
    }
  } catch { /* unknown */ }
  return { thru, launches, tokens }
}

/** Each token's recent trade prices, fetched after the prices themselves. */
function useSeries(tokens) {
  const [lines, setLines] = useState({})
  const key = (tokens ?? []).map((t) => t.symbol).join(',')
  useEffect(() => {
    if (!tokens?.length) return
    let alive = true
    const pairs = [...new Map(tokens.map((t) => [t.pair.quoteVault + t.pair.tokenVault, t.pair])).values()]
    Promise.all(pairs.map(async (p) => [p.quoteVault + p.tokenVault, (await tradesOf(p.quoteVault, p.tokenVault))
      .filter((x) => Number(x.tokens) > 0)
      .map((x) => (Number(x.quote) / 10 ** p.qd) / (Number(x.tokens) / 10 ** p.td))]))
      .then((entries) => { if (alive) setLines(Object.fromEntries(entries)) })
    return () => { alive = false }
  }, [key])  // eslint-disable-line react-hooks/exhaustive-deps
  return (tokens ?? []).map((t) => {
    const raw = [...(lines[t.pair.quoteVault + t.pair.tokenVault] ?? [])]
    const base = t.invert ? 1 / t.price : t.price
    if (base) raw.push(base)
    return { ...t, series: t.invert ? raw.map((v) => 1 / v) : raw }
  })
}

/* ---------- pieces ---------- */

function PalArt({ id, wallet, size }) {
  const svg = useMemo(() => toSvg(palFor(id, wallet).grid, size), [id, wallet, size])
  return <span className="lp-pal" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />
}

// Four Pals for the banner, the Genesis at the front, drawn the same way the
// collection draws them.
const BANNER = [
  { id: 103, wallet: 'hero-r4', size: 96 },
  { id: 101, wallet: 'hero-w2', size: 108 },
  { id: 100, wallet: 'hero-q1', size: 120 },
  { id: GENESIS.id, wallet: GENESIS.wallet, size: 156 },
]

function Banner({ pals, reload }) {
  const m = useMint({ onMinted: reload })
  const taken = pals ? pals.minted + (pals.reservedAhead ?? 0) : 0
  const open = pals ? taken < pals.supply : true
  const floor = pals?.market?.floor
  return (
    <section className="lp-banner">
      {m.modal}
      <Link to="/pals" className="lp-banner-art" aria-label="Pixel Pals collection">
        {BANNER.map((p) => <PalArt key={p.id} {...p} />)}
      </Link>
      <div className="lp-banner-text">
        <h2><Link to="/pals">Pixel Pals</Link></h2>
        <p>2,026 on Thru · {pals ? (open ? 'minting now' : 'sold out') : 'collection'}</p>
        <div className="lp-banner-row">
          <dl className="lp-banner-stats">
            <div><dt>Price</dt><dd>{pals ? num(pals.price) : '–'} THRU</dd></div>
            <div><dt>Minted</dt><dd>{pals ? `${num(taken)} / ${num(pals.supply)}` : '–'}</dd></div>
            {floor ? <div><dt>Floor</dt><dd>{num(floor)} THRU</dd></div> : <div><dt>Limit</dt><dd>1 per wallet</dd></div>}
          </dl>
          <div className="lp-banner-actions">
            {open
              ? <button className="lp-banner-btn" onClick={m.mint} disabled={m.busy || m.minted !== null}>{m.minted !== null ? 'Minted' : m.label ?? 'Mint'}</button>
              : <Link className="lp-banner-btn" to="/pals">Buy one</Link>}
            <Link className="lp-banner-ghost" to="/pals">{open ? 'View collection' : 'Collection'}</Link>
          </div>
        </div>
        {m.minted !== null && <p className="lp-banner-note">{m.minted === 'unknown' ? <>Minted. <Link to="/pals?tab=yours">See your Pal</Link>.</> : <>Minted. <Link to={`/pals?id=${m.minted}`}>Pixel Pal #{m.minted}</Link> is yours.</>}</p>}
        {m.needWallet && <p className="lp-banner-note">You need a Thru wallet to mint. <Link to="/wallet">Get one here</Link>, it takes a minute.</p>}
        {m.error && <p className="lp-banner-note bad">{m.error}</p>}
      </div>
    </section>
  )
}

/** A small price line from a list of prices; flat when there is no history. */
function Spark({ series, trend = 0 }) {
  const pts = series?.length > 1 ? series.slice(-24) : [1, 1]
  const lo = Math.min(...pts), hi = Math.max(...pts)
  const y = (v) => (hi === lo ? 14 : 24 - ((v - lo) / (hi - lo)) * 20)
  const d = pts.map((v, i) => `${(i / (pts.length - 1)) * 72},${y(v).toFixed(1)}`).join(' ')
  const cls = trend > 0 ? 'lp-spark up' : trend < 0 ? 'lp-spark down' : 'lp-spark'
  return <svg className={cls} width="72" height="28" viewBox="0 0 72 28" aria-hidden="true"><polyline points={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" /></svg>
}

function change(series) {
  if (!series || series.length < 2 || !series[0]) return null
  return ((series[series.length - 1] - series[0]) / series[0]) * 100
}

function Tokens({ tokens }) {
  return (
    <section className="lp-block">
      <header className="lp-block-head"><h3>Tokens</h3><Link to="/swap">Swap</Link></header>
      <div className="lp-tokens">
        {(tokens ?? [null, null, null, null]).map((t, i) => {
          if (!t) return <div key={i} className="lp-token lp-token-empty" />
          const c = change(t.series)
          return (
            <Link key={t.symbol} to={t.to} className="lp-token">
              <span className="lp-coin">{t.symbol.slice(0, 2)}</span>
              <span className="lp-token-main">
                <b>{t.symbol}</b>
                <span className="mono">{price(t.price)} {t.unit}{c !== null && Math.abs(c) >= 0.05 && <i className={c >= 0 ? 'up' : 'down'}> {c >= 0 ? '+' : ''}{c.toFixed(1)}%</i>}</span>
              </span>
              <Spark series={t.series} trend={c === null || Math.abs(c) < 0.05 ? 0 : c} />
            </Link>
          )
        })}
      </div>
    </section>
  )
}

function Stat({ label, value }) {
  return <div className="lp-stat"><span>{label}</span><b className="mono">{value}</b></div>
}

/* ---------- the page ---------- */

export function LandingPage() {
  const navigate = useNavigate()
  // Older links pointed at / with a query: /?tx=, /?account=, /?tab=wall.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (q.get('tx')) navigate(`/tx/${q.get('tx')}`, { replace: true })
    else if (q.get('account')) navigate(`/account/${q.get('account')}`, { replace: true })
    else if (q.get('tab')) navigate(`/explorer?tab=${q.get('tab')}`, { replace: true })
  }, [navigate])
  const overview = usePoll(readOverview, REFRESH_MS)
  const { data: pals, reload: reloadPals } = usePollReload(readPals, 15000)
  const markets = usePoll(readMarkets, 30000)
  const blocks = overview?.blocks ?? []
  const txs = overview?.transactions ?? []
  const launches = markets?.launches ?? []
  const series = useSeries(markets?.tokens)

  return (
    <div className="lp">
      <div className="lp-search"><Search compact /></div>

      <div className="lp-grid">
        <div className="lp-main">
          <Banner pals={pals} reload={() => reloadPals()} />

          <Tokens tokens={markets ? series : null} />

          <div className="lp-stats">
            <Stat label="Finalized block" value={num(overview?.finalized)} />
            <Stat label="Block time" value={overview?.blockTimeMs ? `${Math.round(overview.blockTimeMs)} ms` : '–'} />
            <Stat label="Transactions / sec" value={overview?.tps ? overview.tps.toFixed(0) : '–'} />
            <Stat label="Launches" value={markets ? num(launches.length) : '–'} />
          </div>

          <div className="lp-tables">
            <section className="lp-panel">
              <header><h3>Latest blocks</h3><Link to="/explorer">View all</Link></header>
              <div className="lp-thead lp-cols-blocks"><span>Block</span><span>Txns</span><span>Age</span></div>
              {blocks.slice(0, 8).map((b) => (
                <div key={b.slot} className="lp-tr lp-cols-blocks mono">
                  <span className="strong">{num(b.slot)}</span>
                  <span>{b.txs ?? '–'}</span>
                  <span className="dim">{timeAgo(b.time)}</span>
                </div>
              ))}
              {!overview && <p className="lp-empty">Reading the chain</p>}
            </section>

            <section className="lp-panel">
              <header><h3>Latest transactions</h3><Link to="/explorer">View all</Link></header>
              <div className="lp-thead lp-cols-txs"><span>Type</span><span>Transaction</span><span>From</span><span>Age</span></div>
              {txs.slice(0, 8).map((t) => (
                <Link key={t.signature} to={`/tx/${t.signature}`} className="lp-tr lp-cols-txs">
                  <span><i className={`lp-tag${t.ok === false ? ' bad' : ''}`}>{describe(t, null).label}</i></span>
                  <span className="mono">{short(t.signature, 10, 4)}</span>
                  <span className="mono dim">{short(t.feePayer, 6, 4)}</span>
                  <span className="mono dim">{timeAgo(t.time)}</span>
                </Link>
              ))}
              {!overview && <p className="lp-empty">Reading the chain</p>}
            </section>
          </div>
        </div>

        <aside className="lp-side">
          <section className="lp-panel">
            <header><h3>Launchpad</h3><span className="dim">Market cap</span></header>
            {launches.slice(0, 7).map((l) => (
              <Link key={l.id} to={`/launch/${l.id}`} className="lp-tr lp-side-row">
                <span className="lp-coin">{l.symbol.slice(0, 2)}</span>
                <span className="lp-side-name"><b>{l.symbol}</b><span className="dim">{l.graduated ? 'Graduated' : 'Bonding curve'}</span></span>
                <span className="mono">{l.cap === null ? '–' : `${price(l.cap)} ${l.unit}`}</span>
              </Link>
            ))}
            {!markets && <p className="lp-empty">Reading the chain</p>}
            {markets && launches.length === 0 && <p className="lp-empty">No launches yet.</p>}
            <Link to="/launch" className="lp-foot">Launch a token</Link>
          </section>

          <section className="lp-panel">
            <header><h3>On ThruScan</h3></header>
            {[
              ['Swap', 'THRU and every Thru token', '/swap'],
              ['Names', 'A readable name for your wallet', '/names'],
              ['Wall', 'Posts on chain', '/wall'],
              ['Games', 'Wordle and 2048', '/games'],
              ['Faucet', 'Test THRU and tUSD', '/faucet'],
              ['ThruScan Wallet', 'Browser extension', '/get-wallet'],
            ].map(([name, sub, to]) => (
              <Link key={to} to={to} className="lp-tr lp-side-row">
                <span className="lp-side-name"><b>{name}</b><span className="dim">{sub}</span></span>
                <span className="dim">›</span>
              </Link>
            ))}
          </section>
        </aside>
      </div>
    </div>
  )
}

export default LandingPage
