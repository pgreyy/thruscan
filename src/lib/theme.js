// src/lib/theme.js
//
// Light, dark, or follow the system. The choice is kept in this browser only.
// index.html applies it before the first paint (same key, same logic), so a
// dark page never flashes white on load.

const KEY = 'thruscan_theme'
export const CHOICES = ['system', 'light', 'dark']

export function getChoice() {
  try { const v = localStorage.getItem(KEY); return CHOICES.includes(v) ? v : 'system' } catch { return 'system' }
}

const media = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null)

export function resolve(choice = getChoice()) {
  if (choice === 'light' || choice === 'dark') return choice
  return media()?.matches ? 'dark' : 'light'
}

export function apply(choice = getChoice()) {
  document.documentElement.dataset.theme = resolve(choice)
}

export function setChoice(choice) {
  try { localStorage.setItem(KEY, choice) } catch { /* private mode: still applies for this visit */ }
  apply(choice)
  window.dispatchEvent(new CustomEvent('thruscan-theme', { detail: choice }))
}

/** Keeps "system" in step when the OS switches while the page is open. */
export function watchSystem() {
  const m = media()
  if (!m) return () => {}
  const on = () => { if (getChoice() === 'system') apply('system') }
  m.addEventListener?.('change', on)
  return () => m.removeEventListener?.('change', on)
}
