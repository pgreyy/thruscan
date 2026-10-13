// src/pages/Explorer.jsx
//
// The Explorer (Update 02, 5e-5g): one page for what used to be three.
//
//   /explorer                 Blocks & transactions: the chain's vital signs
//                             and the newest blocks and txs
//   /explorer?tab=activity    the activity feed (&address= narrows it)
//   /explorer?tab=wall        the wall (&filter=to-you, &to=<address>)
//
// The tab lives in the URL, so a link to a tab is a link to that tab and the
// old /activity and /wall addresses redirect here.

import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { describe, isRetiredGame } from '../lib/activity.js'
import { kindOfLabel } from '../lib/pills.js'
import { relTime, fullUtc } from '../lib/when.js'
import { Feed } from '../components/Feed.jsx'
import { EventPill, StatusPill } from '../components/Pill.jsx'
import { WallTab } from './Wall.jsx'
import './explorer.css'

const REFRESH_MS = 5000
const TABS = [
  { key: 'blocks', label: 'Blocks & transactions' },
  { key: 'activity', label: 'Activity' },
  { key: 'wall', label: 'Wall' },
]

const num = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '–' : Number(n).toLocaleString('en-US'))
const short = (s) => (s ? `${s.slice(0, 5)}…${s.slice(-4)}` : '')

function useOverview() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/rpc?action=overview')
      const body = await res.json()
      if (!res.ok || body.ok === false) throw new Error(body.error || `status ${res.status}`)
      setData(body); setError(null)
    } catch (e) {
      setError(String(e?.message ?? e))
    }
  }, [])
  useEffect(() => {
    const first = setTimeout(load, 0)
    const id = setInterval(() => { if (!document.hidden) load() }, REFRESH_MS)
    return () => { clearTimeout(first); clearInterval(id) }
  }, [load])
  return { data, error }
}

function Stat({ label, value, title }) {
  return (
    <div className="ex-stat" title={title}>
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  )
}

function BlocksTab() {
  const { data, error } = useOverview()
  const blocks = data?.blocks ?? []
  const txs = (data?.transactions ?? []).filter((t) => !isRetiredGame(t))

  return (
    <>
      <dl className="ex-stats">
        <Stat label="Finalized block" value={num(data?.finalized)} />
        <Stat label="Block time" value={data?.blockTimeMs ? `${Math.round(data.blockTimeMs)} ms` : '–'} title="Average over the last 60 blocks" />
        <Stat label="Transactions / sec" value={data?.tps !== undefined && data?.tps !== null ? data.tps.toFixed(data.tps < 10 ? 1 : 0) : '–'} />
      </dl>

      {error && !data && <p className="notice bad">Could not read the chain: {error}</p>}

      <div className="ex-lists">
        <section className="ex-panel">
          <div className="ex-panel-head"><h2>Latest blocks</h2></div>
          <div className="ex-table" role="table" aria-label="Latest blocks">
            <div className="ex-tr ex-th ex-blocks" role="row">
              <span role="columnheader">Block</span>
              <span role="columnheader" className="r">Txns</span>
              <span role="columnheader" className="r">Age</span>
            </div>
            {!data && <p className="why ex-pad">Reading the chain…</p>}
            {blocks.slice(0, 10).map((b) => (
              <div key={b.slot} className="ex-tr ex-blocks" role="row">
                <span role="cell" className="mono">{num(b.slot)}</span>
                <span role="cell" className="mono r">{b.txs === null ? '–' : b.txs}</span>
                <span role="cell" className="mono r dim" title={fullUtc(b.time)}>{b.time ? relTime(b.time) : '–'}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="ex-panel">
          <div className="ex-panel-head"><h2>Latest transactions</h2><Link to="/explorer?tab=activity">View all</Link></div>
          <div className="ex-table" role="table" aria-label="Latest transactions">
            <div className="ex-tr ex-th ex-txs" role="row">
              <span role="columnheader">Signature</span>
              <span role="columnheader">Action</span>
              <span role="columnheader">Status</span>
              <span role="columnheader" className="r">Age</span>
            </div>
            {!data && <p className="why ex-pad">Reading the chain…</p>}
            {data && txs.length === 0 && <p className="why ex-pad">No transactions in the latest blocks.</p>}
            {txs.slice(0, 10).map((tx) => {
              const { label } = describe(tx, null)
              return (
                <Link key={tx.signature} to={`/tx/${tx.signature}`} className="ex-tr ex-txs" role="row">
                  <span role="cell" className="mono ex-sig">{short(tx.signature)}</span>
                  <span role="cell" title={label}><EventPill kind={kindOfLabel(label)} /></span>
                  <span role="cell"><StatusPill ok={tx.ok !== false} /></span>
                  <span role="cell" className="mono r dim" title={fullUtc(tx.time)}>{tx.time ? relTime(tx.time) : '–'}</span>
                </Link>
              )
            })}
          </div>
        </section>
      </div>
    </>
  )
}

export function ExplorerPage() {
  const [params, setParams] = useSearchParams()
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'blocks'
  const address = params.get('address')

  const pick = (key) => {
    const next = new URLSearchParams()
    if (key !== 'blocks') next.set('tab', key)
    setParams(next, { replace: true })
  }

  return (
    <div className="page ex">
      <h1 className="h1 ex-h1">Explorer</h1>
      <div className="tabs ex-tabs" role="tablist" aria-label="Explorer">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" className="tab-btn" aria-selected={tab === t.key} onClick={() => pick(t.key)}>{t.label}</button>
        ))}
      </div>

      <div role="tabpanel" className="ex-panel-body">
        {tab === 'blocks' && <BlocksTab />}
        {tab === 'activity' && <Feed key={address ?? 'all'} embedded address={address} limit={50} />}
        {tab === 'wall' && <WallTab />}
      </div>
    </div>
  )
}

export default ExplorerPage
