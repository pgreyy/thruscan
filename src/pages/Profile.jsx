// src/pages/Profile.jsx
//
// Everything about your account in one place: who you are, what you hold, what
// you made, and what you have done.
//
// The picture is the interesting part. It is not stored by ThruScan: it is a
// record on your `.id` name, which is a key/value pair on Thru's own name
// service. So it is readable by any other explorer or wallet, it survives
// ThruScan, and only you can change it, because the name service checks the
// name's owner rather than who is paying. ThruScan gave you the name and cannot
// edit it.
//
// A record value is capped at 256 bytes, so it holds a reference rather than an
// image, and there are two kinds:
//
//   avatar   an https link to a picture. Drop a file on the square and the site
//            will crop, compress and host it for you, then write the link. You
//            can still paste your own link instead; that path never went away.
//
//   pfp      `thru:pixelpals/1945`, an NFT you own. It draws as a hexagon, and
//            the hexagon is checked rather than trusted: the collection is read
//            on chain every time and the Pal's current owner compared with this
//            name's owner. Sell it and it goes back to a circle by itself.
//
// Everything to do with changing the picture is behind the pencil. A profile
// is a thing you look at far more often than you edit, and a page that leads
// with an upload box and a row of every NFT you own is a page built for the
// rare visit rather than the common one.
//
// Tokens launched are read out of the launchpad registry by matching the
// creator field, which is the only place that fact exists.
//
// Update 02 (5j): no Overview tab. Tokens, Items, Launched and Activity, with
// the estimated value and Send / Receive / Swap in the header.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useWallet, SendForm, ReceiveBody, QuickModal } from './Wallet.jsx'
import { useChainData } from './Dex.jsx'
import { useUnlockGate, isDismissal } from '../components/Unlock.jsx'
import { Pfp } from '../components/Pfp.jsx'
import { TokenMetaCard, TokenIcon } from '../components/TokenMeta.jsx'
import { Activity } from '../components/Activity.jsx'
import { Tabs } from '../components/Tabs.jsx'
import { Icon } from '../components/Icon.jsx'
import { setNameRecord, waitForResult, hasWallet } from '../lib/wallet.js'
import { connectWallet } from '../lib/connect.js'
import { ownedNames, readName } from '../lib/holdings.js'
import { withSuffix } from '../lib/names.js'
import { decodeSwapRegistry } from '../lib/swap.js'
import { usePadMarket } from '../lib/padmarket.js'
import { relTime } from '../lib/when.js'
import { THRUPAD_REGISTRY as PAD_REGISTRY, THRUSWAP_REGISTRY as SWAP_REGISTRY, WTHRU_MINT, TUSD_MINT } from '../lib/addresses.js'
import { AVATAR_KEY, PFP_KEY, formatNftPfp, pfpForDomain, EMPTY_PFP, palsSnapshot } from '../lib/pfp.js'
import { squareImage, uploadImage, fileProblem, NoStoreError } from '../lib/imagefile.js'
import { allTokenMeta } from '../lib/tokenmeta.js'
import { toSvg } from '../lib/pals/art.js'
import './profile.css'

const DECIMALS = 6

const short = (a) => (a ? `${a.slice(0, 5)}…${a.slice(-4)}` : '')

function fmt(units, decimals = DECIMALS, maxFrac = 4) {
  const n = Number(units ?? 0n) / 10 ** decimals
  if (!isFinite(n)) return '0'
  if (n !== 0 && Math.abs(n) < 10 ** -maxFrac) return `<${10 ** -maxFrac}`
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac })
}

/** Nanoseconds since the epoch, as the name service records them. */
function joined(registeredAt) {
  if (!registeredAt) return null
  const ms = Number(registeredAt / 1_000_000n)
  if (!isFinite(ms) || ms <= 0) return null
  return new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

/* ---------- picking a Pal ---------- */

function PalOption({ pal, num, on, onPick }) {
  const art = useMemo(() => toSvg(pal.grid, 56), [pal])
  return (
    <button
      type="button"
      className={`pal-option${on ? ' on' : ''}`}
      onClick={() => onPick(num)}
      aria-pressed={on}
      title={`Pixel Pal #${num}`}
    >
      <span className="pfp pfp-hex" style={{ width: 56, height: 56 }}>
        <span className="pfp-art" dangerouslySetInnerHTML={{ __html: art }} />
      </span>
      <span className="mono">#{num}</span>
    </button>
  )
}

/* ---------- changing the picture ----------
   Only ever on screen because someone pressed the pencil. */

function PictureEditor({ primary, domain, pfp, onSaved, onClose }) {
  const gate = useUnlockGate()
  const fileRef = useRef(null)

  const [busy, setBusy] = useState(null)      // 'upload' | 'nft' | 'link' | 'clear'
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)
  const [over, setOver] = useState(false)
  const [showLink, setShowLink] = useState(false)
  const [linkDraft, setLinkDraft] = useState('')
  const [mine, setMine] = useState([])        // [{ num, pal }] this name's own Pals
  const [noStore, setNoStore] = useState(false)

  const owner = domain?.owner ?? null
  const claimed = pfp?.kind === 'nft' ? pfp.num : null

  // The Pals this name's owner holds right now, drawn from the same snapshot
  // the hexagon check uses, so the picker cannot offer something the check
  // would then refuse.
  useEffect(() => {
    let alive = true
    if (!owner) { setMine([]); return undefined }
    palsSnapshot()
      .then(({ art, owners }) => {
        if (!alive) return
        const held = Object.entries(owners)
          .filter(([, who]) => who === owner)
          .map(([num]) => Number(num))
          .filter((num) => art[num])
          .sort((a, b) => a - b)
        setMine(held.map((num) => ({ num, pal: art[num] })))
      })
      .catch(() => { if (alive) setMine([]) })
    return () => { alive = false }
  }, [owner])

  const write = useCallback(async (key, value, what) => {
    setError(null); setNote(null)
    try { await gate.ensure() } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return false
    }
    const sig = await setNameRecord(primary.account, key, value)
    const r = await waitForResult(sig)
    if (r.settled && !r.succeeded) throw new Error(`The chain rejected it (error ${r.userError || r.vmError}).`)
    // The record read comes from the node, which is a moment behind the write.
    await new Promise((res) => setTimeout(res, 2500))
    await onSaved()
    setNote(what)
    return true
  }, [gate, primary, onSaved])

  const takeFile = async (file) => {
    const problem = fileProblem(file)
    if (problem) { setError(problem); return }
    setError(null); setNote(null); setBusy('upload')
    try {
      const shaped = await squareImage(file)
      let url
      try { url = await uploadImage(shaped.blob, { kind: 'pfp' }) }
      finally { URL.revokeObjectURL(shaped.url) }
      await write(AVATAR_KEY, url, 'Picture saved on your name.')
    } catch (e) {
      if (e instanceof NoStoreError) {
        setNoStore(true); setShowLink(true)
        setError('Uploads are not switched on for this site yet. You can paste a link instead.')
      } else {
        setError(String(e?.message ?? e))
      }
    } finally {
      setBusy(null)
    }
  }

  const pickPal = async (num) => {
    setBusy('nft')
    try {
      if (num === claimed) await write(PFP_KEY, '', 'Back to your picture.')
      else await write(PFP_KEY, formatNftPfp(num), `Pixel Pal #${num} is your picture.`)
    } catch (e) { setError(String(e?.message ?? e)) } finally { setBusy(null) }
  }

  const saveLink = async () => {
    const url = linkDraft.trim()
    if (!/^https:\/\/\S+$/i.test(url)) { setError('Use an https link to an image.'); return }
    if (new TextEncoder().encode(url).length > 256) { setError('That link is longer than 256 bytes.'); return }
    setBusy('link')
    try {
      const ok = await write(AVATAR_KEY, url, 'Picture saved on your name.')
      if (ok) setLinkDraft('')
    } catch (e) { setError(String(e?.message ?? e)) } finally { setBusy(null) }
  }

  const clearPicture = async () => {
    setBusy('clear')
    try { await write(AVATAR_KEY, '', 'Picture removed.') }
    catch (e) { setError(String(e?.message ?? e)) } finally { setBusy(null) }
  }

  const working = busy !== null

  return (
    <section className="card pic-editor">
      {gate.modal}

      <div className="card-head">
        <div>
          <h2 className="h2">Your picture</h2>
          <p className="sub">Stored on {withSuffix(primary.name)}, not on ThruScan</p>
        </div>
        <button className="btn ghost sm" onClick={onClose}>Done</button>
      </div>

      <div
        className={`pic-edit${over ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault(); setOver(false)
          const file = e.dataTransfer?.files?.[0]
          if (file) takeFile(file)
        }}
      >
        <Pfp pfp={pfp} address={owner} size={72} />
        <div className="pic-say">
          <p className="fine">
            {busy === 'upload'
              ? 'Cropping and uploading…'
              : 'Drop a picture here, or choose one. It is cropped square, shrunk to 400 pixels and saved as a link on your name.'}
          </p>
          <div className="pic-acts">
            <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={working}>
              {busy === 'upload' ? 'Uploading' : 'Choose a picture'}
            </button>
            {pfp?.kind === 'image' && (
              <button className="btn ghost sm" onClick={clearPicture} disabled={working}>
                {busy === 'clear' ? 'Removing' : 'Remove'}
              </button>
            )}
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) takeFile(f) }}
        />
      </div>

      <div className="pic-nfts">
        <div className="pic-nfts-head">
          <h3 className="h3">Or use one of your NFTs</h3>
          {claimed !== null && <span className="fine">Tap it again to stop using it</span>}
        </div>
        {mine.length === 0 ? (
          <p className="fine">
            None held by this name yet. NFTs you hold show up here. A Pal you have listed for sale sits in the
            market's escrow until you delist it, so it is not offered.
          </p>
        ) : (
          <div className="pal-options">
            {mine.map(({ num, pal }) => (
              <PalOption key={num} num={num} pal={pal} on={num === claimed} onPick={pickPal} />
            ))}
          </div>
        )}
      </div>

      {error && <p className="notice bad" style={{ marginTop: 14 }}>{error}</p>}
      {note && !error && <p className="notice" style={{ marginTop: 14 }}>{note}</p>}

      <details style={{ marginTop: 14 }} open={showLink}>
        <summary className="fine">{noStore ? 'Paste a link instead' : 'Use a link to a picture somewhere else'}</summary>
        <p className="fine" style={{ marginTop: 8, lineHeight: 1.65 }}>
          Saved as the <code className="mono">{AVATAR_KEY}</code> record, exactly as an upload would be.
        </p>
        <div className="stack" style={{ marginTop: 10 }}>
          <input
            className="field mono"
            value={linkDraft}
            onChange={(e) => { setLinkDraft(e.target.value); setError(null) }}
            placeholder="https://example.com/me.png"
          />
          <button className="btn" onClick={saveLink} disabled={working || !linkDraft.trim()}>
            {busy === 'link' ? 'Signing' : 'Use this link'}
          </button>
        </div>
      </details>
    </section>
  )
}

/* ---------- prices ----------
 * What each token is worth in WTHRU, for the Tokens table and the estimate:
 * WTHRU is 1, THRU wraps to it one for one, a ThruPad token is its curve
 * price, and anything else is priced by a Swap pool paired with WTHRU. A
 * token with none of these has no price and stays out of the estimate. */

function usePrices(wallet) {
  const pad = usePadMarket(null)
  const swap = useChainData(
    SWAP_REGISTRY,
    decodeSwapRegistry,
    (d) => d.pools.flatMap((p) => [p.vaultA, p.vaultB]),
    (d) => d.pools.flatMap((p) => [p.mintA, p.mintB]),
  )
  return useMemo(() => {
    const prices = {}   // mint -> { price, change, launch }
    prices[WTHRU_MINT] = { price: 1, change: null }
    for (const p of swap.data?.pools ?? []) {
      const other = p.mintA === WTHRU_MINT ? 'B' : p.mintB === WTHRU_MINT ? 'A' : null
      if (!other) continue
      const mint = other === 'A' ? p.mintA : p.mintB
      const rx = Number(swap.balances?.[other === 'A' ? p.vaultA : p.vaultB] ?? 0n) / 10 ** (swap.decimals?.[mint] ?? wallet.decimals?.[mint] ?? DECIMALS)
      const rw = Number(swap.balances?.[other === 'A' ? p.vaultB : p.vaultA] ?? 0n) / 10 ** (swap.decimals?.[WTHRU_MINT] ?? 0)
      if (rx > 0 && rw > 0) prices[mint] = { price: rw / rx, change: null }
    }
    for (const r of pad.rows) {
      if (r.inWthru && r.now !== null) prices[r.mint] = { price: r.now, change: r.day?.change ?? null, launch: r }
      else if (prices[r.mint]) prices[r.mint].launch = r
      else prices[r.mint] = { price: null, change: null, launch: r }
    }
    return { prices, launches: pad.rows, padLoading: pad.loading && !pad.data }
  }, [pad.rows, pad.loading, pad.data, swap.data, swap.balances, swap.decimals, wallet.decimals])
}

const value = (v) => (v === null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
function priceText(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 })
  return v.toLocaleString('en-US', { maximumSignificantDigits: 4 })
}
function pctText(c) {
  if (c === null || c === undefined || !Number.isFinite(c)) return null
  if (Math.abs(c) < 0.05) return '0.0%'
  return `${c > 0 ? '+' : '−'}${Math.abs(c).toFixed(1)}%`
}
function Change({ value: c }) {
  const t = pctText(c)
  if (t === null) return <span className="dim">—</span>
  return <span className={Math.abs(c) < 0.05 ? 'dim' : c > 0 ? 'amt-pos' : 'amt-neg'}>{t}</span>
}

/* ---------- the tabs ---------- */

function TokensTab({ rows }) {
  if (rows.length === 0) {
    return <p className="pempty">Nothing yet. <Link to="/faucet">Get some THRU</Link> to start.</p>
  }
  return (
    <>
      <div className="ptable" role="table" aria-label="Tokens">
        <div className="ptr pth" role="row">
          <span role="columnheader">Token</span>
          <span role="columnheader" className="r">Balance</span>
          <span role="columnheader" className="r">Price (WTHRU)</span>
          <span role="columnheader" className="r">Value (WTHRU)</span>
          <span role="columnheader" className="r">24 h</span>
        </div>
        {rows.map((t) => (
          <Link key={t.mint} to={t.to} className="ptr" role="row">
            <span role="cell" className="ptoken">
              <TokenIcon meta={t.meta} symbol={t.ticker} mint={t.mint === 'native' ? WTHRU_MINT : t.mint} size={32} />
              <span>
                <b>{t.ticker}</b>
                <i>{t.sub}</i>
              </span>
            </span>
            <span role="cell" className="mono r">{t.amount}</span>
            <span role="cell" className="mono r">{priceText(t.price)}</span>
            <span role="cell" className="mono r">{value(t.value)}</span>
            <span role="cell" className="mono r"><Change value={t.change} /></span>
            <span className="pc" aria-hidden="true">
              <span className="pc-l"><b>{t.ticker}</b><span className="mono dim">{t.amount}</span></span>
              <span className="pc-r"><span className="mono">{value(t.value)}</span><span className="mono"><Change value={t.change} /></span></span>
            </span>
          </Link>
        ))}
      </div>
      <p className="fine pnote">Values use the current curve or pool price. Tokens without a price show &ldquo;—&rdquo; and are left out of the estimate.</p>
    </>
  )
}

function ItemsTab({ names, pals }) {
  return (
    <div className="pitems">
      <section>
        <h2 className="pgroup">ThruID</h2>
        {names.length === 0
          ? <p className="pempty">None yet. <Link to="/names">Claim one</Link>, free.</p>
          : (
            <div className="pid-grid">
              {names.map((n, i) => (
                <Link key={n.account} to={`/account/${n.account}`} className="pid">
                  <span className="pid-tile mono">{withSuffix(n.name)}</span>
                  <span className="pid-sub">
                    <b className="mono">{withSuffix(n.name)}</b>
                    <span className="fine">{n.domain?.records?.length ?? 0} {(n.domain?.records?.length ?? 0) === 1 ? 'record' : 'records'}{i === 0 ? ' · primary' : ''}</span>
                  </span>
                </Link>
              ))}
            </div>
          )}
      </section>
      <section>
        <h2 className="pgroup">NFTs</h2>
        {pals.length === 0
          ? <p className="pempty">No NFTs yet.</p>
          : (
            <div className="pnft-grid">
              {pals.map(({ num, pal }) => <PalTile key={num} num={num} pal={pal} />)}
            </div>
          )}
      </section>
    </div>
  )
}

function PalTile({ num, pal }) {
  const art = useMemo(() => toSvg(pal.grid, 160), [pal])
  return (
    <Link to="/pixelpals?tab=yours" className="pnft" title={`Pixel Pal #${num}`}>
      <span className="pnft-art" dangerouslySetInnerHTML={{ __html: art }} />
      <span className="pnft-name mono">Pixel Pal #{num}</span>
    </Link>
  )
}

function LaunchedTab({ launches, scanning, own, meta, wallet, onChanged, now }) {
  const [editing, setEditing] = useState(null)
  if (scanning) return <p className="pempty">Reading ThruPad…</p>
  if (launches.length === 0) return <p className="pempty">Nothing yet. <Link to="/create">Launch a token</Link>.</p>
  return (
    <div className="plaunched">
      {launches.map((l) => {
        const unit = l.unit ?? 'WTHRU'
        const qd = l.qd ?? DECIMALS
        return (
          <div key={l.id} className="plrow-wrap">
            <Link to={`/launch/${l.id}${own ? '#creator-fees' : ''}`} className="plrow">
              <TokenIcon meta={meta[l.mint]} symbol={l.symbol} mint={l.mint} size={40} />
              <span className="plrow-id">
                <b>{l.name || l.symbol}</b>
                <span className="mono dim">
                  {l.graduated ? 'Graduated' : `Curve ${((l.progress ?? 0) * 100).toFixed(0)}%`}
                  {l.ageMs !== null && l.ageMs !== undefined ? ` · ${relTime(now - l.ageMs, now)}` : ''}
                </span>
              </span>
              {own && <span className="plrow-fees mono">Unclaimed {fmt(l.creatorFees, qd)} {unit}</span>}
            </Link>
            {own && (
              <button type="button" className="btn plain plrow-edit" aria-expanded={editing === l.id} onClick={() => setEditing(editing === l.id ? null : l.id)}>
                {editing === l.id ? 'Done' : 'Edit image and links'}
              </button>
            )}
            {own && editing === l.id && (
              <TokenMetaCard launch={l} address={wallet.address} quoteTicker={unit} onClaimed={onChanged} />
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ---------- the page ---------- */

/**
 * Your assets (Update 02, 5j): who you are and what you are worth, then
 * Tokens, Items, Launched and Activity. The tab is in the URL (?tab=).
 */
export function ProfilePage() {
  const wallet = useWallet()
  const [names, setNames] = useState([])       // [{ name, account, domain }]
  const [pfp, setPfp] = useState(EMPTY_PFP)
  const [editing, setEditing] = useState(false)
  const [pals, setPals] = useState([])
  const [meta, setMeta] = useState({})
  const [quick, setQuick] = useState(null)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const { prices, launches: allLaunches, padLoading } = usePrices(wallet)
  const [overview, setOverview] = useState(null)

  const storeKey = wallet.address ? `thruscan.names.${wallet.address}` : null

  /* Names, in two passes. The names this browser remembers resolve first and
     show at once, then the chain's answer replaces them. Both passes check the
     current owner, so neither shows a name that is no longer yours. */
  const loadNames = useCallback(async () => {
    if (!wallet.address) { setNames([]); return }
    let remembered = []
    try { remembered = JSON.parse(localStorage.getItem(storeKey) || '[]') } catch { /* nothing claimed here */ }

    const quickRows = (await Promise.all(remembered.map((n) => readName(n).catch(() => null))))
      .filter((r) => r?.domain?.owner === wallet.address)
    if (quickRows.length) setNames(quickRows)

    try {
      setNames(await ownedNames(wallet.address, remembered))
    } catch { if (!quickRows.length) setNames([]) }
  }, [wallet.address, storeKey])

  useEffect(() => { loadNames() }, [loadNames])
  useEffect(() => {
    let alive = true
    allTokenMeta().then((m) => { if (alive) setMeta(m) }).catch(() => {})
    fetch('/api/rpc?action=overview').then((r) => r.json()).then((j) => { if (alive && j?.ok) setOverview(j) }).catch(() => {})
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const primary = names[0] ?? null

  useEffect(() => {
    let alive = true
    if (!primary?.domain) { setPfp(EMPTY_PFP); return undefined }
    pfpForDomain(primary.domain).then((p) => { if (alive) setPfp(p) })
    return () => { alive = false }
  }, [primary?.domain])

  // The Pals this wallet holds, drawn from the collection itself.
  useEffect(() => {
    let alive = true
    if (!wallet.address) { setPals([]); return undefined }
    palsSnapshot()
      .then(({ art, owners }) => {
        if (!alive) return
        setPals(Object.entries(owners)
          .filter(([, who]) => who === wallet.address)
          .map(([num]) => Number(num))
          .filter((num) => art[num])
          .sort((a, b) => a - b)
          .map((num) => ({ num, pal: art[num] })))
      })
      .catch(() => { if (alive) setPals([]) })
    return () => { alive = false }
  }, [wallet.address])

  /* Tokens launched by this wallet: the registry is the only record of that,
     so it is a filter over the launches ThruPad already read. */
  const launches = useMemo(() => {
    const age = (l) => (overview?.finalized && overview?.blockTimeMs && l.startSlot
      ? Math.max(0, Number(overview.finalized) - Number(l.startSlot)) * overview.blockTimeMs : null)
    return allLaunches.filter((l) => l.creator === wallet.address).map((l) => ({ ...l, ageMs: age(l) }))
  }, [allLaunches, wallet.address, overview])
  const scanning = !!PAD_REGISTRY && padLoading
  const created = new Set(launches.map((l) => l.mint))

  const rows = useMemo(() => {
    const out = []
    const native = wallet.native ?? 0n
    if (native > 0n) {
      out.push({ mint: 'native', ticker: 'THRU', sub: 'Thru, wraps 1:1 to WTHRU', amount: Number(native).toLocaleString('en-US'), price: 1, value: Number(native), change: null, to: '/wallet' })
    }
    for (const [mint, b] of Object.entries(wallet.balances ?? {})) {
      if (!b?.exists || b.amount <= 0n) continue
      const d = wallet.decimals?.[mint] ?? DECIMALS
      const n = Number(b.amount) / 10 ** d
      const p = prices[mint]
      const ticker = wallet.tickers?.[mint] || p?.launch?.symbol || short(mint)
      const sub = mint === WTHRU_MINT ? 'Wrapped THRU'
        : created.has(mint) ? 'ThruPad · you created this'
          : p?.launch ? 'ThruPad' : mint === TUSD_MINT ? 'Test USD' : 'Token'
      out.push({
        mint, ticker, sub, meta: meta[mint],
        amount: fmt(b.amount, d),
        price: p?.price ?? null,
        value: p?.price !== null && p?.price !== undefined ? n * p.price : null,
        change: p?.change ?? null,
        to: p?.launch ? `/launch/${p.launch.id}` : `/token/${mint}`,
      })
    }
    return out.sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
  }, [wallet.balances, wallet.native, wallet.decimals, wallet.tickers, prices, meta])  // eslint-disable-line react-hooks/exhaustive-deps

  const estimate = rows.reduce((s, r) => (r.value !== null && Number.isFinite(r.value) ? s + r.value : s), 0)
  const priced = rows.some((r) => r.value !== null)

  if (!hasWallet()) {
    return (
      <div className="page profile">
        <h1 className="h1">Assets</h1>
        <section className="empty">
          <span className="empty-title">Connect a wallet to see your assets</span>
          <p>Your tokens, names, NFTs, the tokens you launched and your activity, read from the chain.</p>
          <div className="mk-actions-row">
            <button type="button" className="btn" onClick={connectWallet}><Icon name="wallet" size={18} />Connect wallet</button>
          </div>
        </section>
      </div>
    )
  }

  const since = joined(primary?.domain?.registeredAt)
  const copy = () => {
    navigator.clipboard?.writeText(wallet.address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="page profile">
      <header className="phead">
        <div className="phead-pic">
          <Pfp pfp={pfp} address={wallet.address} size={80} />
          {primary && (
            <button
              type="button"
              className="pic-pencil"
              onClick={() => setEditing((v) => !v)}
              aria-label="Change your picture"
              aria-expanded={editing}
              title="Change your picture"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
              </svg>
            </button>
          )}
        </div>

        <div className="phead-id">
          <h1>{primary ? withSuffix(primary.name) : 'Unnamed'}</h1>
          <p className="phead-addr">
            <span className="mono" title={wallet.address}>{short(wallet.address)}</span>
            <button type="button" className="pcopy" onClick={copy} aria-label="Copy address">{copied ? '✓ Copied' : <Icon name="copy" size={16} />}</button>
            {since && <span className="dim">· Joined {since}</span>}
          </p>
          {!primary && <p className="fine"><Link to="/names">Claim a name</Link>, free, and you can set a picture.</p>}
        </div>

        <div className="phead-right">
          <div className="pvalue">
            <span className="pvalue-k">Estimated value</span>
            <span className="pvalue-v mono">{priced ? `≈ ${value(estimate)}` : '—'} <small>WTHRU</small></span>
          </div>
          <div className="pacts">
            <button type="button" className="btn secondary pact" onClick={() => setQuick('send')} disabled={!wallet.unlocked || !wallet.registered}>
              <span className="pact-ic"><Icon name="send" size={18} /></span><span>Send</span>
            </button>
            <button type="button" className="btn secondary pact" onClick={() => setQuick('receive')}>
              <span className="pact-ic"><Icon name="receive" size={18} /></span><span>Receive</span>
            </button>
            <Link className="btn pact pact-main" to="/swap">
              <span className="pact-ic"><Icon name="swap" size={18} /></span><span>Swap</span>
            </Link>
          </div>
          {!wallet.unlocked && <p className="why">Unlock your wallet to send.</p>}
        </div>
      </header>

      {quick === 'send' && <QuickModal title="Send" onClose={() => setQuick(null)}><SendForm wallet={wallet} /></QuickModal>}
      {quick === 'receive' && <QuickModal title="Receive" onClose={() => setQuick(null)}><ReceiveBody address={wallet.address} /></QuickModal>}

      {editing && primary && (
        <PictureEditor
          primary={primary}
          domain={primary.domain}
          pfp={pfp}
          onSaved={loadNames}
          onClose={() => setEditing(false)}
        />
      )}

      <Tabs
        tabs={[
          { key: 'tokens', label: 'Tokens', badge: rows.length, el: <TokensTab rows={rows} /> },
          { key: 'items', label: 'Items', badge: names.length + pals.length, el: <ItemsTab names={names} pals={pals} /> },
          {
            key: 'launched',
            label: 'Launched',
            badge: launches.length,
            el: <LaunchedTab launches={launches} scanning={scanning} own meta={meta} wallet={wallet} now={now} onChanged={() => wallet.refresh()} />,
          },
          { key: 'activity', label: 'Activity', el: <Activity addresses={[wallet.address]} me={wallet.address} /> },
        ]}
      />
    </div>
  )
}

export default ProfilePage
