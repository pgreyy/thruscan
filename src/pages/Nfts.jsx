// src/pages/Nfts.jsx
//
// The NFT market's front page: every collection with its numbers, the
// cheapest things for sale right now, and the latest sales. Pixel Pals is the
// first collection; artists' collections from the launchpad join this table.

import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useWallet } from './Wallet.jsx'
import { usePals, PalArt, PalCard, fmt, short, ago } from './Pals.jsx'
import { useMarket } from '../lib/pals/useMarket.js'
import { GENESIS, palFor } from '../lib/pals/art.js'
import './nfts.css'

export function NftsPage() {
  const wallet = useWallet()
  const navigate = useNavigate()
  const { info, error, reload, pals, listings } = usePals(wallet.address)
  const market = useMarket({ onDone: reload })
  const m = info?.market
  const genesis = useMemo(() => palFor(GENESIS.id, GENESIS.wallet), [])
  const taken = info ? info.minted + (info.reservedAhead ?? 0) : 0
  const cheapest = (m?.listings ?? []).slice(0, 10)
  const mine = new Set([...(info?.mine?.holding ?? []), ...(info?.mine?.listed ?? [])])
  const open = (id) => navigate(`/pals?id=${id}`)

  return (
    <div className="nft-page">
      {market.modal}
      <div className="nft-title">
        <h1>NFTs</h1>
        <Link to="/pals" className="btn">Mint Pixel Pals</Link>
      </div>

      <section className="nft-section">
        <div className="nft-table nft-collections" role="table">
          <div className="nft-tr nft-th" role="row">
            <span>Collection</span><span>Floor</span><span>Volume</span><span>Sales</span><span>Listed</span><span>Owners</span><span>Items</span>
          </div>
          <Link to="/pals" className="nft-tr" role="row">
            <span className="nft-item">
              <PalArt pal={genesis} size={40} className="nft-thumb" />
              <span><b>Pixel Pals</b><i>{info && taken < info.supply ? 'Minting' : 'Thru'}</i></span>
            </span>
            <span className="mono">{m?.floor ? `${fmt(m.floor)} THRU` : '–'}</span>
            <span className="mono">{m?.live ? `${fmt(m.volume)} THRU` : '–'}</span>
            <span className="mono">{m?.live ? fmt(m.sales) : '–'}</span>
            <span className="mono">{m?.live ? fmt(m.listed) : '–'}</span>
            <span className="mono">{m ? fmt(m.holders) : '–'}</span>
            <span className="mono">{info ? `${fmt(taken)} / ${fmt(info.supply)}` : '–'}</span>
          </Link>
        </div>
        {error && <p className="notice bad" style={{ marginTop: 10 }}>{error}</p>}
      </section>

      <section className="nft-section">
        <header className="nft-section-head">
          <h2>Cheapest right now</h2>
          <Link to="/pals?tab=sale">All for sale</Link>
        </header>
        {!info ? <p className="nft-empty">{error ? 'Could not load the market. It retries every few seconds.' : 'Loading…'}</p> : cheapest.length === 0
          ? <p className="nft-empty">Nothing is listed yet. Holders list from a Pal's page, and the cheapest show up here.</p>
          : (
            <div className="nft-grid">
              {cheapest.map((l) => pals[l.id] && (
                <PalCard key={l.id} id={l.id} pal={pals[l.id]} listing={listings.get(l.id)} mine={mine.has(l.id)}
                  onOpen={open} onBuy={market.buy} busy={market.busy !== null} />
              ))}
            </div>
          )}
        {market.note && <p className="notice" style={{ marginTop: 12 }}>{market.note}</p>}
        {market.error && <p className="notice bad" style={{ marginTop: 12 }}>{market.error}</p>}
        {market.needWallet && <p className="notice" style={{ marginTop: 12 }}>You need a Thru wallet to buy. <Link to="/wallet">Get one here</Link>.</p>}
      </section>

      <section className="nft-section">
        <header className="nft-section-head">
          <h2>Latest sales</h2>
          <Link to="/pals?tab=activity">Activity</Link>
        </header>
        {!info ? <p className="nft-empty">Loading…</p> : !(m?.recent?.length)
          ? <p className="nft-empty">No sales yet.</p>
          : (
            <div className="nft-table" role="table">
              {m.recent.slice(0, 8).map((s) => (
                <div className="nft-tr nft-sale" role="row" key={s.n ?? `${s.id}-${s.slot}`}>
                  <button className="nft-item" onClick={() => open(s.id)}>
                    {pals[s.id] && <PalArt pal={pals[s.id]} size={40} className="nft-thumb" />}
                    <span><b>Pixel Pal #{s.id}</b><i>{short(s.seller)} to {short(s.buyer)}</i></span>
                  </button>
                  <span className="mono">{fmt(s.price)} THRU</span>
                  <span className="nft-muted">{ago(s.time)}</span>
                </div>
              ))}
            </div>
          )}
      </section>
    </div>
  )
}

export default NftsPage
