// src/pages/Home.jsx
//
// The explorer's front page: search first, the chain's vital signs under it,
// then the newest blocks and transactions side by side, refreshed every few
// seconds. Everything is read live from alphanet.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getAccount } from '../lib/rpcClient.js'
import { describe, timeAgo } from '../lib/activity.js'
import { decodeSwapRegistry } from '../lib/swap.js'
import { decodePadRegistry } from '../lib/pad.js'
import { checkName } from '../lib/wallet.js'
import { decodeDomain, ROOT_REGISTRAR, ROOT_SUFFIX } from '../lib/names.js'
import { THRUSWAP_REGISTRY, THRUPAD_REGISTRY } from '../lib/addresses.js'
import './home.css'

const REFRESH_MS = 5000
const short = (s, a = 6, b = 4) => (s ? `${s.slice(0, a)}…${s.slice(-b)}` : '')
const num = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString())

function bytesOf(b64) {
  if (!b64) return new Uint8Array()
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/* ---------- data ---------- */

function useOverview() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/rpc?action=overview')
      const body = await res.json()
      if (!res.ok || body.ok === false) throw new Error(body.error || `status ${res.status}`)
      setData(body); setError(null)
    } catch (e) {
      setError(String(e?.message ?? e))
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  return { data, error }
}

/** What ThruScan's own programs hold: names claimed, pools, launches. */
function useCounts() {
  const [counts, setCounts] = useState({ names: null, pools: null, launches: null })
  useEffect(() => {
    let alive = true
    Promise.all([
      getAccount(ROOT_REGISTRAR).catch(() => null),
      THRUSWAP_REGISTRY ? getAccount(THRUSWAP_REGISTRY).catch(() => null) : null,
      THRUPAD_REGISTRY ? getAccount(THRUPAD_REGISTRY).catch(() => null) : null,
    ]).then(([root, swap, pad]) => {
      if (!alive) return
      const next = { names: null, pools: null, launches: null }
      // Root registrar: [1 tag][32 authority][64 name][u32 len][u64 total]
      const r = bytesOf(root?.data?.base64)
      if (r.length >= 109) next.names = Number(new DataView(r.buffer).getBigUint64(101, true))
      try { next.pools = decodeSwapRegistry(swap?.data?.base64).pools.length } catch { /* unknown */ }
      try { next.launches = decodePadRegistry(pad?.data?.base64).launches.length } catch { /* unknown */ }
      setCounts(next)
    })
    return () => { alive = false }
  }, [])
  return counts
}

/* ---------- search ---------- */

function Search() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const go = async (e) => {
    e?.preventDefault()
    const v = q.trim()
    if (!v) return
    setError(null)
    if (v.startsWith('ts')) return navigate(`/tx/${v}`)
    if (v.startsWith('ta') && v.length >= 40) return navigate(`/account/${v}`)

    // Anything else is treated as a name.
    const name = v.toLowerCase().replace(new RegExp(`\\.${ROOT_SUFFIX}$`), '')
    setBusy(true)
    try {
      const r = await checkName(name)
      if (!r.ok || !r.taken) throw new Error(`${name}.${ROOT_SUFFIX} is not registered.`)
      const domain = decodeDomain(bytesOf(r.data))
      navigate(`/account/${domain.owner}`)
    } catch (err) {
      setError(String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="home-search" onSubmit={go}>
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setError(null) }}
        placeholder={`Address, transaction or name.${ROOT_SUFFIX}`}
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit" aria-label="Search" disabled={busy}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      </button>
      {error && <p className="home-search-error">{error}</p>}
    </form>
  )
}

/* ---------- pieces ---------- */

function Stat({ icon, label, value, sub, align }) {
  return (
    <div className={`home-stat${align === 'right' ? ' right' : ''}`}>
      {icon && <span className="home-stat-icon" aria-hidden="true">{icon}</span>}
      <span className="home-stat-body">
        <span className="home-stat-label">{label}</span>
        <span className="home-stat-value">{value}{sub && <span className="home-stat-sub"> {sub}</span>}</span>
      </span>
    </div>
  )
}

const I = {
  cube: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2 3 7v10l9 5 9-5V7z" /><path d="m3 7 9 5 9-5M12 12v10" /></svg>,
  bolt: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>,
  tag: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 12V3h9l9 9-9 9z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg>,
  clock: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  doc: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M14 3H6v18h12V7z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></svg>,
  box: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2 3 7v10l9 5 9-5V7z" /><path d="m3 7 9 5 9-5M12 12v10" /></svg>,
}

/** Transactions per block, oldest on the left. */
function ActivityChart({ blocks }) {
  const points = useMemo(() => [...(blocks ?? [])].reverse().filter((b) => b.txs !== null), [blocks])
  if (points.length < 2) return <div className="home-chart-empty fine">Reading the chain</div>

  const W = 320, H = 86
  const max = Math.max(1, ...points.map((p) => p.txs))
  const step = W / points.length
  return (
    <svg className="home-chart" viewBox={`0 0 ${W} ${H + 16}`} preserveAspectRatio="none" role="img"
      aria-label={`Transactions per block across the last ${points.length} blocks, up to ${max}`}>
      {[0.5, 1].map((f) => (
        <line key={f} x1="0" x2={W} y1={H - H * f} y2={H - H * f} className="home-chart-grid" />
      ))}
      {points.map((p, i) => {
        const h = Math.max(1.5, (p.txs / max) * (H - 4))
        return <rect key={p.slot} x={i * step + 1} y={H - h} width={Math.max(1, step - 2)} height={h} rx="1.5" className="home-chart-bar"><title>{`Slot ${num(p.slot)}: ${p.txs} txns`}</title></rect>
      })}
      <text x="0" y={H + 13} className="home-chart-axis">{num(points[0].slot)}</text>
      <text x={W} y={H + 13} textAnchor="end" className="home-chart-axis">{num(points[points.length - 1].slot)}</text>
      <text x={W} y="10" textAnchor="end" className="home-chart-axis">{max}</text>
    </svg>
  )
}

function BlockRow({ b }) {
  return (
    <div className="home-row">
      <span className="home-row-icon">{I.box}</span>
      <span className="home-row-main">
        <span className="home-row-title mono">{num(b.slot)}</span>
        <span className="fine">{timeAgo(b.time)}</span>
      </span>
      <span className="home-row-mid">
        <span>Producer <Link className="mono" to={`/account/${b.producer}`}>{short(b.producer, 8, 4)}</Link></span>
        <span className="fine">{b.txs === null ? 'txns not counted' : `${b.txs} txn${b.txs === 1 ? '' : 's'}`}</span>
      </span>
      <span className="home-badge mono">{num(b.compute)} CU</span>
    </div>
  )
}

function TxRow({ t }) {
  const { label } = describe(t, null)
  return (
    <div className="home-row">
      <span className="home-row-icon">{I.doc}</span>
      <span className="home-row-main">
        <Link className="home-row-title mono" to={`/tx/${t.signature}`}>{short(t.signature, 12, 4)}</Link>
        <span className="fine">{timeAgo(t.time)}</span>
      </span>
      <span className="home-row-mid">
        <span>From <Link className="mono" to={`/account/${t.feePayer}`}>{short(t.feePayer, 8, 4)}</Link></span>
        <span className="fine">{label}</span>
      </span>
      <span className={`home-badge${t.ok === false ? ' bad' : ''}`}>{t.ok === false ? 'Failed' : 'Success'}</span>
    </div>
  )
}

/* ---------- the page ---------- */

export function HomePage() {
  const { data, error } = useOverview()
  const counts = useCounts()
  const blocks = data?.blocks ?? []
  const txs = data?.transactions ?? []

  return (
    <div className="home">
      <section className="home-hero">
        <div className="home-hero-inner">
          <h1>The Thru Alphanet Explorer</h1>
          <Search />
        </div>
      </section>

      <div className="home-wrap">
        <section className="home-stats">
          <div className="home-stats-col">
            <Stat icon={I.cube} label="Block height" value={num(data?.finalized)} />
            <Stat icon={I.clock} label="Block time" value={data?.blockTimeMs ? `${Math.round(data.blockTimeMs)} ms` : '-'} sub="average, last 60" />
          </div>
          <div className="home-stats-col">
            <div className="home-stat-pair">
              <Stat icon={I.bolt} label="Transactions" value={data?.tps ? `${data.tps.toFixed(1)} TPS` : '-'} />
              <Stat label="Last executed" value={num(data?.executed)} align="right" />
            </div>
            <div className="home-stat-pair">
              <Stat icon={I.tag} label={`.${ROOT_SUFFIX} names`} value={num(counts.names)} />
              <Stat label="Pools · Launches" value={`${num(counts.pools)} · ${num(counts.launches)}`} align="right" />
            </div>
          </div>
          <div className="home-stats-col chart">
            <span className="home-stat-label">Transactions per block, last 60 blocks</span>
            <ActivityChart blocks={blocks} />
          </div>
        </section>

        {error && !data && <p className="notice bad">Could not read the chain: {error}</p>}

        <div className="home-lists">
          <section className="home-list">
            <div className="home-list-head"><h2>Latest Blocks</h2><span className="home-live"><i />live</span></div>
            {blocks.slice(0, 8).map((b) => <BlockRow key={b.slot} b={b} />)}
            {!data && <p className="fine home-pad">Reading the chain</p>}
          </section>

          <section className="home-list">
            <div className="home-list-head"><h2>Latest Transactions</h2><span className="home-live"><i />live</span></div>
            {txs.slice(0, 8).map((t) => <TxRow key={t.signature} t={t} />)}
            {!data && <p className="fine home-pad">Reading the chain</p>}
          </section>
        </div>
      </div>
    </div>
  )
}

export default HomePage
