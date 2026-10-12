// src/lib/when.js
//
// One way of writing a time across the site: relative under a day ("6m",
// "40s"), the date and time after that ("Oct 11, 14:02"), and the full UTC
// timestamp for a tooltip or a long press.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n) => String(n).padStart(2, '0')

/** Milliseconds from whatever the source gave: ms, or the indexer's nanoseconds. */
export function toMs(t) {
  if (t === null || t === undefined || t === '') return null
  try {
    const big = BigInt(t)
    // Anything past the year 5000 in milliseconds is nanoseconds.
    return Number(big > 100000000000000n ? big / 1000000n : big)
  } catch {
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }
}

export function relTime(t, now = Date.now()) {
  const ms = toMs(t)
  if (ms === null) return '—'
  const secs = Math.max(0, Math.round((now - ms) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fullUtc(t) {
  const ms = toMs(t)
  if (ms === null) return undefined
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

/** "14:02", for "last update" lines. */
export function clock(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Seconds or minutes since, for "Read from chain 8s ago". */
export function since(ms, now = Date.now()) {
  if (!ms) return '—'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}
