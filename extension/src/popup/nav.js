/* global chrome */
// extension/src/popup/nav.js
//
// Two things the screens do that are not components: follow the theme
// setting, and send someone to a ThruScan page in a new tab.

import { EXPLORER } from './ui.jsx'

/** Dark by default; Settings → Theme can make it light or follow the system. */
export function applyTheme(theme) {
  const t = theme === 'light' || theme === 'dark'
    ? theme
    : theme === 'system' && window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  document.documentElement.dataset.theme = t
}

/** Open a ThruScan page in a new tab and close the popup. */
export function openSite(path) {
  chrome.tabs.create({ url: `${EXPLORER}${path}` })
  window.close()
}
