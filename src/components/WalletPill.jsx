// src/components/WalletPill.jsx
//
// The wallet, where a wallet goes: top right, always there, never a nav item.
//
// A navigation rail is for places. A wallet is not a place, it is a thing you
// carry, and it needs to be visible on the Swap page at the moment you are
// deciding whether to trade rather than one click away in a list. Every app
// that has solved this puts it in the same corner, so this does too.
//
// It renders through a portal into a fixed container rather than into whatever
// header happens to exist, so it sits correctly without this file knowing
// anything about the page's layout. That also means it survives a redesign of
// the rail without needing to be found and re-parented.
//
// Three states:
//   no wallet    a quiet "Connect wallet" that goes to the Wallet page
//   locked       the address, and a tap to unlock
//   unlocked     balance, a wallet button, address, and a panel with the rest

import { useEffect, useMemo, useRef, useState } from 'react'
import './wallet-pill.css'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useWallet } from '../pages/Wallet.jsx'
import { locked, unlock } from '../lib/wallet.js'
import { hasWallet, storedWallet } from '../lib/wallet.js'
import { TUSD_MINT } from '../lib/addresses.js'
import { withSuffix } from '../lib/names.js'
import { ownedNames, knownMints } from '../lib/holdings.js'
import { isExternal, externalName, hasProvider, connectExternal, disconnectExternal, EXTENSION_URL } from '../lib/external.js'

const DECIMALS = 6

function fmt(units, decimals = DECIMALS, maxFrac = 2) {
  const n = Number(units ?? 0n) / 10 ** decimals
  if (!isFinite(n)) return '0'
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac })
}

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

/** The first `.id` name this browser claimed for an address, if any. */
function primaryName(address) {
  if (!address) return null
  try {
    const held = JSON.parse(localStorage.getItem(`thruscan.names.${address}`) || '[]')
    return held.length ? withSuffix(held[0]) : null
  } catch { return null }
}

/**
 * An identicon from the address itself.
 *
 * Four coloured cells from a cheap hash. It is not decoration: two addresses
 * that differ only in the middle look identical when truncated, and a glance at
 * the wrong-coloured square is faster than reading six characters.
 */
function Avatar({ address, size = 20 }) {
  const cells = useMemo(() => {
    let h = 0
    for (let i = 0; i < (address?.length ?? 0); i++) h = (h * 31 + address.charCodeAt(i)) >>> 0
    return [0, 1, 2, 3].map((i) => `hsl(${(h >> (i * 7)) % 360} 62% 55%)`)
  }, [address])

  if (!address) return null
  return (
    <span
      aria-hidden="true"
      style={{
        width: size, height: size, borderRadius: 6, overflow: 'hidden',
        display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr',
        flex: `0 0 ${size}px`,
      }}
    >
      {cells.map((c, i) => <span key={i} style={{ background: c }} />)}
    </span>
  )
}

/** A wallet, drawn small. Inherits colour, so it works on either theme. */
function WalletGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 7.5V17" />
      <path d="M16 12.5h1.5" />
    </svg>
  )
}

function CopyRow({ label, value }) {
  const [done, setDone] = useState(false)
  if (!value) return null
  return (
    <button
      className="pill-row"
      title={value}
      onClick={() => {
        navigator.clipboard?.writeText(value)
        setDone(true)
        setTimeout(() => setDone(false), 1400)
      }}
    >
      <span>{label}</span>
      <span className="mono">{done ? 'Copied' : short(value)}</span>
    </button>
  )
}

function Panel({ wallet, onClose }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const doUnlock = async () => {
    setBusy(true); setError(null)
    try {
      await unlock(password)
      setPassword('')
      await wallet.refresh()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  if (!wallet.unlocked) {
    return (
      <div className="pill-panel">
        <p className="fine" style={{ marginBottom: 10 }}>Locked</p>
        <input
          className="field"
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && password) doUnlock() }}
          placeholder="Password"
          autoComplete="current-password"
        />
        <button className="btn" style={{ marginTop: 8, width: '100%' }} onClick={doUnlock} disabled={busy || !password}>
          {busy ? 'Unlocking' : 'Unlock'}
        </button>
        {error && <p className="notice bad" style={{ marginTop: 10 }}>{error}</p>}
        {hasProvider() && (
          <button className="btn ghost" style={{ marginTop: 8, width: '100%' }}
            onClick={() => connectExternal().then(onClose).catch((e) => setError(String(e?.message ?? e)))}>
            Use ThruScan Wallet instead
          </button>
        )}
      </div>
    )
  }

  const rows = Object.entries(wallet.balances ?? {})
    .filter(([, b]) => b?.exists)
    .map(([mint, b]) => ({
      mint,
      ticker: wallet.tickers?.[mint] || short(mint),
      amount: fmt(b.amount, wallet.decimals?.[mint] ?? DECIMALS, 4),
    }))

  return (
    <div className="pill-panel">
      {primaryName(wallet.address) && (
        <div className="pill-row" style={{ cursor: 'default' }}>
          <span className="fine">Name</span>
          <b>{primaryName(wallet.address)}</b>
        </div>
      )}
      <CopyRow label="Address" value={wallet.address} />

      <div className="pill-divider" />

      {/* THRU first: it is the chain's own asset, not a footnote about fees. */}
      <div className="pill-row" style={{ cursor: 'default' }}>
        <span>THRU</span>
        <span className="mono">{Number(wallet.native ?? 0n).toLocaleString()}</span>
      </div>
      {rows.map((r) => (
        <Link className="pill-row" key={r.mint} to={`/token/${r.mint}`} onClick={onClose}>
          <span>{r.ticker}</span>
          <span className="mono">{r.amount}</span>
        </Link>
      ))}

      <div className="pill-divider" />

      <Link className="pill-row" to="/profile" onClick={onClose}><span>Profile</span><span>→</span></Link>
      <Link className="pill-row" to="/wallet" onClick={onClose}><span>Wallet</span><span>→</span></Link>
      {!isExternal() && (hasProvider()
        ? (
          <button className="pill-row" onClick={() => connectExternal().then(onClose).catch(() => {})}>
            <span>Use ThruScan Wallet</span><span className="fine">extension</span>
          </button>
        )
        : (
          <a className="pill-row" href={EXTENSION_URL} target="_blank" rel="noreferrer">
            <span>Get ThruScan Wallet</span><span>↗</span>
          </a>
        ))}

      <div className="pill-divider" />

      {isExternal() ? (
        <button className="pill-row" onClick={() => { disconnectExternal(); onClose() }}>
          <span>Disconnect</span><span className="fine">{externalName()}</span>
        </button>
      ) : (
        <button
          className="pill-row"
          onClick={() => { locked(); wallet.setState({ unlocked: false, balances: {} }); onClose() }}
        >
          <span>Lock</span>
        </button>
      )}
    </div>
  )
}

/** Two ways in: a wallet you already have, or ThruScan's browser wallet. */
function ConnectMenu({ onClose }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const found = hasProvider()
  const connect = async () => {
    setBusy(true); setError(null)
    try { await connectExternal(); onClose() } catch (e) { setError(String(e?.message ?? e)) } finally { setBusy(false) }
  }
  return (
    <div className="pill-panel connect-menu">
      <p className="fine" style={{ margin: '2px 4px 8px' }}>Connect with</p>
      {found ? (
        <button className="connect-option" onClick={connect} disabled={busy}>
          <span className="connect-mark">T</span>
          <span className="connect-text"><b>ThruScan Wallet</b><span className="fine">{busy ? 'Approve in the extension' : 'Extension, detected'}</span></span>
        </button>
      ) : (
        <a className="connect-option" href={EXTENSION_URL} target="_blank" rel="noreferrer">
          <span className="connect-mark">T</span>
          <span className="connect-text"><b>ThruScan Wallet</b><span className="fine">Get the Chrome extension</span></span>
        </a>
      )}
      <Link className="connect-option" to="/wallet" onClick={onClose}>
        <span className="connect-mark ghost"><WalletGlyph /></span>
        <span className="connect-text"><b>Browser wallet</b><span className="fine">Made here, no install</span></span>
      </Link>
      {error && <p className="notice bad" style={{ marginTop: 8 }}>{error}</p>}
    </div>
  )
}

export function WalletPill() {
  const wallet = useWallet()
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const boxRef = useRef(null)

  useEffect(() => { setMounted(true) }, [])

  // A new device has no list of names yet. Read them off the chain once, so
  // the pill shows the name everywhere rather than only where it was claimed.
  const [, bumpName] = useState(0)
  useEffect(() => {
    const address = wallet.address
    if (!address || primaryName(address)) return
    let alive = true
    ownedNames(address).then((rows) => {
      if (!alive || rows.length === 0) return
      try { localStorage.setItem(`thruscan.names.${address}`, JSON.stringify(rows.map((r) => r.name))) } catch {}
      bumpName((n) => n + 1)
    }).catch(() => {})
    return () => { alive = false }
  }, [wallet.address])

  // Close on a click anywhere else, and on Escape. Both are expected, and a
  // panel that only closes by clicking the thing that opened it is a trap on a
  // phone where that thing may now be under your thumb.
  useEffect(() => {
    if (!open) return
    const away = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    const key = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  // Every token ThruScan knows (pools, launches, ones added by address), so a
  // launchpad token shows here before it has a pool.
  useEffect(() => {
    if (!wallet.unlocked) return
    wallet.refresh()
    knownMints().then((all) => wallet.refresh(all)).catch(() => {})
  }, [wallet.unlocked, wallet.address])

  if (!mounted) return null

  const tusd = wallet.balances?.[TUSD_MINT]
  const address = wallet.address ?? storedWallet()?.address ?? null

  /* Once a name points at this wallet it IS the wallet, as far as anyone else
     is concerned, so the pill wears it and the address moves into the panel.
     The list is what this browser claimed; a name claimed elsewhere still
     resolves on chain, it just is not known here. */
  const label = primaryName(address) ?? short(address)

  const body = (
    <div className="wallet-pill-mount" ref={boxRef}>
      {!hasWallet() ? (
        <>
          <button className="wallet-pill" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <span className="pill-strong">Connect wallet</span>
          </button>
          {open && <ConnectMenu onClose={() => setOpen(false)} />}
        </>
      ) : (
        <>
          <button className="wallet-pill" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {wallet.unlocked && tusd?.exists && (
              <span className="pill-balance mono">{fmt(tusd.amount)} tUSD</span>
            )}
            {/* Straight to the wallet page. Opening a menu to find a link to
                the thing the menu is about is one click too many for the page
                people go to most. */}
            <Link
              to="/wallet"
              className="pill-jump"
              title="Open your wallet"
              aria-label="Open your wallet"
              onClick={(e) => { e.stopPropagation(); setOpen(false) }}
            >
              <WalletGlyph />
            </Link>
            <Avatar address={address} />
            <span className={label.endsWith('.id') ? 'pill-strong' : 'pill-strong mono'}>{label}</span>
            <span className="pill-caret" aria-hidden="true">▾</span>
          </button>
          {open && <Panel wallet={wallet} onClose={() => setOpen(false)} />}
        </>
      )}
    </div>
  )

  return createPortal(body, document.body)
}
