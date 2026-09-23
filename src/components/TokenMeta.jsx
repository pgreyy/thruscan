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

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  signUserMessage, signAndSend, waitForResult, deriveTokenAccount, openTokenAccount,
} from '../lib/wallet.js'
import { buildClaimInstruction } from '../lib/pad.js'
import { THRUPAD_PROGRAM as PAD_PROGRAM, THRUPAD_REGISTRY as PAD_REGISTRY } from '../lib/addresses.js'
import { displayDecimals } from '../lib/wthru.js'
import { useUnlockGate, isDismissal } from './Unlock.jsx'
import { useConfirm } from './Confirm.jsx'
import {
  saveTokenMeta, tokenMetaFor, cleanMeta, metaProblem, xUrl, telegramUrl, EMPTY_META,
} from '../lib/tokenmeta.js'
import { squareImage, uploadImage, fileProblem, NoStoreError } from '../lib/imagefile.js'

/** A picture if there is one, otherwise the ticker's first letter. */
export function TokenIcon({ meta, symbol, mint, size = 32, className = '' }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => { setBroken(false) }, [meta?.image])

  const hue = useMemo(() => {
    let h = 0
    const s = mint || symbol || ''
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
    return h % 360
  }, [mint, symbol])

  if (meta?.image && !broken) {
    return (
      <span className={`pfp pfp-round tok-icon ${className}`} style={{ width: size, height: size, flex: `0 0 ${size}px` }}>
        <img src={meta.image} alt="" onError={() => setBroken(true)} />
      </span>
    )
  }
  // With no ticker yet there is nothing to letter, so it stays a quiet
  // placeholder rather than a coloured circle with a question mark in it.
  const letter = (symbol || '').slice(0, 1).toUpperCase()
  return (
    <span
      className={`pfp pfp-round tok-icon${letter ? ' tok-letter' : ' tok-blank'} ${className}`}
      style={{
        width: size, height: size, flex: `0 0 ${size}px`,
        background: letter ? `hsl(${hue} 58% 52%)` : undefined,
        fontSize: Math.round(size * 0.42),
      }}
      aria-hidden="true"
    >
      {letter}
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
      if (r.settled && !r.succeeded) throw new Error(`The chain rejected it (error ${r.userError || r.vmError}).`)
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
