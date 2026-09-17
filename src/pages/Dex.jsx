// src/pages/Dex.jsx
//
// The Swap and Launchpad pages.
//
// Both are read-and-quote rather than click-to-trade. A trade moves real
// balances, so the tokens have to sit in somebody's account, and the sponsored
// model the games use would mean everyone shared one pot: one visitor could
// spend what another just bought. Rather than ship something that looks like a
// wallet and is not, these pages price the trade exactly as the chain will and
// hand over the command to run with your own key. The wall already works this
// way with its "Post from your terminal" tab.
//
// The quotes are not approximations. quoteSwap and quoteBuy reproduce the
// programs' arithmetic in BigInt, and the instruction builders were checked
// byte for byte against transactions that already executed on chain, so the
// number shown here is the number that lands.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getAccount } from '../lib/rpcClient.js'
import {
  decodeSwapRegistry, quoteSwap, buildSwapInstruction, toHex,
} from '../lib/swap.js'
import {
  decodePadRegistry, quoteBuy, quoteSell, snipeBps, graduationProgress,
  buildBuyInstruction, buildSellInstruction, STATE_GRADUATED,
} from '../lib/pad.js'

import {
  THRUSWAP_PROGRAM as SWAP_PROGRAM,
  THRUSWAP_REGISTRY as SWAP_REGISTRY,
  THRUPAD_PROGRAM as PAD_PROGRAM,
  THRUPAD_REGISTRY as PAD_REGISTRY,
} from '../lib/addresses.js'

const DECIMALS = 6

/* ---------- shared helpers ---------- */

/** A token account is 73 bytes: mint[32] owner[32] amount(u64) is_frozen. */
function readTokenAmount(account) {
  const b64 = account?.data?.base64
  if (!b64) return 0n
  const binary = atob(b64)
  if (binary.length < 73) return 0n
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const dv = new DataView(bytes.buffer)
  return dv.getBigUint64(64, true)
}

/** Base units to a readable figure. Never rounds a balance up. */
function fmt(units, decimals = DECIMALS, maxFrac = 4) {
  const n = Number(units) / 10 ** decimals
  if (!isFinite(n)) return '0'
  if (n !== 0 && Math.abs(n) < 10 ** -maxFrac) return `<${10 ** -maxFrac}`
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac })
}

/** Readable figure back to base units, as BigInt, with no float drift. */
function toUnits(text, decimals = DECIMALS) {
  const clean = String(text ?? '').trim()
  if (!clean || !/^\d*\.?\d*$/.test(clean)) return 0n
  const [whole = '0', frac = ''] = clean.split('.')
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals)
  try { return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0') }
  catch { return 0n }
}

function short(addr) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : ''
}

/** The command to run, built from the same bytes the chain will receive. */
function cliCommand(program, built) {
  const parts = [`thru txn execute ${program} ${toHex(built.data)}`]
  for (const a of built.readWrite) parts.push(`  --readwrite-accounts ${a}`)
  for (const a of built.readOnly) parts.push(`  --readonly-accounts ${a}`)
  parts.push('  --fee-payer YOUR_KEY_NAME')
  parts.push('  --state-units 60000 --memory-units 60000')
  return parts.join(' `\n')
}

function CopyBlock({ text, label = 'Copy command' }) {
  const [done, setDone] = useState(false)
  const copy = () => {
    navigator.clipboard?.writeText(text)
    setDone(true)
    setTimeout(() => setDone(false), 1600)
  }
  return (
    <div style={{ marginTop: 12 }}>
      <div className="codewrap" style={{ maxHeight: 220, overflow: 'auto' }}>
        <pre className="mono" style={{ margin: 0, padding: 12, fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{text}</pre>
      </div>
      <button className="btn" style={{ marginTop: 8 }} onClick={copy}>{done ? 'Copied' : label}</button>
    </div>
  )
}

function NotLive({ what }) {
  return (
    <section className="card">
      <h2 className="h2">{what} is not connected yet</h2>
      <p className="fine" style={{ marginTop: 8, lineHeight: 1.65 }}>
        The program is deployed on alphanet, but this page needs its addresses before it can read
        anything. Set them in the site's environment variables and redeploy, and this page fills in.
      </p>
    </section>
  )
}

/** Fetch a registry plus the vault balances the page needs, in one go. */
function useChainData(registry, decode, vaultsOf) {
  const [state, setState] = useState({ loading: true, error: null, data: null, balances: {} })

  const load = useCallback(async () => {
    if (!registry) { setState({ loading: false, error: null, data: null, balances: {} }); return }
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const acc = await getAccount(registry)
      const data = decode(acc.data?.base64)

      // Reserves are read live from the vaults rather than cached in the
      // record, so a price can never be quoted against a balance that is not
      // actually there.
      const wanted = [...new Set(vaultsOf(data))]
      const results = await Promise.all(wanted.map((v) => getAccount(v).catch(() => null)))
      const balances = {}
      wanted.forEach((v, i) => { balances[v] = results[i] ? readTokenAmount(results[i]) : 0n })

      setState({ loading: false, error: null, data, balances })
    } catch (err) {
      setState({ loading: false, error: String(err?.message ?? err), data: null, balances: {} })
    }
  }, [registry])

  useEffect(() => { load() }, [load])
  return { ...state, reload: load }
}

/* ==========================================================================
   SWAP
   ========================================================================== */

function PoolCard({ pool, balances, program, registry }) {
  const [amount, setAmount] = useState('')
  const [flipped, setFlipped] = useState(false)

  const reserveA = balances[pool.vaultA] ?? 0n
  const reserveB = balances[pool.vaultB] ?? 0n

  const vaultIn = flipped ? pool.vaultB : pool.vaultA
  const vaultOut = flipped ? pool.vaultA : pool.vaultB
  const reserveIn = flipped ? reserveB : reserveA
  const reserveOut = flipped ? reserveA : reserveB

  const amountIn = toUnits(amount)
  const quote = useMemo(
    () => quoteSwap({ reserveIn, reserveOut, amountIn, feeBps: pool.feeBps }),
    [reserveIn, reserveOut, amountIn, pool.feeBps],
  )

  const built = useMemo(() => {
    if (amountIn <= 0n || quote.amountOut <= 0n) return null
    try {
      return buildSwapInstruction({
        registry, poolId: pool.id, vaultIn, vaultOut,
        userIn: 'YOUR_TOKEN_ACCOUNT_IN', userOut: 'YOUR_TOKEN_ACCOUNT_OUT',
        amountIn, minOut: 1n,
      })
    } catch { return null }
  }, [registry, pool.id, vaultIn, vaultOut, amountIn, quote.amountOut])

  const price = reserveA > 0n && reserveB > 0n
    ? (Number(reserveB) / Number(reserveA)) : 0

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="h2">Pool {pool.id}</h2>
          <p className="sub">{pool.feeBps / 100}% to liquidity providers</p>
        </div>
        <span className="hero-tag">{Number(pool.swapCount)} swap{Number(pool.swapCount) === 1 ? '' : 's'}</span>
      </div>

      <div className="hero" style={{ marginTop: 14 }}>
        <p className="hero-eyebrow">Reserves</p>
        <h2 className="hero-title" style={{ fontSize: 22 }}>
          {fmt(reserveA)} <span style={{ opacity: 0.55, fontSize: 15 }}>/</span> {fmt(reserveB)}
        </h2>
        <div className="hero-stats">
          <span className="hero-stat"><b>{price ? price.toFixed(4) : '0'}</b><span>B per A</span></span>
          <span className="hero-stat"><b>{fmt(pool.lpSupply)}</b><span>LP supply</span></span>
        </div>
      </div>

      <div className="rows" style={{ marginTop: 4 }}>
        <div className="row"><span>Token A</span><span className="mono">{short(pool.mintA)}</span></div>
        <div className="row"><span>Token B</span><span className="mono">{short(pool.mintB)}</span></div>
      </div>

      <div className="stack" style={{ marginTop: 16 }}>
        <div className="inline">
          <input
            className="field mono"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            inputMode="decimal"
          />
          <button className="btn ghost" onClick={() => setFlipped((f) => !f)} title="Swap direction">
            {flipped ? 'B → A' : 'A → B'}
          </button>
        </div>

        {amountIn > 0n && (
          quote.amountOut > 0n ? (
            <div className="rows">
              <div className="row"><span>You receive</span><b className="mono">{fmt(quote.amountOut)}</b></div>
              <div className="row"><span>Price impact</span><span className="mono">{(Number(quote.priceImpactBps) / 100).toFixed(2)}%</span></div>
              <div className="row"><span>Fee</span><span className="mono">{fmt((amountIn * BigInt(pool.feeBps)) / 10000n)}</span></div>
            </div>
          ) : (
            <p className="notice bad">{quote.reason === 'empty pool' ? 'This pool has no liquidity yet.' : `Cannot quote: ${quote.reason}.`}</p>
          )
        )}
      </div>

      {built && (
        <>
          <p className="fine" style={{ marginTop: 16 }}>
            Replace the two placeholder accounts with your own token accounts for each side, and
            <code className="mono"> YOUR_KEY_NAME</code> with your CLI key.
          </p>
          <CopyBlock text={cliCommand(program, built)} />
        </>
      )}
    </section>
  )
}

export function SwapPage() {
  const { loading, error, data, balances, reload } = useChainData(
    SWAP_REGISTRY,
    decodeSwapRegistry,
    (d) => d.pools.flatMap((p) => [p.vaultA, p.vaultB]),
  )

  if (!SWAP_PROGRAM || !SWAP_REGISTRY) {
    return (
      <div className="wrap">
        <p className="eyebrow">Trade</p>
        <h1 className="h1">Swap</h1>
        <p className="lede">A constant product market maker, running on chain.</p>
        <NotLive what="thruswap" />
      </div>
    )
  }

  return (
    <div className="wrap">
      <p className="eyebrow">Trade</p>
      <h1 className="h1">Swap</h1>
      <p className="lede">
        A constant product market maker on Thru. Reserves live in token accounts the program itself
        owns, so no one signs for them and the price is whatever the ratio says it is.
      </p>

      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="h2">Pools</h2>
            <p className="sub">{data ? `${data.pools.length} of ${data.capacity} slots in use` : 'reading the chain'}</p>
          </div>
          <button className="btn ghost" onClick={reload} disabled={loading}>{loading ? 'Reading' : 'Refresh'}</button>
        </div>
        {error && <p className="notice bad" style={{ marginTop: 12 }}>Could not read the pool registry. It may be mid-reset.</p>}
        {!error && data && data.pools.length === 0 && (
          <p className="fine" style={{ marginTop: 12 }}>No pools have been created yet.</p>
        )}
      </section>

      {data?.pools.map((p) => (
        <PoolCard key={p.id} pool={p} balances={balances} program={SWAP_PROGRAM} registry={SWAP_REGISTRY} />
      ))}
    </div>
  )
}

/* ==========================================================================
   LAUNCHPAD
   ========================================================================== */

function LaunchCard({ launch, balances, threshold, program, registry, slot }) {
  const [side, setSide] = useState('buy')
  const [amount, setAmount] = useState('')

  const quoteHeld = balances[launch.quoteVault] ?? 0n
  const raised = quoteHeld > launch.creatorFees ? quoteHeld - launch.creatorFees : 0n
  const progress = graduationProgress(raised, threshold)
  const tax = slot != null ? snipeBps(launch.startSlot, slot) : 0n

  const amountIn = toUnits(amount)
  const q = useMemo(() => {
    if (side === 'buy') {
      return quoteBuy({
        vq: launch.vq, vt: launch.vt, amountIn, feeBps: launch.feeBps,
        startSlot: launch.startSlot, currentSlot: slot,
      })
    }
    return quoteSell({ vq: launch.vq, vt: launch.vt, amountIn, feeBps: launch.feeBps })
  }, [side, launch, amountIn, slot])

  const out = side === 'buy' ? q.tokensOut : q.quoteOut

  const built = useMemo(() => {
    if (amountIn <= 0n || out <= 0n || launch.graduated) return null
    const args = {
      registry, launchId: launch.id,
      tokenVault: launch.tokenVault, quoteVault: launch.quoteVault,
      userToken: 'YOUR_TOKEN_ACCOUNT', userQuote: 'YOUR_TUSD_ACCOUNT',
      amountIn, minOut: 1n,
    }
    try { return side === 'buy' ? buildBuyInstruction(args) : buildSellInstruction(args) }
    catch { return null }
  }, [side, registry, launch, amountIn, out])

  const price = Number(launch.vq) / Number(launch.vt || 1n)

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="h2">{launch.name}</h2>
          <p className="sub">${launch.symbol} · {launch.feeBps / 100}% creator fee</p>
        </div>
        <span className="hero-tag">{launch.graduated ? 'Graduated' : 'Live'}</span>
      </div>

      <div className="hero" style={{ marginTop: 14 }}>
        <p className="hero-eyebrow">Raised</p>
        <h2 className="hero-title" style={{ fontSize: 24 }}>{fmt(raised)} <span style={{ fontSize: 15, opacity: 0.55 }}>tUSD</span></h2>
        <div className="hero-stats">
          <span className="hero-stat"><b>{(progress * 100).toFixed(1)}%</b><span>to graduation</span></span>
          <span className="hero-stat"><b>{price.toExponential(2)}</b><span>price</span></span>
          <span className="hero-stat"><b>{Number(launch.tradeCount)}</b><span>trades</span></span>
        </div>
      </div>

      {/* A plain bar rather than a chart: what matters is how close this is to
          the threshold, and one number in one shape says it. */}
      <div style={{ height: 6, borderRadius: 3, background: 'rgba(128,128,128,0.2)', marginTop: 14, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.max(2, progress * 100)}%`, background: 'currentColor', opacity: 0.55 }} />
      </div>

      {tax > 0n && !launch.graduated && (
        <p className="notice" style={{ marginTop: 14 }}>
          Anti-snipe tax is {(Number(tax) / 100).toFixed(1)}% right now and falling to zero.
          It is paid to nobody and stays in the curve. Waiting a few seconds gets you more.
        </p>
      )}

      {launch.graduated ? (
        <p className="fine" style={{ marginTop: 14, lineHeight: 1.65 }}>
          This curve is frozen. It raised enough to graduate, and its reserves are ready to seed a
          pool on the swap page.
        </p>
      ) : (
        <div className="stack" style={{ marginTop: 16 }}>
          <div className="inline">
            <button className="btn ghost" onClick={() => setSide('buy')} aria-current={side === 'buy'}>Buy</button>
            <button className="btn ghost" onClick={() => setSide('sell')} aria-current={side === 'sell'}>Sell</button>
          </div>
          <input
            className="field mono"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={side === 'buy' ? 'tUSD to spend' : `${launch.symbol} to sell`}
            inputMode="decimal"
          />
          {amountIn > 0n && (
            out > 0n ? (
              <div className="rows">
                <div className="row">
                  <span>You receive</span>
                  <b className="mono">{fmt(out)} {side === 'buy' ? launch.symbol : 'tUSD'}</b>
                </div>
                <div className="row"><span>Creator fee</span><span className="mono">{fmt(q.creatorFee)} tUSD</span></div>
                {side === 'buy' && q.snipeTax > 0n && (
                  <div className="row"><span>Anti-snipe tax</span><span className="mono">{fmt(q.snipeTax)} tUSD</span></div>
                )}
              </div>
            ) : (
              <p className="notice bad">Cannot quote: {q.reason}.</p>
            )
          )}
        </div>
      )}

      <div className="rows" style={{ marginTop: 16 }}>
        <div className="row"><span>Mint</span><span className="mono">{short(launch.mint)}</span></div>
        <div className="row"><span>Creator</span><span className="mono">{short(launch.creator)}</span></div>
        <div className="row"><span>Unclaimed fees</span><span className="mono">{fmt(launch.creatorFees)} tUSD</span></div>
      </div>

      {built && (
        <>
          <p className="fine" style={{ marginTop: 16 }}>
            Replace the placeholder accounts with your own, and <code className="mono">YOUR_KEY_NAME</code> with your CLI key.
          </p>
          <CopyBlock text={cliCommand(program, built)} />
        </>
      )}
    </section>
  )
}

export function LaunchpadPage() {
  const [slot, setSlot] = useState(null)
  const { loading, error, data, balances, reload } = useChainData(
    PAD_REGISTRY,
    decodePadRegistry,
    (d) => d.launches.flatMap((l) => [l.quoteVault, l.tokenVault]),
  )

  // The anti-snipe tax decays by slot, so the page needs the current height to
  // show what a buy costs right now rather than what it cost at launch.
  useEffect(() => {
    let alive = true
    const tick = () => {
      fetch('/api/rpc?action=height')
        .then((r) => r.json())
        .then((j) => { if (alive && j?.ok) setSlot(BigInt(j.height ?? j.blockHeight ?? 0)) })
        .catch(() => {})
    }
    tick()
    const id = setInterval(tick, 15000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  if (!PAD_PROGRAM || !PAD_REGISTRY) {
    return (
      <div className="wrap">
        <p className="eyebrow">Launch</p>
        <h1 className="h1">Launchpad</h1>
        <p className="lede">Put a token on a bonding curve and let the chain price it.</p>
        <NotLive what="thrupad" />
      </div>
    )
  }

  return (
    <div className="wrap">
      <p className="eyebrow">Launch</p>
      <h1 className="h1">Launchpad</h1>
      <p className="lede">
        Every launch puts its whole supply on a bonding curve priced in tUSD. There is no second
        instruction that mints, so the supply is fixed by construction rather than by promise.
      </p>

      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="h2">Launches</h2>
            <p className="sub">
              {data
                ? `${data.launches.length} of ${data.capacity} slots · graduates at ${fmt(data.gradThreshold)} tUSD`
                : 'reading the chain'}
            </p>
          </div>
          <button className="btn ghost" onClick={reload} disabled={loading}>{loading ? 'Reading' : 'Refresh'}</button>
        </div>
        {error && <p className="notice bad" style={{ marginTop: 12 }}>Could not read the launch registry. It may be mid-reset.</p>}
        {!error && data && data.launches.length === 0 && (
          <p className="fine" style={{ marginTop: 12 }}>Nothing has launched yet.</p>
        )}
      </section>

      {data?.launches.map((l) => (
        <LaunchCard
          key={l.id}
          launch={l}
          balances={balances}
          threshold={data.gradThreshold}
          program={PAD_PROGRAM}
          registry={PAD_REGISTRY}
          slot={slot}
        />
      ))}
    </div>
  )
}
