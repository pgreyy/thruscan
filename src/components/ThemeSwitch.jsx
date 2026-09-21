// src/components/ThemeSwitch.jsx
//
// One small button in the top bar. It shows the theme in use; clicking it
// offers System, Light and Dark.

import { useEffect, useRef, useState } from 'react'
import { CHOICES, getChoice, setChoice, watchSystem } from '../lib/theme.js'

const LABEL = { system: 'System', light: 'Light', dark: 'Dark' }

function Glyph({ name }) {
  const p = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  if (name === 'light') return (
    <svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
  )
  if (name === 'dark') return <svg {...p}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>
  return <svg {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
}

export default function ThemeSwitch() {
  const [choice, setLocal] = useState(getChoice)
  const [open, setOpen] = useState(false)
  const box = useRef(null)

  useEffect(() => watchSystem(), [])
  useEffect(() => {
    const on = (e) => setLocal(e.detail)
    window.addEventListener('thruscan-theme', on)
    return () => window.removeEventListener('thruscan-theme', on)
  }, [])
  useEffect(() => {
    if (!open) return
    const off = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', off)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', off); document.removeEventListener('keydown', esc) }
  }, [open])

  return (
    <div className="theme-switch" ref={box}>
      <button className="theme-btn" onClick={() => setOpen((o) => !o)} aria-label={`Theme: ${LABEL[choice]}`} aria-expanded={open} title={`Theme: ${LABEL[choice]}`}>
        <Glyph name={choice} />
      </button>
      {open && (
        <div className="theme-menu" role="menu">
          {CHOICES.map((c) => (
            <button key={c} role="menuitemradio" aria-checked={c === choice} className={c === choice ? 'on' : ''}
              onClick={() => { setChoice(c); setLocal(c); setOpen(false) }}>
              <Glyph name={c} /> {LABEL[c]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
