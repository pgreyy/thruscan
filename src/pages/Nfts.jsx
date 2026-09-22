// src/pages/Nfts.jsx
//
// Collections: every NFT collection on ThruScan in one ranked table, with
// its floor, volume, sales, listings, owners and size. A row opens the
// collection's own page, where its items are bought and sold.

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { COLLECTIONS } from '../lib/collections.js'
import { PalArt, fmt } from './Pals.jsx'
import './nfts.css'

const COLS = [
  ['floor', 'Floor'],
  ['volume', 'Volume'],
  ['sales', 'Sales'],
  ['listed', 'Listed'],
  ['owners', 'Owners'],
  ['minted', 'Items'],
]

function useStats() {
  const [stats, setStats] = useState({})
  const [errors, setErrors] = useState({})
  useEffect(() => {
    let alive = true
    const load = () => COLLECTIONS.forEach((c) => c.stats()
      .then((s) => { if (alive) { setStats((o) => ({ ...o, [c.slug]: s })); setErrors((o) => ({ ...o, [c.slug]: null })) } })
      .catch((e) => { if (alive) setErrors((o) => ({ ...o, [c.slug]: String(e?.message ?? e) })) }))
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 15_000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return { stats, errors }
}

function Avatar({ c }) {
  const pal = useMemo(() => c.avatar(), [c])
  return <PalArt pal={pal} size={44} className="col-avatar" />
}

export function NftsPage() {
  const { stats, errors } = useStats()
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState({ key: 'volume', dir: -1 })

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return COLLECTIONS
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.creator.toLowerCase().includes(q))
      .filter((c) => filter !== 'minting' || stats[c.slug]?.minting)
      .sort((a, b) => {
        const x = stats[a.slug]?.[sort.key] ?? -1, y = stats[b.slug]?.[sort.key] ?? -1
        return (x - y) * sort.dir || a.name.localeCompare(b.name)
      })
  }, [stats, filter, query, sort])

  const head = (key, label) => (
    <button className={`col-sort${sort.key === key ? ' on' : ''}`} onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }))}>
      {label}{sort.key === key && <span aria-hidden="true">{sort.dir < 0 ? ' ↓' : ' ↑'}</span>}
    </button>
  )

  return (
    <div className="nft-page">
      <div className="col-top">
        <h1>Collections</h1>
        <div className="col-tools">
          <div className="col-seg" role="tablist">
            {[['all', 'All'], ['minting', 'Minting now']].map(([k, l]) => (
              <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}>{l}</button>
            ))}
          </div>
          <input className="field col-search" placeholder="Search collections" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      <div className="col-table" role="table">
        <div className="col-tr col-th" role="row">
          <span>#</span><span>Collection</span>
          {COLS.map(([k, l]) => <span key={k}>{head(k, l)}</span>)}
        </div>
        {rows.map((c, i) => {
          const s = stats[c.slug]
          return (
            <Link key={c.slug} to={c.to} className="col-tr" role="row">
              <span className="col-rank">{i + 1}</span>
              <span className="col-name">
                <Avatar c={c} />
                <span>
                  <b>{c.name}</b>
                  <i>
                    by {c.creator}
                    {s?.minting && <em> · Minting {fmt(s.minted)} / {fmt(s.supply)}</em>}
                    {errors[c.slug] && !s && <em> · not loading right now</em>}
                  </i>
                </span>
              </span>
              <span className="mono">{s?.floor != null ? `${fmt(s.floor)} THRU` : '–'}</span>
              <span className="mono">{s?.volume != null ? `${fmt(s.volume)} THRU` : '–'}</span>
              <span className="mono">{s?.sales != null ? fmt(s.sales) : '–'}</span>
              <span className="mono">{s?.listed != null ? fmt(s.listed) : '–'}</span>
              <span className="mono">{s?.owners != null ? fmt(s.owners) : '–'}</span>
              <span className="mono">{s ? fmt(s.minted) : '–'}</span>
            </Link>
          )
        })}
        {rows.length === 0 && <p className="nft-empty col-none">{filter === 'minting' ? 'Nothing is minting right now.' : 'No collection matches that.'}</p>}
      </div>
    </div>
  )
}

export default NftsPage
