// extension/src/popup/ui.jsx
//
// Small shared pieces for the wallet's screens: talking to the background,
// hash routing, number formatting, and a few components.

import { useCallback, useEffect, useRef, useState } from 'react'

export const EXPLORER = 'https://thruscan.xyz'

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
      {done ? '✓ Copied' : label}
    </button>
  )
}

/* The icon set: a 20px grid, 1.6 stroke, the website's shapes (2c) plus the
   wallet's own. currentColor, so they follow the text they sit in. */
const ICONS = {
  back: <path d="M16 10H4M8 6L4 10L8 14" />,
  send: <path d="M10 16.5V6M5.5 10.5L10 6L14.5 10.5M4 3.5H16" />,
  receive: <path d="M10 3.5V14M5.5 9.5L10 14L14.5 9.5M4 16.5H16" />,
  swap: <path d="M4 7H16L12.5 3.5M16 13H4L7.5 16.5" />,
  faucet: <path d="M10 3s5 5.4 5 9.2a5 5 0 0 1-10 0C5 8.4 10 3 10 3z" />,
  wallet: <><rect x="3" y="5" width="14" height="11" rx="2" /><path d="M12.5 10.5H17" /></>,
  activity: <><circle cx="10" cy="10" r="6.5" /><path d="M10 6.5V10L12.5 11.5" /></>,
  settings: <><circle cx="10" cy="10" r="2.5" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></>,
  lock: <><rect x="4.5" y="9" width="11" height="8" rx="1.5" /><path d="M7 9V6.5C7 4.8 8.3 3.5 10 3.5S13 4.8 13 6.5V9" /></>,
  copy: <><rect x="7" y="7" width="9" height="9" rx="1.5" /><path d="M4 13V5.5C4 4.7 4.7 4 5.5 4H13" /></>,
  external: <path d="M11 4H16V9M16 4L9 11M8 5H4V16H15V12" />,
  success: <path d="M4.5 10.5L8 14L15.5 6.5" />,
  failed: <path d="M5 5L15 15M15 5L5 15" />,
  warning: <><path d="M10 3L18 16.5H2Z" /><path d="M10 8V11.5M10 13.5V14.5" /></>,
  message: <path d="M3.5 4.5H16.5V13.5H9L5.5 16.5V13.5H3.5Z" />,
  expand: <path d="M6 8L10 12L14 8" />,
  key: <><circle cx="7" cy="13" r="3.5" /><path d="M9.5 10.5L16.5 3.5M13.5 6.5L15.5 8.5" /></>,
  search: <><circle cx="9" cy="9" r="5.5" /><path d="M13 13L17 17" /></>,
}
export function Icon({ name, size = 20, stroke = 1.6 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={stroke}
      strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">{ICONS[name]}</svg>
  )
}

/* The Passage mark: a rounded block with a T-shaped channel cut through it.
   The tile turns light on the dark theme by itself (--tile). */
export function Mark({ size = 28 }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--tile)" />
      <path d="M6 8H26V14H19V32H13V14H6Z" fill="#FEAE39" />
    </svg>
  )
}

export function Header({ title, back, right }) {
  return (
    <header className="bar">
      {back
        ? <button className="icon-btn" aria-label="Back" onClick={() => (typeof back === 'function' ? back() : go(back))}><Icon name="back" /></button>
        : <Mark size={28} />}
      <h1>{title}</h1>
      <div className="bar-right">{right}</div>
    </header>
  )
}

/** Wallet · Activity · Settings, along the bottom of the main screens. */
export function TabBar({ on }) {
  const tabs = [['/', 'Wallet', 'wallet'], ['/activity', 'Activity', 'activity'], ['/settings', 'Settings', 'settings']]
  return (
    <nav className="tabs-bar" aria-label="Wallet">
      {tabs.map(([path, label, icon]) => (
        <button key={path} className={on === path ? 'on' : ''} aria-current={on === path ? 'page' : undefined} onClick={() => go(path)}>
          <Icon name={icon} size={22} />{label}
        </button>
      ))}
    </nav>
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

/**
 * One box per word, for typing a phrase back.
 *
 * A recovery phrase is twelve separate words, and the thing a person does
 * between words is press space. In a set of one-word boxes that either does
 * nothing or puts a space inside the box, and either way they have to reach for
 * the mouse twelve times. Space, Enter and Tab all move on here, backspace on
 * an empty box goes back, and pasting a whole phrase into any box fills the
 * rest of them, because that is what someone with the phrase in a password
 * manager is going to do.
 *
 * `slots` is the list of word positions to ask for, zero based, so the same
 * component asks for three words or all twelve.
 */
export function WordInputs({ slots, values, onChange, autoFocus = true }) {
  const refs = useRef([])

  const focus = (n) => {
    const el = refs.current[n]
    if (el) { el.focus(); el.select?.() }
  }

  const set = (slot, text) => onChange({ ...values, [slot]: text })

  const spread = (n, text) => {
    // A pasted phrase fills this box and the ones after it, in order.
    const words = String(text).trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length < 2) return false
    const next = { ...values }
    slots.slice(n).forEach((slot, i) => { if (words[i]) next[slot] = words[i] })
    onChange(next)
    focus(Math.min(n + words.length, slots.length - 1))
    return true
  }

  return (
    <div className="words-in">
      {slots.map((slot, n) => (
        <label className="words-in-cell" key={slot}>
          <i>{slot + 1}</i>
          <input
            ref={(el) => { refs.current[n] = el }}
            value={values[slot] ?? ''}
            autoFocus={autoFocus && n === 0}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onPaste={(e) => {
              if (spread(n, e.clipboardData.getData('text'))) e.preventDefault()
            }}
            onChange={(e) => {
              const raw = e.target.value
              if (/\s/.test(raw)) {
                // Typing or dictating a space ends the word rather than
                // entering one: a phrase word never contains whitespace.
                const parts = raw.trim().split(/\s+/).filter(Boolean)
                if (parts.length > 1) { spread(n, parts.join(' ')); return }
                set(slot, (parts[0] ?? '').toLowerCase())
                if (parts.length === 1) focus(Math.min(n + 1, slots.length - 1))
                return
              }
              set(slot, raw.toLowerCase())
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                if ((values[slot] ?? '').trim()) focus(Math.min(n + 1, slots.length - 1))
              } else if (e.key === 'Backspace' && !(values[slot] ?? '') && n > 0) {
                e.preventDefault()
                focus(n - 1)
              }
            }}
          />
        </label>
      ))}
    </div>
  )
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
