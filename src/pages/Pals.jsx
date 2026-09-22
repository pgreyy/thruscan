// src/pages/Pals.jsx
//
// Pixel Pals, the collection page: mint, buy, list and see what sold.
//
// The collection's rules are enforced by the Pixel Pals program on chain (see
// programs/thrupals.c): 2,026 in total, one per wallet at mint, paid straight
// to the treasury, and a Pal moves only when its holder signs or when it is
// bought from the market. A listed Pal sits with the program until it sells or
// its seller takes it back, so a listing can never be stale or sold twice.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useSearchParams } from 'react-router-dom'
import { useWallet } from './Wallet.jsx'
import { useUnlockGate, isDismissal } from '../components/Unlock.jsx'
import { signAndSend, waitForResult } from '../lib/wallet.js'
import { palsInOrder, toSvg, GENESIS, palFor } from '../lib/pals/art.js'
import { buildSend, buildClaim, palsError, nftAccountFor, WTHRU_MINT, PALS_PROGRAM } from '../lib/pals/chain.js'
import { useMint } from '../lib/pals/useMint.js'
import { useMarket } from '../lib/pals/useMarket.js'
import './nfts.css'

const PAGE = 60
const SWEEP_MAX = 8
export const fmt = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('en-US'))
export const short = (s) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : '')
export const ago = (ms) => {
  if (!ms) return ''
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function PalArt({ pal, size = 160, className = 'pal-art' }) {
  const svg = useMemo(() => toSvg(pal.grid, size), [pal, size])
  return <div className={className} dangerouslySetInnerHTML={{ __html: svg }} />
}

export function usePals(address) {
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
  useEffect(() => { load(); const t = setInterval(() => { if (!document.hidden) load() }, 10_000); return () => clearInterval(t) }, [load])
  // Pals by Pal number (a sparse array), drawn in mint order so a later mint
  // never changes an earlier Pal. `palNums` lists the minted numbers.
  const { pals, palNums } = useMemo(() => {
    const map = palsInOrder((info?.pals ?? []).map(([num, minter]) => ({ num, minter })))
    const arr = []
    for (const [num, p] of map) arr[num] = p
    return { pals: arr, palNums: [...map.keys()] }
  }, [info?.pals?.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const owners = useMemo(() => Object.fromEntries((info?.pals ?? []).map(([num, , owner]) => [num, owner])), [info?.pals])
  const listings = useMemo(() => new Map((info?.market?.listings ?? []).map((l) => [l.id, l])), [info?.market])
  return { info, error, reload: load, pals, palNums, owners, listings }
}

/** One item in a grid: art, number, rank, and its price when it is for sale. */
export function PalCard({ id, pal, listing, mine, picked, onOpen, onPick, onBuy, busy }) {
  return (
    <div className={`nft-card${picked ? ' picked' : ''}`}>
      <button className="nft-card-art" onClick={() => onOpen(id)} aria-label={`Pixel Pal #${id}`}>
        <PalArt pal={pal} size={200} />
        {listing && !mine && onPick && (
          <span className={`nft-pick${picked ? ' on' : ''}`} role="checkbox" aria-checked={picked} aria-label="Add to sweep"
            onClick={(e) => { e.stopPropagation(); onPick(id) }}>{picked ? '✓' : '+'}</span>
        )}
      </button>
      <div className="nft-card-body">
        <div className="nft-card-line">
          <b>#{id}</b>
          <span className="nft-rank" title="Rarity rank, 1 is the rarest">Rank {pal.rank}</span>
        </div>
        <div className="nft-card-line">
          {listing ? <span className="nft-price">{fmt(listing.price)} THRU</span> : <span className="nft-muted">{mine ? 'Yours' : 'Not listed'}</span>}
          {listing && mine && <span className="nft-muted">Yours</span>}
        </div>
      </div>
      {listing && !mine && onBuy && (
        <button className="nft-card-buy" onClick={() => onBuy([listing])} disabled={busy}>Buy now</button>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- page */

const SORTS = [
  ['price-asc', 'Price: low to high'],
  ['price-desc', 'Price: high to low'],
  ['rank', 'Rarest first'],
  ['recent', 'Recently listed'],
  ['newest', 'Newest'],
  ['number', 'Number'],
]

export function PalsPage() {
  const wallet = useWallet()
  const me = wallet.address
  const { info, error, reload, pals, palNums, owners, listings } = usePals(me)
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') || 'items'
  const setTab = (t) => setParams(t === 'items' ? {} : { tab: t })
  const openId = params.get('id') !== null ? Number(params.get('id')) : null
  const open = (id) => { const p = Object.fromEntries(params); if (id === null) delete p.id; else p.id = String(id); setParams(p) }

  const [sort, setSort] = useState('price-asc')
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [picked, setPicked] = useState([])
  const market = useMarket({ onDone: async () => { setPicked([]); await reload() } })

  const m = info?.market
  const minted = info?.minted ?? 0
  const supply = info?.supply ?? 2026
  const taken = minted + (info?.reservedAhead ?? 0)
  const mintOpen = info ? info.live !== false && taken < supply : false
  const holding = info?.mine?.holding ?? []
  const myListed = info?.mine?.listed ?? []
  const isMine = (id) => holding.includes(id) || myListed.includes(id)

  const rows = useMemo(() => {
    let ids = [...palNums]
    if (tab === 'sale') ids = ids.filter((id) => listings.has(id))
    if (tab === 'yours') ids = ids.filter((id) => holding.includes(id) || myListed.includes(id))
    const q = query.trim().replace(/^#/, '')
    if (q) ids = ids.filter((id) => String(id).startsWith(q))
    const price = (id) => (listings.has(id) ? BigInt(listings.get(id).price) : null)
    const byPrice = (dir) => (a, b) => {
      const x = price(a), y = price(b)
      if (x === null && y === null) return a - b
      if (x === null) return 1
      if (y === null) return -1
      return x === y ? a - b : (x < y ? -dir : dir)
    }
    if (sort === 'price-asc') ids.sort(byPrice(1))
    else if (sort === 'price-desc') ids.sort(byPrice(-1))
    else if (sort === 'rank') ids.sort((a, b) => pals[a].rank - pals[b].rank)
    else if (sort === 'newest') ids.sort((a, b) => b - a)
    else if (sort === 'recent') ids.sort((a, b) => {
      const x = listings.get(a)?.slot, y = listings.get(b)?.slot
      if (!x && !y) return b - a
      if (!x) return 1
      if (!y) return -1
      return Number(BigInt(y) - BigInt(x))
    })
    return ids
  }, [pals, palNums, listings, tab, sort, query, holding, myListed])

  // Sweep: the cheapest listings that are not yours, N at a time.
  const buyable = useMemo(() => (m?.listings ?? []).filter((l) => l.seller !== me), [m, me])
  const pickedListings = picked.map((id) => listings.get(id)).filter(Boolean)
  const total = pickedListings.reduce((t, l) => t + BigInt(l.price), 0n)
  const togglePick = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= SWEEP_MAX ? p : [...p, id]))
  const sweepTo = (n) => setPicked(buyable.slice(0, n).map((l) => l.id))
  useEffect(() => { setPicked((p) => p.filter((id) => listings.has(id))) }, [listings])

  return (
    <div className="nft-page">
      {market.modal}
      <CollectionHead info={info} pals={pals} mintOpen={mintOpen} taken={taken} supply={supply} reload={reload} />

      <div className="nft-tabs" role="tablist">
        {[['items', 'Items', minted], ['sale', 'For sale', m?.listed ?? 0], ['activity', 'Activity', null], ['yours', 'Yours', me ? holding.length + myListed.length : null]].map(([k, label, n]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}{n !== null && n !== undefined && <span>{fmt(n)}</span>}
          </button>
        ))}
      </div>

      {error && <p className="notice bad">{error}</p>}

      {tab === 'activity' ? (
        info ? <Activity sales={m?.recent ?? []} pals={pals} open={open} /> : <p className="nft-empty">Loading…</p>
      ) : (
        <>
          <div className="nft-toolbar">
            <input className="field nft-search" placeholder="Search by number" value={query} inputMode="numeric"
              onChange={(e) => { setQuery(e.target.value); setShown(PAGE) }} />
            <select className="field nft-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
              {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <span className="nft-count">{fmt(rows.length)} {rows.length === 1 ? 'item' : 'items'}</span>
          </div>

          {!info && !error && <p className="nft-empty">Loading…</p>}
          {info && rows.length === 0 && (
            <p className="nft-empty">
              {tab === 'sale' ? 'Nothing is listed right now. Holders can list a Pal from its page.'
                : tab === 'yours' ? (me ? 'No Pals in this wallet.' : 'Connect a wallet to see your Pals.')
                : query ? 'No Pal with that number yet.' : 'None minted yet.'}
            </p>
          )}

          <div className="nft-grid">
            {rows.slice(0, shown).map((id) => (
              <PalCard key={id} id={id} pal={pals[id]} listing={listings.get(id)} mine={isMine(id)}
                picked={picked.includes(id)} onOpen={open} onPick={togglePick} onBuy={market.buy} busy={market.busy !== null} />
            ))}
          </div>
          {shown < rows.length && <button className="btn ghost full" style={{ marginTop: 16 }} onClick={() => setShown((s) => s + PAGE)}>Show more</button>}
        </>
      )}

      {openId === null && (market.error || market.note || market.needWallet) && (
        <div className="nft-flash">
          {market.needWallet && <p className="notice">You need a Thru wallet to buy. <Link to="/wallet">Get one here</Link>.</p>}
          {market.note && <p className="notice">{market.note}</p>}
          {market.error && <p className="notice bad">{market.error}</p>}
        </div>
      )}

      {tab !== 'activity' && buyable.length > 0 && (
        <div className="nft-sweep">
          <span className="nft-sweep-k">Sweep</span>
          <input type="range" min="0" max={Math.min(SWEEP_MAX, buyable.length)} value={picked.length} onChange={(e) => sweepTo(Number(e.target.value))} aria-label="How many of the cheapest to pick" />
          <span className="nft-sweep-n mono">{picked.length}</span>
          <span className="nft-sweep-total mono">{picked.length ? `${fmt(total)} THRU` : 'Pick Pals or drag'}</span>
          {picked.length > 0 && <button className="linkish" onClick={() => setPicked([])}>Clear</button>}
          <button className="btn" disabled={!picked.length || market.busy !== null} onClick={() => market.buy(pickedListings)}>
            {market.busy === 'wrapping' ? 'Wrapping THRU…' : market.busy === 'buy' ? 'Buying…' : picked.length > 1 ? `Buy ${picked.length}` : 'Buy'}
          </button>
        </div>
      )}

      {openId !== null && pals[openId] && (
        <PalModal
          id={openId}
          pal={pals[openId]}
          total={palNums.length}
          owner={owners[openId]}
          listing={listings.get(openId)}
          mine={isMine(openId)}
          prize={info?.mine?.prizes?.find((p) => p.id === openId)}
          vault={info?.prizeVault}
          feeBps={m?.feeBps ?? 0}
          marketLive={Boolean(m?.live)}
          market={market}
          onClose={() => open(null)}
          reload={reload}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------ collection head */

function CollectionHead({ info, pals, mintOpen, taken, supply, reload }) {
  const mint = useMint({ onMinted: reload })
  const m = info?.market
  const genesis = useMemo(() => palFor(GENESIS.id, GENESIS.wallet), [])
  const cover = useMemo(() => [11, 22, 33, 44, 55, 66].map((i) => pals[i] ?? palFor(9100 + i, `cover-${i}`)), [pals.length > 66]) // eslint-disable-line react-hooks/exhaustive-deps
  const on = m?.live
  const stats = [
    ['Floor', m?.floor ? `${fmt(m.floor)} THRU` : '–'],
    ['Listed', on ? fmt(m.listed) : '–'],
    ['Volume', on ? `${fmt(m.volume)} THRU` : '–'],
    ['Sales', on ? fmt(m.sales) : '–'],
    ['Owners', m ? fmt(m.holders) : '–'],
    ['Minted', info ? `${fmt(taken)} / ${fmt(supply)}` : '–'],
  ]
  return (
    <header className="nft-head">
      {mint.modal}
      <div className="nft-cover" aria-hidden="true">
        {cover.map((p, i) => <PalArt key={i} pal={p} size={120} className="nft-cover-pal" />)}
      </div>
      <div className="nft-head-main">
        <div className="nft-avatar"><PalArt pal={genesis} size={96} /></div>
        <div className="nft-head-text">
          <h1>Pixel Pals</h1>
          <p>2,026 pixel creatures on Thru, no two alike. Rank 1 is the rarest.</p>
        </div>
        {mintOpen && (
          <div className="nft-mint">
            <div className="nft-mint-top">
              <span>Minting now</span>
              <span className="mono">{fmt(taken)} / {fmt(supply)}</span>
            </div>
            <div className="pal-bar"><div style={{ width: `${Math.min(100, (taken / supply) * 100)}%` }} /></div>
            <button className="btn full" onClick={mint.mint} disabled={mint.busy || mint.minted !== null}>{mint.minted !== null ? 'Minted' : mint.label ?? `Mint for ${fmt(info?.price ?? 1000)} THRU`}</button>
            {mint.minted !== null && <p className="fine">{mint.minted === 'unknown' ? <>Minted. <Link to="/pals?tab=yours">See your Pal</Link>.</> : <>Minted. <Link to={`/pals?id=${mint.minted}`}>Pixel Pal #{mint.minted}</Link> is yours.</>}</p>}
            {mint.needWallet && <p className="fine">You need a Thru wallet. <Link to="/wallet">Get one here</Link>.</p>}
            {mint.error && <p className="fine bad-text">{mint.error}</p>}
          </div>
        )}
      </div>
      <dl className="nft-stats">
        {stats.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="mono">{v}</dd></div>)}
      </dl>
    </header>
  )
}

/* ------------------------------------------------------------- activity */

function Activity({ sales, pals, open }) {
  if (!sales.length) return <p className="nft-empty">No sales yet. The first one shows up here.</p>
  return (
    <div className="nft-table" role="table">
      <div className="nft-tr nft-th" role="row"><span>Item</span><span>Price</span><span>From</span><span>To</span><span>When</span></div>
      {sales.map((s) => (
        <div className="nft-tr" role="row" key={s.n ?? `${s.id}-${s.slot}`}>
          <button className="nft-item" onClick={() => open(s.id)}>
            {pals[s.id] && <PalArt pal={pals[s.id]} size={40} className="nft-thumb" />}
            <span><b>Pixel Pal #{s.id}</b><i>Sale</i></span>
          </button>
          <span className="mono">{fmt(s.price)} THRU</span>
          <Link className="mono" to={`/account/${s.seller}`}>{short(s.seller)}</Link>
          <Link className="mono" to={`/account/${s.buyer}`}>{short(s.buyer)}</Link>
          <span className="nft-muted">{ago(s.time)}</span>
        </div>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------- a Pal */

function PalModal({ id, pal, total, owner, listing, mine, prize, vault, feeBps, marketLive, market, onClose, reload }) {
  const gate = useUnlockGate()
  const wallet = useWallet()
  const [to, setTo] = useState('')
  const [price, setPrice] = useState(listing && mine ? String(listing.price) : '')
  useEffect(() => { setPrice(listing && mine ? String(listing.price) : '') }, [id, mine, listing?.price]) // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)

  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onClose])
  useEffect(() => { market.clear() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

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
    return signAndSend(await buildSend({ payer: wallet.address, num: id, nftId: pal.nftId, dest }))
  })

  const claim = () => act('claim', async () => {
    const { openTokenAccount } = await import('../lib/wallet.js')
    await openTokenAccount(WTHRU_MINT)
    return signAndSend(await buildClaim({ payer: wallet.address, num: id, vault }))
  })

  const cleanPrice = price.replace(/[, ]/g, '')
  const validPrice = /^\d{1,12}$/.test(cleanPrice) && Number(cleanPrice) > 0
  const youGet = validPrice ? Number(cleanPrice) - Math.floor((Number(cleanPrice) * feeBps) / 10000) : null
  const traits = Object.entries(pal.traits).filter(([k]) => k !== 'Rarity')
  const holder = listing ? listing.seller : owner && owner !== PALS_PROGRAM ? owner : null
  const working = busy !== null || market.busy !== null

  return createPortal(
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-card nft-modal" role="dialog" aria-modal="true" aria-label={`Pixel Pal #${id}`}>
        {gate.modal}
        <div className="nft-modal-art"><PalArt pal={pal} size={360} /></div>
        <div className="nft-modal-side">
          <div className="nft-modal-head">
            <div>
              <p className="nft-muted">Pixel Pals</p>
              <h2>Pixel Pal #{id}</h2>
            </div>
            <button className="nft-x" onClick={onClose} aria-label="Close">×</button>
          </div>
          <p className="nft-modal-sub">
            <span className="nft-rank">Rank {pal.rank} of {total}</span> {pal.traits.Rarity}
            {holder && <> · {listing ? 'Listed by' : 'Owned by'} <Link to={`/account/${holder}`} className="mono">{mine ? 'you' : short(holder)}</Link></>}
          </p>

          <div className="nft-box">
            {listing ? (
              <>
                <span className="nft-muted">Price</span>
                <div className="nft-box-price mono">{fmt(listing.price)} THRU</div>
                {!mine && <button className="btn full" onClick={() => market.buy([listing])} disabled={working}>
                  {market.busy === 'wrapping' ? 'Wrapping THRU…' : market.busy === 'buy' ? 'Buying…' : 'Buy now'}
                </button>}
              </>
            ) : (
              <span className="nft-muted">{mine ? 'Not listed. Set a price below to sell it.' : 'Not for sale.'}</span>
            )}

            {mine && marketLive && (
              <div className="nft-list">
                <div className="nft-list-row">
                  <input className="field mono" placeholder="Price in THRU" value={price} inputMode="numeric" onChange={(e) => setPrice(e.target.value)} />
                  <button className="btn" onClick={() => market.list(id, pal.nftId, cleanPrice)} disabled={working || !validPrice}>
                    {market.busy === 'list' ? 'Listing…' : listing ? 'Change price' : 'List'}
                  </button>
                </div>
                {validPrice && feeBps > 0 && <p className="fine">You get {fmt(youGet)} THRU after the {(feeBps / 100).toString()}% fee.</p>}
                {listing && <button className="btn ghost full" onClick={() => market.delist(id, pal.nftId)} disabled={working}>{market.busy === 'delist' ? 'Taking it back…' : 'Cancel listing'}</button>}
              </div>
            )}
          </div>

          {mine && prize && !listing && (
            <button className="btn full" onClick={claim} disabled={working}>
              {busy === 'claim' ? 'Claiming…' : `Claim ${fmt(prize.amount)} THRU inside`}
            </button>
          )}

          {mine && !listing && (
            <div className="nft-send">
              <input className="field mono" placeholder="Send to ta…" value={to} onChange={(e) => setTo(e.target.value)} />
              <button className="btn ghost" onClick={send} disabled={working || !to.trim()}>{busy === 'send' ? 'Sending…' : 'Send'}</button>
            </div>
          )}

          {(note || market.note) && <p className="notice">{note || market.note}</p>}
          {(error || market.error) && <p className="notice bad">{error || market.error}</p>}
          {market.needWallet && <p className="notice">You need a Thru wallet to buy. <Link to="/wallet">Get one here</Link>.</p>}

          <div className="nft-traits">
            {traits.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}
          </div>
          <p className="fine">
            <a href={`/api/rpc?action=pal&id=${id}`} target="_blank" rel="noreferrer">Metadata</a>
            {' · '}
            <NftLink nftId={pal.nftId} />
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function NftLink({ nftId }) {
  const [addr, setAddr] = useState(null)
  useEffect(() => { nftAccountFor(nftId).then(setAddr) }, [nftId])
  return addr ? <Link to={`/account/${addr}`}>On chain</Link> : null
}

export default PalsPage
