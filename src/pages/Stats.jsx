// src/pages/Stats.jsx
//
// ThruScan's own numbers, read from the chain rather than from a tracker.
//
// Everything the site does for a visitor is paid for by one key: putting a new
// wallet on chain, the faucet, a .id name, clearing a wallet to mint a Pal. Its
// transaction history is therefore an honest usage record, and it cannot be
// inflated by refreshes or bots. Visitor counts (page views, countries) come
// from Vercel and Cloudflare instead; both are linked at the bottom.
//
// The page is not linked anywhere. Set STATS_KEY in the project's environment
// to ask for a password as well.

import { useCallback, useEffect, useState } from 'react'
import './stats.css'

const KEY_STORE = 'thruscan_stats_key'
const fmt = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('en-US'))

function Figure({ label, value, sub }) {
  return (
    <div className="st-fig">
      <span>{label}</span>
      <b className="mono">{value}</b>
      {sub && <i>{sub}</i>}
    </div>
  )
}

/** Days across, one bar per day. Plain counts, no smoothing. */
function Bars({ rows, pick, label }) {
  const max = Math.max(1, ...rows.map((r) => r[pick]))
  if (!rows.length) return <p className="st-none">Nothing in the last 30 days.</p>
  return (
    <div className="st-bars" role="img" aria-label={`${label} per day`}>
      {rows.map((r) => (
        <div key={r.day} className="st-bar" title={`${r.day}: ${r[pick]} ${label}`}>
          <div style={{ height: `${Math.round((r[pick] / max) * 100)}%` }} />
          <span>{r.day.slice(8)}</span>
        </div>
      ))}
    </div>
  )
}

export function StatsPage() {
  const [key, setKey] = useState(() => { try { return localStorage.getItem(KEY_STORE) ?? '' } catch { return '' } })
  const [typed, setTyped] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [needsKey, setNeedsKey] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/rpc?action=stats${key ? `&key=${encodeURIComponent(key)}` : ''}`)
      const j = await r.json()
      if (!j.ok) {
        setNeedsKey(Boolean(j.needsKey))
        throw new Error(j.error || 'Could not read the numbers.')
      }
      setData(j); setError(null); setNeedsKey(false)
    } catch (e) { setError(String(e?.message ?? e)) }
  }, [key])

  // The scan walks the sponsor's history a few pages at a time, so keep asking
  // until it says it reached the end.
  useEffect(() => {
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 6000)
    return () => clearInterval(t)
  }, [load])
  const site = data?.site
  const pals = data?.pals

  return (
    <div className="st-page">
      <div className="st-top">
        <h1>Stats</h1>
        <span className="st-note">
          {site ? (site.complete ? `From the chain · ${fmt(site.scanned)} transactions read` : `Reading the chain… ${fmt(site.scanned)} transactions so far`) : 'Reading the chain…'}
        </span>
      </div>

      {needsKey && (
        <div className="card st-key">
          <p className="sub">This page is locked. Enter the key.</p>
          <div className="st-key-row">
            <input className="field mono" type="password" value={typed} placeholder="Key"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { setKey(typed); try { localStorage.setItem(KEY_STORE, typed) } catch { /* private mode */ } } }} />
            <button className="btn" onClick={() => { setKey(typed); try { localStorage.setItem(KEY_STORE, typed) } catch { /* private mode */ } }}>Unlock</button>
          </div>
        </div>
      )}

      {error && !needsKey && <p className="notice bad">{error}</p>}

      <section className="st-block">
        <h2>People using ThruScan</h2>
        <div className="st-figs">
          <Figure label="Wallets made here" value={fmt(site?.wallets)} sub="Put on chain by the site" />
          <Figure label="Wallets holding tokens" value={fmt(site?.tokens)} sub="Token account opened for them" />
          <Figure label=".id names registered" value={fmt(site?.names)} />
          <Figure label="Cleared to mint a Pal" value={fmt(site?.cleared)} sub="Wallets allowed" />
        </div>
      </section>

      <section className="st-block">
        <h2>Wallets made, by day</h2>
        <Bars rows={site?.daily ?? []} pick="wallet" label="wallets" />
      </section>

      <section className="st-block">
        <h2>Pixel Pals</h2>
        <div className="st-figs">
          <Figure label="Minted" value={pals ? `${fmt(pals.minted)} / ${fmt(pals.supply)}` : '–'} sub={pals ? `${fmt(pals.gifted)} to the team` : null} />
          <Figure label="Holders" value={fmt(pals?.holders)} />
          <Figure label="Listed" value={fmt(pals?.listed)} />
          <Figure label="Sales" value={fmt(pals?.sales)} sub={pals ? `${fmt(pals.volume)} THRU traded` : null} />
        </div>
      </section>

      <section className="st-block">
        <h2>Visitors</h2>
        <p className="st-text">
          Page views, where people came from and which countries they are in are counted by
          {' '}<a href="https://vercel.com/greyys-projects-535d9f13/thruscan/analytics" target="_blank" rel="noreferrer">Vercel Web Analytics</a>
          {' '}and, once its token is set, Cloudflare Web Analytics. Neither stores anything about a visitor
          that could identify them, and neither is needed for the numbers above.
        </p>
      </section>
    </div>
  )
}

export default StatsPage
