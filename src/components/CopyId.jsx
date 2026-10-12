// src/components/CopyId.jsx
//
// A copyable identifier (design system 2g): the first five and last four
// characters joined by "…", in mono, link colour, underlined. The link opens
// the explorer page for it; the button copies the whole id and turns into an
// ink "Copied" chip for a moment. Hovering the link shows the full id.

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from './Icon.jsx'

const shortId = (id) => (id && id.length > 12 ? `${id.slice(0, 5)}…${id.slice(-4)}` : id ?? '')

/** Where an id goes: a signature to its transaction, anything else to its account. */
const hrefFor = (id) => (id && id.length > 60 ? `/tx/${id}` : `/account/${id}`)

export function CopyId({ value, label, to, onNavigate, className }) {
  const [done, setDone] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  if (!value) return null

  const copy = (e) => {
    e.preventDefault(); e.stopPropagation()
    navigator.clipboard?.writeText(value)
    setDone(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setDone(false), 1500)
  }

  return (
    <span className={`copyid${className ? ` ${className}` : ''}`}>
      <Link to={to ?? hrefFor(value)} title={value} onClick={onNavigate}>{label ?? shortId(value)}</Link>
      {done
        ? <span className="copyid-done" role="status"><Icon name="success" size={14} stroke={2} />Copied</span>
        : <button type="button" className="copyid-btn" onClick={copy} aria-label="Copy the full id"><Icon name="copy" size={16} /></button>}
    </span>
  )
}

export default CopyId
