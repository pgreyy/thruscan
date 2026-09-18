// src/pages/Profile.jsx
//
// Everything about your account in one place.
//
// The picture is the interesting part. It is not stored by ThruScan: it is an
// `avatar` record on your `.id` name, which is a key/value pair on Thru's own
// name service. So it is readable by any other explorer or wallet, it survives
// ThruScan, and only you can change it, because the name service checks the
// name's owner rather than who is paying. ThruScan gave you the name and cannot
// edit it.
//
// A record value is capped at 256 bytes, so it holds a URL rather than an
// image. That is the right trade: an image on chain would cost real state for
// something every browser already knows how to fetch, and a URL can point at
// anything you already have.
//
// Tokens launched are read out of the launchpad registry by matching the
// creator field, which is the only place that fact exists. There is no index
// and no database, which is why the page scans rather than queries.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useWallet } from './Wallet.jsx'
import { useUnlockGate, isDismissal } from '../components/Unlock.jsx'
import {
  checkName, setNameRecord, waitForResult, hasWallet,
} from '../lib/wallet.js'
import { decodeDomain, withSuffix, ROOT_SUFFIX } from '../lib/names.js'
import { decodePadRegistry } from '../lib/pad.js'
import { getAccount } from '../lib/rpcClient.js'
import { THRUPAD_REGISTRY as PAD_REGISTRY } from '../lib/addresses.js'

const DECIMALS = 6
const AVATAR_KEY = 'avatar'

const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '')

function fmt(units, decimals = DECIMALS, maxFrac = 4) {
  const n = Number(units ?? 0n) / 10 ** decimals
  if (!isFinite(n)) return '0'
  if (n !== 0 && Math.abs(n) < 10 ** -maxFrac) return `<${10 ** -maxFrac}`
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac })
}

function decodeBase64(b64) {
  if (!b64) return null
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The same four-square identicon the pill uses, larger. */
function Identicon({ address, size = 88 }) {
  const cells = useMemo(() => {
    let h = 0
    for (let i = 0; i < (address?.length ?? 0); i++) h = (h * 31 + address.charCodeAt(i)) >>> 0
    return [0, 1, 2, 3].map((i) => `hsl(${(h >> (i * 7)) % 360} 62% 55%)`)
  }, [address])

  return (
    <span
      aria-hidden="true"
      style={{
        width: size, height: size, borderRadius: 18, overflow: 'hidden',
        display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr',
        flex: `0 0 ${size}px`,
      }}
    >
      {cells.map((c, i) => <span key={i} style={{ background: c }} />)}
    </span>
  )
}

function Avatar({ url, address, size = 88 }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => { setBroken(false) }, [url])

  if (!url || broken) return <Identicon address={address} size={size} />
  return (
    <img
      src={url}
      alt=""
      onError={() => setBroken(true)}
      style={{ width: size, height: size, borderRadius: 18, objectFit: 'cover', flex: `0 0 ${size}px` }}
    />
  )
}

/* ---------- the page ---------- */

export function ProfilePage() {
  const wallet = useWallet()
  const gate = useUnlockGate()

  const [names, setNames] = useState([])       // [{ name, account, domain }]
  const [launches, setLaunches] = useState([])
  const [scanning, setScanning] = useState(true)
  const [urlDraft, setUrlDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const storeKey = wallet.address ? `thruscan.names.${wallet.address}` : null

  const loadNames = useCallback(async () => {
    if (!storeKey) { setNames([]); return }
    let held = []
    try { held = JSON.parse(localStorage.getItem(storeKey) || '[]') } catch {}
    const rows = []
    for (const name of held) {
      try {
        const r = await checkName(name)
        if (r.ok && r.taken) rows.push({ name, account: r.account, domain: decodeDomain(decodeBase64(r.data)) })
      } catch { /* skip rather than fail the page */ }
    }
    setNames(rows)
  }, [storeKey])

  /* The registry is the only record of who launched what, so this reads it and
     filters. It is a scan rather than a query because there is no index, which
     is fine at 64 slots and would not be at 64,000. */
  const loadLaunches = useCallback(async () => {
    if (!wallet.address || !PAD_REGISTRY) { setLaunches([]); setScanning(false); return }
    setScanning(true)
    try {
      const acc = await getAccount(PAD_REGISTRY)
      const reg = decodePadRegistry(acc.data?.base64)
      setLaunches(reg.launches.filter((l) => l.creator === wallet.address))
    } catch { setLaunches([]) }
    finally { setScanning(false) }
  }, [wallet.address])

  useEffect(() => { loadNames() }, [loadNames])
  useEffect(() => { loadLaunches() }, [loadLaunches])

  const primary = names[0] ?? null
  const avatarUrl = primary?.domain?.records?.find((r) => r.key === AVATAR_KEY)?.value ?? null

  const saveAvatar = async () => {
    const url = urlDraft.trim()
    setError(null)
    if (!primary) { setError(`Claim a ${'.' + ROOT_SUFFIX} name first. The picture lives on the name.`); return }
    if (!/^https:\/\/\S+$/i.test(url)) { setError('Use an https link to an image.'); return }
    if (new TextEncoder().encode(url).length > 256) { setError('That link is longer than 256 bytes.'); return }

    try { await gate.ensure() } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return
    }

    setBusy(true)
    try {
      const sig = await setNameRecord(primary.account, AVATAR_KEY, url)
      const r = await waitForResult(sig)
      if (r.settled && !r.succeeded) throw new Error(`The chain rejected it (error ${r.userError || r.vmError}).`)
      setUrlDraft('')
      await new Promise((res) => setTimeout(res, 2500))
      await loadNames()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const held = Object.entries(wallet.balances ?? {})
    .filter(([, b]) => b?.exists && b.amount > 0n)
    .map(([mint, b]) => ({
      mint,
      ticker: wallet.tickers?.[mint] || short(mint),
      amount: fmt(b.amount, wallet.decimals?.[mint] ?? DECIMALS),
    }))

  if (!hasWallet()) {
    return (
      <div className="wrap">
        <p className="eyebrow">Account</p>
        <h1 className="h1">Profile</h1>
        <p className="lede">Your name, your picture, your balances and everything you have launched.</p>
        <section className="card">
          <h2 className="h2">No wallet yet</h2>
          <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
            <Link to="/wallet">Open one</Link>. It takes about fifteen seconds, the key never leaves
            your browser, and everything on this page follows from it.
          </p>
        </section>
      </div>
    )
  }

  return (
    <div className="wrap">
      {gate.modal}

      <section className="card profile-head">
        <Avatar url={avatarUrl} address={wallet.address} />
        <div style={{ minWidth: 0 }}>
          <h1 className="h1" style={{ marginBottom: 4, fontSize: 30 }}>
            {primary ? withSuffix(primary.name) : 'Unnamed'}
          </h1>
          <p className="sub mono" style={{ wordBreak: 'break-all' }}>{wallet.address}</p>
          {!primary && (
            <p className="fine" style={{ marginTop: 8 }}>
              <Link to="/names">Claim a name</Link> and this becomes yours rather than a string of
              characters. It is free.
            </p>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="h2">Picture</h2>
            <p className="sub">Stored on your name, not on ThruScan</p>
          </div>
        </div>

        <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
          {primary
            ? <>An <code className="mono">avatar</code> record on {withSuffix(primary.name)}, which
              means any wallet or explorer that reads Thru's name service can show it, and only you
              can change it. Paste a link to an image.</>
            : <>The picture lives on your name as a record, so you need a name first. Claiming one
              is free and takes a few seconds.</>}
        </p>

        <div className="stack" style={{ marginTop: 14 }}>
          <input
            className="field mono"
            value={urlDraft}
            onChange={(e) => { setUrlDraft(e.target.value); setError(null) }}
            placeholder="https://example.com/me.png"
            disabled={!primary}
          />
          <button className="btn" onClick={saveAvatar} disabled={busy || !primary || !urlDraft.trim()}>
            {busy ? 'Signing' : avatarUrl ? 'Change picture' : 'Set picture'}
          </button>
        </div>

        {avatarUrl && (
          <p className="fine mono" style={{ marginTop: 12, wordBreak: 'break-all' }}>{avatarUrl}</p>
        )}
        {error && <p className="notice bad" style={{ marginTop: 12 }}>{error}</p>}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="h2">Holdings</h2>
            <p className="sub">{wallet.registered ? 'Live on alphanet' : 'Not registered yet'}</p>
          </div>
          <button className="btn ghost" onClick={() => wallet.refresh()}>Refresh</button>
        </div>
        <div className="rows" style={{ marginTop: 12 }}>
          {held.length === 0
            ? <p className="fine">Nothing yet. <Link to="/faucet">Get some tUSD</Link> to start.</p>
            : held.map((h) => (
              <div className="row" key={h.mint}>
                <span><b>{h.ticker}</b></span>
                <span className="mono">{h.amount}</span>
              </div>
            ))}
          <div className="row">
            <span className="fine">Fees</span>
            <span className="mono fine">{wallet.native?.toString() ?? '0'} THRU</span>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="h2">Launched</h2>
            <p className="sub">Tokens whose curve records you as the creator</p>
          </div>
          <Link className="btn ghost" to="/launch">Launch one</Link>
        </div>
        {scanning
          ? <p className="fine" style={{ marginTop: 12 }}>Reading the launchpad…</p>
          : launches.length === 0
            ? <p className="fine" style={{ marginTop: 12 }}>Nothing yet.</p>
            : (
              <div className="rows" style={{ marginTop: 12 }}>
                {launches.map((l) => (
                  <div className="row" key={l.id}>
                    <span>
                      <b>${l.symbol}</b> <span className="fine">{l.name}</span>
                    </span>
                    <span className="mono fine">
                      {fmt(l.creatorFees)} unclaimed · {Number(l.tradeCount)} trades
                    </span>
                  </div>
                ))}
              </div>
            )}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="h2">Names</h2>
            <p className="sub">Claimed in this browser</p>
          </div>
          <Link className="btn ghost" to="/names">Claim another</Link>
        </div>
        <div className="rows" style={{ marginTop: 12 }}>
          {names.length === 0
            ? <p className="fine">None yet.</p>
            : names.map((n) => (
              <div className="row" key={n.account}>
                <span><b>{withSuffix(n.name)}</b></span>
                <span className="fine">{n.domain?.records?.length ?? 0} records</span>
              </div>
            ))}
        </div>
      </section>

      <section className="card">
        <h2 className="h2">Coming to this page</h2>
        <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
          Trading history, fees earned across every launch, and whatever turns out to be worth
          recognising once enough people have used this. All of it has to come off the chain rather
          than out of a database, so each one is a decoder rather than a column, and they arrive one
          at a time.
        </p>
      </section>
    </div>
  )
}
