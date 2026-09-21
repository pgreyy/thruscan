// src/pages/Pals.jsx
//
// Pixel Pals: the mint, your Pals, and every Pal minted so far.
//
// The collection's rules are enforced by the Pixel Pals program on chain (see
// programs/thrupals.c): 2,026 in total, one per wallet, paid straight to the
// treasury, and a Pal moves only when its holder signs. This page builds the
// transactions; the wallet signs them.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useSearchParams } from 'react-router-dom'
import { useWallet, ConnectCard } from './Wallet.jsx'
import { useUnlockGate, isDismissal } from '../components/Unlock.jsx'
import { hasProvider, connectExternal } from '../lib/external.js'
import {
  hasWallet, signAndSend, waitForResult, wrapThru, nativeBalance, tokenBalances,
  requestProof, palsAllow, palsAdvance, accountExists,
} from '../lib/wallet.js'
import { allPals, palFor, toSvg } from '../lib/pals/art.js'
import {
  buildMint, buildSend, buildClaim, palsError, nftAccountFor, WTHRU_MINT,
} from '../lib/pals/chain.js'

const PAGE = 36
const fmt = (n) => Number(n).toLocaleString('en-US')

function PalArt({ pal, size = 160, className = 'pal-art' }) {
  const svg = useMemo(() => toSvg(pal.grid, size), [pal, size])
  return <div className={className} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />
}

/** A few made-up Pals that shuffle, for the mint card before anything is minted. */
function Teaser() {
  const [n, setN] = useState(0)
  useEffect(() => { const t = setInterval(() => setN((x) => x + 1), 1400); return () => clearInterval(t) }, [])
  const pals = useMemo(() => [0, 1, 2, 3].map((i) => palFor(9000 + n * 4 + i, `teaser-${n}-${i}`)), [n])
  return (
    <div className="pal-teaser">
      {pals.map((p, i) => <PalArt key={`${n}-${i}`} pal={p} size={112} />)}
    </div>
  )
}

function usePals(address) {
  const [info, setInfo] = useState(null)
  const [error, setError] = useState(null)
  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ action: 'pals' })
      if (address) q.set('wallet', address)
      const r = await fetch(`/api/rpc?${q}`)
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'Could not load Pixel Pals.')
      setInfo(j); setError(null)
    } catch (e) { setError(String(e?.message ?? e)) }
  }, [address])
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t) }, [load])
  return { info, error, reload: load }
}

export function PalsPage() {
  const wallet = useWallet()
  const address = wallet.address
  const { info, error, reload } = usePals(address)
  const [params, setParams] = useSearchParams()
  const [shown, setShown] = useState(PAGE)

  const pals = useMemo(() => (info?.minters ? allPals(info.minters) : []), [info?.minters?.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const openId = params.get('id') !== null ? Number(params.get('id')) : null
  const open = (id) => setParams(id === null ? {} : { id: String(id) }, { replace: false })

  const minted = info?.minted ?? 0
  const supply = info?.supply ?? 2026
  const newestFirst = useMemo(() => pals.map((p, id) => ({ p, id })).reverse(), [pals])

  return (
    <div className="wrap">
      <h1 className="h1">Pixel Pals</h1>
      <p className="lede">2,026 pixel creatures on Thru. 1,000 THRU each, one per wallet, no two alike.</p>

      <MintCard info={info} pals={pals} wallet={wallet} reload={reload} open={open} />

      {info?.mine?.holding?.length > 0 && (
        <section className="card">
          <h2 className="h2">Your Pals</h2>
          <div className="pal-grid" style={{ marginTop: 14 }}>
            {info.mine.holding.map((id) => pals[id] && (
              <button key={id} className="pal-tile" onClick={() => open(id)}>
                <PalArt pal={pals[id]} size={140} />
                <span className="pal-name">#{id}</span>
                {info.mine.prizes?.some((p) => p.id === id) && <span className="pill new">Something inside</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="h2">Minted</h2>
            <p className="sub">{fmt(minted)} of {fmt(supply)}</p>
          </div>
        </div>
        {error && <p className="notice bad" style={{ marginTop: 12 }}>{error}</p>}
        {info && minted === 0 && <p className="fine" style={{ marginTop: 12 }}>None yet. Be the first.</p>}
        <div className="pal-grid" style={{ marginTop: 14 }}>
          {newestFirst.slice(0, shown).map(({ p, id }) => (
            <button key={id} className="pal-tile" onClick={() => open(id)}>
              <PalArt pal={p} size={140} />
              <span className="pal-name">#{id}</span>
              <span className="fine">{p.traits.Rarity}</span>
            </button>
          ))}
        </div>
        {shown < newestFirst.length && (
          <button className="btn ghost full" style={{ marginTop: 14 }} onClick={() => setShown((s) => s + PAGE)}>Show more</button>
        )}
      </section>

      {openId !== null && pals[openId] && (
        <PalModal
          id={openId}
          pal={pals[openId]}
          rankOf={pals.length}
          mine={info?.mine?.holding?.includes(openId)}
          prize={info?.mine?.prizes?.find((p) => p.id === openId)}
          vault={info?.prizeVault}
          onClose={() => open(null)}
          reload={reload}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------- minting */

function MintCard({ info, pals, wallet, reload, open }) {
  const gate = useUnlockGate()
  const [step, setStep] = useState(null)
  const [error, setError] = useState(null)
  const [justMinted, setJustMinted] = useState(null)

  const live = info?.live
  const minted = info?.minted ?? 0
  const taken = minted + (info?.reservedAhead ?? 0)
  const supply = info?.supply ?? 2026
  const price = BigInt(info?.price ?? '1000')
  const soldOut = live && taken >= supply
  const already = info?.mine?.minted
  const mineId = already ? pals.findIndex((_, id) => info.minters[id] === wallet.address) : -1

  // Like any mint page: the button is always there. With no wallet yet,
  // it connects the browser's Thru wallet first, or shows how to get one.
  const [needWallet, setNeedWallet] = useState(false)
  const connectThenMint = async () => {
    setError(null)
    if (!hasProvider()) { setNeedWallet(true); return }
    try { await connectExternal() } catch (e) { setError(String(e?.message ?? e)); return }
    if (hasWallet()) mint()
  }

  const mint = async () => {
    setError(null)
    try { await gate.ensure() } catch (e) { if (!isDismissal(e)) setError(String(e?.message ?? e)); return }
    const me = wallet.address
    const landed = async (sig, what) => {
      const r = await waitForResult(sig, 30_000)
      if (r.settled && !r.succeeded) throw new Error(what === 'mint' ? palsError(r.userError) : `${what} failed (error ${r.userError || r.vmError}).`)
      return r
    }
    try {
      setStep('checking')
      if (!(await accountExists(me))) throw new Error('This wallet is not on chain yet. Set it up on the Wallet page first.')

      // Pay in WTHRU: wrap only what is missing.
      const [row] = await tokenBalances([WTHRU_MINT], me)
      const have = BigInt(row?.amount ?? 0)
      if (have < price) {
        const need = price - have
        const native = await nativeBalance(me)
        if (native < need + 3n) throw new Error(`You need ${fmt(price)} THRU plus a few for fees. You have ${fmt(native + have)}.`)
        setStep('wrapping')
        await landed(await wrapThru(need), 'Wrapping THRU')
      }

      setStep('clearing')
      await palsAllow(me)

      // The number this Pal will get is the count right now. If someone else
      // takes it first, the program says so and this tries the next one.
      for (let attempt = 0; attempt < 6; attempt++) {
        setStep('minting')
        let now = await (await fetch(`/api/rpc?action=pals&wallet=${me}`)).json()
        if (now.nextReserved) {
          await palsAdvance().catch(() => {})
          now = await (await fetch(`/api/rpc?action=pals&wallet=${me}`)).json()
          if (now.nextReserved) continue
        }
        if (now.minted >= now.supply) throw new Error('Sold out.')
        const id = now.minted
        const proof = await requestProof(await nftAccountFor(id))
        const tx = await buildMint({ payer: me, id, treasury: now.treasury, proof })
        const sig = await signAndSend({ ...tx, computeUnits: 300_000_000, stateUnits: 60_000, memoryUnits: 60_000 })
        const r = await waitForResult(sig, 30_000)
        if (r.settled && !r.succeeded && Number(r.userError) === 23) continue
        if (r.settled && !r.succeeded && Number(r.userError) === 28) { await palsAdvance().catch(() => {}); continue }
        if (r.settled && !r.succeeded) throw new Error(palsError(r.userError))
        setJustMinted(id)
        await reload()
        return
      }
      throw new Error('Busy right now. Try again in a moment.')
    } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
    } finally {
      setStep(null)
    }
  }

  const label = step === 'checking' ? 'Checking…'
    : step === 'wrapping' ? 'Wrapping THRU…'
    : step === 'clearing' ? 'Getting cleared…'
    : step === 'minting' ? 'Minting…'
    : `Mint for ${fmt(price)} THRU`

  const shownId = justMinted ?? (mineId >= 0 ? mineId : null)

  return (
    <section className="card pal-mint">
      {gate.modal}
      <div className="pal-mint-art">
        {shownId !== null && pals[shownId]
          ? <button className="pal-reveal" onClick={() => open(shownId)}><PalArt pal={pals[shownId]} size={232} /></button>
          : <Teaser />}
      </div>
      <div className="pal-mint-body">
        <div className="pal-count">
          <span className="pal-count-n">{fmt(taken)}</span>
          <span className="fine"> / {fmt(supply)} minted</span>
        </div>
        <div className="pal-bar"><div style={{ width: `${Math.min(100, (taken / supply) * 100)}%` }} /></div>

        <div className="row"><span className="row-k">Price</span><span className="row-v num">{fmt(price)} THRU</span></div>
        <div className="row"><span className="row-k">Limit</span><span className="row-v">1 per wallet</span></div>

        {info && !live && <p className="notice" style={{ marginTop: 14 }}>Opening soon.</p>}
        {soldOut && <p className="notice" style={{ marginTop: 14 }}>Sold out.</p>}

        {info?.live !== false && !soldOut && !already && (
          <button className="btn full" style={{ marginTop: 16 }} onClick={hasWallet() ? mint : connectThenMint} disabled={step !== null}>{label}</button>
        )}
        {needWallet && !hasWallet() && (
          <div style={{ marginTop: 14 }}>
            <ConnectCard compact title="Connect a wallet to mint" />
            <p className="fine" style={{ marginTop: 8 }}>No extension? <Link to="/wallet">Make a wallet on ThruScan</Link>.</p>
          </div>
        )}

        {shownId !== null && (
          <p className="notice" style={{ marginTop: 14 }}>
            {justMinted !== null ? 'Minted. ' : ''}This is <button className="linkish" onClick={() => open(shownId)}>Pixel Pal #{shownId}</button>, and it is yours.
          </p>
        )}
        {already && justMinted === null && shownId === null && <p className="notice" style={{ marginTop: 14 }}>This wallet has minted its Pal.</p>}
        {error && <p className="notice bad" style={{ marginTop: 12 }}>{error}</p>}
      </div>
    </section>
  )
}

/* ---------------------------------------------------------------- a Pal */

function PalModal({ id, pal, rankOf, mine, prize, vault, onClose, reload }) {
  const gate = useUnlockGate()
  const wallet = useWallet()
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)

  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onClose])

  const act = async (what, fn) => {
    setError(null); setNote(null)
    try { await gate.ensure() } catch (e) { if (!isDismissal(e)) setError(String(e?.message ?? e)); return }
    setBusy(what)
    try {
      const sig = await fn()
      const r = await waitForResult(sig, 30_000)
      if (r.settled && !r.succeeded) throw new Error(palsError(r.userError))
      setNote(what === 'send' ? 'Sent.' : 'Claimed. It is in your WTHRU balance.')
      await reload()
    } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
    } finally { setBusy(null) }
  }

  const send = () => act('send', async () => {
    const dest = to.trim()
    if (!/^ta[A-Za-z0-9_-]{44}$/.test(dest)) throw new Error('That does not look like a Thru address.')
    if (dest === wallet.address) throw new Error('That is this wallet.')
    return signAndSend(await buildSend({ payer: wallet.address, id, dest }))
  })

  const claim = () => act('claim', async () => {
    const { openTokenAccount } = await import('../lib/wallet.js')
    await openTokenAccount(WTHRU_MINT)
    return signAndSend(await buildClaim({ payer: wallet.address, id, vault }))
  })

  const traits = Object.entries(pal.traits).filter(([k]) => k !== 'Rarity')

  return createPortal(
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-card pal-modal" role="dialog" aria-modal="true" aria-label={`Pixel Pal #${id}`}>
        {gate.modal}
        <div className="pal-modal-art"><PalArt pal={pal} size={280} /></div>
        <div className="card-head" style={{ marginTop: 14 }}>
          <div>
            <h2 className="h2">Pixel Pal #{id}</h2>
            <p className="sub">{pal.traits.Rarity} · Rank {pal.rank} of {rankOf}</p>
          </div>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <div style={{ marginTop: 10 }}>
          {traits.map(([k, v]) => (
            <div className="row" key={k}><span className="row-k">{k}</span><span className="row-v">{v}</span></div>
          ))}
        </div>

        {mine && prize && (
          <button className="btn full" style={{ marginTop: 14 }} onClick={claim} disabled={busy !== null}>
            {busy === 'claim' ? 'Claiming…' : `Claim ${fmt(prize.amount)} THRU inside`}
          </button>
        )}

        {mine && (
          <div style={{ marginTop: 14 }}>
            <input className="field mono" placeholder="Send to ta…" value={to} onChange={(e) => setTo(e.target.value)} />
            <button className="btn ghost full" style={{ marginTop: 8 }} onClick={send} disabled={busy !== null || !to.trim()}>
              {busy === 'send' ? 'Sending…' : 'Send this Pal'}
            </button>
          </div>
        )}

        {note && <p className="notice" style={{ marginTop: 12 }}>{note}</p>}
        {error && <p className="notice bad" style={{ marginTop: 12 }}>{error}</p>}
        <p className="fine" style={{ marginTop: 12 }}>
          <a href={`/api/rpc?action=pal&id=${id}`} target="_blank" rel="noreferrer">Metadata</a>
          {' · '}
          <NftLink id={id} />
        </p>
      </div>
    </div>,
    document.body,
  )
}

function NftLink({ id }) {
  const [addr, setAddr] = useState(null)
  useEffect(() => { nftAccountFor(id).then(setAddr) }, [id])
  return addr ? <Link to={`/account/${addr}`}>On chain</Link> : null
}

export default PalsPage
