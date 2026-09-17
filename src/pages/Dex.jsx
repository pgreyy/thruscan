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
  buildBuyInstruction, buildSellInstruction, buildLaunchInstruction,
} from '../lib/pad.js'

import { decodeMintAccount } from '../lib/token.js'
import {
  THRUSWAP_PROGRAM as SWAP_PROGRAM,
  THRUSWAP_REGISTRY as SWAP_REGISTRY,
  THRUPAD_PROGRAM as PAD_PROGRAM,
  THRUPAD_REGISTRY as PAD_REGISTRY,
  TUSD_MINT,
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

/**
 * Fetch a registry, the vault balances the page needs, and the ticker of every
 * mint involved, in one pass.
 *
 * Tickers are a separate read because a pool record stores mint ADDRESSES, not
 * names: the program has no use for a name and storing one would be 8 wasted
 * bytes per pool. The name lives in the mint account, where the token program
 * put it, so the page fetches it rather than the chain duplicating it.
 */
function useChainData(registry, decode, vaultsOf, mintsOf) {
  const [state, setState] = useState({ loading: true, error: null, data: null, balances: {}, tickers: {} })

  const load = useCallback(async () => {
    if (!registry) { setState({ loading: false, error: null, data: null, balances: {}, tickers: {} }); return }
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const acc = await getAccount(registry)
      const data = decode(acc.data?.base64)

      // Reserves are read live from the vaults rather than cached in the
      // record, so a price can never be quoted against a balance that is not
      // actually there.
      const wantVaults = [...new Set(vaultsOf(data))]
      const wantMints = [...new Set((mintsOf ? mintsOf(data) : []).filter(Boolean))]

      const [vaultRes, mintRes] = await Promise.all([
        Promise.all(wantVaults.map((v) => getAccount(v).catch(() => null))),
        Promise.all(wantMints.map((m) => getAccount(m).catch(() => null))),
      ])

      const balances = {}
      wantVaults.forEach((v, i) => { balances[v] = vaultRes[i] ? readTokenAmount(vaultRes[i]) : 0n })

      const tickers = {}
      wantMints.forEach((m, i) => {
        try { tickers[m] = decodeMintAccount(mintRes[i]?.data?.base64).ticker || null }
        catch { tickers[m] = null }
      })

      setState({ loading: false, error: null, data, balances, tickers })
    } catch (err) {
      setState({ loading: false, error: String(err?.message ?? err), data: null, balances: {}, tickers: {} })
    }
  }, [registry])

  useEffect(() => { load() }, [load])
  return { ...state, reload: load }
}

/* ---------- faucet ---------- */

/**
 * tUSD is what every pool and every launch is priced in, so without a way to
 * get some the whole thing works for exactly one person: whoever holds the
 * mint authority.
 *
 * The faucet only mints. Creating the destination account needs a state proof,
 * which the CLI already does well and a browser does not, so the first command
 * below is the user's to run. Doing less server-side means the part that
 * matters cannot fail for a reason nobody can debug from here.
 */
function FaucetCard() {
  const [account, setAccount] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const claim = async () => {
    setBusy(true); setError(null); setResult(null)
    try {
      const r = await fetch('/api/faucet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: account.trim() }),
      })
      const j = await r.json()
      if (j.ok) setResult(j)
      else setError(j.error || 'That did not go through.')
    } catch {
      setError('Could not reach the faucet.')
    } finally {
      setBusy(false)
    }
  }

  const setupCommand =
    `thru token initialize-account ${TUSD_MINT} YOUR_ADDRESS \\\n` +
    `  0000000000000000000000000000000000000000000000000000000000000000 \\\n` +
    `  --fee-payer YOUR_KEY_NAME`

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="h2">Get tUSD</h2>
          <p className="sub">The test currency every pool and launch is priced in</p>
        </div>
      </div>

      <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
        You need a tUSD token account first. Run this once with your own CLI key, replacing
        <code className="mono"> YOUR_ADDRESS</code> with your public key and
        <code className="mono"> YOUR_KEY_NAME</code> with your key's name. It prints an address.
      </p>
      <CopyBlock text={setupCommand} label="Copy setup command" />

      <div className="stack" style={{ marginTop: 18 }}>
        <input
          className="field mono"
          value={account}
          onChange={(e) => { setAccount(e.target.value); setError(null); setResult(null) }}
          placeholder="Paste the token account address it printed"
        />
        <button className="btn" onClick={claim} disabled={busy || !account.trim()}>
          {busy ? 'Sending' : 'Send me 1,000 tUSD'}
        </button>
      </div>

      {error && <p className="notice bad" style={{ marginTop: 14 }}>{error}</p>}
      {result && (
        <div className="rows" style={{ marginTop: 14 }}>
          <div className="row"><span>Sent</span><b className="mono">{fmt(result.amount)} tUSD</b></div>
          <div className="row"><span>To</span><span className="mono">{short(result.account)}</span></div>
        </div>
      )}

      <p className="fine" style={{ marginTop: 14 }}>
        One claim per account every six hours. This is alphanet: tUSD is a test token with no value,
        and everything here disappears when the network resets from genesis.
      </p>
    </section>
  )
}

/* ---------- creating a launch ---------- */

function randomSeed() {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * Launching needs four transactions and the last one cannot be written until
 * the first three have run, because it refers to accounts they create. So this
 * is deliberately two phases rather than a single button that lies about it.
 */
function CreateLaunchCard({ nextId, registry, onClose }) {
  const [form, setForm] = useState({ name: '', symbol: '', supply: '1000000000', feePct: '1', virtQuote: '30' })
  const [seeds] = useState(() => ({ mint: randomSeed(), tokenVault: randomSeed(), quoteVault: randomSeed() }))
  const [made, setMade] = useState({ mint: '', tokenVault: '', quoteVault: '' })
  const [launchId, setLaunchId] = useState(String(nextId))

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const setMk = (k) => (e) => setMade((m) => ({ ...m, [k]: e.target.value.trim() }))

  const symbol = form.symbol.trim().toUpperCase().slice(0, 8)
  const feeBps = Math.round(Math.min(10, Math.max(0, Number(form.feePct) || 0)) * 100)

  const phaseOne = [
    `# 1. the token, with thrupad as its mint authority so the supply is fixed`,
    `thru token initialize-mint YOUR_ADDRESS ${symbol || 'TICKER'} ${seeds.mint} \\`,
    `  --decimals 6 --mint-authority ${PAD_PROGRAM} --fee-payer YOUR_KEY_NAME`,
    ``,
    `# 2. the curve's own token vault, owned by thrupad`,
    `thru token initialize-account THE_MINT_FROM_STEP_1 ${PAD_PROGRAM} ${seeds.tokenVault} \\`,
    `  --fee-payer YOUR_KEY_NAME`,
    ``,
    `# 3. the curve's tUSD vault, owned by thrupad`,
    `thru token initialize-account ${TUSD_MINT} ${PAD_PROGRAM} ${seeds.quoteVault} \\`,
    `  --fee-payer YOUR_KEY_NAME`,
  ].join('\n')

  const ready = made.mint && made.tokenVault && made.quoteVault && symbol && form.name.trim()

  const phaseTwo = useMemo(() => {
    if (!ready) return null
    try {
      const built = buildLaunchInstruction({
        registry,
        launchId: Number(launchId) || 0,
        mint: made.mint,
        tokenVault: made.tokenVault,
        quoteVault: made.quoteVault,
        feeBps,
        supply: toUnits(form.supply),
        virtQuote: toUnits(form.virtQuote),
        name: form.name,
        symbol,
      })
      return cliCommand(PAD_PROGRAM, built)
    } catch (err) {
      return `# ${String(err?.message ?? err)}`
    }
  }, [ready, registry, launchId, made, feeBps, form.supply, form.virtQuote, form.name, symbol])

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="h2">Launch a token</h2>
          <p className="sub">Four commands. The chain does the rest.</p>
        </div>
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>

      <>
          <div className="stack" style={{ marginTop: 16 }}>
            <div className="form-row">
              <label className="label">Name</label>
              <input className="field" value={form.name} onChange={set('name')} placeholder="Thru Cat" maxLength={32} />
            </div>
            <div className="form-row">
              <label className="label">Ticker</label>
              <input className="field mono" value={form.symbol} onChange={set('symbol')} placeholder="TCAT" maxLength={8} />
            </div>
            <div className="form-row">
              <label className="label">Supply</label>
              <input className="field mono" value={form.supply} onChange={set('supply')} inputMode="decimal" />
            </div>
            <div className="form-row">
              <label className="label">Your fee, percent</label>
              <input className="field mono" value={form.feePct} onChange={set('feePct')} inputMode="decimal" placeholder="1" />
            </div>
            <div className="form-row">
              <label className="label">Opening liquidity, tUSD</label>
              <input className="field mono" value={form.virtQuote} onChange={set('virtQuote')} inputMode="decimal" />
            </div>
            <div className="form-row">
              <label className="label">Slot</label>
              <input className="field mono" value={launchId} onChange={(e) => setLaunchId(e.target.value)} inputMode="numeric" />
            </div>
          </div>

          <p className="fine" style={{ marginTop: 16, lineHeight: 1.65 }}>
            Your fee is capped at 10% and is charged on every buy and sell, claimable at any time.
            Opening liquidity is virtual: it sets the starting price without you putting anything in,
            and a smaller number means a steeper curve.
          </p>

          <p className="eyebrow" style={{ marginTop: 20 }}>Step one, run these three</p>
          <CopyBlock text={phaseOne} label="Copy commands" />

          <p className="eyebrow" style={{ marginTop: 20 }}>Step two, paste what they printed</p>
          <div className="stack">
            <input className="field mono" value={made.mint} onChange={setMk('mint')} placeholder="mint address from step 1" />
            <input className="field mono" value={made.tokenVault} onChange={setMk('tokenVault')} placeholder="token account from step 2" />
            <input className="field mono" value={made.quoteVault} onChange={setMk('quoteVault')} placeholder="token account from step 3" />
          </div>

          {phaseTwo
            ? <CopyBlock text={phaseTwo} label="Copy the launch command" />
            : <p className="fine" style={{ marginTop: 12 }}>Fill in the three addresses and the launch command appears here.</p>}
      </>
    </section>
  )
}

/* ==========================================================================
   SWAP
   ========================================================================== */

function PoolCard({ pool, balances, tickers, program, registry }) {
  const [amount, setAmount] = useState('')
  const [flipped, setFlipped] = useState(false)

  const reserveA = balances[pool.vaultA] ?? 0n
  const reserveB = balances[pool.vaultB] ?? 0n

  // A pool record stores mint addresses, not names. The ticker comes from the
  // mint account itself, so it falls back to a short address when that read
  // has not landed yet rather than showing nothing.
  const symA = tickers?.[pool.mintA] || short(pool.mintA)
  const symB = tickers?.[pool.mintB] || short(pool.mintB)

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
          <h2 className="h2">{symA} / {symB}</h2>
          <p className="sub">Pool {pool.id} · {pool.feeBps / 100}% to liquidity providers</p>
        </div>
        <span className="hero-tag">{Number(pool.swapCount)} swap{Number(pool.swapCount) === 1 ? '' : 's'}</span>
      </div>

      <div className="hero" style={{ marginTop: 14 }}>
        <p className="hero-eyebrow">Reserves</p>
        <h2 className="hero-title" style={{ fontSize: 22 }}>
          {fmt(reserveA)} <span style={{ opacity: 0.55, fontSize: 15 }}>/</span> {fmt(reserveB)}
        </h2>
        <div className="hero-stats">
          <span className="hero-stat"><b>{price ? price.toFixed(4) : '0'}</b><span>{symB} per {symA}</span></span>
          <span className="hero-stat"><b>{fmt(pool.lpSupply)}</b><span>LP supply</span></span>
        </div>
      </div>

      <div className="rows" style={{ marginTop: 4 }}>
        <div className="row"><span>{symA}</span><span className="mono">{short(pool.mintA)}</span></div>
        <div className="row"><span>{symB}</span><span className="mono">{short(pool.mintB)}</span></div>
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
            {flipped ? `${symB} → ${symA}` : `${symA} → ${symB}`}
          </button>
        </div>

        {amountIn > 0n && (
          quote.amountOut > 0n ? (
            <div className="rows">
              <div className="row"><span>You receive</span><b className="mono">{fmt(quote.amountOut)} {flipped ? symA : symB}</b></div>
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
  const { loading, error, data, balances, tickers, reload } = useChainData(
    SWAP_REGISTRY,
    decodeSwapRegistry,
    (d) => d.pools.flatMap((p) => [p.vaultA, p.vaultB]),
    (d) => d.pools.flatMap((p) => [p.mintA, p.mintB]),
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
        <PoolCard key={p.id} pool={p} balances={balances} tickers={tickers}
                  program={SWAP_PROGRAM} registry={SWAP_REGISTRY} />
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
  const [creating, setCreating] = useState(false)
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
      {/* The action belongs beside the title, not buried below the list. Someone
          arriving to launch something should not have to scroll to find out
          they can. */}
      <div className="page-head">
        <div>
          <p className="eyebrow">Launch</p>
          <h1 className="h1">Launchpad</h1>
        </div>
        <button className="btn" onClick={() => setCreating((c) => !c)}>
          {creating ? 'Close' : 'Create a token'}
        </button>
      </div>
      <p className="lede">
        Every launch puts its whole supply on a bonding curve priced in tUSD. There is no second
        instruction that mints, so the supply is fixed by construction rather than by promise.
      </p>

      {creating && (
        <CreateLaunchCard
          nextId={data ? (data.launches.reduce((m, l) => Math.max(m, l.id), -1) + 1) : 0}
          registry={PAD_REGISTRY}
          onClose={() => setCreating(false)}
        />
      )}

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

/* ==========================================================================
   FAUCET
   ========================================================================== */

export function FaucetPage() {
  return (
    <div className="wrap">
      <p className="eyebrow">Get started</p>
      <h1 className="h1">Faucet</h1>
      <p className="lede">
        tUSD is the test currency every pool and every launch is priced in. It has no value and
        disappears whenever alphanet resets from genesis, which is the point: you can experiment
        with it without risking anything.
      </p>

      <FaucetCard />

      <section className="card">
        <h2 className="h2">What to do with it</h2>
        <div className="rows" style={{ marginTop: 12 }}>
          <div className="row"><span>Trade it</span><span className="fine">On the Swap page, against any pool</span></div>
          <div className="row"><span>Buy a launch</span><span className="fine">On the Launchpad, along a bonding curve</span></div>
          <div className="row"><span>Launch your own</span><span className="fine">Create a token and earn fees on every trade</span></div>
        </div>
      </section>
    </div>
  )
}
