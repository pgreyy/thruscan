// extension/src/popup/App.jsx
//
// Which screen to show: setup when there is no wallet, unlock when locked,
// otherwise the wallet. Approval windows (#/approve/<id>) handle their own
// unlocking so a site's request is never lost behind the unlock screen.

import { useCallback, useEffect, useState } from 'react'
import { bg, go, useRoute } from './ui.jsx'
import { Welcome, Create, Import, Ready, Unlock, Forgot } from './Onboard.jsx'
import { Home, Send, Receive, ActivityScreen, Sites, NftScreen, NftCollection } from './Home.jsx'
import { Accounts, NewPhraseAccount, ImportAccount } from './Accounts.jsx'
import { Settings, Reveal, Remove } from './Settings.jsx'
import { Approve } from './Approve.jsx'

export default function App() {
  const route = useRoute()
  const [state, setState] = useState(null)
  const reload = useCallback(() => bg('state').then(setState), [])
  useEffect(() => { reload() }, [reload])
  // Locked by the timer, or changed from another window: follow along.
  useEffect(() => {
    const on = () => reload()
    chrome.storage.onChanged.addListener(on)
    return () => chrome.storage.onChanged.removeListener(on)
  }, [reload])

  if (!state) return <div className="screen" />

  const approve = route.match(/^\/approve\/(.+)$/)
  if (approve) {
    if (!state.hasWallet) return <Welcome />
    return <Approve id={approve[1]} state={state} onUnlocked={reload} />
  }

  const lock = () => bg('lock').then(() => { go('/'); reload() })
  const ready = () => { go('/ready'); reload() }
  const gone = () => { go('/'); reload() }

  if (!state.hasWallet) {
    if (route === '/create') return <Create onReady={ready} />
    if (route === '/import') return <Import onReady={ready} />
    return <Welcome />
  }
  if (route === '/ready') return <Ready />
  if (!state.unlocked) {
    if (route === '/forgot') return <Forgot onGone={gone} />
    return <Unlock onUnlocked={() => { go('/'); reload() }} />
  }

  const nft = route.match(/^\/nft\/(.+)$/)
  if (nft) return <NftScreen account={nft[1]} me={state.account.address} />
  const col = route.match(/^\/nfts\/(.+)$/)
  if (col) return <NftCollection mint={col[1]} me={state.account.address} />

  switch (route) {
    case '/send': return <Send />
    case '/receive': return <Receive account={state.account} />
    case '/activity': return <ActivityScreen account={state.account} />
    case '/sites': return <Sites />
    case '/accounts': return <Accounts onChanged={reload} />
    case '/accounts/new': return <NewPhraseAccount onChanged={reload} />
    case '/accounts/import': return <ImportAccount onChanged={reload} />
    case '/settings': return <Settings state={state} onLock={lock} reload={reload} />
    case '/reveal/phrase': return <Reveal what="phrase" />
    case '/reveal/key': return <Reveal what="key" />
    case '/remove': return <Remove onGone={gone} />
    default: return <Home account={state.account} onLock={lock} />
  }
}
