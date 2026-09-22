// src/components/Counters.jsx
//
// Visitor counting. Two of them, both free and both anonymous:
//
//   Vercel Web Analytics  on by default once it is enabled in the project.
//   Cloudflare Web Analytics  only when VITE_CF_BEACON holds its token.
//
// Neither sets a cookie, and neither can identify a person. ThruScan's own
// numbers (wallets made, Pals minted) come from the chain instead, on /stats.

import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

const CF_TOKEN = import.meta.env.VITE_CF_BEACON || ''

/** Cloudflare's beacon, added once the token is set on the deployment. */
export function CloudflareBeacon() {
  useEffect(() => {
    if (!CF_TOKEN || document.querySelector('script[data-cf-beacon]')) return
    const s = document.createElement('script')
    s.defer = true
    s.src = 'https://static.cloudflareinsights.com/beacon.min.js'
    s.setAttribute('data-cf-beacon', JSON.stringify({ token: CF_TOKEN, spa: true }))
    document.head.appendChild(s)
  }, [])
  return null
}

/** Tells Cloudflare about page changes; the site is one page that rewrites itself. */
export function usePageViews() {
  const { pathname } = useLocation()
  useEffect(() => {
    if (!CF_TOKEN) return
    try { window.__cfBeacon?.trackPageview?.() } catch { /* the beacon handles it itself */ }
  }, [pathname])
}
