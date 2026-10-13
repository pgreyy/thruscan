// src/pages/Market.jsx
//
// The front page: ThruPad (Core Screens 3a-3e, Update 02 5c).
//
// The title and the two actions, the "New here?" steps, what is trending,
// then every token under five tabs (market cap, new, active, near graduation,
// graduated), across the full width. On a phone the Launch tab in the bottom
// bar is the way to create a token, so the title stands alone. Everything here is read from the chain or the indexer; where a
// number cannot be read the page says so in place rather than leaving a hole.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { allTokenMeta } from '../lib/tokenmeta.js'
import { THRUPAD_PROGRAM, THRUPAD_REGISTRY, WTHRU_MINT } from '../lib/addresses.js'
import { network } from '../lib/networks.js'
import { hasWallet } from '../lib/wallet.js'
import { relTime, fullUtc, clock, since } from '../lib/when.js'
import { usePadMarket } from '../lib/padmarket.js'
import { TokenIcon } from '../components/TokenMeta.jsx'
import { Icon } from '../components/Icon.jsx'
import { EXTENSION_URL } from '../lib/external.js'
import { useWallet } from './Wallet.jsx'
import { CreateLaunchCard, compactNumber } from './Dex.jsx'
import './market.css'

const TOP_ROWS = 10
const TRENDING = 10

/* ---------- formatting ---------- */

/** A price with sensible precision: 0.00042180, 0.0123, 1.23, 1,234. */
function price(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–'
  if (v === 0) return '0'
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 })
  return v.toLocaleString('en-US', { maximumSignificantDigits: 4, minimumSignificantDigits: 4 })
}

/** A market cap to one decimal place, like the design. */
const cap = (v) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '–')

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

/* One step. "Get a wallet" leaves the site for the Chrome Web Store, so it is a
   plain link that opens a new tab; the rest are routes. */
function Step({ s, n, children }) {
  const cls = `mk-step${s.done ? ' done' : ''}`
  const body = (
    <>
      <span className="mk-step-n" aria-hidden="true">{s.done ? <Icon name="success" size={14} stroke={2.2} /> : n}</span>
      <span className="mk-step-t"><b>{s.title}{s.href && <Icon name="external" size={14} />}</b><span>{s.sub}</span></span>
      {children}
    </>
  )
  return s.href
    ? <a href={s.href} target="_blank" rel="noopener noreferrer" className={cls}>{body}</a>
    : <Link to={s.to} className={cls}>{body}</Link>
}

function NewHere({ steps, onClose }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="mk-intro" aria-label="New here? Four steps to your first trade">
      <div className="mk-intro-lead"><b>New here?</b></div>
      {steps.map((s, i) => (
        <Step key={s.title} s={s} n={i + 1}>{s.done && <span className="sr-only">(done)</span>}</Step>
      ))}
      <button className="mk-intro-x" onClick={onClose} aria-label="Hide these steps for good"><Icon name="failed" size={16} /></button>

      {/* The phone version: one row that opens the same four steps. */}
      <button className="mk-intro-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <b>New here?</b><span>4 steps to your first trade</span>
        <Icon name={open ? 'expand' : 'arrow-right'} size={16} />
      </button>
      {open && (
        <div className="mk-intro-list">
          {steps.map((s, i) => <Step key={s.title} s={s} n={i + 1} />)}
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

/* ---------- Trending (5c) ----------
 * Top ten by trades in the last 24 hours, then by WTHRU traded. Hidden until
 * at least three tokens have traded, because a "trending" row of one is a
 * list of whatever happened last. Swipe on touch; the arrows move one card
 * and hide at the ends. */

function Trending({ rows, meta }) {
  const track = useRef(null)
  const [ends, setEnds] = useState({ start: true, end: false })
  const list = useMemo(() => rows
    .filter((r) => r.day?.count > 0)
    .sort((a, b) => (b.day.count - a.day.count) || (b.day.volume - a.day.volume))
    .slice(0, TRENDING), [rows])

  const measure = useCallback(() => {
    const el = track.current
    if (!el) return
    setEnds({ start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 })
  }, [])
  useEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure, list.length])

  if (list.length < 3) return null
  const step = (dir) => {
    const el = track.current
    const card = el?.querySelector('.mk-tcard')
    if (!el || !card) return
    el.scrollBy({ left: dir * (card.getBoundingClientRect().width + 16), behavior: 'smooth' })
  }

  return (
    <section className="mk-trend" aria-label="Trending">
      <div className="mk-trend-head">
        <h2>Trending</h2>
        <div className="mk-trend-nav">
          <button type="button" className="mk-round" onClick={() => step(-1)} aria-label="Previous" disabled={ends.start} style={{ visibility: ends.start ? 'hidden' : undefined }}><Icon name="chevron-left" size={18} /></button>
          <button type="button" className="mk-round" onClick={() => step(1)} aria-label="Next" disabled={ends.end} style={{ visibility: ends.end ? 'hidden' : undefined }}><Icon name="chevron-right" size={18} /></button>
        </div>
      </div>
      <div className="mk-trend-track" ref={track} onScroll={measure}>
        {list.map((l, i) => (
          <Link key={l.id} to={`/launch/${l.id}`} className="mk-tcard">
            <span className="mk-tcard-art">
              {meta[l.mint]?.image
                ? <img src={meta[l.mint].image} alt="" loading="lazy" />
                : <span className="mono">{l.symbol.replace(/^\$/, '').slice(0, 2).toUpperCase()}</span>}
            </span>
            <span className="mk-tcard-name"><span className="mono dim">{i + 1}</span> <b>{l.name || l.symbol}</b></span>
            <span className="mk-tcard-cap">
              <span className="mono">{compactNumber(l.cap)} {l.unit}</span>
              <span className="mono"><Change value={l.day?.change ?? null} /></span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  )
}

/* ---------- the list tabs ---------- */

const TABS = [
  { key: 'cap', label: 'Market cap' },
  { key: 'new', label: 'New' },
  { key: 'active', label: 'Active' },
  { key: 'grad', label: 'Near graduation' },
  { key: 'done', label: 'Graduated' },
]

function sorted(rows, tab) {
  switch (tab) {
    case 'new': return [...rows].sort((a, b) => b.id - a.id)
    case 'active': return [...rows].sort((a, b) => ((b.day?.count ?? -1) - (a.day?.count ?? -1)) || (b.trades - a.trades))
    case 'grad': return rows.filter((r) => !r.graduated && r.progress >= 0.5).sort((a, b) => b.progress - a.progress)
    case 'done': return rows.filter((r) => r.graduated)
    default: return [...rows].sort((a, b) => (b.cap ?? -1) - (a.cap ?? -1))
  }
}

const EMPTY_TAB = {
  grad: 'No token is past half of its curve yet.',
  done: 'No token has graduated on this network yet.',
}

/* ---------- the page ---------- */

export function MarketHome({ create = false }) {
  const navigate = useNavigate()
  const [tab, setTab] = useState('cap')
  const [showAll, setShowAll] = useState(false)
  const [meta, setMeta] = useState({})
  const now = useNow()
  const wallet = useWallet()
  const connected = !!wallet.address && hasWallet()
  const intro = useIntro(connected)

  const overview = usePoll(readOverview, 5000)
  const pad = usePadMarket(overview.data)
  const readAt = pad.readAt ?? null

  useEffect(() => {
    let alive = true
    const read = () => allTokenMeta().then((m) => { if (alive) setMeta(m) }).catch(() => {})
    read()
    const id = setInterval(() => { if (!document.hidden) read() }, 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const { data, rows } = pad
  const listedAll = sorted(rows, tab)
  const listed = listedAll.slice(0, showAll ? undefined : TOP_ROWS)
  const unit = rows.length && rows.every((r) => r.unit === rows[0].unit) ? rows[0].unit : 'WTHRU'

  const wthru = wallet.balances?.[WTHRU_MINT]
  const steps = [
    { title: 'Get a wallet', sub: 'ThruScan Wallet for Chrome', href: EXTENSION_URL, done: hasWallet() },
    { title: 'Get test tokens', sub: 'THRU from the faucet', to: '/faucet', done: (wallet.native ?? 0n) > 0n },
    { title: 'Swap for WTHRU', sub: 'Launches are priced in WTHRU', to: '/swap', done: !!(wthru?.exists && wthru.amount > 0n) },
    { title: 'Launch or trade', sub: 'Then check the Explorer', to: '/explorer?tab=activity', done: !!wallet.address && rows.some((r) => r.creator === wallet.address) },
  ]

  const padDown = !!pad.error
  const staleDown = !pad.error && data && readAt && now - readAt > 30_000
  const startCreate = () => { navigate('/create'); window.scrollTo({ top: 0 }) }

  if (!THRUPAD_PROGRAM || !THRUPAD_REGISTRY) {
    return (
      <div className="page mk">
        <Head onCreate={null} />
        <section className="empty">
          <span className="empty-title">ThruPad isn't running on this network yet</span>
          <p>Swap, the Explorer and your wallet still work. Launches will appear here once the ThruPad program is deployed and configured.</p>
          <div className="mk-actions-row">
            <Link className="btn secondary" to="/swap">Go to Swap</Link>
            <Link className="btn tertiary" to="/explorer">Open Explorer</Link>
          </div>
        </section>
      </div>
    )
  }

  if (create) {
    return (
      <div className="page mk-create-page">
        <CreateLaunchCard
          nextId={data ? (data.launches.reduce((m, l) => Math.max(m, l.id), -1) + 1) : 0}
          registry={THRUPAD_REGISTRY}
          threshold={data?.gradThreshold}
          registryDown={padDown}
          onClose={() => navigate('/')}
          onLaunched={pad.reload}
        />
      </div>
    )
  }

  const loading = pad.loading && !data
  const age = (l) => (l.ageMs !== null ? relTime(now - l.ageMs, now) : '–')

  return (
    <div className="page mk">
      <Head createDisabled={padDown} onCreate={startCreate} />

      {intro.show && <NewHere steps={steps} onClose={intro.dismiss} />}

      {padDown && (
        <Warn onRetry={() => pad.reload()}>
          <b>The launch registry can't be read right now.</b>{' '}
          {readAt ? `The list below is from ${clock(readAt)} and may be out of date.` : 'Launches, prices and trading are unavailable until it reads again.'}
        </Warn>
      )}
      {staleDown && <p className="why mk-stale">Not refreshed for {since(readAt, now).replace(' ago', '')}; retrying.</p>}

      <Trending rows={rows} meta={meta} />

      <div className="mk-cols">
        <section className="mk-main">
          <div className="tabs mk-tabs" role="tablist" aria-label="Token lists">
            {TABS.map((t) => (
              <button key={t.key} className="tab-btn" role="tab" aria-selected={tab === t.key} onClick={() => { setTab(t.key); setShowAll(false) }}>{t.label}</button>
            ))}
          </div>

          <div className="mk-table" role="table" aria-label={TABS.find((t) => t.key === tab).label}>
            <div className="mk-tr mk-th" role="row">
              <span role="columnheader">#</span>
              <span role="columnheader">Token</span>
              <span role="columnheader">Price ({unit})</span>
              <span role="columnheader" title="Against the last trade before 24 hours ago, or the oldest trade read when the history is shorter">24 h</span>
              <span role="columnheader" title="Curve price × total supply">Market cap ({unit})</span>
              <span role="columnheader">Curve</span>
              <span role="columnheader" title="From the slot the launch started in and the chain's block time">Age</span>
            </div>
            {loading && <Skeleton rows={4} />}
            {padDown && !data && <p className="mk-note">Tokens can't be listed while the launch registry is unreadable.</p>}
            {data && rows.length === 0 && (
              <div className="mk-empty">
                <span className="empty-title">No tokens on this network yet</span>
                <p>{network.label} may have been reset recently. The first token launched will show up here.</p>
                <button className="btn sm" onClick={startCreate} disabled={padDown}>Create a token</button>
              </div>
            )}
            {data && rows.length > 0 && listed.length === 0 && <p className="mk-note">{EMPTY_TAB[tab] ?? 'Nothing here yet.'}</p>}
            {listed.map((l, i) => (
              <Link key={l.id} to={`/launch/${l.id}`} className="mk-tr" role="row">
                <span className="mk-rank mono" role="cell">{i + 1}</span>
                <span role="cell"><TokenCell l={l} meta={meta[l.mint]} /></span>
                <span className="mono" role="cell">{price(l.now)}{l.unit !== unit && <small> {l.unit}</small>}</span>
                <span className="mono" role="cell"><Change value={l.day?.change ?? null} /></span>
                <span className="mono" role="cell">{cap(l.cap)}</span>
                <span className="mk-curve" role="cell">
                  {l.graduated
                    ? <span className="dim">Graduated</span>
                    : <><Bar progress={l.progress} /><span className="mono">{(l.progress * 100).toFixed(0)}%</span></>}
                </span>
                <span className="mono dim" role="cell" title={l.ageMs !== null ? `Started ~${fullUtc(now - l.ageMs)}` : undefined}>{age(l)}</span>
              </Link>
            ))}
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
            {data && rows.length > 0 && listed.length === 0 && <p className="mk-note">{EMPTY_TAB[tab] ?? 'Nothing here yet.'}</p>}
            {listed.map((l) => (
              <Link key={l.id} to={`/launch/${l.id}`} className="mk-crow">
                <TokenIcon meta={meta[l.mint]} symbol={l.symbol} mint={l.mint} size={36} />
                <span className="mk-crow-body">
                  <span className="mk-crow-line">
                    <span className="mk-crow-name"><b>{l.name || l.symbol}</b></span>
                    <span className="mono mk-c-chg"><Change value={l.day?.change ?? null} /></span>
                  </span>
                  <span className="mk-crow-line">
                    <span className="mono dim">MC {cap(l.cap)} {l.unit} · {age(l)}</span>
                  </span>
                </span>
              </Link>
            ))}
          </div>

          <div className="mk-foot">
            <span>Names and images are set by each token's creator. ThruScan does not review them.</span>
            {listedAll.length > TOP_ROWS && (
              <button className="btn plain" onClick={() => setShowAll((s) => !s)}>{showAll ? `Top ${TOP_ROWS}` : 'All tokens'}</button>
            )}
          </div>
        </section>

      </div>
    </div>
  )
}

/** The header row: the H1 and the two actions, on one line. */
function Head({ onCreate, createDisabled }) {
  return (
    <div className="mk-head">
      <h1 className="mk-h1">ThruPad</h1>
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
