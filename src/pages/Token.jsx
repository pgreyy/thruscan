// src/pages/Token.jsx
//
// One page per token (/token/:mint): what it is, where it trades, and its price
// history. The mint account says what the token is; the launchpad and pool
// registries say where it trades; each market's own history gives the price.

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getAccount } from '../lib/rpcClient.js'
import { decodeMintAccount } from '../lib/token.js'
import { decodeSwapRegistry } from '../lib/swap.js'
import { decodePadRegistry } from '../lib/pad.js'
import { THRUSWAP_REGISTRY, THRUPAD_REGISTRY, TUSD_MINT } from '../lib/addresses.js'
import { TradeChart } from '../components/TradeChart.jsx'
import { TokenIcon, TokenLinks } from '../components/TokenMeta.jsx'
import { tokenMetaFor } from '../lib/tokenmeta.js'
import { Search } from './Home.jsx'
import './home.css'

const short = (s) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : '')

function Field({ k, children }) {
  return (
    <div className="detail-field">
      <span className="detail-k">{k}</span>
      <span className="detail-v">{children}</span>
    </div>
  )
}

function Addr({ value }) {
  const [done, setDone] = useState(false)
  if (!value) return <span>-</span>
  return (
    <span className="detail-addr">
      <Link className="mono" to={`/account/${value}`}>{value}</Link>
      <button className="detail-copy" onClick={() => { navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1400) }}>
        {done ? 'copied' : 'copy'}
      </button>
    </span>
  )
}

export function TokenPage() {
  const { mint } = useParams()
  const [state, setState] = useState({ loading: true })
  const [meta, setMeta] = useState(null)

  useEffect(() => {
    let alive = true
    tokenMetaFor(mint).then((m) => { if (alive) setMeta(m) }).catch(() => {})
    return () => { alive = false }
  }, [mint])

  useEffect(() => {
    let alive = true
    setState({ loading: true })
    ;(async () => {
      const [acc, swap, pad] = await Promise.all([
        getAccount(mint).catch(() => null),
        THRUSWAP_REGISTRY ? getAccount(THRUSWAP_REGISTRY).catch(() => null) : null,
        THRUPAD_REGISTRY ? getAccount(THRUPAD_REGISTRY).catch(() => null) : null,
      ])
      let info = null
      try { info = decodeMintAccount(acc?.data?.base64) } catch { info = null }
      if (!info) { if (alive) setState({ loading: false, notToken: true }); return }

      let pools = []
      try { pools = decodeSwapRegistry(swap?.data?.base64).pools.filter((p) => p.mintA === mint || p.mintB === mint) } catch { /* none */ }
      let launch = null
      try { launch = decodePadRegistry(pad?.data?.base64).launches.find((l) => l.mint === mint) ?? null } catch { /* none */ }

      // Tickers and decimals for everything this token trades against.
      const others = [...new Set([...pools.flatMap((p) => [p.mintA, p.mintB]), launch?.quoteMint].filter((m) => m && m !== mint))]
      const mints = { [mint]: info }
      await Promise.all(others.map(async (m) => {
        try { mints[m] = decodeMintAccount((await getAccount(m))?.data?.base64) } catch { /* unknown */ }
      }))
      if (alive) setState({ loading: false, info, pools, launch, mints })
    })()
    return () => { alive = false }
  }, [mint])

  const { info, pools = [], launch, mints = {} } = state
  const sym = (m) => mints[m]?.ticker || short(m)
  const dec = (m) => mints[m]?.decimals ?? 6
  const ticker = info?.ticker || short(mint)

  return (
    <div className="home">
      <section className="home-hero detail-hero">
        <div className="home-hero-inner">
          <h1>{info ? ticker : 'Token'}</h1>
          <Search compact />
        </div>
      </section>

      <div className="home-wrap detail-wrap">
        {state.loading && <section className="home-list detail-card"><p className="fine home-pad">Reading the chain</p></section>}

        {state.notToken && (
          <section className="home-list detail-card">
            <p className="notice bad" style={{ margin: '14px 0' }}>That address is not a token mint.</p>
            <p className="fine" style={{ marginBottom: 14 }}><Link to={`/account/${mint}`}>Open it as an account</Link></p>
          </section>
        )}

        {info && (
          <section className="home-list detail-card">
            <div className="home-list-head">
              <h2>{launch?.name || 'Overview'}</h2>
              {launch && <Link className="home-badge plain-link" to={`/launch/${launch.id}`}>{launch.graduated ? 'Graduated launch' : 'Trade on launchpad'}</Link>}
            </div>
            <Field k="Ticker">
              <span className="tok-field">
                <TokenIcon meta={meta} symbol={ticker} mint={mint} size={22} />
                <b>{ticker}</b>
              </span>
            </Field>
            {meta && (meta.x || meta.telegram || meta.website) && (
              <Field k="Links"><TokenLinks meta={meta} className="tmeta-links" /></Field>
            )}
            <Field k="Supply"><span>{info.supplyDisplay}</span><span className="fine detail-after">{info.decimals} decimals</span></Field>
            <Field k="Mint"><Addr value={mint} /></Field>
            <Field k="Mint authority"><Addr value={info.mintAuthority} /></Field>
            <Field k="Creator"><Addr value={launch?.creator ?? info.creator} /></Field>
            {pools.length > 0 && (
              <Field k="Pools">
                <span>{pools.map((p) => `${sym(p.mintA)} / ${sym(p.mintB)}`).join(', ')}</span>
                <Link className="fine" to="/swap?tab=pools">open Swap</Link>
              </Field>
            )}
          </section>
        )}

        {info && launch && (
          <TradeChart
            title="Launchpad price"
            quoteVault={launch.quoteVault}
            tokenVault={launch.tokenVault}
            quote={sym(launch.quoteMint)}
            symbol={ticker}
            quoteDecimals={dec(launch.quoteMint)}
            tokenDecimals={info.decimals}
          />
        )}

        {info && pools.map((p) => {
          // Priced in whatever it trades against; for tUSD itself, the other
          // side is priced in tUSD instead, since a tUSD price in TCAT reads oddly.
          const mintIsA = p.mintA === mint
          const other = mintIsA ? p.mintB : p.mintA
          const pricingThis = mint !== TUSD_MINT
          const tokenMint = pricingThis ? mint : other
          const quoteMint = pricingThis ? other : mint
          const tokenIsA = tokenMint === p.mintA
          return (
            <TradeChart
              key={p.id}
              title={`${sym(p.mintA)} / ${sym(p.mintB)} pool`}
              quoteVault={tokenIsA ? p.vaultB : p.vaultA}
              tokenVault={tokenIsA ? p.vaultA : p.vaultB}
              quote={sym(quoteMint)}
              symbol={sym(tokenMint)}
              quoteDecimals={dec(quoteMint)}
              tokenDecimals={dec(tokenMint)}
            />
          )
        })}

        {info && !launch && pools.length === 0 && (
          <section className="home-list detail-card"><p className="fine home-pad">Not trading on ThruScan's launchpad or pools.</p></section>
        )}
      </div>
    </div>
  )
}

export default TokenPage
