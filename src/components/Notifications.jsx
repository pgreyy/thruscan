// src/components/Notifications.jsx
//
// The bell (Update 02, 5b) and the watchers that fill it.
//
// `NotificationWatch` runs once, in the shell, so it watches whatever page
// someone is on. It looks for the three things the wallet does not sign
// itself: wall messages addressed to it, tokens arriving in it, and creator
// fees building up on tokens it launched. The wallet's own transactions are
// added by the tx flow the moment they land or fail (lib/txflow.js).
//
// Pixel Pal sales are still read from the market's sales ring, because the
// seller signs nothing and would otherwise never hear about it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useDismiss } from '../lib/dismiss.js'
import { currentAddress, hasWallet } from '../lib/wallet.js'
import { connectWallet } from '../lib/connect.js'
import { getAccount } from '../lib/rpcClient.js'
import { decodeWall } from '../lib/wall.js'
import { decodePadRegistry } from '../lib/pad.js'
import { displayDecimals } from '../lib/wthru.js'
import { relTime } from '../lib/when.js'
import { WALL_ACCOUNT, THRUPAD_REGISTRY, WTHRU_MINT, TUSD_MINT } from '../lib/addresses.js'
import { useWallet } from '../pages/Wallet.jsx'
import * as notes from '../lib/notify.js'
import { Icon } from './Icon.jsx'

const WALL_MS = 10_000
const FEES_MS = 30_000
const BALANCE_MS = 30_000
const PALS_MS = 30_000

const short = (a) => (a ? `${a.slice(0, 5)}…${a.slice(-4)}` : '')
const fmt = (units, decimals) => {
  const n = Number(units ?? 0n) / 10 ** decimals
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 2 : 4 }) : '0'
}
const quoteName = (mint) => (mint === WTHRU_MINT ? 'WTHRU' : mint === TUSD_MINT ? 'tUSD' : 'tokens')

/** The connected address, followed as the wallet opens, locks or switches. */
function useAddress() {
  const [address, setAddress] = useState(() => currentAddress())
  useEffect(() => {
    const t = setInterval(() => setAddress((a) => (currentAddress() === a ? a : currentAddress())), 2000)
    return () => clearInterval(t)
  }, [])
  return address
}

/** The store for one address, re-read whenever it changes. */
function useNotes(address) {
  const [, bump] = useState(0)
  useEffect(() => notes.subscribe(() => bump((n) => n + 1)), [])
  const list = notes.items(address)
  const seen = notes.seenAt(address)
  const unread = list.filter((n) => notes.isUnread(n, seen)).length
  return { list, seen, unread }
}

/* ---------- the watchers ---------- */

/** Polls on an interval while the tab is visible, and once on wake. */
function usePoll(fn, ms, deps) {
  useEffect(() => {
    let alive = true
    const run = () => { if (alive && !document.hidden) fn() }
    run()
    const t = setInterval(run, ms)
    document.addEventListener('visibilitychange', run)
    const stop = notes.onRefreshRequest(() => { setTimeout(run, 1200); setTimeout(run, 6000) })
    return () => { alive = false; clearInterval(t); document.removeEventListener('visibilitychange', run); stop() }
  }, deps)  // eslint-disable-line react-hooks/exhaustive-deps
}

export function NotificationWatch() {
  const address = useAddress()
  const wallet = useWallet()

  /* Wall messages to you: every post whose recipient is this address. The
     program resolves a .id to its address when the post is written, so an
     address match covers both. */
  usePoll(async () => {
    if (!address || !WALL_ACCOUNT) return
    try {
      const acc = await getAccount(WALL_ACCOUNT)
      const wall = decodeWall(acc.data?.base64)
      const mine = wall.entries.filter((e) => e.to === address && e.poster !== address)
      if (!mine.length) return
      notes.add(address, mine.map((e) => ({
        type: 'wall',
        key: `wall:${e.postedAtNs}:${e.poster}`,
        title: 'New message on your Wall',
        body: `"${e.message.length > 60 ? `${e.message.slice(0, 60)}…` : e.message}"`,
        meta: `from ${e.name || short(e.poster)}`,
        at: e.postedAt.getTime(),
        to: '/explorer?tab=wall&filter=to-you',
      })))
    } catch { /* the next poll tries again */ }
  }, WALL_MS, [address])

  /* Creator fees: once when a launch's unclaimed fees go above zero, then
     again only after they have been claimed back to zero. */
  usePoll(async () => {
    if (!address || !THRUPAD_REGISTRY) return
    try {
      const acc = await getAccount(THRUPAD_REGISTRY)
      const reg = decodePadRegistry(acc.data?.base64)
      const fresh = []
      for (const l of reg.launches.filter((x) => x.creator === address)) {
        const owed = l.creatorFees ?? 0n
        if (owed <= 0n) { notes.setFeeArmed(address, l.id, true); continue }
        if (!notes.feeArmed(address, l.id)) continue
        notes.setFeeArmed(address, l.id, false)
        const qd = wallet.decimals?.[l.quoteMint] ?? displayDecimals(l.quoteMint, 6)
        fresh.push({
          type: 'fees',
          key: `fees:${l.id}:${Date.now()}`,
          title: 'Creator fees ready to claim',
          body: `${fmt(owed, qd)} ${quoteName(l.quoteMint)} unclaimed on ${l.symbol || `#${l.id}`}`,
          to: `/launch/${l.id}#creator-fees`,
          launchId: l.id,
        })
      }
      if (fresh.length) notes.add(address, fresh)
    } catch { /* the next poll tries again */ }
  }, FEES_MS, [address])

  /* Tokens received: a balance that rises when this wallet has not just done
     something itself. The faucet, a send from someone else, an NFT. */
  const last = useRef({ address: null, native: null, balances: {} })
  useEffect(() => {
    if (!address) return undefined
    const t = setInterval(() => { if (!document.hidden) wallet.refresh() }, BALANCE_MS)
    return () => clearInterval(t)
  }, [address])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!address || wallet.address !== address) return
    const prev = last.current
    const snap = { address, native: wallet.native ?? null, balances: { ...(wallet.balances ?? {}) } }
    last.current = snap
    if (prev.address !== address || notes.ownTxRecently()) return
    const fresh = []
    if (prev.native !== null && snap.native !== null && snap.native > prev.native) {
      fresh.push({ type: 'received', key: `recv:native:${snap.native}`, title: 'Received tokens', body: `${(snap.native - prev.native).toLocaleString('en-US')} THRU` })
    }
    for (const [mint, b] of Object.entries(snap.balances)) {
      const was = prev.balances[mint]
      if (!was || !b?.exists || !(b.amount > (was.exists ? was.amount : 0n))) continue
      const d = wallet.decimals?.[mint] ?? displayDecimals(mint, 6)
      const ticker = wallet.tickers?.[mint] || short(mint)
      fresh.push({ type: 'received', key: `recv:${mint}:${b.amount}`, title: 'Received tokens', body: `${fmt(b.amount - (was.exists ? was.amount : 0n), d)} ${ticker}`, to: `/profile` })
    }
    if (fresh.length) notes.add(address, fresh)
  }, [address, wallet.address, wallet.native, wallet.balances, wallet.decimals, wallet.tickers])

  /* Pixel Pal sales from the market's ring. */
  usePoll(async () => {
    if (!address) return
    try {
      const r = await fetch(`/api/rpc?action=pals&wallet=${encodeURIComponent(address)}`)
      const j = await r.json()
      if (!j.ok) return
      const mine = (j.market?.recent ?? []).filter((s) => s.seller === address || s.buyer === address)
      notes.add(address, mine.map((s) => {
        const sold = s.seller === address
        return {
          type: 'trade',
          key: `sale:${s.slot}:${s.id}:${sold ? 'sold' : 'bought'}`,
          side: sold ? 'sell' : 'buy',
          title: sold ? `Pixel Pal #${s.id} sold` : `You bought Pixel Pal #${s.id}`,
          body: `${Number(s.price ?? 0).toLocaleString('en-US')} THRU`,
          at: s.time ?? Date.now(),
          to: '/pixelpals',
        }
      }))
    } catch { /* a missed poll is a missed poll */ }
  }, PALS_MS, [address])

  return null
}

/* ---------- the list ---------- */

const ICON_OF = { wall: 'message', trade: 'swap', fees: 'coins', received: 'receive', tx: 'success' }

function toneOf(n) {
  if (n.ok === false) return 'negative'
  if (n.type === 'fees' || n.type === 'wall') return 'brand'
  if (n.type === 'received' || n.side === 'buy') return 'positive'
  if (n.side === 'sell') return 'negative'
  return 'neutral'
}

function Item({ n, unread, onOpen, mobile }) {
  const icon = n.ok === false ? 'failed' : ICON_OF[n.type] ?? 'success'
  const meta = [n.meta ?? (n.sig ? short(n.sig) : null), n.at ? relTime(n.at) : null].filter(Boolean).join(' · ')
  return (
    <div className={`nt-item${unread ? ' unread' : ''}`}>
      <button type="button" className="nt-item-main" onClick={() => onOpen(n)}>
        <span className={`nt-ic ${toneOf(n)}`} aria-hidden="true"><Icon name={icon} size={mobile ? 18 : 16} stroke={1.8} /></span>
        <span className="nt-text">
          <b>{n.title}</b>
          {n.body && <span className="nt-body">{n.body}</span>}
          {meta && <span className="nt-meta mono">{meta}</span>}
        </span>
        {unread && <span className="nt-dot" aria-label="Unread" />}
      </button>
      {mobile && n.type === 'fees' && n.launchId !== undefined && (
        <button type="button" className="btn sm nt-claim" onClick={() => onOpen(n)}>Claim</button>
      )}
    </div>
  )
}

function Panel({ address, onClose, mobile }) {
  const navigate = useNavigate()
  const { list, seen, unread } = useNotes(address)
  const [filter, setFilter] = useState('all')
  const shown = useMemo(() => {
    const f = notes.FILTERS.find((x) => x.id === filter)
    return f?.types ? list.filter((n) => f.types.includes(n.type)) : list
  }, [list, filter])

  const open = (n) => {
    notes.markRead(address, n.id)
    onClose()
    if (n.to) navigate(n.to)
  }

  const wallet = hasWallet() && address
  return (
    <>
      <div className="nt-head">
        {mobile && <button type="button" className="bar-icon nt-back" onClick={onClose} aria-label="Back"><Icon name="arrow-left" /></button>}
        <h2>Notifications</h2>
        {wallet && unread > 0 && <button type="button" className="btn plain nt-markall" onClick={() => notes.markAllRead(address)}>Mark all read</button>}
      </div>
      {!wallet ? (
        <div className="nt-empty">
          <p>Connect a wallet to get notifications.</p>
          <button type="button" className="btn" onClick={() => { onClose(); connectWallet() }}><Icon name="wallet" size={18} />Connect</button>
        </div>
      ) : (
        <>
          <div className="chips nt-chips" role="group" aria-label="Filter notifications">
            {notes.FILTERS.map((f) => (
              <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
            ))}
          </div>
          <div className="nt-list">
            {shown.length === 0
              ? <p className="nt-none">Nothing yet. Trades, wall messages and fees for this wallet show up here.</p>
              : shown.map((n) => <Item key={n.id} n={n} unread={notes.isUnread(n, seen)} onOpen={open} mobile={mobile} />)}
          </div>
          <div className="nt-foot">
            <Link to={`/explorer?tab=activity&address=${address}`} onClick={onClose}>See your activity in Explorer</Link>
          </div>
        </>
      )}
    </>
  )
}

/* ---------- the bell ---------- */

/**
 * The bell: a popover anchored right on a desktop, a full-screen page on a
 * phone. New items are announced politely; opening it marks nothing read.
 */
export function NotificationBell({ mobile = false }) {
  const address = useAddress()
  const { pathname } = useLocation()
  const { unread } = useNotes(address)
  const [openOn, setOpenOn] = useState(null)
  const open = openOn === pathname
  const close = useCallback(() => setOpenOn(null), [])
  const box = useRef(null)
  const [said, setSaid] = useState('')

  useDismiss(box, open && !mobile, close)

  useEffect(() => notes.subscribe((who, fresh) => {
    if (who === address && fresh?.length) setSaid(fresh.length === 1 ? `New notification: ${fresh[0].title}` : `${fresh.length} new notifications`)
  }), [address])

  useEffect(() => {
    if (!open) return undefined
    const key = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [open, close])

  const label = `Notifications, ${unread} unread`
  return (
    <div className={`nt${mobile ? ' nt-mobile' : ''}`} ref={box}>
      <button
        type="button" className={mobile ? 'bar-icon nt-btn' : 'nt-btn nt-btn-desk'}
        onClick={() => setOpenOn(open ? null : pathname)} aria-label={label} aria-expanded={open} aria-haspopup="dialog"
      >
        <Icon name="bell" size={20} />
        {unread > 0 && <span className="nt-badge mono" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
      </button>
      <span className="sr-only" aria-live="polite">{said}</span>
      {open && !mobile && (
        <div className="nt-pop" role="dialog" aria-label="Notifications">
          <Panel address={address} onClose={close} />
        </div>
      )}
      {open && mobile && createPortal(
        <div className="nt-sheet" role="dialog" aria-modal="true" aria-label="Notifications">
          <Panel address={address} onClose={close} mobile />
        </div>,
        document.body,
      )}
    </div>
  )
}

export default NotificationBell
