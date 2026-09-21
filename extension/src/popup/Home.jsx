// extension/src/popup/Home.jsx
//
// The wallet itself: balance, tokens, activity, and the Send and Receive
// screens.

import { useCallback, useEffect, useState } from 'react'
import { QRImage } from './qr.jsx'
import {
  bg, go, EXPLORER, Header, Notice, Copy, useAction, fmtUnits, toUnits, unitsToText, short, timeAgo,
} from './ui.jsx'

// Pixel Pals are sent through the collection's own program (see lib/chain.js).
const PALS = { program: 'taxb0oMEdQIZKaL2CxCI98QnPIOvuxVBNqVhflRfB1jT4M', mint: 'ta9l4qt8fTyuAofmu1oi3Hy_jc31vWCxLEXyaNEpuGEnMv' }

/** The overview, refreshed every few seconds while the wallet is open. */
export function useOverview() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const load = useCallback(() => bg('overview').then((d) => { setData(d); setError(null) }).catch((e) => setError(e.message)), [])
  useEffect(() => {
    bg('balance').then((d) => setData((old) => old ?? d)).catch(() => {})
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 5000)
    return () => clearInterval(id)
  }, [load])
  return { data, error, reload: load }
}

function assetsOf(data) {
  if (!data) return []
  return [
    { key: 'THRU', ticker: 'THRU', amount: data.thru, decimals: 0, mint: null },
    ...(data.tokens ?? []).map((t) => ({ key: t.mint, ticker: t.ticker, amount: t.amount, decimals: t.decimals, mint: t.mint })),
  ]
}

const ICONS = {
  send: <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />,
  receive: <path d="M12 4v14M5 11l7 7 7-7M5 21h14" />,
  faucet: <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />,
  activity: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  sites: <><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8 21h8M12 18v3" /></>,
  explorer: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  lock: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  key: <><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.8-9.8M16 7l3 3M19 4l2 2" /></>,
}
export function Icon({ name, size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>
  )
}

/** The site in the active tab, and whether it is connected. */
function useCurrentSite() {
  const [site, setSite] = useState(null)
  const load = useCallback(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) return
      // The page's bridge says where it is; no "tabs" permission needed.
      const r = await chrome.tabs.sendMessage(tab.id, { from: 'thruscan-wallet-popup', ask: 'origin' }).catch(() => null)
      if (!r?.origin) return setSite(null)
      const all = await bg('sites')
      setSite({ origin: r.origin, connected: Boolean(all[r.origin]) })
    } catch { setSite(null) }
  }, [])
  useEffect(() => { load() }, [load])
  return { site, reload: load }
}

export function Home({ account, onLock }) {
  const { data, error, reload } = useOverview()
  const { site, reload: reloadSite } = useCurrentSite()
  const act = useAction()
  const [note, setNote] = useState(null)
  const [copied, setCopied] = useState(false)

  const activate = () => act.run(async () => { await bg('activate'); setNote('Your account is on chain.'); reload() })
  const faucet = () => act.run(async () => {
    const sig = await bg('faucet')
    setNote('Claiming 10,000 test THRU…')
    const r = await bg('waitFor', { signature: sig })
    setNote(r.settled && !r.ok ? null : 'Claimed 10,000 test THRU.')
    if (r.settled && !r.ok) act.setError(`The faucet refused (error ${r.userError || r.vmError}). It may be empty or rate limited; try again later.`)
    reload()
  })
  const copy = () => { navigator.clipboard.writeText(account.address); setCopied(true); setTimeout(() => setCopied(false), 1400) }

  const assets = assetsOf(data)
  const tokens = assets.slice(1)
  const live = data?.exists

  const tiles = [
    { icon: 'send', label: 'Send', onClick: () => go('/send'), off: !live },
    { icon: 'receive', label: 'Receive', onClick: () => go('/receive') },
    { icon: 'faucet', label: act.busy ? 'Claiming…' : 'Faucet', onClick: faucet, off: !live || act.busy },
    { icon: 'explorer', label: 'Explorer', href: `${EXPLORER}/account/${account.address}` },
  ]
  const [tab, setTab] = useState(() => sessionStorage.getItem('home-tab') || 'tokens')
  const pickTab = (t) => { setTab(t); try { sessionStorage.setItem('home-tab', t) } catch { /* ignore */ } }

  return (
    <div className="screen">
      <header className="top">
        <button className="acct-chip" onClick={copy} title="Copy address">
          <Icon name="key" size={16} />
          <b>Account 1</b>
          <span className="mono">{short(account.address, 5)}</span>
          <span className="chip-copy">{copied ? 'Copied' : <Icon name="copy" size={14} />}</span>
        </button>
        <div className="top-right">
          <button className="icon-btn" aria-label="Lock" title="Lock" onClick={onLock}><Icon name="lock" size={18} /></button>
          <button className="icon-btn" aria-label="Settings" title="Settings" onClick={() => go('/settings')}><Icon name="settings" size={18} /></button>
        </div>
      </header>

      <div className="body home">
        <section className="hero">
          <div className="hero-top">
            <span>THRU balance</span>
            <span className="hero-net"><i />Alphanet</span>
          </div>
          <b className="hero-amount">{data ? fmtUnits(data.thru) : '…'}</b>
          <div className="hero-chips">
            {tokens.slice(0, 4).map((t) => <span key={t.key}>{t.ticker}</span>)}
            {tokens.length > 4 && <span>+{tokens.length - 4}</span>}
            {data && data.tokens !== null && tokens.length === 0 && <span className="dim">No tokens yet</span>}
          </div>
        </section>

        {data && !live && (
          <section className="card callout">
            <b>Activate this address</b>
            <p className="fine">A new Thru address is written on chain once before it can hold anything. Free, and signed by you.</p>
            <button className="btn small" disabled={act.busy} onClick={activate}>{act.busy ? 'Activating…' : 'Activate'}</button>
          </section>
        )}

        <nav className="grid">
          {tiles.map((t) => t.href
            ? <a key={t.label} className="tile" href={t.href} target="_blank" rel="noreferrer"><Icon name={t.icon} size={22} /><span>{t.label}</span></a>
            : <button key={t.label} className="tile" onClick={t.onClick} disabled={t.off}><Icon name={t.icon} size={22} /><span>{t.label}</span></button>)}
        </nav>

        <Notice kind="good">{note}</Notice>
        <Notice>{act.error || error}</Notice>

        <div className="seg tabs">
          <button className={tab === 'tokens' ? 'on' : ''} onClick={() => pickTab('tokens')}>Tokens</button>
          <button className={tab === 'nfts' ? 'on' : ''} onClick={() => pickTab('nfts')}>NFTs</button>
          <button className={tab === 'activity' ? 'on' : ''} onClick={() => pickTab('activity')}>Activity</button>
        </div>

        {tab === 'nfts' && <NftGrid />}
        {tab === 'activity' && <Activity address={account.address} />}
        {tab === 'tokens' && <div className="list">
          {!data && <p className="fine pad">Reading the chain…</p>}
          {assets.map((a) => (
            <a key={a.key} className="row" target="_blank" rel="noreferrer"
              href={a.mint ? `${EXPLORER}/token/${a.mint}` : `${EXPLORER}/account/${account.address}`}>
              <span className="coin">{a.ticker.slice(0, 1)}</span>
              <span className="row-main"><b>{a.ticker}</b>{a.mint && <span className="fine mono">{short(a.mint, 4)}</span>}</span>
              <span className="mono">{fmtUnits(a.amount, a.decimals)}</span>
            </a>
          ))}
          {data && data.tokens === null && <p className="fine pad">Looking for tokens…</p>}
        </div>}

        {site && (
          <section className="site-bar bottom">
            <span className="favicon">{site.origin.replace(/^https?:\/\//, '').slice(0, 1).toUpperCase()}</span>
            <span className="row-main">
              <b>{site.origin.replace(/^https?:\/\//, '')}</b>
              <span className={`fine ${site.connected ? 'on' : ''}`}>{site.connected ? 'Connected' : 'Not connected'}</span>
            </span>
            {site.connected && <button className="btn ghost small" onClick={() => bg('revoke', { origin: site.origin }).then(reloadSite)}>Disconnect</button>}
          </section>
        )}
      </div>
    </div>
  )
}

/* ---------- NFTs ---------- */

let nftCache = null   // survives switching tabs while the popup is open

function NftGrid() {
  const [items, setItems] = useState(nftCache)
  const [error, setError] = useState(null)
  useEffect(() => {
    bg('nfts').then((n) => { nftCache = n; setItems(n) }).catch((e) => setError(e.message))
  }, [])
  return (
    <div className="nft-wrap">
      <Notice>{error}</Notice>
      {items === null && !error && <p className="fine pad">Reading the chain…</p>}
      {items?.length === 0 && <p className="fine pad">No NFTs yet. Ones you mint or receive show up here.</p>}
      {items?.length > 0 && (
        <div className="nft-grid">
          {items.map((n) => (
            <button key={n.account} className="nft-card" onClick={() => go(`/nft/${n.account}`)}>
              <NftImage src={n.image} id={n.id} />
              <span className="nft-name">{n.name || `#${n.id}`}</span>
              {n.collection && <span className="fine">{n.collection}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function NftImage({ src, id, big = false }) {
  const [broken, setBroken] = useState(false)
  return (
    <span className={`nft-img ${big ? 'big' : ''}`}>
      {src && !broken ? <img src={src} alt="" onError={() => setBroken(true)} /> : <b>#{id}</b>}
    </span>
  )
}

export function NftScreen({ account: nftAccount, me }) {
  const n = (nftCache ?? []).find((x) => x.account === nftAccount)
  const [to, setTo] = useState('')
  const [result, setResult] = useState(null)
  const act = useAction()
  if (!n) {
    return (
      <div className="screen">
        <Header title="NFT" back="/" />
        <div className="body"><p className="fine">Open it again from the NFTs tab.</p></div>
      </div>
    )
  }
  const canSend = n.authority === me || (n.mint === PALS.mint && n.authority === PALS.program)
  const send = () => act.run(async () => {
    const sig = await bg('sendNft', { account: nftAccount, to: to.trim() })
    const r = await bg('waitFor', { signature: sig })
    if (r.settled && !r.ok) throw new Error(`The chain rejected it (error ${r.userError || r.vmError}).`)
    nftCache = null
    setResult(sig)
  })
  return (
    <div className="screen">
      <Header title={n.name || `#${n.id}`} back="/" />
      <div className="body stack">
        <NftImage src={n.image} id={n.id} big />
        <div className="card kv">
          {n.collection && <div><span>Collection</span><b>{n.collection}</b></div>}
          <div><span>Number</span><b>#{n.id}</b></div>
          <div><span>Mint</span><a className="mono" href={`${EXPLORER}/account/${n.mint}`} target="_blank" rel="noreferrer">{short(n.mint)}</a></div>
        </div>
        {!canSend && !result && (
          <p className="fine">Transfers for this collection go through its own program, so send it from the collection's site.</p>
        )}
        {!canSend ? null : !result ? (
          <>
            <label className="field">
              <span>Send to</span>
              <input value={to} placeholder="Address (ta…) or name.id" spellCheck={false} autoComplete="off" onChange={(e) => setTo(e.target.value)} />
            </label>
            <Notice>{act.error}</Notice>
            <button className="btn" disabled={!to.trim() || act.busy} onClick={send}>{act.busy ? 'Sending…' : 'Send NFT'}</button>
          </>
        ) : (
          <>
            <p className="notice good">Sent.</p>
            <a className="btn ghost" href={`${EXPLORER}/tx/${result}`} target="_blank" rel="noreferrer">View on ThruScan</a>
            <button className="btn" onClick={() => go('/')}>Done</button>
          </>
        )}
      </div>
    </div>
  )
}

export function ActivityScreen({ account }) {
  return (
    <div className="screen">
      <Header title="Activity" back="/" />
      <div className="body"><Activity address={account.address} /></div>
    </div>
  )
}

export function Sites() {
  const [sites, setSites] = useState(null)
  const load = () => bg('sites').then(setSites)
  useEffect(() => { load() }, [])
  return (
    <div className="screen">
      <Header title="Connected sites" back="/" />
      <div className="body stack">
        {sites && Object.keys(sites).length === 0 && <p className="fine">No site is connected. A site asks when it wants to connect, and you decide.</p>}
        {sites && Object.entries(sites).map(([origin, s]) => (
          <div className="site-bar" key={origin}>
            <span className="favicon">{origin.replace(/^https?:\/\//, '').slice(0, 1).toUpperCase()}</span>
            <span className="row-main"><b>{origin.replace(/^https?:\/\//, '')}</b><span className="fine">connected {timeAgo(s.at)}</span></span>
            <button className="btn ghost small" onClick={() => bg('revoke', { origin }).then(load)}>Disconnect</button>
          </div>
        ))}
      </div>
    </div>
  )
}

export function Activity({ address }) {
  const [items, setItems] = useState(null)
  const [next, setNext] = useState(null)
  const [error, setError] = useState(null)
  const [more, setMore] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () => bg('history').then((h) => {
      if (!alive) return
      setItems((old) => {
        if (!old) return h.items
        const seen = new Set(h.items.map((i) => i.signature))
        return [...h.items, ...old.filter((i) => !seen.has(i.signature))]
      })
      setNext((n) => n ?? h.next)
    }).catch((e) => alive && setError(e.message))
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 6000)
    return () => { alive = false; clearInterval(id) }
  }, [address])

  const loadMore = async () => {
    setMore(true)
    try {
      const h = await bg('history', { page: next })
      setItems((old) => [...old, ...h.items.filter((i) => !old.some((o) => o.signature === i.signature))])
      setNext(h.next)
    } catch (e) { setError(e.message) } finally { setMore(false) }
  }

  return (
    <div className="list">
      <Notice>{error}</Notice>
      {items === null && !error && <p className="fine pad">Reading the chain…</p>}
      {items?.length === 0 && <p className="fine pad">Nothing yet.</p>}
      {items?.map((i) => (
        <a key={i.signature} className="row" href={`${EXPLORER}/tx/${i.signature}`} target="_blank" rel="noreferrer">
          <span className={`dot ${i.ok === false ? 'bad' : ''}`} />
          <span className="row-main">
            <b>{i.label}{i.ok === false ? ' (failed)' : ''}</b>
            <span className="fine">{timeAgo(i.time)}</span>
          </span>
          {i.delta && <span className="mono small">{i.delta}</span>}
        </a>
      ))}
      {next && <button className="btn ghost small" disabled={more} onClick={loadMore}>{more ? 'Loading…' : 'Older'}</button>}
    </div>
  )
}

export function Receive({ account }) {
  return (
    <div className="screen">
      <Header title="Receive" back="/" />
      <div className="body stack center">
        <QRImage text={account.address} size={190} />
        <p className="mono addr">{account.address}</p>
        <Copy value={account.address} label="Copy address" className="btn" />
        <p className="fine">Send only Thru assets to this address.</p>
      </div>
    </div>
  )
}

export function Send() {
  const { data } = useOverview()
  const assets = assetsOf(data)
  const [assetKey, setAssetKey] = useState('THRU')
  const [to, setTo] = useState('')
  const [resolved, setResolved] = useState(null)
  const [amount, setAmount] = useState('')
  const [step, setStep] = useState('form')
  const [result, setResult] = useState(null)
  const act = useAction()

  const asset = assets.find((a) => a.key === assetKey) ?? assets[0]
  const units = asset ? toUnits(amount, asset.decimals) : null
  const tooMuch = asset && units !== null && units > BigInt(asset.amount)

  // Resolve name.id (or check an address) as the user types.
  useEffect(() => {
    setResolved(null)
    const v = to.trim()
    if (!v) return
    const t = setTimeout(() => {
      bg('resolve', { to: v }).then((r) => setResolved({ ...r, input: v })).catch((e) => setResolved({ error: e.message, input: v }))
    }, 350)
    return () => clearTimeout(t)
  }, [to])

  const ready = asset && resolved?.address && units !== null && units > 0n && !tooMuch

  const send = () => act.run(async () => {
    const sig = await bg('send', { to: resolved.address, mint: asset.mint, amount: units.toString() })
    setStep('sent')
    setResult({ signature: sig })
    const r = await bg('waitFor', { signature: sig })
    setResult({ signature: sig, ...r })
  })

  if (step === 'sent') {
    const failed = result?.settled && !result.ok
    return (
      <div className="screen">
        <Header title="Sent" back="/" />
        <div className="body stack center">
          <span className={`mark big ${failed ? 'bad' : ''}`}>{failed ? '!' : result?.settled ? '✓' : '…'}</span>
          <p>{failed ? `The chain rejected it (error ${result.userError || result.vmError}).` : result?.settled ? `${amount} ${asset.ticker} sent.` : 'Waiting for the chain…'}</p>
          <a className="btn ghost" href={`${EXPLORER}/tx/${result.signature}`} target="_blank" rel="noreferrer">View on ThruScan</a>
          <button className="btn" onClick={() => go('/')}>Done</button>
        </div>
      </div>
    )
  }

  if (step === 'review') {
    return (
      <div className="screen">
        <Header title="Review" back={() => setStep('form')} />
        <div className="body stack">
          <div className="card kv">
            <div><span>Sending</span><b>{amount} {asset.ticker}</b></div>
            <div><span>To</span><b className="mono">{resolved.name ?? short(resolved.address)}</b></div>
            {resolved.name && <div><span>Address</span><span className="mono fine">{short(resolved.address, 10)}</span></div>}
            <div><span>Network</span><span>Thru alphanet</span></div>
          </div>
          {asset.mint && <p className="fine">If the receiver has never held {asset.ticker}, this first opens their {asset.ticker} account, which is a second transaction you sign.</p>}
          <Notice>{act.error}</Notice>
          <button className="btn" disabled={act.busy} onClick={send}>{act.busy ? 'Sending…' : 'Send'}</button>
        </div>
      </div>
    )
  }

  return (
    <div className="screen">
      <Header title="Send" back="/" />
      <div className="body stack">
        <label className="field">
          <span>Asset</span>
          <select value={assetKey} onChange={(e) => { setAssetKey(e.target.value); setAmount('') }}>
            {assets.map((a) => <option key={a.key} value={a.key}>{a.ticker}</option>)}
          </select>
        </label>
        <label className="field">
          <span>To</span>
          <input value={to} placeholder="Address (ta…) or name.id" autoComplete="off" spellCheck={false} onChange={(e) => setTo(e.target.value)} />
          {resolved?.error && <span className="hint bad">{resolved.error}</span>}
          {resolved?.name && <span className="hint mono">{short(resolved.address, 10)}</span>}
        </label>
        <label className="field">
          <span className="field-row">
            Amount
            {asset && <span className="fine">Balance {fmtUnits(asset.amount, asset.decimals)} {asset.ticker}</span>}
          </span>
          <div className="with-btn">
            <input value={amount} inputMode="decimal" placeholder="0" onChange={(e) => setAmount(e.target.value)} />
            <button className="btn ghost small" disabled={!asset || asset.amount === '0'} onClick={() => setAmount(unitsToText(asset.amount, asset.decimals))}>Max</button>
          </div>
          {tooMuch && <span className="hint bad">More than you hold.</span>}
          {amount && units === null && <span className="hint bad">{asset?.decimals === 0 ? 'Whole numbers only.' : `Up to ${asset?.decimals} decimal places.`}</span>}
        </label>
        <button className="btn" disabled={!ready} onClick={() => setStep('review')}>Review</button>
      </div>
    </div>
  )
}
