// src/components/Pill.jsx
//
// Status and event pills (Update 02, section 6). The word is always on the
// pill, so colour is never the only signal.
//
//   <StatusPill ok={true} />           Success, green tint with a tick
//   <StatusPill ok={false} />          Failed, red tint with a cross
//   <StatusPill pending />             Pending, sunken with a clock
//   <EventPill kind="buy" />           Buy green, Sell red, Launch amber,
//                                      everything else neutral

import { Icon } from './Icon.jsx'
import { EVENT_WORD, eventTone } from '../lib/pills.js'

export function StatusPill({ ok, pending = false, size, children }) {
  const tone = pending ? 'pending' : ok ? 'positive' : 'negative'
  const icon = pending ? 'pending' : ok ? 'success' : 'failed'
  const word = children ?? (pending ? 'Pending' : ok ? 'Success' : 'Failed')
  return (
    <span className={`pill2 ${tone}${size === 'lg' ? ' lg' : ''}`}>
      <Icon name={icon} size={size === 'lg' ? 14 : 12} stroke={2.2} />{word}
    </span>
  )
}

export function EventPill({ kind, children, size }) {
  const word = children ?? EVENT_WORD[kind] ?? (kind ? String(kind).charAt(0).toUpperCase() + String(kind).slice(1) : 'Call')
  return <span className={`pill2 ${eventTone(kind)}${size === 'lg' ? ' lg' : ''}`}>{word}</span>
}

/** A signed amount: received green with "+", sent red with "−", else plain. */
export function Amount({ delta, text }) {
  if (text === null || text === undefined || text === '') return <span className="amt-none">—</span>
  const clean = String(text).replace(/^[+\-−]\s*/, '')
  if (delta > 0) return <span className="amt-pos">+{clean}</span>
  if (delta < 0) return <span className="amt-neg">−{clean}</span>
  return <span>{clean}</span>
}
