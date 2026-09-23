// src/components/Notifications.jsx
//
// The bell, and the thing that fills it.
//
// `useMarketWatch` runs once, in the shell, so it is watching whatever page
// someone is on. It reads the market's sales ring and turns anything naming
// this wallet into a notification: see src/lib/notify.js for why a sale has to
// be found this way rather than announced when it happens.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { currentAddress } from '../lib/wallet.js'
import * as notes from '../lib/notify.js'

const POLL_MS = 30_000
const fmt = (n) => Number(n ?? 0).toLocaleString('en-US')

const ago = (ms) => {
  if (!ms) return ''
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

/* ---------- watching the chain ---------- */

export function useMarketWatch(address) {
  const seen = useRef(null)

  useEffect(() => {
    if (!address) return undefined
    let alive = true
    seen.current = null

    const look = async () => {
      try {
        const r = await fetch(`/api/rpc?action=pals&wallet=${encodeURIComponent(address)}`)
        const j = await r.json()
        if (!alive || !j.ok) return
        const sales = j.market?.recent ?? []
        const cutoff = notes.historyCutoff(address)

        const mine = []
        for (const s of sales) {
          const sold = s.seller === address
          const bought = s.buyer === address
          if (!sold && !bought) continue
          // A sale with no time yet is recent by definition: the API only looks
          // up times for the newest few, so treat a missing one as now.
          const at = s.time ?? Date.now()
          if (at < cutoff) continue
          mine.push({
            id: `sale:${s.slot}:${s.id}:${sold ? 'sold' : 'bought'}`,
            kind: sold ? 'sold' : 'bought',
            at,
            title: sold ? `Pixel Pal #${s.id} sold` : `You bought Pixel Pal #${s.id}`,
            body: sold
              ? `${fmt(s.price)} THRU, paid into your wrapped THRU balance`
              : `${fmt(s.price)} THRU`,
            to: '/pals',
          })
        }
        if (mine.length) notes.addMany(address, mine)
        seen.current = Date.now()
      } catch { /* a missed poll is a missed poll; the ring is still there */ }
    }

    look()
    const t = setInterval(() => { if (!document.hidden) look() }, POLL_MS)
    const wake = () => { if (!document.hidden) look() }
    document.addEventListener('visibilitychange', wake)
    // A purchase asks for a look straight away, twice: the market account and
    // the block time both take a moment to catch up with a transaction that has
    // only just landed.
    const stop = notes.onRefreshRequest(() => {
      setTimeout(look, 1200)
      setTimeout(look, 6000)
    })
    return () => {
      alive = false; clearInterval(t); stop()
      document.removeEventListener('visibilitychange', wake)
    }
  }, [address])
}

/* ---------- the bell ---------- */

export function NotificationBell() {
  const [address, setAddress] = useState(() => currentAddress())
  const [open, setOpen] = useState(false)
  const [, bump] = useState(0)
  const boxRef = useRef(null)

  // The wallet can be opened, unlocked or switched while the bar is on screen,
  // and none of that re-renders this on its own.
  useEffect(() => {
    const t = setInterval(() => setAddress((a) => (currentAddress() === a ? a : currentAddress())), 2000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => notes.subscribe(() => bump((n) => n + 1)), [])
  useMarketWatch(address)

  useEffect(() => {
    if (!open) return undefined
    const away = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    const key = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key) }
  }, [open])

  const list = notes.items(address)
  const unread = list.filter((n) => !n.read).length

  const toggle = useCallback(() => {
    setOpen((v) => {
      if (!v && unread) setTimeout(() => notes.markAllRead(address), 900)
      return !v
    })
  }, [address, unread])

  return (
    <div className="bell" ref={boxRef}>
      <button
        className="bell-btn"
        onClick={toggle}
        aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}
        aria-expanded={open}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && <span className="bell-dot" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className="bell-menu" role="dialog" aria-label="Notifications">
          <div className="bell-head">
            <b>Notifications</b>
            {list.length > 0 && (
              <button className="bell-clear" onClick={() => notes.clear(address)}>Clear</button>
            )}
          </div>

          {!address ? (
            <p className="fine bell-none">Open a wallet and anything that happens to it shows up here.</p>
          ) : list.length === 0 ? (
            <p className="fine bell-none">Nothing yet. Sales, purchases and anything else that touches your wallet land here.</p>
          ) : (
            <div className="bell-list">
              {list.map((n) => (
                <Link key={n.id} to={n.to ?? '/'} className={`bell-item${n.read ? '' : ' new'}`} onClick={() => setOpen(false)}>
                  <span className={`bell-kind bell-${n.kind}`} aria-hidden="true" />
                  <span>
                    <b>{n.title}</b>
                    <i>{n.body}</i>
                  </span>
                  <span className="bell-when">{ago(n.at)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default NotificationBell
