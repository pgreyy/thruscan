// src/components/TokenMeta.jsx
//
// A token's picture and links: how they are shown, and how their creator
// changes them.
//
// The editor writes nothing itself. It asks the wallet to sign a message and
// hands that to the API, which checks the signature against the creator the
// launchpad recorded on chain. So the person who launched the token is the only
// one who can change it, on any device, with no account anywhere. See
// src/lib/tokenmeta.js for the message and api/token-meta.js for the check.

import { useEffect, useRef, useState } from 'react'
import {
  signUserMessage, signAndSend, waitForResult, deriveTokenAccount, openTokenAccount,
} from '../lib/wallet.js'
import { buildClaimInstruction } from '../lib/pad.js'
import { notifyTx } from '../lib/notify.js'
import { THRUPAD_PROGRAM as PAD_PROGRAM, THRUPAD_REGISTRY as PAD_REGISTRY, WTHRU_MINT, TUSD_MINT } from '../lib/addresses.js'
import { displayDecimals } from '../lib/wthru.js'
import { useUnlockGate, isDismissal } from './Unlock.jsx'
import { useConfirm } from './Confirm.jsx'
import {
  saveTokenMeta, tokenMetaFor, cleanMeta, metaProblem, xUrl, telegramUrl, EMPTY_META,
  allTokenMeta, iconSource,
} from '../lib/tokenmeta.js'
import { squareImage, uploadImage, fileProblem, NoStoreError } from '../lib/imagefile.js'

/**
 * A token's avatar (design system 2g).
 *
 * Square, because these are creator uploads, not verified logos: the creator's
 * picture if there is one, otherwise the first two letters of the symbol in
 * mono on sunken stone. The two system tokens are round and drawn by ThruScan:
 * WTHRU an amber circle with "WT", tUSD an ink circle with an amber "tU".
 * Radius 6 up to 40px, 8 at 48, 10 at 64.
 */
/* Every token's picture, for icons whose caller passed no metadata (the Swap
   pickers and the Liquidity panel). One read per page, shared by every icon
   on it: allTokenMeta() caches the request, and this tells each icon when it
   lands. */
let sharedMeta = null
let sharedLoading = false
const sharedSubs = new Set()

function useSharedMeta(wanted) {
  const [all, setAll] = useState(sharedMeta)
  useEffect(() => {
    if (!wanted) return undefined
    sharedSubs.add(setAll)
    if (sharedMeta) setAll(sharedMeta)
    else if (!sharedLoading) {
      sharedLoading = true
      allTokenMeta()
        .then((m) => { sharedMeta = m; sharedSubs.forEach((fn) => fn(m)) })
        .finally(() => { sharedLoading = false })
    }
    return () => { sharedSubs.delete(setAll) }
  }, [wanted])
  return all
}

export function TokenIcon({ meta, symbol, mint, size = 32, className = '' }) {
  // Only an icon handed no metadata at all looks it up; null means "has none".
  const all = useSharedMeta(meta === undefined && !!mint && mint !== 'THRU')
  const src = iconSource({ meta, mint, symbol, all })
  const [broken, setBroken] = useState(false)
  useEffect(() => { setBroken(false) }, [src.image])

  const radius = size >= 64 ? 10 : size >= 48 ? 8 : 6
  const font = size >= 64 ? 18 : size >= 48 ? 14 : size >= 40 ? 13 : size >= 28 ? 11 : 10
  const box = { width: size, height: size, flex: `0 0 ${size}px`, borderRadius: radius, fontSize: font }

  // THRU itself, the chain's coin: round like the other system tokens.
  if (mint === 'THRU') {
    return (
      <span className={`tok-icon tok-system tok-thru ${className}`}
        style={{ ...box, borderRadius: '50%', fontSize: Math.max(9, Math.round(size * 0.38)) }} aria-hidden="true">TH</span>
    )
  }
  if (mint && (mint === WTHRU_MINT || mint === TUSD_MINT)) {
    const wthru = mint === WTHRU_MINT
    return (
      <span className={`tok-icon tok-system ${wthru ? 'tok-wthru' : 'tok-tusd'} ${className}`}
        style={{ ...box, borderRadius: '50%', fontSize: Math.max(9, Math.round(size * 0.38)) }} aria-hidden="true">
        {wthru ? 'WT' : 'tU'}
      </span>
    )
  }

  if (src.image && !broken) {
    return (
      <span className={`tok-icon tok-img ${className}`} style={box}>
        <img src={src.image} alt="" onError={() => setBroken(true)} />
      </span>
    )
  }
  // With no symbol yet there is nothing to letter, so it stays a quiet
  // placeholder rather than a box with a question mark in it.
  const letters = src.letters ?? iconSource({ meta: null, symbol }).letters
  return (
    <span className={`tok-icon${letters ? ' tok-letter' : ' tok-blank'} ${className}`} style={box} aria-hidden="true">
      {letters || <span className="tok-blank-in" />}
    </span>
  )
}

/** X, Telegram and a website, as far as there are any. */
export function TokenLinks({ meta, className = 'tmeta-links' }) {
  if (!meta) return null
  const links = [
    meta.x && ['X', xUrl(meta.x)],
    meta.telegram && ['Telegram', telegramUrl(meta.telegram)],
    meta.website && ['Website', meta.website],
  ].filter(Boolean)
  if (!links.length) return null
  return (
    <div className={className}>
      {links.map(([label, href]) => (
        <a key={label} href={href} target="_blank" rel="noreferrer noopener">{label}</a>
      ))}
    </div>
  )
}

/**
 * One launched token, with its picture and links editable in place.
 *
 * Deliberately not a modal: someone who launched three tokens should be able to
 * see all three and fix the one with the wrong picture, without a dialog in
 * between.
 */
export function TokenMetaCard({ launch, address, decimals = 6, quoteTicker = 'tUSD', onClaimed }) {
  const fileRef = useRef(null)
  const gate = useUnlockGate()
  const confirm = useConfirm()
  const [meta, setMeta] = useState(null)
  const [draft, setDraft] = useState(EMPTY_META)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)
  const [over, setOver] = useState(false)

  useEffect(() => {
    let alive = true
    tokenMetaFor(launch.mint).then((m) => {
      if (!alive) return
      setMeta(m)
      setDraft({ ...EMPTY_META, ...(m ?? {}) })
    })
    return () => { alive = false }
  }, [launch.mint])

  const dp = displayDecimals(launch.quoteMint, decimals)
  const fmtFees = (units) => (Number(units ?? 0n) / 10 ** dp).toLocaleString(undefined, { maximumFractionDigits: 4 })
  const owed = launch.creatorFees ?? 0n

  /* Claiming what the curve has collected for you.
     The money sits in the launch's quote vault until it is asked for; the
     program moves it only into an account owned by the creator it recorded, so
     the destination is derived from the wallet rather than typed. */
  const claim = async () => {
    setError(null); setNote(null)
    if (owed <= 0n) return
    const ok = await confirm.ask({
      title: `Claim your $${launch.symbol} fees`,
      body: 'These are the fees your curve has taken on trades so far. They go straight to your wallet.',
      detail: [{ label: 'You receive', value: `${fmtFees(owed)} ${quoteTicker}` }],
      confirmLabel: `Claim ${fmtFees(owed)} ${quoteTicker}`,
      tone: 'go',
    })
    if (!ok) return
    try { await gate.ensure() } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return
    }
    setBusy('claim')
    try {
      // The vault pays into a token account for the quote asset; open one if
      // this wallet has never held it.
      await openTokenAccount(launch.quoteMint)
      const dest = await deriveTokenAccount(launch.quoteMint, address)
      const built = buildClaimInstruction({
        registry: PAD_REGISTRY, launchId: launch.id, quoteVault: launch.quoteVault, dest,
      })
      const sig = await signAndSend({ program: PAD_PROGRAM, ...built })
      const r = await waitForResult(sig)
      if (r.settled && !r.succeeded) {
        notifyTx({ address, type: 'fees', title: 'Claim failed', body: `error ${r.userError || r.vmError}`, sig, ok: false })
        throw new Error(`The chain rejected it (error ${r.userError || r.vmError}).`)
      }
      notifyTx({ address, type: 'fees', title: 'Creator fees claimed', body: `${fmtFees(owed)} ${quoteTicker} from ${launch.symbol}`, sig })
      setNote(`Claimed ${fmtFees(owed)} ${quoteTicker}.`)
      await onClaimed?.()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally { setBusy(null) }
  }

  const save = async (next) => {
    const clean = cleanMeta(next)
    const problem = metaProblem(clean)
    if (problem) { setError(problem); return null }
    setError(null); setNote(null)
    const saved = await saveTokenMeta({ mint: launch.mint, meta: clean, address, sign: signUserMessage })
    setMeta(saved)
    setDraft({ ...EMPTY_META, ...(saved ?? {}) })
    return saved
  }

  const takeFile = async (file) => {
    const problem = fileProblem(file)
    if (problem) { setError(problem); return }
    setBusy('image'); setError(null); setNote(null)
    try {
      const shaped = await squareImage(file)
      let url
      try { url = await uploadImage(shaped.blob, { kind: 'token' }) }
      finally { URL.revokeObjectURL(shaped.url) }
      await save({ ...draft, image: url })
      setNote('Picture saved.')
    } catch (e) {
      setError(e instanceof NoStoreError
        ? 'Uploads are not switched on for this site yet.'
        : String(e?.message ?? e))
    } finally { setBusy(null) }
  }

  const saveLinks = async () => {
    setBusy('links')
    try {
      await save(draft)
      setNote('Saved.')
      setOpen(false)
    } catch (e) { setError(String(e?.message ?? e)) } finally { setBusy(null) }
  }

  const set = (k) => (e) => { setDraft((d) => ({ ...d, [k]: e.target.value })); setError(null) }
  const working = busy !== null

  return (
    <div className="tmeta">
      {gate.modal}{confirm.modal}
      <div className="tmeta-head">
        <div
          className={`tmeta-drop${over ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer?.files?.[0]; if (f) takeFile(f) }}
        >
          <TokenIcon meta={meta} symbol={launch.symbol} mint={launch.mint} size={44} />
          <button
            type="button" className="tmeta-pencil" onClick={() => fileRef.current?.click()}
            disabled={working} aria-label={`Change the picture for ${launch.symbol}`} title="Upload a picture"
          >
            <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
              <path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
            </svg>
          </button>
          <input
            ref={fileRef} type="file" hidden
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) takeFile(f) }}
          />
        </div>

        <div className="tmeta-id">
          <b>${launch.symbol}</b> <span className="fine">{launch.name}</span>
          <p className="fine mono">{fmtFees(owed)} {quoteTicker} unclaimed · {Number(launch.tradeCount)} trades</p>
          <TokenLinks meta={meta} />
        </div>

        <div className="tmeta-btns">
          {owed > 0n && (
            <button className="btn sm" onClick={claim} disabled={working}>
              {busy === 'claim' ? 'Claiming' : 'Claim fees'}
            </button>
          )}
          <button className="btn ghost sm" onClick={() => setOpen((v) => !v)} disabled={working}>
            {open ? 'Close' : 'Links'}
          </button>
        </div>
      </div>

      {busy === 'image' && <p className="fine" style={{ marginTop: 8 }}>Uploading and signing…</p>}

      {open && (
        <>
          <div className="tmeta-fields">
            <input className="field" value={draft.x} onChange={set('x')} placeholder="X handle, or paste the link" />
            <input className="field" value={draft.telegram} onChange={set('telegram')} placeholder="Telegram handle or t.me link" />
            <input className="field" value={draft.website} onChange={set('website')} placeholder="Website" />
          </div>
          <div className="tmeta-acts">
            <button className="btn sm" onClick={saveLinks} disabled={working}>
              {busy === 'links' ? 'Signing' : 'Save'}
            </button>
            <span className="fine">Your wallet signs this. Nothing is sent to the chain.</span>
          </div>
        </>
      )}

      {error && <p className="notice bad" style={{ marginTop: 10 }}>{error}</p>}
      {note && !error && <p className="fine" style={{ marginTop: 8 }}>{note}</p>}
    </div>
  )
}

export default TokenMetaCard
