// src/pages/Market.jsx
//
// The front page: ThruPad (Core Screens 3a-3e).
//
// What the page is for, the four steps to a first trade, the launchpad's
// numbers, the tokens by WTHRU raised, the newest launches and what just
// happened. Everything here is read from the chain or the indexer; nothing is
// estimated, and where a number cannot be read the page says so in place
// rather than leaving a hole. The chain has been unreliable, so every block on
// this page has a loading state, an empty state and a down state.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { decodePadRegistry, graduationProgress } from '../lib/pad.js'
import { allTokenMeta } from '../lib/tokenmeta.js'
import { fetchFeed } from '../lib/feed.js'
import { THRUPAD_PROGRAM, THRUPAD_REGISTRY, TUSD_MINT, WTHRU_MINT } from '../lib/addresses.js'
import { network } from '../lib/networks.js'
import { hasWallet } from '../lib/wallet.js'
import { relTime, fullUtc, clock, since } from '../lib/when.js'
import { TokenIcon } from '../components/TokenMeta.jsx'
import { Icon } from '../components/Icon.jsx'
import { useWallet } from './Wallet.jsx'
import { useChainData, CreateLaunchCard } from './Dex.jsx'
import './market.css'

const TOKEN_DECIMALS = 6   // every launch mints at 6
const QUOTE_DEFAULT = 6
const TOP_ROWS = 8
const NEW_ROWS = 6
const FEED_ROWS = 6
const NET = network.label.toLowerCase()

/* ---------- formatting ---------- */

const num = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '–' : Number(n).toLocaleString('en-US'))

/** A price with sensible precision: 0.00042180, 0.0123, 1.23, 1,234. */
function price(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–'
  if (v === 0) return '0'
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 })
  return v.toLocaleString('en-US', { maximumSignificantDigits: 4, minimumSignificantDigits: 4 })
}

/** An amount of the quote asset, to one decimal place like the design. */
const amount = (v) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '–')

function pct(c) {
  if (c === null || !Number.isFinite(c)) return null
  if (c > 999) return '>+999%'
  const sign = c > 0 ? '+' : c < 0 ? '−' : ''
  return `${sign}${Math.abs(c).toFixed(1)}%`
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

const readActivity = async () => {
  const r = await fetchFeed({ group: 'all', limit: FEED_ROWS })
  if (r.problem) throw new Error(r.detail || 'The chain is not answering right now.')
  return r.items
}

/**
 * Recent trade prices for the launches on screen, for the change column.
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

/** From the oldest trade read to the price the curve quotes now. It is not a
 *  24-hour figure, and the column says so. */
function changeOf(prices, now) {
  if (!prices?.length || !prices[0] || !Number.isFinite(now)) return null
  return ((now - prices[0]) / prices[0]) * 100
}

/** A clock that ticks once a second, for "read 8s ago". */
function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/* ---------- the "New here?" steps ----------
 *
 * Shown once per browser. The cross dismisses it for good; it hides itself once
 * a wallet is connected; the steps tick off as they are done; and "How
 * ThruScan works" in the test-network strip brings it back. */

const INTRO_DISMISSED = 'thruscan_intro_dismissed'

function useIntro(connected) {
  const read = () => { try { return localStorage.getItem(INTRO_DISMISSED) === '1' } catch { return false } }
  const [dismissed, setDismissed] = useState(read)
  const [reopened, setReopened] = useState(false)
  useEffect(() => {
    const on = () => { setDismissed(false); setReopened(true); window.scrollTo({ top: 0 }) }
    window.addEventListener('thruscan-intro', on)
    return () => window.removeEventListener('thruscan-intro', on)
  }, [])
  const dismiss = () => {
    try { localStorage.setItem(INTRO_DISMISSED, '1') } catch { /* private mode */ }
    setDismissed(true); setReopened(false)
  }
  return { show: !dismissed && (reopened || !connected), dismiss }
}

function NewHere({ steps, onClose }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="mk-intro" aria-label="New here? Four steps to your first trade">
      <div className="mk-intro-lead"><b>New here?</b></div>
      {steps.map((s, i) => (
        <Link key={s.title} to={s.to} className={`mk-step${s.done ? ' done' : ''}`}>
          <span className="mk-step-n" aria-hidden="true">{s.done ? <Icon name="success" size={14} stroke={2.2} /> : i + 1}</span>
          <span className="mk-step-t"><b>{s.title}</b><span>{s.sub}</span></span>
          {s.done && <span className="sr-only">(done)</span>}
        </Link>
      ))}
      <button className="mk-intro-x" onClick={onClose} aria-label="Hide these steps for good"><Icon name="failed" size={16} /></button>

      {/* The phone version: one row that opens the same four steps. */}
      <button className="mk-intro-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <b>New here?</b><span>4 steps to your first trade</span>
        <Icon name={open ? 'expand' : 'arrow-right'} size={16} />
      </button>
      {open && (
        <div className="mk-intro-list">
          {steps.map((s, i) => (
            <Link key={s.title} to={s.to} className={`mk-step${s.done ? ' done' : ''}`}>
              <span className="mk-step-n" aria-hidden="true">{s.done ? <Icon name="success" size={14} stroke={2.2} /> : i + 1}</span>
              <span className="mk-step-t"><b>{s.title}</b><span>{s.sub}</span></span>
            </Link>
          ))}
          <button className="btn tertiary sm" onClick={onClose}>Hide for good</button>
        </div>
      )}
    </section>
  )
}

/* ---------- pieces ---------- */

function Change({ value }) {
  const text = pct(value)
  if (text === null) return <span className="dim">–</span>
  const flat = Math.abs(value) < 0.05
  return <span className={flat ? 'dim' : value > 0 ? 'mk-up' : 'mk-down'}>{flat ? '0.0%' : text}</span>
}

function Stat({ label, value, title }) {
  return (
    <div className="mk-stat" title={title}>
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  )
}

function Bar({ progress, graduated }) {
  return (
    <span className="progress thin mk-bar" role="img" aria-label={graduated ? 'Graduated' : `${(progress * 100).toFixed(0)}% of the curve`}>
      <span style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }} />
    </span>
  )
}

function TokenCell({ l, meta, size = 32 }) {
  return (
    <span className="mk-token">
      <TokenIcon meta={meta} symbol={l.symbol} mint={l.mint} size={size} />
      <span>
        <b>{l.name || l.symbol}</b>
        <i className="mono">{l.symbol}{l.graduated ? ' · graduated' : ''}</i>
      </span>
    </span>
  )
}

/** The page's own warning banner (2h), with Retry. */
function Warn({ children, onRetry }) {
  return (
    <div className="notice mk-warn" role="status">
      <Icon name="warning" size={18} />
      <span>{children}{onRetry && <> <button className="btn plain" onClick={onRetry}>Retry</button></>}</span>
    </div>
  )
}

function Skeleton({ rows }) {
  return (
    <div className="mk-skel" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="mk-skel-row">
          <span className="skel" style={{ width: 32, height: 32, borderRadius: 6 }} />
          <span className="skel" style={{ width: i % 2 ? 100 : 140, height: 10 }} />
          <span style={{ flex: 1 }} />
          <span className="skel" style={{ width: 80, height: 10 }} />
        </div>
      ))}
    </div>
  )
}

/* ---------- the page ---------- */

export function MarketHome() {
  const [creating, setCreating] = useState(false)
  const [tab, setTab] = useState('top')           // top | grad (desktop tabs)
  const [mobileTab, setMobileTab] = useState('top') // top | new | activity
  const [showAll, setShowAll] = useState(false)
  const [meta, setMeta] = useState({})
  const [readAt, setReadAt] = useState(null)
  const now = useNow()
  const wallet = useWallet()
  const connected = !!wallet.address && hasWallet()
  const intro = useIntro(connected)

  const pad = useChainData(
    THRUPAD_REGISTRY,
    decodePadRegistry,
    (d) => d.launches.flatMap((l) => [l.quoteVault, l.tokenVault]),
    (d) => [d.quoteMint, ...d.launches.map((l) => l.quoteMint)],
  )
  const overview = usePoll(readOverview, 5000)
  const activity = usePoll(readActivity, 10_000)

  // When the registry was last read, for "Read from chain" and for the time in
  // the banner if a later read fails.
  useEffect(() => { if (pad.data) setReadAt(Date.now()) }, [pad.data, pad.balances])

  useEffect(() => {
    let alive = true
    const read = () => allTokenMeta().then((m) => { if (alive) setMeta(m) }).catch(() => {})
    read()
    const id = setInterval(() => { if (!document.hidden) read() }, 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const { data, balances, tickers, decimals } = pad
  const ov = overview.data

  /* Every launch with what the page shows about it worked out once. */
  const rows = useMemo(() => (data?.launches ?? []).map((l) => {
    const qd = decimals?.[l.quoteMint] ?? QUOTE_DEFAULT
    const vq = Number(l.vq), vt = Number(l.vt)
    const nowPrice = vt > 0 ? (vq / 10 ** qd) / (vt / 10 ** TOKEN_DECIMALS) : null
    const held = balances?.[l.quoteVault] ?? 0n
    const raised = held > l.creatorFees ? held - l.creatorFees : 0n
    // The launch's age, from the slot it started in and the chain's own block
    // time. Slots are close to evenly spaced, so this is near enough to say
    // "3d"; the tooltip says where it comes from.
    const ageMs = ov?.finalized && ov?.blockTimeMs && l.startSlot
      ? Math.max(0, Number(ov.finalized) - Number(l.startSlot)) * ov.blockTimeMs
      : null
    return {
      ...l,
      symbol: l.symbol || `#${l.id}`,
      qd,
      unit: tickers?.[l.quoteMint] || (l.quoteMint === WTHRU_MINT ? 'WTHRU' : l.quoteMint === TUSD_MINT ? 'tUSD' : 'THRU'),
      inWthru: l.quoteMint === WTHRU_MINT,
      now: nowPrice,
      raised: Number(raised) / 10 ** qd,
      trades: Number(l.tradeCount),
      progress: l.graduated ? 1 : graduationProgress(raised, data.gradThreshold),
      ageMs,
    }
  }), [data, balances, tickers, decimals, ov])

  const top = useMemo(() => [...rows].sort((a, b) => (b.raised ?? 0) - (a.raised ?? 0)), [rows])
  const nearGrad = useMemo(() => rows.filter((r) => !r.graduated).sort((a, b) => b.progress - a.progress), [rows])
  const listed = (tab === 'top' ? top : nearGrad).slice(0, showAll ? undefined : TOP_ROWS)
  const newest = useMemo(() => [...rows].sort((a, b) => b.id - a.id).slice(0, NEW_ROWS), [rows])
  const series = useTradeSeries(listed)
  const unit = rows.length && rows.every((r) => r.unit === rows[0].unit) ? rows[0].unit : 'WTHRU'

  const totals = useMemo(() => ({
    launches: data ? rows.length : null,
    trades: data ? rows.reduce((s, r) => s + r.trades, 0) : null,
    held: data ? rows.filter((r) => r.inWthru).reduce((s, r) => s + r.raised, 0) : null,
  }), [data, rows])

  const wthru = wallet.balances?.[WTHRU_MINT]
  const wthruDecimals = wallet.decimals?.[WTHRU_MINT]
  const yourWthru = wallet.unlocked && wthru?.exists && wthruDecimals !== undefined
    ? (Number(wthru.amount) / 10 ** wthruDecimals).toLocaleString('en-US', { maximumFractionDigits: 2 })
    : null

  const steps = [
    { title: 'Get a wallet', sub: 'Extension or in-browser', to: '/get-wallet', done: hasWallet() },
    { title: 'Get test tokens', sub: 'THRU from the faucet', to: '/faucet', done: (wallet.native ?? 0n) > 0n },
    { title: 'Swap for WTHRU', sub: 'Launches are priced in WTHRU', to: '/swap', done: !!(wthru?.exists && wthru.amount > 0n) },
    { title: 'Launch or trade', sub: 'Then check Activity', to: '/activity', done: !!wallet.address && rows.some((r) => r.creator === wallet.address) },
  ]

  const padDown = !!pad.error
  const staleDown = !pad.error && pad.data && readAt && now - readAt > 30_000

  if (!THRUPAD_PROGRAM || !THRUPAD_REGISTRY) {
    return (
      <div className="page mk">
        <Head onCreate={null} />
        <section className="empty">
          <span className="empty-title">ThruPad isn't running on this network yet</span>
          <p>Swap, Activity and your wallet still work. Launches will appear here once the ThruPad program is deployed and configured.</p>
          <div className="mk-actions-row">
            <Link className="btn secondary" to="/swap">Go to Swap</Link>
            <Link className="btn tertiary" to="/activity">View Activity</Link>
          </div>
        </section>
      </div>
    )
  }

  if (creating) {
    return (
      <div className="page mk-create-page">
        <CreateLaunchCard
          nextId={data ? (data.launches.reduce((m, l) => Math.max(m, l.id), -1) + 1) : 0}
          registry={THRUPAD_REGISTRY}
          threshold={data?.gradThreshold}
          registryDown={padDown}
          onClose={() => setCreating(false)}
          onLaunched={pad.reload}
        />
      </div>
    )
  }

  const createDisabled = padDown
  const loading = pad.loading && !data

  return (
    <div className="page mk">
      <Head createDisabled={createDisabled} onCreate={() => { setCreating(true); window.scrollTo({ top: 0 }) }} />

      {intro.show && <NewHere steps={steps} onClose={intro.dismiss} />}

      {padDown && (
        <Warn onRetry={() => pad.reload()}>
          <b>The launch registry can't be read right now.</b>{' '}
          {readAt ? `The list below is from ${clock(readAt)} and may be out of date.` : 'Launches, prices and trading are unavailable until it reads again.'}
        </Warn>
      )}

      {/* Four numbers, each one the registry or the chain actually gives. */}
      <dl className="mk-stats">
        {connected && yourWthru !== null
          ? <Stat label="Your WTHRU" value={yourWthru} />
          : <Stat label="Tokens launched" value={num(totals.launches)} />}
        <Stat label={<><span className="mk-wide">Trades, all time</span><span className="mk-narrow">Trades</span></>} value={num(totals.trades)} title="Every buy and sell on every launch, from the registry" />
        <Stat label="WTHRU held in curves" value={totals.held === null ? '–' : amount(totals.held)} title="WTHRU in each curve's vault, less unclaimed creator fees" />
        <Stat label="Read from chain" value={readAt ? since(readAt, now) : '–'} title={readAt ? fullUtc(readAt) : undefined} />
      </dl>
      {staleDown && <p className="why mk-stale">Not refreshed for {since(readAt, now).replace(' ago', '')}; retrying.</p>}

      {/* The phone switch between the three lists. */}
      <div className="seg mk-seg" role="tablist" aria-label="Lists">
        {[['top', 'Top'], ['new', 'New'], ['activity', 'Activity']].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={mobileTab === k} onClick={() => setMobileTab(k)}>{label}</button>
        ))}
      </div>

      <div className="mk-cols" data-mobile={mobileTab}>
        <section className="mk-main" data-part="top">
          <div className="mk-tabs-row">
            <div className="tabs mk-tabs" role="tablist">
              <button className="tab-btn" role="tab" aria-selected={tab === 'top'} onClick={() => setTab('top')}>Top tokens</button>
              <button className="tab-btn" role="tab" aria-selected={tab === 'grad'} onClick={() => setTab('grad')}>Near graduation</button>
            </div>
            <span className="fine mk-sort">{tab === 'top' ? `Sorted by ${unit} raised` : 'Sorted by curve progress'}</span>
          </div>

          <div className="mk-table" role="table" aria-label={tab === 'top' ? 'Top tokens' : 'Tokens nearest graduation'}>
            <div className="mk-tr mk-th" role="row">
              <span role="columnheader">#</span>
              <span role="columnheader">Token</span>
              <span role="columnheader">Price ({unit})</span>
              <span role="columnheader" title="From the oldest of the token's recent trades to the price its curve quotes now. Not a 24-hour figure."><span className="term">Recent</span></span>
              <span role="columnheader">Raised ({unit})</span>
              <span role="columnheader">Curve</span>
              <span role="columnheader" title="From the slot the launch started in and the chain's block time">Age</span>
            </div>
            {loading && <Skeleton rows={4} />}
            {padDown && !data && <p className="mk-note">Tokens can't be listed while the launch registry is unreadable.</p>}
            {data && rows.length === 0 && (
              <div className="mk-empty">
                <span className="empty-title">No tokens on this network yet</span>
                <p>{network.label} may have been reset recently. The first token launched will show up here.</p>
                <button className="btn sm" onClick={() => setCreating(true)} disabled={createDisabled}>Create a token</button>
              </div>
            )}
            {data && rows.length > 0 && listed.length === 0 && <p className="mk-note">Every token here has graduated.</p>}
            {listed.map((l, i) => {
              const c = changeOf(series[l.mint], l.now)
              return (
                <Link key={l.id} to={`/launch/${l.id}`} className="mk-tr" role="row">
                  <span className="mk-rank mono" role="cell">{i + 1}</span>
                  <span role="cell"><TokenCell l={l} meta={meta[l.mint]} /></span>
                  <span className="mono" role="cell">{price(l.now)}{l.unit !== unit && <small> {l.unit}</small>}</span>
                  <span className="mono" role="cell"><Change value={c} /></span>
                  <span className="mono" role="cell">{amount(l.raised)}</span>
                  <span className="mk-curve" role="cell">
                    {l.graduated
                      ? <span className="dim">Graduated</span>
                      : <><Bar progress={l.progress} /><span className="mono">{(l.progress * 100).toFixed(0)}%</span></>}
                  </span>
                  <span className="mono dim" role="cell" title={l.ageMs !== null ? `Started ~${fullUtc(now - l.ageMs)}` : undefined}>{l.ageMs !== null ? relTime(now - l.ageMs, now) : '–'}</span>
                </Link>
              )
            })}
          </div>

          {/* The same list on a phone: two lines per token. */}
          <div className="mk-compact">
            {loading && <Skeleton rows={3} />}
            {padDown && !data && <p className="mk-note">Tokens can't be listed while the launch registry is unreadable.</p>}
            {data && rows.length === 0 && (
              <div className="mk-empty">
                <span className="empty-title">No tokens on this network yet</span>
                <p>{network.label} may have been reset recently. The first token launched will show up here.</p>
              </div>
            )}
            {top.slice(0, showAll ? undefined : TOP_ROWS).map((l) => (
              <CompactToken key={l.id} l={l} meta={meta[l.mint]} right={<span className="mono">{price(l.now)}</span>}
                extra={<span className="mono mk-c-chg"><Change value={changeOf(series[l.mint], l.now)} /></span>} />
            ))}
          </div>

          <div className="mk-foot">
            <span>Names and images are set by each token's creator. ThruScan does not review them.</span>
            {rows.length > TOP_ROWS && (
              <button className="btn plain" onClick={() => setShowAll((s) => !s)}>{showAll ? `Top ${TOP_ROWS}` : 'All tokens'}</button>
            )}
          </div>
        </section>

        <aside className="mk-side">
          <section data-part="new">
            <div className="mk-side-head"><h2 className="h3">New launches</h2><span className="fine">newest first</span></div>
            <div className="mk-list">
              {loading && <Skeleton rows={3} />}
              {padDown && !data && <p className="mk-note">Unavailable while the registry is unreadable.</p>}
              {data && rows.length === 0 && <p className="mk-note">No launches yet.</p>}
              {newest.map((l) => (
                <CompactToken key={l.id} l={l} meta={meta[l.mint]}
                  right={<span className="mono dim" title={l.ageMs !== null ? fullUtc(now - l.ageMs) : undefined}>{l.ageMs !== null ? relTime(now - l.ageMs, now) : '–'}</span>} />
              ))}
            </div>
          </section>

          <section data-part="activity">
            <div className="mk-side-head"><h2 className="h3">Recent activity</h2><Link to="/activity" className="mk-viewall">View all</Link></div>
            <div className="mk-feed">
              {activity.loading && !activity.data && <Skeleton rows={3} />}
              {activity.error && !activity.data && <p className="mk-note">Activity can't be read right now.</p>}
              {activity.data && activity.data.length === 0 && <p className="mk-note">Nothing has happened on {NET} yet.</p>}
              {(activity.data ?? []).map((a) => (
                <Link key={a.signature} to={`/tx/${a.signature}`} className="mk-feed-row">
                  <span className="mk-feed-what">
                    <b>{a.label}</b>
                    {!a.ok && <span className="status-pill bad">Failed</span>}
                  </span>
                  <span className="mono dim" title={fullUtc(a.time)}>{relTime(a.time)}</span>
                </Link>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}

/** A token on two lines: name and price, then its curve. */
function CompactToken({ l, meta, right, extra }) {
  return (
    <Link to={`/launch/${l.id}`} className="mk-crow">
      <TokenIcon meta={meta} symbol={l.symbol} mint={l.mint} size={36} />
      <span className="mk-crow-body">
        <span className="mk-crow-line">
          <span className="mk-crow-name"><b>{l.name || l.symbol}</b> <span className="mono">{l.symbol}</span></span>
          {right}
        </span>
        <span className="mk-crow-line">
          <Bar progress={l.progress} graduated={l.graduated} />
          <span className="mono dim">{l.graduated ? 'Graduated' : `${(l.progress * 100).toFixed(0)}%`}</span>
          {extra}
        </span>
      </span>
    </Link>
  )
}

/** The header row: H1, the lead, and the two actions. */
function Head({ onCreate, createDisabled }) {
  return (
    <div className="mk-head">
      <div className="mk-head-text">
        <h1 className="mk-h1">ThruPad</h1>
        <p className="mk-lead">
          Launch a token on a bonding curve, trade it, and see every trade on chain.
          <span className="mk-lead-more"> Your wallet signs everything; ThruScan can pay fees but can never move your tokens.</span>
        </p>
      </div>
      {onCreate && (
        <div className="mk-actions">
          <Link className="btn secondary lg mk-get" to="/faucet">Get test tokens</Link>
          <div className="mk-create">
            <button className="btn lg" onClick={onCreate} disabled={createDisabled} aria-describedby={createDisabled ? 'mk-create-why' : undefined}>
              <Icon name="create" size={18} stroke={2} />Create a token
            </button>
            {createDisabled && <span id="mk-create-why" className="why">Paused until the registry can be read</span>}
          </div>
        </div>
      )}
    </div>
  )
}

export default MarketHome
