// src/components/TradeChart.jsx
//
// Price over time for anything that trades between two vaults: a launch's
// bonding curve, or a swap pool.
//
// Every trade moves tokens through both vaults, so the quote vault's
// transaction history is the trade history, and the token program's transfer
// records in each transaction give the exact amounts. The price plotted is what
// each trade actually paid per token. Nothing is stored anywhere but the chain.

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

/** 0.0000000803 rather than 8.030e-8: the same four digits, readable. */
export const sig4 = (v) => Number(v).toLocaleString(undefined, { maximumSignificantDigits: 4, maximumFractionDigits: 20 })

function amount(units, decimals) {
  const n = Number(units ?? 0) / 10 ** decimals
  if (n !== 0 && n < 0.0001) return '<0.0001'
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

/** Trades between two vaults, oldest first. */
export function useTrades(quoteVault, tokenVault, refreshKey) {
  const [trades, setTrades] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!quoteVault || !tokenVault) return
    let alive = true
    const q = new URLSearchParams({ action: 'launchtrades', quoteVault, tokenVault })
    // The node is sometimes slow to answer; one quiet retry before saying so.
    const get = () => fetch(`/api/rpc?${q}`).then((r) => r.json()).then((j) => { if (!j.ok) throw new Error(j.error); return j })
    get().catch(() => new Promise((r) => setTimeout(r, 1500)).then(get))
      .then((j) => { if (alive) { setTrades(j.trades); setError(null) } })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)) })
    return () => { alive = false }
  }, [quoteVault, tokenVault, refreshKey])

  return { trades, error }
}

/**
 * The chart and the most recent trades. `symbol` is the token being priced,
 * `quote` what it is priced in.
 */
export function TradeChart({
  quoteVault, tokenVault, quote, symbol, quoteDecimals = 6, tokenDecimals = 6,
  refreshKey, title = 'Price', bare = false,
}) {
  const { trades, error } = useTrades(quoteVault, tokenVault, refreshKey)

  const points = (trades ?? []).map((t) => ({
    ...t,
    price: (Number(t.quote) / 10 ** quoteDecimals) / (Number(t.tokens) / 10 ** tokenDecimals),
  })).filter((t) => isFinite(t.price) && t.price > 0)

  const W = 320, H = 120, P = 6
  let chart = null
  if (points.length > 0) {
    const prices = points.map((p) => p.price)
    const lo = Math.min(...prices), hi = Math.max(...prices)
    const flat = hi === lo
    const base = flat ? lo / 2 : lo
    const span = flat ? lo : hi - lo
    const x = (i) => (points.length === 1 ? W / 2 : P + (i / (points.length - 1)) * (W - 2 * P))
    const y = (v) => H - P - ((v - base) / span) * (H - 2 * P)
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ')
    chart = (
      <svg className="price-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`Price of ${symbol} across ${points.length} trades`}>
        <line x1="0" x2={W} y1={H - P} y2={H - P} className="price-chart-axis" />
        {points.length > 1 && <path d={path} className="price-chart-line" />}
        {/* Dots are zero-length round-capped lines: with a stretched viewBox a
            circle would turn into an oval, but a non-scaling stroke stays round. */}
        {points.map((p, i) => (
          <g key={p.signature} className={`price-chart-dot ${p.side}`}>
            <title>{`${p.side === 'buy' ? 'Buy' : 'Sell'} at ${sig4(p.price)} ${quote}`}</title>
            <line x1={x(i)} x2={x(i)} y1={y(p.price)} y2={y(p.price)} className="dot-outer" />
            {p.side === 'sell' && <line x1={x(i)} x2={x(i)} y1={y(p.price)} y2={y(p.price)} className="dot-inner" />}
          </g>
        ))}
      </svg>
    )
  }

  const last = points[points.length - 1]

  const body = (
    <>
      <div className="card-head">
        <div>
          <h2 className="h2">{title}</h2>
          <p className="sub">{last ? `${sig4(last.price)} ${quote} per ${symbol}, last trade` : `${quote} per ${symbol}`}</p>
        </div>
      </div>

      {error && <p className="notice bad" style={{ marginTop: 12 }}>Could not read the trades: {error}</p>}
      {!error && trades === null && <p className="fine" style={{ marginTop: 12 }}>Reading the chain.</p>}
      {trades !== null && points.length === 0 && <p className="fine" style={{ marginTop: 12 }}>No trades yet.</p>}
      {chart && <div style={{ marginTop: 12 }}>{chart}</div>}

      {points.length > 0 && (
        <div className="trade-list">
          {[...points].reverse().slice(0, 8).map((t) => (
            <Link key={t.signature} className="trade-row" to={`/tx/${t.signature}`}>
              <span className={`trade-side ${t.side}`}>{t.side === 'buy' ? 'Buy' : 'Sell'}</span>
              <span className="mono">{amount(t.tokens, tokenDecimals)} {symbol}</span>
              <span className="mono fine">{amount(t.quote, quoteDecimals)} {quote}</span>
              <span className="fine">{t.time ? new Date(t.time).toLocaleDateString() : ''}</span>
            </Link>
          ))}
        </div>
      )}
    </>
  )

  return bare ? body : <section className="card">{body}</section>
}

export default TradeChart
