// src/lib/useTab.js
//
// The selected tab, kept in the URL (?tab=), for pages that draw their own tab
// strip. The back button works, a refresh keeps you where you were, and a link
// to a tab is a link to that tab. The first key is the default and leaves the
// URL clean.

import { useSearchParams } from 'react-router-dom'

export function useTab(keys, param = 'tab') {
  const [params, setParams] = useSearchParams()
  const wanted = params.get(param)
  const active = keys.includes(wanted) ? wanted : keys[0]
  const pick = (key) => {
    const next = new URLSearchParams(params)
    if (key === keys[0]) next.delete(param)
    else next.set(param, key)
    setParams(next, { replace: true })
  }
  return [active, pick]
}
