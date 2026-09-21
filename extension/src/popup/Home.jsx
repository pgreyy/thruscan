// extension/src/popup/Home.jsx
//
// The wallet itself: balance, tokens, activity, and the Send and Receive
// screens.

import { useCallback, useEffect, useState } from 'react'
import { QRImage } from './qr.jsx'
import {
  bg, go, EXPLORER, Header, Notice, Copy, useAction, fmtUnits, toUnits, unitsToText, short, timeAgo,
} from './ui.jsx'

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

export function Home({ account, onLock }) {
  const { data, error, reload } = useOverview()
  const [tab, setTab] = useState('tokens')
  const act = useAction()
  const [note, setNote] = useState(null)

  const activate = () => act.run(async () => { await bg('activate'); setNote('Your account is on chain.'); reload() })
  const faucet = () => act.run(async () => {
    const sig = await bg('faucet')
    setNote('Claiming 10,000 test THRU…')
    const r = await bg('waitFor', { signature: sig })
    setNote(r.settled && !r.ok ? null : 'Claimed 10,000 test THRU.')
    if (r.settled && !r.ok) act.setError(`The faucet refused (error ${r.userError || r.vmError}). It may be empty or rate limited; try again later.`)
    reload()
  })

  const assets = assetsOf(data)

  return (
    <div className="screen">
      <header className="bar">
        <span className="mark">T</span>
        <div className="acct">
          <b>Account 1</b>
          <span className="mono muted">{short(account.address)}</span>
        </div>
        <div className="bar-right">
          <Copy value={account.address} label="Copy" className="icon-btn text" />
          <button className="icon-btn" aria-label="Settings" onClick={() => go('/settings')}>⚙</button>
        </div>
      </header>

      <div className="body">
        <section className="balance">
          <span className="muted">THRU</span>
          <b>{data ? fmtUnits(data.thru) : '…'}</b>
          <span className="net">Thru alphanet</span>
        </section>

        {data && !data.exists && (
          <section className="card callout">
            <b>Activate this address</b>
            <p className="fine">A new Thru address has to be written on chain once before it can hold anything. It is free and signed by you.</p>
            <button className="btn small" disabled={act.busy} onClick={activate}>{act.busy ? 'Activating…' : 'Activate'}</button>
          </section>
        )}

        <div className="actions">
          <button className="act" onClick={() => go('/send')} disabled={!data?.exists}><span>↑</span>Send</button>
          <button className="act" onClick={() => go('/receive')}><span>↓</span>Receive</button>
          <button className="act" onClick={faucet} disabled={!data?.exists || act.busy}><span>+</span>Faucet</button>
          <a className="act" href={`${EXPLORER}/account/${account.address}`} target="_blank" rel="noreferrer"><span>↗</span>Explorer</a>
        </div>

        <Notice kind="good">{note}</Notice>
        <Notice>{act.error || error}</Notice>

        <div className="seg tabs">
          <button className={tab === 'tokens' ? 'on' : ''} onClick={() => setTab('tokens')}>Tokens</button>
          <button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity</button>
        </div>

        {tab === 'tokens' && (
          <div className="list">
            {!data && <p className="fine pad">Reading the chain…</p>}
            {assets.map((a) => (
              <a key={a.key} className="row" target="_blank" rel="noreferrer"
                href={a.mint ? `${EXPLORER}/token/${a.mint}` : `${EXPLORER}/account/${account.address}`}>
                <span className="coin">{a.ticker.slice(0, 1)}</span>
                <span className="row-main"><b>{a.ticker}</b>{a.mint && <span className="fine mono">{short(a.mint, 4)}</span>}</span>
                <span className="mono">{fmtUnits(a.amount, a.decimals)}</span>
              </a>
            ))}
          </div>
        )}
        {tab === 'activity' && <Activity address={account.address} />}
      </div>

      <footer className="foot">
        <button className="link" onClick={onLock}>Lock</button>
      </footer>
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
