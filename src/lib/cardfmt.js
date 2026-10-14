// src/lib/cardfmt.js
//
// How a card or phone row writes a market cap and a 24 h change, in pieces
// that can sit in a flex row without ever breaking inside a number or a unit.
// Each piece is rendered in its own nowrap span (see .mk-nw in market.css);
// the space between the pieces is the only place a line may break.

/** 52,340,734 -> 52M, 1,234 -> 1.2K. Short enough for a 160px card. */
export function compactNumber(n) {
  if (n === null || n === undefined || !isFinite(n)) return '–'
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 2)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 2)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`
  if (abs >= 1) return n.toFixed(2)
  if (abs === 0) return '0'
  return n.toPrecision(2)
}

/** A 24 h change in at most eight characters, so a row never wraps:
 *  +226.2%, +12.3K%, +4.5M%, and beyond that >+999M%. */
export function pct(c) {
  if (c === null || c === undefined || !Number.isFinite(c)) return null
  const sign = c > 0 ? '+' : c < 0 ? '−' : ''
  const a = Math.abs(c)
  if (a >= 999.95e6) return `>${sign}999M%`
  if (a >= 999.95e3) return `${sign}${(a / 1e6).toFixed(1)}M%`
  if (a >= 999.95) return `${sign}${(a / 1e3).toFixed(1)}K%`
  return `${sign}${a.toFixed(1)}%`
}

/** A market cap as its number and its unit, two tokens, each unbreakable. */
export function cardValue(cap, unit) {
  return { num: compactNumber(cap), unit: unit ?? '' }
}
