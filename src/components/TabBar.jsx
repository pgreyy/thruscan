// src/components/TabBar.jsx
//
// The phone's bottom tab bar (Update 02, 5d). Below 1024px only.
//
// Home, Explore, Trade (raised, the centre), Launch and Assets. Trade and
// Launch sit side by side because they are the site's two core actions. The
// bar hides while the on-screen keyboard or a sheet or modal is open; that is
// done in CSS (styles.css, "tab bar") so it needs no global state.

import { Link, useLocation } from 'react-router-dom'

/* Outline and filled versions of each icon, from 5d. The filled one marks the
   active tab, so the state is shape as well as colour. */
const ICONS = {
  home: (on) => (
    <svg width="22" height="22" viewBox="0 0 20 20" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 9L10 3.5L16.5 9V16.5H12V12H8V16.5H3.5Z" />
    </svg>
  ),
  explore: (on) => (
    <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="10" cy="10" r="7" fill={on ? 'currentColor' : 'none'} />
      <path d="M13 7L11 11L7 13L9 9Z" fill={on ? 'var(--bg-surface)' : 'none'} stroke={on ? 'var(--bg-surface)' : 'currentColor'} />
    </svg>
  ),
  launch: (on) => (
    <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="3.5" y="3.5" width="13" height="13" rx="3" fill={on ? 'currentColor' : 'none'} />
      <path d="M10 7V13M7 10H13" stroke={on ? 'var(--bg-surface)' : 'currentColor'} />
    </svg>
  ),
  assets: (on) => (
    <svg width="22" height="22" viewBox="0 0 20 20" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M9 3.5A6.5 6.5 0 1 0 16.5 11H9Z" />
      <path d="M11.5 2.5A6.5 6.5 0 0 1 17.5 8.5H11.5Z" />
    </svg>
  ),
}

const TABS = [
  { key: 'home', label: 'Home', to: '/', on: (p) => p === '/' || p.startsWith('/launch/') || p.startsWith('/token/') },
  { key: 'explore', label: 'Explore', to: '/explorer', on: (p) => ['/explorer', '/tx/', '/account/', '/block/'].some((x) => p === x || p.startsWith(x)) },
  { key: 'trade', label: 'Trade', to: '/swap', on: (p) => p === '/swap' },
  { key: 'launch', label: 'Launch', to: '/create', on: (p) => p === '/create' },
  { key: 'assets', label: 'Assets', to: '/profile', on: (p) => p === '/profile' },
]

export function TabBar() {
  const { pathname } = useLocation()
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => {
        const on = t.on(pathname)
        if (t.key === 'trade') {
          return (
            <Link key={t.key} to={t.to} className={`tabbar-item tabbar-trade${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}>
              <span className="tabbar-trade-btn" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7H16L12.5 3.5M16 13H4L7.5 16.5" /></svg>
              </span>
              <span>{t.label}</span>
            </Link>
          )
        }
        return (
          <Link key={t.key} to={t.to} className={`tabbar-item${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}>
            {ICONS[t.key](on)}
            <span>{t.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export default TabBar
