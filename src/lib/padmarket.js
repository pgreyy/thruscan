// src/lib/padmarket.js
//
// ThruPad as a market: every launch with its price, market cap, curve progress
// and the last 24 hours of trading, worked out once and shared by the home
// page (Trending and the list tabs) and the profile's prices.
//
// The launches come from the registry and their vaults (useChainData). The
// 24-hour figures come from each launch's trade history, read through
// /api/rpc?action=launchtrades: one request per launch, slowly, and cached for
// the page's life so moving between pages does not read it all again.

import { useEffect, useMemo, useState } from 'react'
import { decodePadRegistry, graduationProgress } from './pad.js'
import { THRUPAD_REGISTRY, TUSD_MINT, WTHRU_MINT } from './addresses.js'
import { useChainData } from '../pages/Dex.jsx'
import { launchAgeMs, loadLaunchTime, onLaunchTime } from './launchtime.js'

export const TOKEN_DECIMALS = 6   // every launch mints at 6
const QUOTE_DEFAULT = 6
const DAY = 86_400_000
const SERIES_MS = 60_000

/* ---------- trade history, per launch ---------- */

const seriesCache = new Map()   // mint -> { at, trades }
const seriesListeners = new Set()

async function readTrades(l) {
  const q = new URLSearchParams({ action: 'launchtrades', quoteVault: l.quoteVault, tokenVault: l.tokenVault, pages: '1' })
  const r = await fetch(`/api/rpc?${q}`)
  const j = await r.json()
  if (!j?.ok) throw new Error(j?.error || `status ${r.status}`)
  return j.trades ?? []
}

function useTradeHistory(launches) {
  const [, bump] = useState(0)
  useEffect(() => {
    const on = () => bump((n) => n + 1)
    seriesListeners.add(on)
    return () => seriesListeners.delete(on)
  }, [])
  const key = launches.map((l) => l.mint).join(',')
  useEffect(() => {
    if (!launches.length) return undefined
    let alive = true
    const load = () => launches.forEach(async (l) => {
      const had = seriesCache.get(l.mint)
      if (had && Date.now() - had.at < SERIES_MS / 2) return
      try {
        const trades = await readTrades(l)
        if (!alive) return
        seriesCache.set(l.mint, { at: Date.now(), trades })
        seriesListeners.forEach((fn) => fn())
      } catch { /* the next round tries again */ }
    })
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, SERIES_MS)
    return () => { alive = false; clearInterval(id) }
  }, [key])  // eslint-disable-line react-hooks/exhaustive-deps
  return seriesCache
}

/** What a launch's trades say about the last 24 hours. Null when unread. */
function dayStats(trades, qd, nowPrice, now) {
  if (!trades) return null
  const priced = trades
    .filter((t) => Number(t.tokens) > 0)
    .map((t) => ({ ...t, price: (Number(t.quote) / 10 ** qd) / (Number(t.tokens) / 10 ** TOKEN_DECIMALS) }))
  const since = now - DAY
  const day = priced.filter((t) => t.time !== null && t.time >= since)
  const volume = day.reduce((s, t) => s + Number(t.quote) / 10 ** qd, 0)
  // The change: against the last trade before 24 hours ago when the history
  // read reaches that far, otherwise against the oldest trade read.
  const before = [...priced].reverse().find((t) => t.time !== null && t.time < since)
  const base = before ?? priced[0]
  const change = base?.price && Number.isFinite(nowPrice) ? ((nowPrice - base.price) / base.price) * 100 : null
  return { count: day.length, volume, change, trades: priced }
}

/* ---------- the hook ---------- */

/**
 * { data, rows, loading, error, reload, readAt, decimals, tickers }
 * rows: each launch with now (price), cap (market cap), raised, progress,
 * ageMs, and day: { count, volume, change } once its history is read.
 * `overview` is the chain overview ({ finalized, blockTimeMs }) for ages.
 */
export function usePadMarket(overview) {
  const pad = useChainData(
    THRUPAD_REGISTRY,
    decodePadRegistry,
    (d) => d.launches.flatMap((l) => [l.quoteVault, l.tokenVault]),
    (d) => [d.quoteMint, ...d.launches.map((l) => l.quoteMint)],
  )
  const { data, balances, tickers, decimals } = pad
  const launches = useMemo(() => data?.launches ?? [], [data])
  const cache = useTradeHistory(launches)
  // Launch times, read once per launch from the chain; see launchtime.js.
  const [, bumpTimes] = useState(0)
  useEffect(() => onLaunchTime(() => bumpTimes((n) => n + 1)), [])
  useEffect(() => { launches.forEach((l) => loadLaunchTime(l.tokenVault)) }, [launches])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const rows = launches.map((l) => {
    const qd = decimals?.[l.quoteMint] ?? QUOTE_DEFAULT
    const vq = Number(l.vq), vt = Number(l.vt)
    const price = vt > 0 ? (vq / 10 ** qd) / (vt / 10 ** TOKEN_DECIMALS) : null
    const supply = (Number(l.vt) + Number(l.tokensSold)) / 10 ** TOKEN_DECIMALS
    const held = balances?.[l.quoteVault] ?? 0n
    const raised = held > l.creatorFees ? held - l.creatorFees : 0n
    // One launch time for every layout that shows this row.
    const ageMs = launchAgeMs(l, { overview, now })
    return {
      ...l,
      symbol: l.symbol || `#${l.id}`,
      qd,
      unit: tickers?.[l.quoteMint] || (l.quoteMint === WTHRU_MINT ? 'WTHRU' : l.quoteMint === TUSD_MINT ? 'tUSD' : 'THRU'),
      inWthru: l.quoteMint === WTHRU_MINT,
      now: price,
      cap: price !== null ? price * supply : null,
      raised: Number(raised) / 10 ** qd,
      trades: Number(l.tradeCount),
      progress: l.graduated ? 1 : graduationProgress(raised, data.gradThreshold),
      ageMs,
      day: dayStats(cache.get(l.mint)?.trades ?? null, qd, price, now),
    }
  })

  return { ...pad, rows, now }
}
