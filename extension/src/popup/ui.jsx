// extension/src/popup/ui.jsx
//
// Small shared pieces for the wallet's screens: talking to the background,
// hash routing, number formatting, and a few components.

import { useCallback, useEffect, useState } from 'react'

export const EXPLORER = 'https://thruscan.vercel.app'

/** Ask the background worker. Throws its error message on failure. */
export function bg(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
      if (!res) return reject(new Error('No answer from the wallet.'))
      res.ok ? resolve(res.result) : reject(new Error(res.error))
    })
  })
}

/* ---------- routing: #/path ---------- */

export function useRoute() {
  const read = () => (location.hash.replace(/^#/, '') || '/')
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const on = () => setRoute(read())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}
export const go = (path) => { location.hash = path }

/** True when this page is a full browser tab rather than the toolbar popup. */
export const inTab = () => new URLSearchParams(location.search).get('tab') === '1'

/** Open the wallet in a full tab at a route (used for setup, where the popup
    would close the moment the user clicks away to write their words down). */
export function openInTab(path) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`popup.html?tab=1#${path}`) })
  window.close()
}

/* ---------- numbers ---------- */

export function fmtUnits(units, decimals = 0, maxFrac = 4) {
  const v = BigInt(units ?? 0)
  if (decimals === 0) return v.toLocaleString()
  const base = 10n ** BigInt(decimals)
  const whole = v / base
  const frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '')
  if (whole === 0n && !frac && v > 0n) return `<0.${'0'.repeat(maxFrac - 1)}1`
  return `${whole.toLocaleString()}${frac ? `.${frac}` : ''}`
}

/** Exact decimal text back to base units, or null if it is not a number. */
export function toUnits(text, decimals = 0) {
  const s = String(text ?? '').trim().replace(/,/g, '')
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null
  const [w, f = ''] = s.split('.')
  if (f.length > decimals) return null
  return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0')
}

/** Base units to plain text for an input box, all digits kept. */
export function unitsToText(units, decimals = 0) {
  const v = BigInt(units ?? 0)
  if (decimals === 0) return v.toString()
  const base = 10n ** BigInt(decimals)
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${v / base}${frac ? `.${frac}` : ''}`
}

export const short = (a, n = 6) => (a ? `${a.slice(0, n)}…${a.slice(-4)}` : '')

export function timeAgo(ms) {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(ms).toLocaleDateString()
}

/* ---------- components ---------- */

export function Copy({ value, label = 'Copy', className = 'btn ghost small' }) {
  const [done, setDone] = useState(false)
  return (
    <button className={className} onClick={() => { navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1400) }}>
      {done ? 'Copied' : label}
    </button>
  )
}

export function Header({ title, back, right }) {
  return (
    <header className="bar">
      {back ? <button className="icon-btn" aria-label="Back" onClick={() => (typeof back === 'function' ? back() : go(back))}>←</button> : <span className="mark">T</span>}
      <h1>{title}</h1>
      <div className="bar-right">{right}</div>
    </header>
  )
}

export function Notice({ kind = 'bad', children }) {
  if (!children) return null
  return <p className={`notice ${kind}`}>{children}</p>
}

/** Run an async action with a busy flag and an error message. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const run = useCallback(async (fn) => {
    setBusy(true); setError(null)
    try { return await fn() } catch (e) { setError(String(e?.message ?? e)); return undefined } finally { setBusy(false) }
  }, [])
  return { busy, error, setError, run }
}

export function PasswordField({ value, onChange, placeholder = 'Password', autoFocus, onEnter }) {
  const [show, setShow] = useState(false)
  return (
    <div className="pw">
      <input
        type={show ? 'text' : 'password'} value={value} placeholder={placeholder} autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && onEnter) onEnter() }}
        autoComplete="off" spellCheck={false}
      />
      <button type="button" className="pw-eye" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
    </div>
  )
}
