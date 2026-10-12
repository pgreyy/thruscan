// src/pages/Home.jsx
//
// The search field: in the bar, in the phone's search row and drawer, and on
// the transaction and account pages. (The explorer's front page that used to
// live here is the Explorer's Blocks & transactions tab now: Explorer.jsx.)

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { checkName } from '../lib/wallet.js'
import { decodeDomain, ROOT_SUFFIX } from '../lib/names.js'
import { tokenByMint, tokenByText, looksLikeSignature, looksLikeAddress } from '../lib/findToken.js'
import './home.css'

function bytesOf(b64) {
  if (!b64) return new Uint8Array()
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/* ---------- search ---------- */

/* Longest first. A compact field shows the longest of these that fits its
   own width, so the hint is never cut off mid-word, whether the field is a
   300px slot in the desktop bar or what is left of a 320px phone. */
const HINTS = [
  `Token, address, transaction or name.${ROOT_SUFFIX}`,
  'Search tokens, wallets, txs',
  'Tokens, wallets, txs',
  'Search',
]

/* The bar's wording (2f). */
const BAR_HINTS = [
  `Search tokens, addresses, tx, .${ROOT_SUFFIX}`,
  'Search tokens, addresses, tx',
  'Search',
]

let measureCtx = null
function useFittedHint(inputRef, enabled, hints = HINTS) {
  const [hint, setHint] = useState(hints[0])
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!enabled || !el) return undefined
    const fit = () => {
      const cs = getComputedStyle(el)
      const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      if (!(room > 0)) return
      measureCtx ??= document.createElement('canvas').getContext('2d')
      measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      setHint(hints.find((h) => measureCtx.measureText(h).width <= room) ?? hints[hints.length - 1])
    }
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    fit()
    document.fonts?.ready?.then(fit)
    return () => ro.disconnect()
  }, [inputRef, enabled, hints])
  return hint
}

export function Search({ compact = false, bar = false, autoFocus = false }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [q, setQ] = useState('')
  const inputRef = useRef(null)
  const hint = useFittedHint(inputRef, compact || bar, bar ? BAR_HINTS : HINTS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  /* The box empties once it has taken you somewhere. It sits in the top bar on
     every page, so a leftover address follows you around the site long after
     you have finished with it, and the next search starts by clearing it. */
  useEffect(() => { setQ(''); setError(null) }, [pathname])

  /* One field, four kinds of thing.
   *
   * Signatures are unambiguous, so they go first and cost nothing. An address
   * is where it gets interesting: a token's mint is an address like any other,
   * and sending somebody who pasted a contract address to the raw account page
   * is answering a different question than the one they asked. So an address
   * is checked against the launchpad first, and only then treated as a wallet.
   *
   * Anything else is a ticker, a token name, or a .id name, tried in that
   * order. The token lookup reads one cached account; if the chain is
   * unreachable it answers "no" rather than failing, and the name lookup still
   * gets its turn. */
  const go = async (e) => {
    e?.preventDefault()
    const v = q.trim()
    if (!v) return
    setError(null)

    if (looksLikeSignature(v)) return navigate(`/tx/${v}`)

    setBusy(true)
    try {
      if (looksLikeAddress(v)) {
        const token = await tokenByMint(v)
        return navigate(token ? `/token/${v}` : `/account/${v}`)
      }

      const token = await tokenByText(v)
      if (token) return navigate(`/token/${token.mint}`)

      const name = v.toLowerCase().replace(new RegExp(`\\.${ROOT_SUFFIX}$`), '')
      const r = await checkName(name)
      if (!r.ok || !r.taken) throw new Error(`Nothing found for "${v}".`)
      const domain = decodeDomain(bytesOf(r.data))
      navigate(`/account/${domain.owner}`)
    } catch (err) {
      setError(String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  /* The bar's field (2f): the icon on the left, the hint, and the "/" key
     that jumps here from anywhere. Enter searches. */
  if (bar) {
    return (
      <form className="bar-find-form" onSubmit={go} role="search">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="M13 13L17 17" /></svg>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setError(null) }}
          placeholder={busy ? 'Searching…' : hint}
          aria-label={BAR_HINTS[0]}
          spellCheck={false}
          autoComplete="off"
          autoFocus={autoFocus}
          enterKeyHint="search"
        />
        <kbd aria-hidden="true">/</kbd>
        {error && <p className="home-search-error" role="alert">{error}</p>}
      </form>
    )
  }

  return (
    <form className={`home-search${compact ? ' compact' : ''}`} onSubmit={go}>
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => { setQ(e.target.value); setError(null) }}
        placeholder={hint}
        aria-label={HINTS[0]}
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit" aria-label="Search" disabled={busy}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      </button>
      {error && <p className="home-search-error">{error}</p>}
    </form>
  )
}

export default Search
