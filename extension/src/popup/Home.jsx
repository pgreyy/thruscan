// extension/src/popup/Home.jsx
//
// The wallet itself (6e-6h): what it holds, Send, Receive, and activity.

import { useCallback, useEffect, useState } from 'react'
import { QRImage } from './qr.jsx'
import {
  bg, go, EXPLORER, Header, Notice, Copy, useAction, fmtUnits, toUnits, unitsToText, short, timeAgo,
  Icon, Mark, TabBar,
} from './ui.jsx'
import { openSite } from './nav.js'

// Pixel Pals are sent through the collection's own program (see lib/chain.js).
/* Pixel Pals, from whichever network the wallet is pointed at. Hardcoded here
   until 5 October 2026, which meant a wallet on a second chain would offer to
   send a Pal through the first chain's program. */
import { networkFor } from '../lib/networks.js'

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

/* WTHRU is THRU wrapped one for one: one native unit is one WTHRU base unit.
   So the wallet's value in WTHRU is its THRU plus its WTHRU, counted in base
   units. Other tokens have no price the wallet can read for itself; their
   value is on ThruScan, and the line under the number says so. */
function estimate(data, net) {
  if (!data) return null
  const wthru = (data.tokens ?? []).find((t) => t.mint === net.WTHRU_MINT || t.ticker === 'WTHRU')
  return BigInt(data.thru ?? 0) + BigInt(wthru?.amount ?? 0)
}

function initials(name, address) {
  const n = String(name ?? '').replace(/[^A-Za-z0-9]/g, '')
  return (n.slice(0, 2) || String(address ?? '').slice(2, 4)).toLowerCase()
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

function Coin({ ticker, mint, net }) {
  const cls = !mint ? 'coin round thru' : mint === net.WTHRU_MINT || ticker === 'WTHRU' ? 'coin round wthru' : 'coin'
  return <span className={cls}>{(ticker || '?').slice(0, 2).toUpperCase()}</span>
}

export function Home({ account, settings }) {
  const net = networkFor(settings)
  const { data, error, reload } = useOverview()
  const { site, reload: reloadSite } = useCurrentSite()
  const act = useAction()
  const [note, setNote] = useState(null)
  const [copied, setCopied] = useState(false)

  const activate = () => act.run(async () => { await bg('activate'); setNote('Your account is on chain.'); reload() })
  const copy = () => { navigator.clipboard.writeText(account.address); setCopied(true); setTimeout(() => setCopied(false), 1400) }

  const assets = assetsOf(data)
  const live = data?.exists
  /* False only when the node did not answer at all, which is a different
     problem from an address that is not on chain yet and must not be shown
     as one. */
  const reachable = data ? data.reachable !== false : !error
  const value = estimate(data, net)
  const others = assets.filter((a) => a.mint && a.mint !== net.WTHRU_MINT && a.ticker !== 'WTHRU' && BigInt(a.amount ?? 0) > 0n).length

  /* Send is the one amber action. Swap and Faucet open ThruScan in a tab. */
  const tiles = [
    { icon: 'send', label: 'Send', onClick: () => go('/send'), off: !live, main: true },
    { icon: 'receive', label: 'Receive', onClick: () => go('/receive') },
    { icon: 'swap', label: 'Swap', onClick: () => openSite('/swap') },
    { icon: 'faucet', label: 'Faucet', onClick: () => openSite('/faucet') },
  ]
  const [tab, setTab] = useState(() => sessionStorage.getItem('home-tab') || 'tokens')
  const pickTab = (t) => { setTab(t); try { sessionStorage.setItem('home-tab', t) } catch { /* ignore */ } }

  return (
    <div className="screen">
      <header className="top">
        <button className="chip-pill" onClick={() => go('/accounts')} title="Switch account">
          <span className="ava">{initials(account.name, account.address)}</span>
          <b>{account.name ?? 'Account 1'}</b>
          <Icon name="expand" size={14} />
        </button>
        <span className="net-chip" title={`${net.label}${net.test ? ' (test network)' : ''}`}><i />{net.label.replace(/\s*\(.*\)$/, '')}</span>
        <div className="top-right">
          <button className="icon-btn" aria-label={copied ? 'Copied' : 'Copy address'} title={copied ? 'Copied' : 'Copy address'} onClick={copy}><Icon name={copied ? 'success' : 'copy'} size={18} /></button>
          <button className="icon-btn" aria-label="Open ThruScan" title="Open ThruScan" onClick={() => openSite(`/account/${account.address}`)}><Icon name="external" size={18} /></button>
        </div>
      </header>

      <div className="body">
        <section className="value">
          <span className="value-k">Estimated value</span>
          <b className="value-v">{data && reachable && value !== null ? fmtUnits(value) : '…'}</b>
          <span className="value-sub">WTHRU{others > 0 ? ` · THRU and WTHRU only; ${others} other token${others === 1 ? '' : 's'} priced on ThruScan` : ''}</span>
        </section>

        {/* A node that does not answer. Nothing is wrong with the wallet; say
            so rather than leave the number on "…" for ever. */}
        {(!reachable || (!data && error)) && (
          <section className="card callout">
            <b>Cannot reach {net.label}</b>
            <p className="fine">
              Nothing is wrong with your wallet or your key. The node at <span className="mono">{net.rpc}</span> is
              not answering{net.id === 'mainnet' ? ', which is expected until Thru opens mainnet' : ''}. Change the
              network in Settings, or wait and it will fill in by itself.
            </p>
          </section>
        )}

        {data && !live && reachable && (
          <section className="card callout">
            <b>Activate this address</b>
            <p className="fine">A new Thru address is written on chain once before it can hold anything. Free, and signed by you.</p>
            <button className="btn small" disabled={act.busy} onClick={activate}>{act.busy ? 'Activating…' : 'Activate'}</button>
          </section>
        )}

        <nav className="tiles">
          {tiles.map((t) => (
            <button key={t.label} className={`tile${t.main ? ' main' : ''}`} onClick={t.onClick} disabled={t.off}>
              <span className="tile-ic"><Icon name={t.icon} size={22} /></span><span>{t.label}</span>
            </button>
          ))}
        </nav>

        <Notice kind="good">{note}</Notice>
        <Notice>{act.error || error}</Notice>

        <div className="seg">
          <button className={tab === 'tokens' ? 'on' : ''} onClick={() => pickTab('tokens')}>Tokens</button>
          <button className={tab === 'items' ? 'on' : ''} onClick={() => pickTab('items')}>Items</button>
        </div>

        {tab === 'items' && <NftGrid address={account.address} />}
        {tab !== 'items' && <div className="list">
          {!data && <p className="fine pad">Reading the chain…</p>}
          {assets.map((a) => (
            <a key={a.key} className="row" target="_blank" rel="noreferrer"
              href={a.mint ? `${EXPLORER}/token/${a.mint}` : `${EXPLORER}/account/${account.address}`}>
              <Coin ticker={a.ticker} mint={a.mint} net={net} />
              <span className="row-main"><b>{a.ticker}</b>{a.mint && <span className="fine mono">{short(a.mint, 4)}</span>}</span>
              <span className="row-end">{fmtUnits(a.amount, a.decimals)}</span>
            </a>
          ))}
          {data && data.tokens === null && <p className="fine pad">Looking for tokens…</p>}
        </div>}
      </div>

      {site && (
        <section className="site-bar pinned">
          <span className="favicon">{site.origin.replace(/^https?:\/\//, '').slice(0, 1).toUpperCase()}</span>
          <span className="row-main">
            <b>{site.origin.replace(/^https?:\/\//, '')}</b>
            <span className={`fine ${site.connected ? 'on' : ''}`}>{site.connected ? 'Connected' : 'Not connected'}</span>
          </span>
          {site.connected && <button className="btn ghost small" onClick={() => bg('revoke', { origin: site.origin }).then(reloadSite)}>Disconnect</button>}
        </section>
      )}
      <TabBar on="/" />
    </div>
  )
}

/* ---------- NFTs ---------- */

let nftCache = null   // survives switching tabs while the popup is open
let nftCacheFor = null

function useNfts(address) {
  if (nftCacheFor !== address) { nftCache = null; nftCacheFor = address }
  const [items, setItems] = useState(nftCache)
  const [error, setError] = useState(null)
  useEffect(() => {
    bg('nfts').then((n) => { nftCache = n; nftCacheFor = address; setItems(n) }).catch((e) => setError(e.message))
  }, [address])
  return { items, error }
}

/** NFTs grouped into one row per collection, in the order first seen. */
function groups(items) {
  const by = new Map()
  for (const n of items ?? []) {
    if (!by.has(n.mint)) by.set(n.mint, { mint: n.mint, name: n.collection || (n.name ? n.name.replace(/\s*#\d+$/, '') : null) || short(n.mint, 5), items: [] })
    by.get(n.mint).items.push(n)
  }
  for (const g of by.values()) g.items.sort((a, b) => Number(a.id) - Number(b.id))
  return [...by.values()]
}

function NftGrid({ address }) {
  const { items, error } = useNfts(address)
  const cols = groups(items)
  return (
    <div className="nft-wrap">
      <Notice>{error}</Notice>
      {items === null && !error && <p className="fine pad">Reading the chain…</p>}
      {items?.length === 0 && <p className="fine pad">No NFTs yet. Ones you mint or receive show up here.</p>}
      {cols.length > 0 && (
        <div className="list">
          {cols.map((c) => (
            <button key={c.mint} className="row nft-col" onClick={() => go(c.items.length === 1 ? `/nft/${c.items[0].account}` : `/nfts/${c.mint}`)}>
              <span className="nft-stack">
                {c.items.slice(0, 3).map((n) => <NftImage key={n.account} src={n.image} id={n.id} />)}
                {c.items.length > 3 && <span className="nft-more">+{c.items.length - 3}</span>}
              </span>
              <span className="row-main"><b>{c.name}</b><span className="fine">{c.items.length === 1 ? (c.items[0].name || `#${c.items[0].id}`) : `${c.items.length} items`}</span></span>
              <span className="chev">›</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Every NFT of one collection this wallet holds. */
export function NftCollection({ mint, me }) {
  const { items, error } = useNfts(me)
  const g = groups(items).find((x) => x.mint === mint)
  return (
    <div className="screen">
      <Header title={g?.name ?? 'Collection'} back="/" />
      <div className="body">
        <Notice>{error}</Notice>
        {items === null && !error && <p className="fine pad">Reading the chain…</p>}
        {g && (
          <div className="list">
            {g.items.map((n) => (
              <button key={n.account} className="row nft-row" onClick={() => go(`/nft/${n.account}`)}>
                <NftImage src={n.image} id={n.id} />
                <span className="row-main"><b>{n.name || `#${n.id}`}</b>{n.listed && <span className="fine">Listed · {Number(n.price).toLocaleString('en-US')} THRU</span>}</span>
                <span className="chev">›</span>
              </button>
            ))}
          </div>
        )}
      </div>
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

export function NftScreen({ account: nftAccount, me, settings }) {
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
  const PALS = networkFor(settings).pals
  const canSend = !n.listed && (n.authority === me || (n.mint === PALS.mint && n.authority === PALS.program))
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
        {n.listed && (
          <p className="fine">Listed for {Number(n.price).toLocaleString('en-US')} THRU. The market holds it until it sells. To change the price or take it back, <a href={`${EXPLORER}/pals?id=${n.id}`} target="_blank" rel="noreferrer">open it on ThruScan</a>.</p>
        )}
        {!canSend && !n.listed && !result && (
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
      <Header title="Activity" />
      <div className="body"><Activity address={account.address} /></div>
      <TabBar on="/activity" />
    </div>
  )
}

export function Sites() {
  const [sites, setSites] = useState(null)
  const load = () => bg('sites').then(setSites)
  useEffect(() => { load() }, [])
  return (
    <div className="screen">
      <Header title="Connected sites" back="/settings" />
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

/* Activity (6h): grouped by day, a tinted icon square per row, amounts green
   when they arrive and red when they leave. The word stays on every row, so
   colour is never the only signal. */
function dayOf(ms) {
  if (!ms) return 'Earlier'
  const d = new Date(ms)
  const today = new Date()
  const y = new Date(); y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
function toneOf(i) {
  if (i.ok === false) return 'negative'
  const l = String(i.label ?? '').toLowerCase()
  if (/^(bought|received)|faucet/.test(l) || String(i.delta ?? '').startsWith('+')) return 'positive'
  if (/^(sold|sent)/.test(l) || /^[−-]/.test(String(i.delta ?? ''))) return 'negative'
  if (/launch/.test(l)) return 'brand'
  return 'neutral'
}
const ICON_OF = { positive: 'receive', negative: 'send', brand: 'success', neutral: 'swap' }

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

  let lastDay = null
  return (
    <div className="list">
      <Notice>{error}</Notice>
      {items === null && !error && <p className="fine pad">Reading the chain…</p>}
      {items?.length === 0 && <p className="fine pad">Nothing yet.</p>}
      {items?.map((i) => {
        const day = dayOf(i.time)
        const head = day !== lastDay ? <p className="day" key={`d-${day}`}>{day}</p> : null
        lastDay = day
        const tone = toneOf(i)
        const delta = String(i.delta ?? '')
        return [
          head,
          <a key={i.signature} className="row" href={`${EXPLORER}/tx/${i.signature}`} target="_blank" rel="noreferrer">
            <span className={`ic-sq ${tone}`}><Icon name={i.ok === false ? 'failed' : ICON_OF[tone]} size={18} /></span>
            <span className="row-main">
              <b>{i.label}{i.ok === false ? ' failed' : ''}</b>
              <span className="fine">{timeAgo(i.time)}</span>
            </span>
            <span className={`row-end ${delta.startsWith('+') ? 'amt-pos' : /^[−-]/.test(delta) ? 'amt-neg' : 'muted'}`}>{i.ok === false ? '—' : delta || '—'}</span>
          </a>,
        ]
      })}
      {next && <button className="btn ghost small" disabled={more} onClick={loadMore}>{more ? 'Loading…' : 'Older'}</button>}
    </div>
  )
}

export function Receive({ account, settings }) {
  const net = networkFor(settings)
  return (
    <div className="screen">
      <Header title="Receive" back="/" />
      <div className="body stack center">
        <div className="qr-card">
          <QRImage text={account.address} size={200} />
          <span className="qr-mark"><Mark size={36} /></span>
        </div>
        <b>{account.name ?? 'Account'}</b>
        <p className="mono addr">{account.address}</p>
        <Copy value={account.address} label="Copy address" className="btn full" />
        <p className="fine">Only send Thru {net.label.replace(/\s*\(.*\)$/, '').toLowerCase()} tokens to this address.</p>
      </div>
    </div>
  )
}

export function Send({ settings }) {
  const net = networkFor(settings)
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
        <Header title={failed ? 'Not sent' : result?.settled ? 'Sent' : 'Sending'} back="/" />
        <div className="body stack center">
          <span className={`ic-sq ${failed ? 'negative' : result?.settled ? 'positive' : ''}`} style={{ width: 56, height: 56, borderRadius: 16 }}>
            <Icon name={failed ? 'failed' : result?.settled ? 'success' : 'activity'} size={26} />
          </span>
          <p>{failed ? `The chain rejected it (error ${result.userError || result.vmError}). Nothing was sent but the fee.` : result?.settled ? `${amount} ${asset.ticker} sent.` : 'Sent to the network. Waiting for it to land…'}</p>
          <a className="mono" href={`${EXPLORER}/tx/${result.signature}`} target="_blank" rel="noreferrer">{short(result.signature)}</a>
          <button className="btn full" onClick={() => go('/')}>Close</button>
        </div>
      </div>
    )
  }

  if (step === 'review') {
    return (
      <div className="screen">
        <Header title="Review send" back={() => setStep('form')} />
        <div className="body stack">
          <div className="big-amount"><span className="value-v amt-neg">−{amount} <small className="muted">{asset.ticker}</small></span></div>
          <div className="card kv">
            <div><span>To</span><b className="mono">{resolved.name ?? short(resolved.address)}</b></div>
            {resolved.name && <div><span>Address</span><span className="mono fine">{short(resolved.address, 10)}</span></div>}
            <div><span>Network</span><span>{net.label}{net.test ? ' (test)' : ''}</span></div>
            <div><span>Network fee</span><span className="mono">1 THRU at most</span></div>
          </div>
          {asset.mint && <p className="fine">If the receiver has never held {asset.ticker}, this first opens their {asset.ticker} account, which is a second transaction you sign.</p>}
          <Notice>{act.error}</Notice>
        </div>
        <footer className="foot two">
          <button className="btn ghost" onClick={() => setStep('form')}>Back</button>
          <button className="btn" disabled={act.busy} onClick={send}>{act.busy ? 'Sending…' : 'Send'}</button>
        </footer>
      </div>
    )
  }

  return (
    <div className="screen">
      <Header title="Send" back="/" />
      <div className="body stack">
        <label className="field">
          <span>To</span>
          <input value={to} placeholder="Address (ta…) or name.id" autoComplete="off" spellCheck={false} onChange={(e) => setTo(e.target.value)} />
          {resolved?.error && <span className="hint bad"><Icon name="failed" size={12} stroke={2.2} />{resolved.error}</span>}
          {resolved?.name && <span className="hint good"><Icon name="success" size={12} stroke={2.2} />resolves to <span className="mono">{short(resolved.address, 5)}</span></span>}
        </label>

        <div className="big-amount">
          <span className="token-pill">
            {asset && <Coin ticker={asset.ticker} mint={asset.mint} net={net} />}
            <select aria-label="Token" value={assetKey} onChange={(e) => { setAssetKey(e.target.value); setAmount('') }}>
              {assets.map((a) => <option key={a.key} value={a.key}>{a.ticker}</option>)}
            </select>
          </span>
          <input aria-label="Amount" value={amount} inputMode="decimal" placeholder="0" onChange={(e) => setAmount(e.target.value)} />
          {asset && (
            <span className="fine">
              <span className="mono">{fmtUnits(asset.amount, asset.decimals)} {asset.ticker}</span>
              <button className="link" disabled={asset.amount === '0'} onClick={() => setAmount(unitsToText(asset.amount, asset.decimals))}>Max</button>
            </span>
          )}
          {tooMuch && <span className="hint bad">More than you hold.</span>}
          {amount && units === null && <span className="hint bad">{asset?.decimals === 0 ? 'Whole numbers only.' : `Up to ${asset?.decimals} decimal places.`}</span>}
        </div>

        <div className="card kv">
          <div><span>Network fee</span><span className="mono">1 THRU at most</span></div>
        </div>
      </div>
      <footer className="foot">
        <button className="btn full" disabled={!ready} onClick={() => setStep('review')}>Review send</button>
      </footer>
    </div>
  )
}
