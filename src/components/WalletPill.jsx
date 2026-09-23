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
import { NamePfp } from './Pfp.jsx'
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
 * Whose wallet this is, in twenty pixels.
 *
 * The same picture as everywhere else: their profile picture when they have
 * one, a hexagon when it is an NFT they own, and otherwise the identicon drawn
 * from the address. The identicon is not decoration — two addresses that differ
 * only in the middle look identical when truncated, and a glance at the
 * wrong-coloured square is faster than reading six characters.
 */
function Avatar({ address, label, size = 20 }) {
  if (!address) return null
  const bare = label?.endsWith('.id') ? label.slice(0, -3) : null
  return <NamePfp name={bare} address={address} size={size} />
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

/** Copy the address without leaving the row it sits on. */
function CopyDot({ value }) {
  const [done, setDone] = useState(false)
  if (!value) return null
  return (
    <button
      className="pill-copy"
      title="Copy the address"
      aria-label="Copy the address"
      onClick={(e) => {
        e.preventDefault(); e.stopPropagation()
        navigator.clipboard?.writeText(value)
        setDone(true)
        setTimeout(() => setDone(false), 1400)
      }}
    >
      {done ? '✓' : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
      )}
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

  /* Who you are, then where to go, then what you hold.
     The name and the address used to be two rows of their own above all of it,
     which spent the top of the menu restating what the button you just pressed
     already said. They now sit on the Wallet row, which is where they are
     useful: it is the row that opens the page about them. */
  const name = primaryName(wallet.address)

  return (
    <div className="pill-panel">
      <Link className="pill-row" to="/profile" onClick={onClose}>
        <span>Profile</span><span className="pill-go">→</span>
      </Link>

      <Link className="pill-row pill-wallet" to="/wallet" onClick={onClose}>
        <span>Wallet</span>
        <span className="pill-who">
          {name && <b>{name}</b>}
          <span className="mono">{short(wallet.address)}</span>
        </span>
        <CopyDot value={wallet.address} />
      </Link>

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
            <Avatar address={address} label={label} />
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
