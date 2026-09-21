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

function usePoll(fn, ms) {
  const [data, setData] = useState(null)
  const load = useCallback(async () => {
    try { setData(await fn()) } catch { /* keep the last good value */ }
  }, [fn])
  useEffect(() => {
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, ms)
    return () => clearInterval(id)
  }, [load, ms])
  return data
}

async function readOverview() {
  const r = await fetch('/api/rpc?action=overview')
  const j = await r.json()
  if (!j.ok) throw new Error(j.error)
  return j
}

async function readPals() {
  const r = await fetch('/api/rpc?action=pals')
  const j = await r.json()
  if (!j.ok) throw new Error(j.error)
  return j
}

/** THRU in tUSD from the WTHRU/tUSD pool, and every launch's price and size. */
async function readMarkets() {
  const [swapAcct, padAcct] = await Promise.all([
    getAccount(THRUSWAP_REGISTRY).catch(() => null),
    getAccount(THRUPAD_REGISTRY).catch(() => null),
  ])
  let thru = null
  try {
    const pools = decodeSwapRegistry(swapAcct?.data?.base64).pools
    const pool = pools.find((p) => [p.mintA, p.mintB].includes(WTHRU_MINT) && [p.mintA, p.mintB].includes(TUSD_MINT))
    if (pool) {
      const [va, vb] = await Promise.all([getAccount(pool.vaultA), getAccount(pool.vaultB)])
      const a = tokenAmount(va), b = tokenAmount(vb)
      const [w, t] = pool.mintA === WTHRU_MINT ? [a, b] : [b, a]
      // One native THRU is one WTHRU base unit; tUSD has 6 decimals.
      if (w && t !== null) thru = Number(t) / 1e6 / Number(w)
    }
  } catch { /* unknown */ }

  let launches = []
  try {
    launches = decodePadRegistry(padAcct?.data?.base64).launches.map((l) => {
      const vq = Number(l.vq), vt = Number(l.vt), sold = Number(l.tokensSold)
      const inTusd = l.quoteMint === TUSD_MINT
      const quoteDecimals = inTusd ? 6 : 0   // WTHRU base units are whole THRU
      // Market cap in the quote asset: price per token unit times all units.
      const cap = vt > 0 ? (vq / vt) * (vt + sold) / 10 ** quoteDecimals : null
      return { id: l.id, symbol: l.symbol || `#${l.id}`, graduated: l.graduated, cap, unit: inTusd ? 'tUSD' : 'THRU' }
    })
    launches.sort((a, b) => (b.cap ?? 0) - (a.cap ?? 0))
  } catch { /* unknown */ }
  return { thru, launches }
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

function Banner({ pals }) {
  return (
    <Link to="/pals" className="lp-banner">
      <div className="lp-banner-art" aria-hidden="true">
        {BANNER.map((p) => <PalArt key={p.id} {...p} />)}
      </div>
      <div className="lp-banner-text">
        <h2>Pixel Pals</h2>
        <p>2,026 on Thru · {pals && pals.minted < pals.supply ? 'minting now' : pals ? 'sold out' : 'collection'}</p>
        <div className="lp-banner-row">
          <dl className="lp-banner-stats">
            <div><dt>Price</dt><dd>{pals ? num(pals.price) : '–'} THRU</dd></div>
            <div><dt>Minted</dt><dd>{pals ? `${num(pals.minted)} / ${num(pals.supply)}` : '–'}</dd></div>
            <div><dt>Limit</dt><dd>1 per wallet</dd></div>
          </dl>
          <span className="lp-banner-btn">Mint</span>
        </div>
      </div>
    </Link>
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
  const pals = usePoll(readPals, 15000)
  const markets = usePoll(readMarkets, 30000)
  const blocks = overview?.blocks ?? []
  const txs = overview?.transactions ?? []
  const launches = markets?.launches ?? []

  return (
    <div className="lp">
      <div className="lp-search"><Search compact /></div>

      <div className="lp-grid">
        <div className="lp-main">
          <Banner pals={pals} />

          <div className="lp-stats">
            <Stat label="Finalized block" value={num(overview?.finalized)} />
            <Stat label="Block time" value={overview?.blockTimeMs ? `${Math.round(overview.blockTimeMs)} ms` : '–'} />
            <Stat label="Transactions / sec" value={overview?.tps ? overview.tps.toFixed(0) : '–'} />
            <Stat label="THRU price" value={markets?.thru ? `${price(markets.thru)} tUSD` : '–'} />
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
