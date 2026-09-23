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
// creator field, which is the only place that fact exists. There is no index
// and no database, which is why the page scans rather than queries.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useWallet } from './Wallet.jsx'
import { useUnlockGate, isDismissal } from '../components/Unlock.jsx'
import { Pfp } from '../components/Pfp.jsx'
import { TokenMetaCard, TokenIcon } from '../components/TokenMeta.jsx'
import { Activity } from '../components/Activity.jsx'
import { Tabs } from '../components/Tabs.jsx'
import { setNameRecord, waitForResult, hasWallet } from '../lib/wallet.js'
import { ownedNames, readName } from '../lib/holdings.js'
import { withSuffix, ROOT_SUFFIX } from '../lib/names.js'
import { decodePadRegistry } from '../lib/pad.js'
import { getAccount } from '../lib/rpcClient.js'
import { THRUPAD_REGISTRY as PAD_REGISTRY } from '../lib/addresses.js'
import { AVATAR_KEY, PFP_KEY, formatNftPfp, pfpForDomain, EMPTY_PFP, palsSnapshot } from '../lib/pfp.js'
import { squareImage, uploadImage, fileProblem, NoStoreError } from '../lib/imagefile.js'
import { allTokenMeta } from '../lib/tokenmeta.js'
import { toSvg } from '../lib/pals/art.js'
import './profile.css'

const DECIMALS = 6
/* An overview is a glance, not an inventory: 202 Pals drawn on the first
   screen is a slow page nobody asked for. The tab beside it has all of them. */
const PREVIEW = 10
const PAGE = 60

const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '')

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
            None held by this name yet. <Link to="/pals">Mint or buy a Pixel Pal</Link> and it will show up here.
            A Pal you have listed for sale sits in the market's escrow until you delist it, so it is not offered.
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

/* ---------- what you hold ---------- */

function TokenTile({ ticker, amount, meta, mint }) {
  return (
    <Link className="ptile" to={`/token/${mint}`}>
      <TokenIcon meta={meta} symbol={ticker} mint={mint} size={34} />
      <span className="ptile-id">
        <b>{ticker}</b>
        <i className="mono">{amount}</i>
      </span>
    </Link>
  )
}

function PalTile({ num, pal }) {
  const art = useMemo(() => toSvg(pal.grid, 220), [pal])
  return (
    <Link className="pitem" to="/pals" title={`Pixel Pal #${num}`}>
      <span className="pitem-art" dangerouslySetInnerHTML={{ __html: art }} />
      <span className="pitem-name">Pixel Pal #{num}</span>
      <span className="pitem-sub">Rank {pal.rank}</span>
    </Link>
  )
}

function Row({ title, count, to, children }) {
  return (
    <section className="prow">
      <div className="prow-head">
        <h2>{title}{count != null && <span className="prow-count">{count}</span>}</h2>
        {to && <Link className="prow-all" to={to}>See all →</Link>}
      </div>
      {children}
    </section>
  )
}

/** The items tab, which is the one that may hold hundreds. */
function ItemsPanel({ pals }) {
  const [shown, setShown] = useState(PAGE)
  if (pals.length === 0) return <p className="fine">No NFTs yet. <Link to="/pals">Mint a Pixel Pal</Link>.</p>
  return (
    <>
      <div className="pitems">
        {pals.slice(0, shown).map(({ num, pal }) => <PalTile key={num} num={num} pal={pal} />)}
      </div>
      {shown < pals.length && (
        <button className="btn ghost" style={{ marginTop: 14 }} onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, pals.length - shown)} more
        </button>
      )}
    </>
  )
}

/* ---------- the page ---------- */

export function ProfilePage() {
  const wallet = useWallet()

  const [names, setNames] = useState([])       // [{ name, account, domain }]
  const [launches, setLaunches] = useState([])
  const [scanning, setScanning] = useState(true)
  const [pfp, setPfp] = useState(EMPTY_PFP)
  const [editing, setEditing] = useState(false)
  const [pals, setPals] = useState([])
  const [meta, setMeta] = useState({})

  const storeKey = wallet.address ? `thruscan.names.${wallet.address}` : null

  /* Names, in two passes.
     This used to read only the names claimed in this browser, which got two
     things wrong: a name claimed on another device, or with a connected
     wallet, was invisible, and a name since transferred away still showed as
     yours. Reading the chain fixes both, but it means scanning the address's
     history, which on a busy wallet takes seconds.
     So the remembered names are resolved first and shown at once, then the
     chain's answer replaces them when it arrives. Both passes check the
     current owner, so neither shows a name that is no longer yours. */
  const loadNames = useCallback(async () => {
    if (!wallet.address) { setNames([]); return }
    let remembered = []
    try { remembered = JSON.parse(localStorage.getItem(storeKey) || '[]') } catch { /* nothing claimed here */ }

    const quick = (await Promise.all(remembered.map((n) => readName(n).catch(() => null))))
      .filter((r) => r?.domain?.owner === wallet.address)
    if (quick.length) setNames(quick)

    try {
      setNames(await ownedNames(wallet.address, remembered))
    } catch { if (!quick.length) setNames([]) }
  }, [wallet.address, storeKey])

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
  useEffect(() => {
    let alive = true
    allTokenMeta().then((m) => { if (alive) setMeta(m) }).catch(() => {})
    return () => { alive = false }
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
        <h1 className="h1">Profile</h1>
        <p className="lede">Your name, picture, balances and launches.</p>
        <section className="card">
          <h2 className="h2">No wallet yet</h2>
          <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
            <Link to="/wallet">Open one</Link> to see your profile.
          </p>
        </section>
      </div>
    )
  }

  const since = joined(primary?.domain?.registeredAt)

  const tokens = held.length > 0 && (
    <div className="ptiles">
      {held.map((h) => <TokenTile key={h.mint} {...h} meta={meta[h.mint]} />)}
    </div>
  )
  const itemsPreview = pals.length > 0 && (
    <div className="pitems">
      {pals.slice(0, PREVIEW).map(({ num, pal }) => <PalTile key={num} num={num} pal={pal} />)}
    </div>
  )

  return (
    <div className="wrap-wide profile">
      <header className="phead">
        <div className="phead-pic">
          <Pfp pfp={pfp} address={wallet.address} size={104} />
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
          <p className="mono phead-addr">{wallet.address}</p>
          <p className="phead-facts">
            {pfp.kind === 'nft' && (
              <>
                <Link to="/pals">Pixel Pal #{pfp.num}</Link>, held by this wallet on chain
                <span className="phead-dot">·</span>
              </>
            )}
            {since && <>Joined {since}<span className="phead-dot">·</span></>}
            {pals.length} {pals.length === 1 ? 'item' : 'items'}
            <span className="phead-dot">·</span>
            {held.length} {held.length === 1 ? 'token' : 'tokens'}
          </p>
          {!primary && (
            <p className="fine" style={{ marginTop: 8 }}>
              <Link to="/names">Claim a name</Link>, free, and you can set a picture.
            </p>
          )}
        </div>
      </header>

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
        param="view"
        tabs={[
          {
            key: 'overview',
            label: 'Overview',
            el: (
              <>
                <Row title="Tokens" count={held.length || null}>
                  {tokens || <p className="fine">Nothing yet. <Link to="/faucet">Get some tUSD</Link> to start.</p>}
                </Row>
                <Row title="Items" count={pals.length || null} to={pals.length > PREVIEW ? '?view=items' : null}>
                  {itemsPreview || <p className="fine">No NFTs yet. <Link to="/pals">Mint a Pixel Pal</Link>.</p>}
                </Row>
                <Row title="Launched" count={launches.length || null}>
                  {scanning
                    ? <p className="fine">Reading the launchpad…</p>
                    : launches.length === 0
                      ? <p className="fine">Nothing yet. <Link to="/launch">Launch a token</Link>.</p>
                      : (
                        <div className="launch-mine">
                          {launches.map((l) => <TokenMetaCard key={l.id} launch={l} address={wallet.address} />)}
                        </div>
                      )}
                </Row>
                <Row title="Names" count={names.length || null}>
                  {names.length === 0
                    ? <p className="fine">None yet. <Link to="/names">Claim one</Link>, free.</p>
                    : (
                      <div className="rows">
                        {names.map((n) => (
                          <div className="row" key={n.account}>
                            <span><b>{withSuffix(n.name)}</b></span>
                            <span className="fine">{n.domain?.records?.length ?? 0} records</span>
                          </div>
                        ))}
                      </div>
                    )}
                </Row>
              </>
            ),
          },
          {
            key: 'tokens',
            label: 'Tokens',
            badge: held.length || null,
            el: (
              <Row title="Tokens" count={held.length || null}>
                {tokens || <p className="fine">Nothing yet. <Link to="/faucet">Get some tUSD</Link> to start.</p>}
              </Row>
            ),
          },
          {
            key: 'items',
            label: 'Items',
            badge: pals.length || null,
            el: (
              <Row title="Items" count={pals.length || null}>
                <ItemsPanel pals={pals} />
              </Row>
            ),
          },
          {
            key: 'activity',
            label: 'Activity',
            el: <div className="prow"><Activity addresses={[wallet.address]} me={wallet.address} /></div>,
          },
        ]}
      />
    </div>
  )
}

export default ProfilePage
