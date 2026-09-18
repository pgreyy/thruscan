// src/pages/Dex.jsx
//
// The Swap and Launchpad pages.
//
// Both trade, and both also print the command, because those are two audiences
// and neither should be made to use the other's tool.
//
// A trade moves real balances, so the tokens have to sit in somebody's account.
// The sponsored model the games use would mean everyone shared one pot, where
// one visitor could spend what another just bought, so that was never an
// option. What makes the buttons honest instead is the in-app wallet: a Thru
// transaction carries one signature, the fee payer's, so the only way to spend
// your tokens is to hold the key, and the key is in your browser.
//
// The quotes are not approximations. quoteSwap and quoteBuy reproduce the
// programs' arithmetic in BigInt, and the instruction builders were checked
// byte for byte against transactions that already executed on chain, so the
// number shown here is the number that lands, by either route.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { getAccount } from '../lib/rpcClient.js'
import {
  decodeSwapRegistry, quoteSwap, buildSwapInstruction, toHex,
} from '../lib/swap.js'
import {
  decodePadRegistry, quoteBuy, quoteSell, snipeBps, graduationProgress,
  buildBuyInstruction, buildSellInstruction, buildLaunchInstruction,
} from '../lib/pad.js'

import { decodeMintAccount } from '../lib/token.js'
import { useWallet, sendBuilt, TopUpCard } from './Wallet.jsx'
import { deriveTokenAccount, openTokenAccount, hasWallet } from '../lib/wallet.js'
import { useUnlockGate, isDismissal } from '../components/Unlock.jsx'
import {
  THRUSWAP_PROGRAM as SWAP_PROGRAM,
  THRUSWAP_REGISTRY as SWAP_REGISTRY,
  THRUPAD_PROGRAM as PAD_PROGRAM,
  THRUPAD_REGISTRY as PAD_REGISTRY,
  TUSD_MINT,
  WTHRU_MINT,
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

const fmtRaw = (units, decimals) => fmt(units, decimals ?? DECIMALS)

/**
 * What a revert probably meant.
 *
 * The chain reports a failed trade as VM_REVERT with whatever code the program
 * raised, and the token program's codes reach us through the caller, so the
 * useful ones are worth naming. "The chain rejected it (error -765)" is true
 * and tells nobody anything; almost every rejection in testing was spending a
 * token the wallet did not hold.
 */
function explainRevert(result) {
  const code = Number(result?.userError ?? 0)
  if (code === 4) return 'Not enough of that token in your account.'
  if (code === 20) return 'That account already exists.'
  if (code !== 0) return `The program rejected it (error ${code}).`
  return 'The chain rejected it. The usual cause is not holding enough of the token you are spending, '
    + 'or a pool too thin for a trade that size.'
}

/** The command to run, built from the same bytes the chain will receive. */
function cliCommand(program, built) {
  // No line continuations. A backslash is bash and a backtick is PowerShell,
  // and whichever one is chosen is wrong for half the people who paste it.
  const parts = [`thru txn execute ${program} ${toHex(built.data)}`]
  for (const a of built.readWrite) parts.push(`--readwrite-accounts ${a}`)
  for (const a of built.readOnly) parts.push(`--readonly-accounts ${a}`)
  parts.push('--fee-payer YOUR_KEY_NAME')
  parts.push('--state-units 60000 --memory-units 60000')
  return parts.join(' ')
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

/**
 * A quote becomes a button when there is a wallet, and stays a command when
 * there is not.
 *
 * Both paths send exactly the same bytes. The builders in swap.js and pad.js
 * sort the accounts and derive every index from the sorted order, so what the
 * button signs and what the command would have run are the same transaction,
 * and the number shown above it is the number that lands either way.
 *
 * `needs` maps a name the caller's builder expects to the mint whose token
 * account should fill it. Those accounts are derived rather than asked for, and
 * opened on the spot if they do not exist yet, because "you need a TCAT account
 * before you can be paid in TCAT" is a true but useless thing to tell someone
 * mid-trade.
 */
function Execute({ program, needs, buildWith, cli, label, spend }) {
  const wallet = useWallet()
  const gate = useUnlockGate()
  const [step, setStep] = useState(null)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  /* Refuse before sending rather than after. A trade paid for with a token the
     wallet does not hold comes back as a bare revert with no code, so the only
     place this can be explained is here. */
  const shortfall = (() => {
    if (!spend || !wallet.unlocked) return null
    const held = wallet.balances?.[spend.mint]?.amount ?? 0n
    if (spend.amount <= held) return null
    // The caller knows the ticker because it read the mint to draw the card.
    // The wallet store only knows mints it has fetched, which is why this said
    // "you have no tacdgT..._SNg" for a token the page was calling WTHRU.
    const ticker = spend.ticker || wallet.tickers?.[spend.mint] || short(spend.mint)
    return held === 0n
      ? `You have no ${ticker}. Get some first, then come back.`
      : `You only have ${fmtRaw(held, wallet.decimals?.[spend.mint])} ${ticker}.`
  })()

  const go = async () => {
    setError(null); setDone(null)
    try { await gate.ensure() } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return
    }
    try {
      const resolved = {}
      for (const [key, mint] of Object.entries(needs)) {
        const account = await deriveTokenAccount(mint, wallet.address)
        const known = wallet.balances[mint]
        if (!known?.exists) {
          setStep('opening')
          const made = await openTokenAccount(mint)
          // Opening lands a slot or two later, and trading into an account that
          // is not there yet fails for a reason nobody could guess from the UI.
          if (!made.already) await new Promise((r) => setTimeout(r, 2800))
          resolved[key] = made.account ?? account
        } else {
          resolved[key] = known.account ?? account
        }
      }

      setStep('signing')
      const built = buildWith(resolved)
      const result = await sendBuilt(program, built)

      if (result.settled && !result.succeeded) throw new Error(explainRevert(result))
      setDone(result.signature)
      await wallet.refresh(Object.values(needs))
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setStep(null)
    }
  }

  if (!hasWallet()) {
    return (
      <>
        <p className="fine" style={{ marginTop: 16, lineHeight: 1.65 }}>
          <Link to="/wallet">Open a wallet</Link> to do this in one click, or run it yourself: replace
          the placeholder accounts with your own and <code className="mono">YOUR_KEY_NAME</code>{' '}
          with your CLI key.
        </p>
        <CopyBlock text={cli} />
      </>
    )
  }

  return (
    <div style={{ marginTop: 16 }}>
      {gate.modal}
      {shortfall && <p className="notice bad" style={{ marginBottom: 12 }}>{shortfall}</p>}
      <button className="btn" onClick={go} disabled={step !== null || !!shortfall} style={{ width: '100%' }}>
        {step === 'opening' ? 'Opening your token account…'
          : step === 'signing' ? 'Signing…'
          : label}
      </button>
      {error && <p className="notice bad" style={{ marginTop: 12 }}>{error}</p>}
      {done && (
        <p className="notice" style={{ marginTop: 12 }}>
          Done. <Link className="mono" to={`/tx/${done}`}>{short(done)}</Link>
        </p>
      )}
      <details style={{ marginTop: 12 }}>
        <summary className="fine">Run it from the terminal instead</summary>
        <CopyBlock text={cli} />
      </details>
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
  const [state, setState] = useState({ loading: true, error: null, data: null, balances: {}, tickers: {}, decimals: {} })

  const load = useCallback(async () => {
    if (!registry) { setState({ loading: false, error: null, data: null, balances: {}, tickers: {}, decimals: {} }); return }
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

      // Decimals matter as much as the ticker: WTHRU is 8 and tUSD is 6, so a
      // balance formatted at the wrong scale is off by a hundred.
      const tickers = {}
      const decimals = {}
      wantMints.forEach((m, i) => {
        try {
          const d = decodeMintAccount(mintRes[i]?.data?.base64)
          tickers[m] = d?.ticker || null
          decimals[m] = d?.decimals ?? DECIMALS
        } catch { tickers[m] = null; decimals[m] = DECIMALS }
      })

      setState({ loading: false, error: null, data, balances, tickers, decimals })
    } catch (err) {
      setState({ loading: false, error: String(err?.message ?? err), data: null, balances: {}, tickers: {}, decimals: {} })
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
      // The faucet lives inside /api/wallet rather than having a function of
      // its own: Vercel's Hobby plan allows twelve, and a faucet is three lines
      // of difference from what that endpoint already does.
      const r = await fetch('/api/wallet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'faucet', account: account.trim() }),
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
          {busy ? 'Sending' : 'Send me 500 tUSD'}
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
        500 tUSD a day per account, capped at 10,000 held at once. This is alphanet: tUSD is a test
        token with no value, and everything here disappears when the network resets from genesis.
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
  // v2 of thrupad reads the quote asset off each launch rather than off the
  // registry, so a creator chooses what their curve is priced in. tUSD is the
  // deep side today; WTHRU is the one that will mean something at mainnet.
  const [quote, setQuote] = useState('tusd')
  const quoteMint = quote === 'wthru' ? WTHRU_MINT : TUSD_MINT
  const quoteTicker = quote === 'wthru' ? 'WTHRU' : 'tUSD'
  const [seeds] = useState(() => ({ mint: randomSeed(), tokenVault: randomSeed(), quoteVault: randomSeed() }))
  const [made, setMade] = useState({ mint: '', tokenVault: '', quoteVault: '' })
  const [launchId, setLaunchId] = useState(String(nextId))

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const setMk = (k) => (e) => setMade((m) => ({ ...m, [k]: e.target.value.trim() }))

  const symbol = form.symbol.trim().toUpperCase().slice(0, 8)
  const feeBps = Math.round(Math.min(10, Math.max(0, Number(form.feePct) || 0)) * 100)

  /* One line per command, with no continuations at all.
     These used to wrap with a trailing backslash, which is bash. PowerShell
     reads that backslash as an argument and the indented remainder as a new
     command, so all three failed with "unexpected argument" followed by a
     parser error. A long line pastes correctly into every shell there is. */
  const phaseOne = [
    `# 1. the token, with thrupad as its mint authority so the supply is fixed`,
    `thru token initialize-mint YOUR_ADDRESS ${symbol || 'TICKER'} ${seeds.mint} --decimals 6 --mint-authority ${PAD_PROGRAM} --fee-payer YOUR_KEY_NAME`,
    ``,
    `# 2. the curve's own token vault, owned by thrupad`,
    `thru token initialize-account THE_MINT_FROM_STEP_1 ${PAD_PROGRAM} ${seeds.tokenVault} --fee-payer YOUR_KEY_NAME`,
    ``,
    `# 3. the curve's ${quoteTicker} vault, owned by thrupad`,
    `thru token initialize-account ${quoteMint} ${PAD_PROGRAM} ${seeds.quoteVault} --fee-payer YOUR_KEY_NAME`,
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
        quoteMint,
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
  }, [ready, registry, launchId, made, feeBps, form.supply, form.virtQuote, form.name, symbol, quoteMint])

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
              <label className="label">Priced in</label>
              <div className="inline">
                <button
                  className="btn ghost"
                  onClick={() => setQuote('tusd')}
                  aria-current={quote === 'tusd'}
                >tUSD</button>
                <button
                  className="btn ghost"
                  onClick={() => setQuote('wthru')}
                  aria-current={quote === 'wthru'}
                >WTHRU</button>
              </div>
            </div>
            <div className="form-row">
              <label className="label">Opening liquidity, {quoteTicker}</label>
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

          <p className="fine" style={{ marginTop: 12, lineHeight: 1.65 }}>
            tUSD is where the liquidity is today, so a curve priced in it will find buyers.
            WTHRU is wrapped native THRU, which is what will actually be worth something once
            the network distributes it, and there is a WTHRU pool on the swap page already. Pick
            tUSD if you want people to trade this now.
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

/* ---------- the swap panel ----------
 *
 * A pair of token pickers rather than a card per pool, because nobody thinks in
 * pools. They think "I have this, I want that", and the pool is an
 * implementation detail the page should find for them.
 *
 * Three things this does that the old card did not:
 *
 *   It knows what you hold. The amount field carries your balance and a MAX,
 *   and the button refuses before it sends if you do not have the tokens. Every
 *   rejected trade in testing was this: buying with an asset the wallet held
 *   none of, which the chain reports as a bare revert with no useful code.
 *
 *   It says when a pool is too thin. These pools are small, and a trade that
 *   moves the price 96% is not a trade, it is a donation. That gets said before
 *   the button rather than after the failure.
 *
 *   It picks the pool. Either orientation, whichever holds both mints.
 */

function TokenPicker({ tokens, value, onChange, exclude, label }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const away = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const chosen = tokens.find((t) => t.mint === value)

  return (
    <div className="picker" ref={boxRef}>
      <button className="picker-trigger" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {chosen
          ? <><b>{chosen.ticker}</b><span className="picker-caret">›</span></>
          : <><span>{label}</span><span className="picker-caret">›</span></>}
      </button>

      {open && (
        <div className="picker-menu">
          {tokens.filter((t) => t.mint !== exclude).map((t) => (
            <button
              key={t.mint}
              className="picker-item"
              onClick={() => { onChange(t.mint); setOpen(false) }}
            >
              <span className="picker-item-name">
                <b>{t.ticker}</b>
                <span className="fine mono">{short(t.mint)}</span>
              </span>
              <span className="mono fine">{fmt(t.balance, t.decimals)}</span>
            </button>
          ))}
          {tokens.filter((t) => t.mint !== exclude).length === 0 && (
            <p className="fine" style={{ padding: 10 }}>Nothing to pick yet.</p>
          )}
        </div>
      )}
    </div>
  )
}

function SwapPanel({ pools, balances, tickers, decimalsOf, reload }) {
  const wallet = useWallet()
  const gate = useUnlockGate()

  // Every mint that any pool touches, with whatever this wallet holds of it.
  const tokens = useMemo(() => {
    const seen = new Map()
    for (const p of pools) {
      for (const mint of [p.mintA, p.mintB]) {
        if (seen.has(mint)) continue
        seen.set(mint, {
          mint,
          ticker: tickers?.[mint] || short(mint),
          decimals: decimalsOf(mint),
          balance: wallet.balances?.[mint]?.amount ?? 0n,
        })
      }
    }
    return [...seen.values()]
  }, [pools, tickers, wallet.balances])

  const [fromMint, setFromMint] = useState(null)
  const [toMint, setToMint] = useState(null)
  const [amount, setAmount] = useState('')
  const [step, setStep] = useState(null)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  // Open on the pair the wallet can actually trade, so the first thing you see
  // is something you could do rather than something you cannot.
  useEffect(() => {
    if (fromMint || tokens.length < 2) return
    const held = tokens.find((t) => t.balance > 0n) ?? tokens[0]
    const other = tokens.find((t) => t.mint !== held.mint)
    setFromMint(held.mint)
    setToMint(other?.mint ?? null)
  }, [tokens, fromMint])

  const from = tokens.find((t) => t.mint === fromMint)
  const to = tokens.find((t) => t.mint === toMint)

  const pool = useMemo(() => {
    if (!fromMint || !toMint) return null
    return pools.find(
      (p) => (p.mintA === fromMint && p.mintB === toMint) || (p.mintB === fromMint && p.mintA === toMint),
    ) ?? null
  }, [pools, fromMint, toMint])

  const flipped = pool ? pool.mintA !== fromMint : false
  const vaultIn = pool ? (flipped ? pool.vaultB : pool.vaultA) : null
  const vaultOut = pool ? (flipped ? pool.vaultA : pool.vaultB) : null
  const reserveIn = pool ? (balances[vaultIn] ?? 0n) : 0n
  const reserveOut = pool ? (balances[vaultOut] ?? 0n) : 0n

  const amountIn = toUnits(amount, from?.decimals ?? DECIMALS)
  const quote = useMemo(
    () => (pool ? quoteSwap({ reserveIn, reserveOut, amountIn, feeBps: pool.feeBps }) : null),
    [pool, reserveIn, reserveOut, amountIn],
  )

  const impactBps = quote?.priceImpactBps ?? 0n
  const shortOfFunds = from && amountIn > from.balance

  /* Everything that should stop a trade before it is sent, in the order a
     person would notice them. The chain reports every one of these as the same
     bare revert, so saying which it is has to happen here. */
  const blocker = (() => {
    if (!from || !to) return 'Pick two tokens.'
    if (!pool) return `There is no ${from.ticker} / ${to.ticker} pool yet.`
    if (reserveIn === 0n || reserveOut === 0n) return 'This pool has no liquidity yet.'
    if (amountIn <= 0n) return null
    if (shortOfFunds) {
      return from.balance === 0n
        ? `You have no ${from.ticker}. Get some first, then come back.`
        : `You only have ${fmt(from.balance, from.decimals)} ${from.ticker}.`
    }
    if (!quote || quote.amountOut <= 0n) {
      return quote?.reason ? `Cannot quote: ${quote.reason}.` : 'Cannot quote that.'
    }
    if (amountIn >= reserveIn) {
      return `That is more ${from.ticker} than the pool holds. Try a fraction of ${fmt(reserveIn, from.decimals)}.`
    }
    return null
  })()

  const thin = impactBps >= 1000n && !blocker      // 10% and up
  const veryThin = impactBps >= 5000n && !blocker  // half the pool

  const swap = async () => {
    setError(null); setDone(null)
    try {
      await gate.ensure()
    } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return
    }

    try {
      setStep('opening')
      const accounts = {}
      for (const [key, mint] of [['userIn', fromMint], ['userOut', toMint]]) {
        const known = wallet.balances[mint]
        if (known?.exists) { accounts[key] = known.account; continue }
        const made = await openTokenAccount(mint)
        if (!made.already) await new Promise((r) => setTimeout(r, 2800))
        accounts[key] = made.account ?? (await deriveTokenAccount(mint, wallet.address))
      }

      setStep('signing')
      const built = buildSwapInstruction({
        registry: SWAP_REGISTRY, poolId: pool.id, vaultIn, vaultOut,
        userIn: accounts.userIn, userOut: accounts.userOut,
        amountIn, minOut: 1n,
      })
      const result = await sendBuilt(SWAP_PROGRAM, built)

      if (result.settled && !result.succeeded) throw new Error(explainRevert(result))
      setDone(result.signature)
      setAmount('')
      await wallet.refresh(tokens.map((t) => t.mint))
      reload()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setStep(null)
    }
  }

  const flip = () => { setFromMint(toMint); setToMint(fromMint); setAmount('') }

  return (
    <section className="card swap-card">
      {gate.modal}

      <div className="swap-side">
        <div className="swap-side-head">
          <span className="fine">Sell</span>
          {from && (
            <span className="fine">
              Balance {fmt(from.balance, from.decimals)}
              {from.balance > 0n && (
                <button
                  className="linkish"
                  onClick={() => setAmount(String(Number(from.balance) / 10 ** from.decimals))}
                >MAX</button>
              )}
            </span>
          )}
        </div>
        <div className="swap-side-body">
          <input
            className="swap-amount mono"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            inputMode="decimal"
          />
          <TokenPicker tokens={tokens} value={fromMint} onChange={setFromMint} exclude={toMint} label="Select" />
        </div>
      </div>

      <div className="swap-flip">
        <button className="flip-btn" onClick={flip} title="Swap direction" aria-label="Swap direction">↓</button>
      </div>

      <div className="swap-side">
        <div className="swap-side-head">
          <span className="fine">Buy</span>
          {to && <span className="fine">Balance {fmt(to.balance, to.decimals)}</span>}
        </div>
        <div className="swap-side-body">
          <span className="swap-amount mono" style={{ opacity: quote?.amountOut ? 1 : 0.4 }}>
            {quote?.amountOut ? fmt(quote.amountOut, to?.decimals ?? DECIMALS) : '0'}
          </span>
          <TokenPicker tokens={tokens} value={toMint} onChange={setToMint} exclude={fromMint} label="Select" />
        </div>
      </div>

      {pool && amountIn > 0n && !blocker && (
        <div className="rows" style={{ marginTop: 14 }}>
          <div className="row"><span>Rate</span><span className="mono">
            1 {from.ticker} = {fmt((quote.amountOut * 10n ** BigInt(from.decimals)) / (amountIn || 1n), to.decimals)} {to.ticker}
          </span></div>
          <div className="row"><span>Price impact</span>
            <span className="mono" style={veryThin ? { fontWeight: 600 } : undefined}>
              {(Number(impactBps) / 100).toFixed(2)}%
            </span>
          </div>
          <div className="row"><span>Fee</span><span className="mono">
            {fmt((amountIn * BigInt(pool.feeBps)) / 10000n, from.decimals)} {from.ticker}
          </span></div>
          <div className="row"><span>Pool holds</span><span className="mono fine">
            {fmt(reserveIn, from.decimals)} {from.ticker} · {fmt(reserveOut, to.decimals)} {to.ticker}
          </span></div>
        </div>
      )}

      {veryThin && (
        <p className="notice bad" style={{ marginTop: 14 }}>
          This pool is very thin, and a trade this size would move the price by{' '}
          {(Number(impactBps) / 100).toFixed(0)}%. You would get back a small fraction of what the
          rate suggests. Try an amount closer to a hundredth of the pool.
        </p>
      )}
      {thin && !veryThin && (
        <p className="notice" style={{ marginTop: 14 }}>
          Thin pool: this moves the price {(Number(impactBps) / 100).toFixed(1)}%. Smaller trades get
          a better rate.
        </p>
      )}

      {blocker && <p className="notice bad" style={{ marginTop: 14 }}>{blocker}</p>}

      <button
        className="btn"
        style={{ width: '100%', marginTop: 14 }}
        onClick={swap}
        disabled={!!blocker || amountIn <= 0n || step !== null}
      >
        {step === 'opening' ? 'Opening your token account…'
          : step === 'signing' ? 'Signing…'
          : !hasWallet() ? 'Create a wallet to swap'
          : from && to ? `Swap ${from.ticker} for ${to.ticker}`
          : 'Swap'}
      </button>

      {!hasWallet() && (
        <p className="fine" style={{ marginTop: 10 }}>
          <Link to="/wallet">Open a wallet</Link> first. It takes about fifteen seconds and the key
          never leaves your browser.
        </p>
      )}

      {error && <p className="notice bad" style={{ marginTop: 12 }}>{error}</p>}
      {done && (
        <p className="notice" style={{ marginTop: 12 }}>
          Swapped. <Link className="mono" to={`/tx/${done}`}>{short(done)}</Link>
        </p>
      )}

      {pool && amountIn > 0n && !blocker && (
        <details style={{ marginTop: 14 }}>
          <summary className="fine">Run it from the terminal instead</summary>
          <CopyBlock text={cliCommand(SWAP_PROGRAM, buildSwapInstruction({
            registry: SWAP_REGISTRY, poolId: pool.id, vaultIn, vaultOut,
            userIn: 'YOUR_TOKEN_ACCOUNT_IN', userOut: 'YOUR_TOKEN_ACCOUNT_OUT',
            amountIn, minOut: 1n,
          }))} />
        </details>
      )}
    </section>
  )
}

/** A pool, read only. The trading happens in the panel above. */
function PoolRow({ pool, balances, tickers, decimalsOf }) {
  const symA = tickers?.[pool.mintA] || short(pool.mintA)
  const symB = tickers?.[pool.mintB] || short(pool.mintB)
  const dpA = decimalsOf(pool.mintA)
  const dpB = decimalsOf(pool.mintB)
  const a = balances[pool.vaultA] ?? 0n
  const b = balances[pool.vaultB] ?? 0n

  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <span>
        <b>{symA} / {symB}</b>{' '}
        <span className="fine">pool {pool.id} · {pool.feeBps / 100}% · {Number(pool.swapCount)} swaps</span>
      </span>
      <span className="mono fine">{fmt(a, dpA)} · {fmt(b, dpB)}</span>
    </div>
  )
}


export function SwapPage() {
  const { loading, error, data, balances, tickers, decimals, reload } = useChainData(
    SWAP_REGISTRY,
    decodeSwapRegistry,
    (d) => d.pools.flatMap((p) => [p.vaultA, p.vaultB]),
    (d) => d.pools.flatMap((p) => [p.mintA, p.mintB]),
  )
  const decimalsOf = useCallback((m) => decimals?.[m] ?? DECIMALS, [decimals])

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

      {error && <p className="notice bad">Could not read the pool registry. It may be mid-reset.</p>}

      {data?.pools?.length > 0 && (
        <SwapPanel
          pools={data.pools}
          balances={balances}
          tickers={tickers}
          decimalsOf={decimalsOf}
          reload={reload}
        />
      )}

      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="h2">Pools</h2>
            <p className="sub">{data ? `${data.pools.length} of ${data.capacity} slots in use` : 'reading the chain'}</p>
          </div>
          <button className="btn ghost" onClick={reload} disabled={loading}>{loading ? 'Reading' : 'Refresh'}</button>
        </div>
        {!error && data && data.pools.length === 0 && (
          <p className="fine" style={{ marginTop: 12 }}>No pools have been created yet.</p>
        )}
        <div className="rows" style={{ marginTop: 12 }}>
          {data?.pools.map((p) => (
            <PoolRow key={p.id} pool={p} balances={balances} tickers={tickers} decimalsOf={decimalsOf} />
          ))}
        </div>
      </section>
    </div>
  )
}

function LaunchCard({ launch, balances, tickers, threshold, program, registry, slot }) {
  // What this curve is priced in, according to the curve rather than to us.
  const quoteMint = launch.quoteMint
  const quote = tickers?.[quoteMint] || short(quoteMint)
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
        <h2 className="hero-title" style={{ fontSize: 24 }}>{fmt(raised)} <span style={{ fontSize: 15, opacity: 0.55 }}>{quote}</span></h2>
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
            placeholder={side === 'buy' ? `${quote} to spend` : `${launch.symbol} to sell`}
            inputMode="decimal"
          />
          {amountIn > 0n && (
            out > 0n ? (
              <div className="rows">
                <div className="row">
                  <span>You receive</span>
                  <b className="mono">{fmt(out)} {side === 'buy' ? launch.symbol : quote}</b>
                </div>
                <div className="row"><span>Creator fee</span><span className="mono">{fmt(q.creatorFee)} {quote}</span></div>
                {side === 'buy' && q.snipeTax > 0n && (
                  <div className="row"><span>Anti-snipe tax</span><span className="mono">{fmt(q.snipeTax)} {quote}</span></div>
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
        <div className="row"><span>Unclaimed fees</span><span className="mono">{fmt(launch.creatorFees)} {quote}</span></div>
      </div>

      {built && (
        <Execute
          program={program}
          needs={{ userToken: launch.mint, userQuote: quoteMint }}
          spend={side === 'buy'
            ? { mint: quoteMint, amount: amountIn, ticker: quote }
            : { mint: launch.mint, amount: amountIn, ticker: launch.symbol }}
          buildWith={(a) => {
            const args = {
              registry, launchId: launch.id,
              tokenVault: launch.tokenVault, quoteVault: launch.quoteVault,
              userToken: a.userToken, userQuote: a.userQuote,
              amountIn, minOut: 1n,
            }
            return side === 'buy' ? buildBuyInstruction(args) : buildSellInstruction(args)
          }}
          cli={cliCommand(program, built)}
          label={side === 'buy'
            ? `Buy ${launch.symbol} with ${amount} ${quote}`
            : `Sell ${amount} ${launch.symbol}`}
        />
      )}
    </section>
  )
}

export function LaunchpadPage() {
  const [slot, setSlot] = useState(null)
  const [creating, setCreating] = useState(false)
  const { loading, error, data, balances, tickers, reload } = useChainData(
    PAD_REGISTRY,
    decodePadRegistry,
    (d) => d.launches.flatMap((l) => [l.quoteVault, l.tokenVault]),
    // v2 lets each launch choose its quote asset, so the tickers have to be
    // read rather than assumed. A WTHRU curve labelled tUSD would be a lie
    // about what the buyer is spending.
    (d) => d.launches.map((l) => l.quoteMint),
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
        Every launch puts its whole supply on a bonding curve, priced in whichever asset its creator chose. There is no second
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
        <LaunchCard tickers={tickers}
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
  const wallet = useWallet()

  return (
    <div className="wrap">
      <p className="eyebrow">Get started</p>
      <h1 className="h1">Faucet</h1>
      <p className="lede">
        tUSD is the test currency every pool and every launch is priced in, and THRU is what pays
        transaction fees. Neither has any value, and both disappear whenever alphanet resets from
        genesis, which is the point: you can experiment without risking anything.
      </p>

      {wallet.unlocked && wallet.registered
        ? <TopUpCard />
        : (
          <section className="card">
            <h2 className="h2">The short way</h2>
            <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
              With a wallet this is two buttons and no addresses. <a href="/wallet">Open one</a>,
              which takes about fifteen seconds, and it claims both currencies for you and opens the
              token accounts they need. The longer way below still works if you would rather use
              your own key from the terminal.
            </p>
          </section>
        )}

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
