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
import { Link, useParams } from 'react-router-dom'
import { getAccount } from '../lib/rpcClient.js'
import {
  decodeSwapRegistry, quoteSwap, buildSwapInstruction, toHex,
  buildAddLiquidityInstruction, buildRemoveLiquidityInstruction,
} from '../lib/swap.js'
import {
  decodePadRegistry, quoteBuy, quoteSell, snipeBps, graduationProgress,
  buildBuyInstruction, buildSellInstruction, buildLaunchInstruction,
} from '../lib/pad.js'

import { decodeMintAccount } from '../lib/token.js'
import { useWallet, sendBuilt, TopUpCard, AddressChip, AddToken } from './Wallet.jsx'
import { customMints, customMeta, onCustomMintsChange } from '../lib/customTokens.js'
import { displayDecimals } from '../lib/wthru.js'
import {
  deriveTokenAccount, openTokenAccount, hasWallet, createLaunchAccounts,
  burnToken, returnNativeThru, wrapThru, unwrapThru, waitForResult, tokenBalances,
} from '../lib/wallet.js'
import { useUnlockGate, isDismissal } from '../components/Unlock.jsx'
import { TokenIcon, TokenLinks } from '../components/TokenMeta.jsx'
import { cleanMeta, saveTokenMeta, allTokenMeta } from '../lib/tokenmeta.js'
import { squareImage, uploadImage, fileProblem, NoStoreError } from '../lib/imagefile.js'
import { signUserMessage } from '../lib/wallet.js'
import { Tabs } from '../components/Tabs.jsx'
import { TradeChart, sig4 } from '../components/TradeChart.jsx'
import { useConfirm } from '../components/Confirm.jsx'
import {
  THRUSWAP_PROGRAM as SWAP_PROGRAM,
  THRUSWAP_REGISTRY as SWAP_REGISTRY,
  THRUPAD_PROGRAM as PAD_PROGRAM,
  THRUPAD_REGISTRY as PAD_REGISTRY,
  TUSD_MINT,
  WTHRU_MINT,
} from '../lib/addresses.js'
import './launch.css'

const DECIMALS = 6
/** Stands in for native THRU in the swap pickers; it is not a mint. */
const THRU = 'THRU'
/** THRU kept back when selling THRU, for the fees of the trade itself. */
const THRU_KEEP = 5n

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
  if (code === 3) return 'An account this needs is not on chain yet. Try again in a moment.'
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
function Execute({ program, needs, buildWith, cli, label, spend, onDone }) {
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
      // The page that owns the numbers re-reads them. A trade that visibly
      // changes nothing looks like a trade that did not happen.
      onDone?.()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setStep(null)
    }
  }

  if (!hasWallet()) {
    return (
      <>
        <p className="fine" style={{ marginTop: 16, lineHeight: 1.65 }}><Link to="/wallet">Open a wallet</Link>, or run it from a terminal:</p>
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
      <p className="fine" style={{ marginTop: 8, lineHeight: 1.65 }}>Not configured yet.</p>
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
          decimals[m] = displayDecimals(m, d?.decimals ?? DECIMALS)
        } catch { tickers[m] = null; decimals[m] = displayDecimals(m, DECIMALS) }
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
/**
 * The terminal route, for people who have their own CLI key.
 *
 * This used to be the main event and it is now a footnote, correctly. It asked
 * you to run a command with YOUR_ADDRESS and YOUR_KEY_NAME in it, which meant
 * knowing your own public key, having a CLI wallet, and understanding what a
 * token account is, before you could receive a single test token. Several
 * people, reasonably, pasted the placeholders verbatim.
 *
 * The wallet above does all of that in one click. So this is collapsed by
 * default and exists only for someone who is deliberately working from a
 * terminal and already knows what those two values are.
 */
function TerminalFaucet() {
  const [account, setAccount] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const claim = async () => {
    setBusy(true); setError(null); setResult(null)
    try {
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

  // One line, no backslashes. PowerShell does not understand a bash line
  // continuation and silently swallows the rest of the command.
  const setupCommand =
    `thru token initialize-account ${TUSD_MINT} <your public key> `
    + `0000000000000000000000000000000000000000000000000000000000000000 `
    + `--fee-payer <your key name>`

  return (
    <section className="card">
      <details>
        <summary className="h2" style={{ cursor: 'pointer', listStyle: 'revert' }}>
          Using your own CLI key instead
        </summary>

        <p className="fine" style={{ marginTop: 12, lineHeight: 1.65 }}>Your public key is what <code className="mono">thru keys list</code> prints. Run this once, then paste the address it returns.</p>
        <CopyBlock text={setupCommand} label="Copy setup command" />

        <div className="stack" style={{ marginTop: 16 }}>
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
      </details>
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
/**
 * Launching a token, as one button.
 *
 * This used to print four commands with YOUR_ADDRESS and THE_MINT_FROM_STEP_1
 * in them, which is a fine thing to hand a developer and a terrible thing to
 * put in front of anyone else. Nobody should have to learn what a token vault
 * is to launch a token, and pasting a placeholder verbatim is not a user error,
 * it is a design error.
 *
 * What happens when the button is pressed:
 *
 *   ThruScan makes three accounts, because all three need creation state proofs
 *   and a browser cannot produce one. A mint whose authority is thrupad, a
 *   vault for the token and a vault for the quote asset.
 *
 *   You sign the launch. That is the transaction thrupad reads the creator from,
 *   so the fees accrue to you. ThruScan cannot sign it and would not want to.
 *
 * The commands are still there, under a fold, for anyone who prefers them.
 */
function CreateLaunchCard({ nextId, registry, threshold, onClose, onLaunched }) {
  const wallet = useWallet()
  const gate = useUnlockGate()
  const fileRef = useRef(null)

  const [form, setForm] = useState({ name: '', symbol: '', supply: '1000000000', feePct: '1', virtQuote: '30' })
  const [social, setSocial] = useState({ x: '', telegram: '', website: '' })
  const [image, setImage] = useState(null)        // { url, preview } once uploaded
  const [uploading, setUploading] = useState(false)
  const [over, setOver] = useState(false)
  const [quote, setQuote] = useState('tusd')
  const [step, setStep] = useState(null)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  const quoteMint = quote === 'wthru' ? WTHRU_MINT : TUSD_MINT
  const quoteTicker = quote === 'wthru' ? 'WTHRU' : 'tUSD'

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const setSoc = (k) => (e) => setSocial((s) => ({ ...s, [k]: e.target.value }))
  const symbol = form.symbol.trim().toUpperCase().slice(0, 8)
  const feeBps = Math.round(Math.min(10, Math.max(0, Number(form.feePct) || 0)) * 100)

  const problem = (() => {
    if (!form.name.trim()) return 'Give it a name.'
    if (!/^[A-Z0-9]{2,8}$/.test(symbol)) return 'A ticker is 2 to 8 letters or digits.'
    if (toUnits(form.supply) <= 0n) return 'Supply has to be more than zero.'
    if (toUnits(form.virtQuote) <= 0n) return 'Opening liquidity has to be more than zero.'
    return null
  })()

  const launch = async () => {
    setError(null); setDone(null)
    try { await gate.ensure() } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return
    }
    if (!wallet.registered) {
      setError('Your wallet needs an account on chain first. Open the Wallet page and register it.')
      return
    }

    try {
      setStep('accounts')
      const made = await createLaunchAccounts({ symbol, quoteMint, padProgram: PAD_PROGRAM })
      if (!made.ok) throw new Error(made.error)

      // The vaults land a slot or two after they are submitted, and launching
      // against a vault that is not there yet fails for a reason nobody could
      // guess from this form.
      await new Promise((r) => setTimeout(r, 3000))

      setStep('signing')
      const built = buildLaunchInstruction({
        registry,
        launchId: Number(nextId) || 0,
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
      const result = await sendBuilt(PAD_PROGRAM, built)
      if (result.settled && !result.succeeded) throw new Error(explainRevert(result))

      setDone({ signature: result.signature, mint: made.mint })
      onLaunched?.()

      // The picture and links are stored beside the chain and authorised by a
      // signature from the creator, so this can only run once the launch is in
      // the registry for the server to check against. If it does not take, the
      // token is still launched and the same fields are on the profile page,
      // which is what the note says rather than making it look like a failure.
      const meta = cleanMeta({ image: image?.url ?? '', ...social })
      if (meta.image || meta.x || meta.telegram || meta.website) {
        setStep('meta')
        try {
          await saveTokenMeta({ mint: made.mint, meta, address: wallet.address, sign: signUserMessage })
        } catch (e) {
          setError(`Launched, but the picture and links did not save: ${String(e?.message ?? e)}. You can add them from your profile.`)
        }
      }
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setStep(null)
    }
  }

  const takeFile = async (file) => {
    const problem = fileProblem(file)
    if (problem) { setError(problem); return }
    setError(null); setUploading(true)
    try {
      const shaped = await squareImage(file)
      try {
        const url = await uploadImage(shaped.blob, { kind: 'token' })
        setImage((old) => { if (old?.preview) URL.revokeObjectURL(old.preview); return { url, preview: null } })
      } finally { URL.revokeObjectURL(shaped.url) }
    } catch (e) {
      setError(e instanceof NoStoreError
        ? 'Pictures are not switched on for this site yet. Everything else still works.'
        : String(e?.message ?? e))
    } finally { setUploading(false) }
  }

  const manual = [
    `# Only if you would rather do it yourself. Replace YOUR_KEY_NAME with the`,
    `# name of your key as "thru keys list" shows it, and YOUR_ADDRESS with its`,
    `# public key. THE_MINT is what step 1 prints.`,
    ``,
    `thru token initialize-mint YOUR_ADDRESS ${symbol || 'TICKER'} <32-byte hex seed> --decimals 6 --mint-authority ${PAD_PROGRAM} --fee-payer YOUR_KEY_NAME`,
    `thru token initialize-account THE_MINT ${PAD_PROGRAM} <another seed> --fee-payer YOUR_KEY_NAME`,
    `thru token initialize-account ${quoteMint} ${PAD_PROGRAM} <another seed> --fee-payer YOUR_KEY_NAME`,
  ].join('\n')

  const preview = { image: image?.url ?? '' }

  return (
    <section className="card launch-make">
      {gate.modal}

      <div className="card-head">
        <div>
          <h2 className="h2">Launch a token</h2>
          <p className="sub">The whole supply goes onto a curve you cannot mint past.</p>
        </div>
        <button className="btn ghost sm" onClick={onClose}>Close</button>
      </div>

      <div className="launch-grid">
        <div className="launch-form">
          <div className="lf-pair">
            <label className="lf">
              <span>Name</span>
              <input className="field" value={form.name} onChange={set('name')} placeholder="Thru Cat" maxLength={32} />
            </label>
            <label className="lf">
              <span>Ticker</span>
              <input className="field mono" value={form.symbol} onChange={set('symbol')} placeholder="TCAT" maxLength={8} />
            </label>
          </div>

          {/* The picture sits with the name, because that is the part of the
              form that decides what the token looks like. Optional, and it says
              so, so nobody stalls here hunting for a logo. */}
          <div className="lf-picture">
            <div
              className={`tmeta-drop${over ? ' over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setOver(true) }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer?.files?.[0]; if (f) takeFile(f) }}
            >
              <TokenIcon meta={preview} symbol={symbol} mint={form.name} size={48} />
              <button
                type="button" className="tmeta-pencil" onClick={() => fileRef.current?.click()}
                disabled={uploading} aria-label="Add a picture" title="Add a picture"
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
            <p className="fine">
              {uploading ? 'Uploading…' : image ? 'Picture ready. Press the pencil to change it.' : 'Drop a picture here, or press the pencil. Optional.'}
            </p>
          </div>

          <div className="lf-pair">
            <label className="lf">
              <span>Supply</span>
              <input className="field mono" value={form.supply} onChange={set('supply')} inputMode="decimal" />
            </label>
            <label className="lf">
              <span>Your fee, percent</span>
              <input className="field mono" value={form.feePct} onChange={set('feePct')} inputMode="decimal" placeholder="1" />
            </label>
          </div>

          <div className="lf-pair">
            <div className="lf">
              <span>Priced in</span>
              <div className="seg">
                <button type="button" onClick={() => setQuote('tusd')} aria-pressed={quote === 'tusd'}>tUSD</button>
                <button type="button" onClick={() => setQuote('wthru')} aria-pressed={quote === 'wthru'}>WTHRU</button>
              </div>
            </div>
            <label className="lf">
              <span>Opening liquidity, {quoteTicker}</span>
              <input className="field mono" value={form.virtQuote} onChange={set('virtQuote')} inputMode="decimal" />
            </label>
          </div>

          {/* Three places people look for a token, none of them required. A
              launch with no links is a normal launch. */}
          <details className="lf-socials">
            <summary className="fine">Links, all optional</summary>
            <div className="lf-social-fields">
              <input className="field" value={social.x} onChange={setSoc('x')} placeholder="X handle" />
              <input className="field" value={social.telegram} onChange={setSoc('telegram')} placeholder="Telegram handle" />
              <input className="field" value={social.website} onChange={setSoc('website')} placeholder="Website" />
            </div>
          </details>

          {problem && <p className="fine lf-problem">{problem}</p>}
          {!hasWallet() && <p className="fine lf-problem"><Link to="/wallet">Open a wallet</Link> first.</p>}

          <button
            className="btn full"
            onClick={launch}
            disabled={!!problem || !hasWallet() || step !== null}
          >
            {step === 'accounts' ? 'Making the mint and vaults…'
              : step === 'signing' ? 'Sign the launch…'
              : step === 'meta' ? 'Saving the picture…'
              : symbol ? `Launch $${symbol}` : 'Launch'}
          </button>

          {error && <p className="notice bad" style={{ marginTop: 12 }}>{error}</p>}

          {done && (
            <div className="rows" style={{ marginTop: 14 }}>
              <div className="row"><span>Launched</span><b>${symbol}</b></div>
              <div className="row"><span>Mint</span><span className="mono">{short(done.mint)}</span></div>
              <div className="row">
                <span>Transaction</span>
                <Link className="mono" to={`/tx/${done.signature}`}>{short(done.signature)}</Link>
              </div>
            </div>
          )}
        </div>

        {/* What you are about to make, as it will look and as it will behave.
            Everything here is derived from the form, so there is nothing to
            keep in step by hand. */}
        <aside className="launch-preview">
          <div className="lp-head">
            <TokenIcon meta={preview} symbol={symbol} mint={form.name} size={52} />
            <div>
              <b>{form.name.trim() || 'Your token'}</b>
              <span className="mono">{symbol ? `$${symbol}` : 'ticker'}</span>
            </div>
          </div>
          <div className="lp-rows">
            <div><span>Priced in</span><b>{quoteTicker}</b></div>
            <div><span>Supply</span><b className="mono">{Number(form.supply || 0).toLocaleString('en-US')}</b></div>
            <div><span>Opening liquidity</span><b className="mono">{Number(form.virtQuote || 0).toLocaleString('en-US')} {quoteTicker}</b></div>
            <div><span>Your fee</span><b className="mono">{(feeBps / 100).toFixed(2)}%</b></div>
            {threshold ? <div><span>Graduates at</span><b className="mono">{fmt(threshold)} {quoteTicker}</b></div> : null}
            <div><span>Mint authority</span><b>Burned to the curve</b></div>
          </div>
          <p className="fine">
            Your fee, up to 10%, is taken on every trade and can be claimed at any time.
            The supply is minted once, onto the curve.
          </p>
        </aside>
      </div>

      <details style={{ marginTop: 14 }}>
        <summary className="fine">Do it from the terminal instead</summary>
        <p className="fine" style={{ marginTop: 8, lineHeight: 1.65 }}>Substitute your key name and the addresses each step prints.</p>
        <CopyBlock text={manual} label="Copy the setup commands" />
      </details>
    </section>
  )
}

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

function TokenPicker({ tokens, value, onChange, exclude, label, onAdded }) {
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
                <span className="fine mono">{t.native ? 'native coin' : short(t.mint)}</span>
              </span>
              <span className="mono fine">{fmt(t.balance, t.decimals)}</span>
            </button>
          ))}
          {tokens.filter((t) => t.mint !== exclude).length === 0 && (
            <p className="fine" style={{ padding: 10 }}>Nothing to pick yet.</p>
          )}
          <div className="picker-add">
            <AddToken compact known={tokens.map((t) => t.mint)}
              onAdded={(mint) => { onAdded?.(mint); onChange(mint); setOpen(false) }} />
          </div>
        </div>
      )}
    </div>
  )
}

function SwapPanel({ pools, balances, tickers, decimalsOf, reload }) {
  const wallet = useWallet()
  const gate = useUnlockGate()

  /* Ask for the balances of every mint on this page.
     The wallet store only holds balances something has asked it to fetch, and
     nothing was asking here, so a mint that had never been fetched read as
     undefined and was rendered as zero. That is how a wallet holding 76 TCAT
     came to display "Balance 0" after every hard refresh. */
  // Tokens added by address, which may have no pool yet but are still yours.
  const [custom, setCustom] = useState(() => customMints())
  useEffect(() => onCustomMintsChange(() => setCustom(customMints())), [])

  const mintKey = pools.flatMap((p) => [p.mintA, p.mintB]).concat(custom).join(',')
  useEffect(() => {
    if (!wallet.address) return
    wallet.refresh([...new Set([...pools.flatMap((p) => [p.mintA, p.mintB]), ...custom])])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mintKey, wallet.address])

  // Every mint that any pool touches, with whatever this wallet holds of it.
  const tokens = useMemo(() => {
    const seen = new Map()
    for (const mint of [...pools.flatMap((p) => [p.mintA, p.mintB]), ...custom]) {
      {
        if (seen.has(mint)) continue
        const row = wallet.balances?.[mint]
        seen.set(mint, {
          mint,
          ticker: tickers?.[mint] || wallet.tickers?.[mint] || customMeta()[mint]?.ticker || short(mint),
          decimals: tickers?.[mint] ? decimalsOf(mint) : (wallet.decimals?.[mint] ?? customMeta()[mint]?.decimals ?? decimalsOf(mint)),
          balance: row?.amount ?? 0n,
          // Zero and "not looked up yet" are different answers and the second
          // one must not be shown as the first.
          known: row !== undefined,
        })
      }
    }
    // THRU itself, the chain's coin. Pools hold WTHRU, its token form, so a
    // THRU trade wraps or unwraps on the way through.
    const thru = {
      mint: THRU, ticker: 'THRU', decimals: 0,
      balance: wallet.native ?? 0n, known: true, native: true,
    }
    return [thru, ...seen.values()]
  }, [pools, tickers, wallet.balances, wallet.tickers, wallet.native, custom])

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
    if (!tokens.every((t) => t.known)) return    // wait, rather than guess
    const held = tokens.find((t) => t.balance > 0n) ?? tokens[0]
    const other = tokens.find((t) => t.mint !== held.mint)
    setFromMint(held.mint)
    setToMint(other?.mint ?? null)
  }, [tokens, fromMint])

  const from = tokens.find((t) => t.mint === fromMint)
  const to = tokens.find((t) => t.mint === toMint)

  // THRU trades through the WTHRU pools; THRU <-> WTHRU is a plain wrap.
  const poolFrom = fromMint === THRU ? WTHRU_MINT : fromMint
  const poolTo = toMint === THRU ? WTHRU_MINT : toMint
  const wrapOnly = (fromMint === THRU && toMint === WTHRU_MINT) || (fromMint === WTHRU_MINT && toMint === THRU)

  const pool = useMemo(() => {
    if (!poolFrom || !poolTo || wrapOnly) return null
    return pools.find(
      (p) => (p.mintA === poolFrom && p.mintB === poolTo) || (p.mintB === poolFrom && p.mintA === poolTo),
    ) ?? null
  }, [pools, poolFrom, poolTo, wrapOnly])

  const flipped = pool ? pool.mintA !== poolFrom : false
  const vaultIn = pool ? (flipped ? pool.vaultB : pool.vaultA) : null
  const vaultOut = pool ? (flipped ? pool.vaultA : pool.vaultB) : null
  const reserveIn = pool ? (balances[vaultIn] ?? 0n) : 0n
  const reserveOut = pool ? (balances[vaultOut] ?? 0n) : 0n

  const amountIn = toUnits(amount, from?.decimals ?? DECIMALS)
  const quote = useMemo(
    () => (wrapOnly
      ? { amountOut: amountIn, priceImpactBps: 0n }
      : pool ? quoteSwap({ reserveIn, reserveOut, amountIn, feeBps: pool.feeBps }) : null),
    [pool, reserveIn, reserveOut, amountIn, wrapOnly],
  )

  const impactBps = quote?.priceImpactBps ?? 0n
  // Spending THRU has to leave a little for the fees of the trade itself.
  const spendable = from?.native ? (from.balance > THRU_KEEP ? from.balance - THRU_KEEP : 0n) : from?.balance ?? 0n
  const shortOfFunds = from && amountIn > spendable

  /* Everything that should stop a trade before it is sent, in the order a
     person would notice them. The chain reports every one of these as the same
     bare revert, so saying which it is has to happen here. */
  const blocker = (() => {
    if (!from || !to) return 'Pick two tokens.'
    if (wrapOnly) {
      if (amountIn <= 0n) return null
      if (shortOfFunds) return `You have ${fmt(spendable, from.decimals)} ${from.ticker} to use.`
      return null
    }
    if (!pool) return `There is no ${from.ticker} / ${to.ticker} pool yet.`
    if (reserveIn === 0n || reserveOut === 0n) return 'This pool has no liquidity yet.'
    if (amountIn <= 0n) return null
    if (shortOfFunds) {
      return spendable === 0n
        ? `You have no ${from.ticker}${from.native ? ' to spare after fees' : ''}. Get some first, then come back.`
        : `You have ${fmt(spendable, from.decimals)} ${from.ticker} to use.`
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

    const landed = async (sig, what) => {
      const r = await waitForResult(sig)
      if (r.settled && !r.succeeded) throw new Error(`${what} failed (error ${r.userError || r.vmError}).`)
      return sig
    }

    try {
      // THRU <-> WTHRU needs no pool: it is a wrap or an unwrap.
      if (wrapOnly) {
        setStep(fromMint === THRU ? 'wrapping' : 'unwrapping')
        const sig = fromMint === THRU ? await wrapThru(amountIn) : await unwrapThru(amountIn)
        await landed(sig, fromMint === THRU ? 'Wrapping' : 'Unwrapping')
        setDone(sig); setAmount('')
        await wallet.refresh([WTHRU_MINT])
        return
      }

      setStep('opening')
      const accounts = {}
      for (const [key, mint] of [['userIn', poolFrom], ['userOut', poolTo]]) {
        const known = wallet.balances[mint]
        if (known?.exists) { accounts[key] = known.account; continue }
        const made = await openTokenAccount(mint)
        accounts[key] = made.account ?? (await deriveTokenAccount(mint, wallet.address))
      }

      // Selling THRU: wrap it first, then trade the WTHRU.
      if (fromMint === THRU) {
        setStep('wrapping')
        await landed(await wrapThru(amountIn), 'Wrapping THRU')
      }

      // Buying THRU: note the WTHRU held now, so exactly what the trade brings
      // in is unwrapped afterwards and nothing already held is touched.
      const wthruBefore = toMint === THRU
        ? BigInt((await tokenBalances([WTHRU_MINT], wallet.address))[0]?.amount ?? 0)
        : 0n

      setStep('signing')
      const built = buildSwapInstruction({
        registry: SWAP_REGISTRY, poolId: pool.id, vaultIn, vaultOut,
        userIn: accounts.userIn, userOut: accounts.userOut,
        amountIn, minOut: 1n,
      })
      const result = await sendBuilt(SWAP_PROGRAM, built)

      if (result.settled && !result.succeeded) throw new Error(explainRevert(result))

      if (toMint === THRU) {
        setStep('unwrapping')
        let got = 0n
        for (let i = 0; i < 8 && got <= 0n; i++) {
          const now = BigInt((await tokenBalances([WTHRU_MINT], wallet.address))[0]?.amount ?? 0)
          got = now - wthruBefore
          if (got <= 0n) await new Promise((r) => setTimeout(r, 1000))
        }
        if (got > 0n) await landed(await unwrapThru(got), 'Unwrapping to THRU')
      }
      setDone(result.signature)
      setAmount('')
      await wallet.refresh(tokens.filter((t) => !t.native).map((t) => t.mint))
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
              Balance {from.known ? fmt(from.balance, from.decimals) : '—'}
              {from.balance > 0n && (
                <button
                  className="linkish"
                  onClick={() => setAmount(String(Number(spendable) / 10 ** from.decimals))}
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
          {to && <span className="fine">Balance {to.known ? fmt(to.balance, to.decimals) : '—'}</span>}
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
        <p className="notice bad" style={{ marginTop: 14 }}>Thin pool: this trade moves the price {(Number(impactBps) / 100).toFixed(0)}% and you'd get far less than fair value. Trade smaller.</p>
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
          : step === 'wrapping' ? 'Wrapping THRU…'
          : step === 'unwrapping' ? 'Unwrapping to THRU…'
          : step === 'signing' ? 'Signing…'
          : !hasWallet() ? 'Connect a wallet to swap'
          : from && to ? `Swap ${from.ticker} for ${to.ticker}`
          : 'Swap'}
      </button>

      {!hasWallet() && (
        <p className="fine" style={{ marginTop: 10 }}><Link to="/wallet">Open a wallet</Link> first.</p>
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
/**
 * A pool's price history. Priced in tUSD when tUSD is one side, since that is
 * the unit people think in; otherwise in the pool's second token.
 */
export function PoolChart({ pool, tickers, decimalsOf, title }) {
  const quoteIsA = pool.mintA === TUSD_MINT
  const quoteMint = quoteIsA ? pool.mintA : pool.mintB
  const tokenMint = quoteIsA ? pool.mintB : pool.mintA
  return (
    <TradeChart
      title={title ?? `${tickers?.[tokenMint] || short(tokenMint)} price`}
      quoteVault={quoteIsA ? pool.vaultA : pool.vaultB}
      tokenVault={quoteIsA ? pool.vaultB : pool.vaultA}
      quote={tickers?.[quoteMint] || short(quoteMint)}
      symbol={tickers?.[tokenMint] || short(tokenMint)}
      quoteDecimals={decimalsOf(quoteMint)}
      tokenDecimals={decimalsOf(tokenMint)}
    />
  )
}

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
        <b><Link className="plain-link" to={`/token/${pool.mintA}`}>{symA}</Link> / <Link className="plain-link" to={`/token/${pool.mintB}`}>{symB}</Link></b>{' '}
        <span className="fine">pool {pool.id} · {pool.feeBps / 100}% · {Number(pool.swapCount)} swaps</span>
      </span>
      <span className="mono fine">{fmt(a, dpA)} · {fmt(b, dpB)}</span>
    </div>
  )
}


/**
 * Adding and removing liquidity.
 *
 * This is the honest answer to a pool so thin that thirty tUSD moves it by
 * half. Rather than me quietly topping it up, anyone can, and anyone who does
 * gets the fees that trade through it.
 *
 * Two things the maths forces, both worth saying in the UI rather than
 * discovering through a revert:
 *
 *   Deposits go in at the pool's current ratio. Put in more of one side than
 *   the ratio wants and the excess is simply kept by the pool, which is a
 *   donation with extra steps. So the second amount is computed, not typed.
 *
 *   The first deposit into an empty pool sets the price, and the program burns
 *   the first 1000 LP tokens so the pool can never be fully drained and
 *   re-priced from nothing.
 */

/**
 * What you own, across every pool.
 *
 * An LP token is a claim on a share of whatever the pool holds right now, not a
 * receipt for what you put in, and those are different numbers the moment
 * anyone trades. So this shows the claim: your percentage, and what that
 * percentage is worth in both tokens at this instant. No profit figure, since
 * that needs deposit history this page does not have.
 */
function Positions({ pools, balances, tickers, decimalsOf }) {
  const wallet = useWallet()
  const tick = (m) => tickers?.[m] || short(m)

  const mine = pools
    .map((p) => {
      const lp = wallet.balances?.[p.lpMint]?.amount ?? 0n
      if (lp <= 0n || p.lpSupply <= 0n) return null
      const reserveA = balances[p.vaultA] ?? 0n
      const reserveB = balances[p.vaultB] ?? 0n
      return {
        pool: p,
        lp,
        shareA: (lp * reserveA) / p.lpSupply,
        shareB: (lp * reserveB) / p.lpSupply,
        pct: Number((lp * 1000000n) / p.lpSupply) / 10000,
      }
    })
    .filter(Boolean)

  if (!wallet.address) return null

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="h2">Your positions</h2>
          <p className="sub">
            {mine.length ? `${mine.length} pool${mine.length === 1 ? '' : 's'}` : 'Nothing deposited yet'}
          </p>
        </div>
        <button className="btn ghost" onClick={() => wallet.refresh(pools.flatMap((p) => [p.lpMint, p.mintA, p.mintB]))}>
          Refresh
        </button>
      </div>

      {mine.length === 0 ? (
        <p className="fine" style={{ marginTop: 12, lineHeight: 1.65 }}>Just deposited? It can take a few seconds. Press Refresh.</p>
      ) : (
        mine.map(({ pool, lp, shareA, shareB, pct }) => (
          <div className="position" key={pool.id}>
            <div className="position-head">
              <span className="position-pair">{tick(pool.mintA)} / {tick(pool.mintB)}</span>
              <span className="position-share">{pct.toFixed(4)}% of the pool</span>
            </div>
            <div className="rows">
              <div className="row">
                <span>Your share is worth</span>
                <b className="mono">
                  {fmt(shareA, decimalsOf(pool.mintA))} {tick(pool.mintA)}
                  {' · '}
                  {fmt(shareB, decimalsOf(pool.mintB))} {tick(pool.mintB)}
                </b>
              </div>
              <div className="row"><span>LP tokens held</span><span className="mono">{fmt(lp)}</span></div>
              <div className="row"><span>Earning</span><span className="mono">{pool.feeBps / 100}% of every trade</span></div>
            </div>
          </div>
        ))
      )}

      <p className="fine" style={{ marginTop: 14, lineHeight: 1.65 }}>Your share tracks what the pool holds now, not what you put in. Fees offset the difference.</p>
    </section>
  )
}


function LiquidityPanel({ pools, balances, tickers, decimalsOf, reload }) {
  const wallet = useWallet()
  const gate = useUnlockGate()

  const [poolId, setPoolId] = useState(null)
  const [side, setSide] = useState('add')
  const [amountA, setAmountA] = useState('')
  const [lpAmount, setLpAmount] = useState('')
  const [step, setStep] = useState(null)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  useEffect(() => { if (poolId == null && pools.length) setPoolId(pools[0].id) }, [pools, poolId])

  /* Why "Your share" always said none.
   *
   * The wallet store only holds balances for mints something has asked it to
   * fetch, and nothing ever asked for the LP mints. So the number was not
   * wrong, it was never looked up: you could deposit, watch both tokens leave
   * your wallet, and be told you owned nothing. Ask for them once, and again
   * whenever the set of pools changes. */
  const lpKey = pools.map((p) => p.lpMint).join(',')
  useEffect(() => {
    if (!pools.length || !wallet.address) return
    const mints = pools.flatMap((p) => [p.lpMint, p.mintA, p.mintB])
    wallet.refresh([...new Set(mints)])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lpKey, wallet.address])

  const pool = pools.find((p) => p.id === poolId) ?? null
  const tick = (m) => tickers?.[m] || short(m)
  const dp = (m) => decimalsOf(m)

  const reserveA = pool ? (balances[pool.vaultA] ?? 0n) : 0n
  const reserveB = pool ? (balances[pool.vaultB] ?? 0n) : 0n
  const heldA = pool ? (wallet.balances?.[pool.mintA]?.amount ?? 0n) : 0n
  const heldB = pool ? (wallet.balances?.[pool.mintB]?.amount ?? 0n) : 0n
  const heldLp = pool ? (wallet.balances?.[pool.lpMint]?.amount ?? 0n) : 0n

  const inA = pool ? toUnits(amountA, dp(pool.mintA)) : 0n

  /* The matching amount of the other side, at the pool's ratio. Rounded up, so
     a rounding error costs the depositor a unit rather than the pool. */
  const inB = useMemo(() => {
    if (!pool || inA <= 0n || reserveA === 0n) return 0n
    return (inA * reserveB + reserveA - 1n) / reserveA
  }, [pool, inA, reserveA, reserveB])

  const burnLp = pool ? toUnits(lpAmount, DECIMALS) : 0n
  const outA = pool && pool.lpSupply > 0n ? (burnLp * reserveA) / pool.lpSupply : 0n
  const outB = pool && pool.lpSupply > 0n ? (burnLp * reserveB) / pool.lpSupply : 0n

  const sharePct = pool && pool.lpSupply > 0n
    ? Number((heldLp * 10000n) / pool.lpSupply) / 100
    : 0

  const blocker = (() => {
    if (!pool) return 'No pools yet.'
    if (side === 'add') {
      if (reserveA === 0n || reserveB === 0n) {
        return 'This pool is empty. Seeding an empty pool sets its price, and that is not wired up here yet.'
      }
      if (inA <= 0n) return null
      if (inA > heldA) {
        return heldA === 0n
          ? `You have no ${tick(pool.mintA)}.`
          : `You only have ${fmt(heldA, dp(pool.mintA))} ${tick(pool.mintA)}.`
      }
      if (inB > heldB) {
        return heldB === 0n
          ? `That needs ${fmt(inB, dp(pool.mintB))} ${tick(pool.mintB)} to match, and you have none.`
          : `That needs ${fmt(inB, dp(pool.mintB))} ${tick(pool.mintB)} to match, and you have ${fmt(heldB, dp(pool.mintB))}.`
      }
      return null
    }
    if (burnLp <= 0n) return null
    if (burnLp > heldLp) {
      return heldLp === 0n
        ? 'You have no LP tokens in this pool.'
        : `You only have ${fmt(heldLp)} LP.`
    }
    return null
  })()

  const go = async () => {
    setError(null); setDone(null)
    try { await gate.ensure() } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return
    }

    try {
      setStep('opening')
      const need = [pool.mintA, pool.mintB, pool.lpMint]
      const accounts = {}
      for (const mint of need) {
        const known = wallet.balances[mint]
        if (known?.exists) { accounts[mint] = known.account; continue }
        const made = await openTokenAccount(mint)
        if (!made.already) await new Promise((r) => setTimeout(r, 2800))
        accounts[mint] = made.account ?? (await deriveTokenAccount(mint, wallet.address))
      }

      setStep('signing')
      const args = {
        registry: SWAP_REGISTRY, poolId: pool.id,
        vaultA: pool.vaultA, vaultB: pool.vaultB,
        userA: accounts[pool.mintA], userB: accounts[pool.mintB],
        lpMint: pool.lpMint, userLp: accounts[pool.lpMint],
      }
      const built = side === 'add'
        ? buildAddLiquidityInstruction({ ...args, amountA: inA, amountB: inB })
        : buildRemoveLiquidityInstruction({ ...args, lpAmount: burnLp })

      const result = await sendBuilt(SWAP_PROGRAM, built)
      if (result.settled && !result.succeeded) throw new Error(explainRevert(result))

      setDone(result.signature)
      setAmountA(''); setLpAmount('')
      await wallet.refresh(need)
      reload()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setStep(null)
    }
  }

  if (!pools.length) return null

  return (
    <section className="card">
      {gate.modal}

      <div className="card-head">
        <div>
          <h2 className="h2">Liquidity</h2>
          <p className="sub">Deposit both sides, earn a share of every trade</p>
        </div>
        <div className="inline">
          <button className="btn ghost" onClick={() => setSide('add')} aria-current={side === 'add'}>Add</button>
          <button className="btn ghost" onClick={() => setSide('remove')} aria-current={side === 'remove'}>Remove</button>
        </div>
      </div>

      <div className="form-row" style={{ marginTop: 14 }}>
        <label className="label">Pool</label>
        <div className="inline">
          {pools.map((p) => (
            <button
              key={p.id}
              className="btn ghost"
              onClick={() => { setPoolId(p.id); setAmountA(''); setLpAmount('') }}
              aria-current={p.id === poolId}
            >
              {tick(p.mintA)} / {tick(p.mintB)}
            </button>
          ))}
        </div>
      </div>

      {pool && (
        <>
          <div className="rows" style={{ marginTop: 14 }}>
            <div className="row">
              <span>Pool holds</span>
              <span className="mono">
                {fmt(reserveA, dp(pool.mintA))} {tick(pool.mintA)} · {fmt(reserveB, dp(pool.mintB))} {tick(pool.mintB)}
              </span>
            </div>
            <div className="row">
              <span>Your share</span>
              <span className="mono">
                {heldLp > 0n ? `${sharePct.toFixed(2)}% · ${fmt(heldLp)} LP` : 'none'}
              </span>
            </div>
            <div className="row"><span>Fee to providers</span><span className="mono">{pool.feeBps / 100}% of every trade</span></div>
          </div>

          {side === 'add' ? (
            <div className="stack" style={{ marginTop: 16 }}>
              <div className="swap-side">
                <div className="swap-side-head">
                  <span className="fine">{tick(pool.mintA)}</span>
                  <span className="fine">
                    Balance {fmt(heldA, dp(pool.mintA))}
                    {heldA > 0n && (
                      <button
                        className="linkish"
                        onClick={() => setAmountA(String(Number(heldA) / 10 ** dp(pool.mintA)))}
                      >MAX</button>
                    )}
                  </span>
                </div>
                <input
                  className="swap-amount mono"
                  value={amountA}
                  onChange={(e) => setAmountA(e.target.value)}
                  placeholder="0"
                  inputMode="decimal"
                />
              </div>

              <div className="swap-side">
                <div className="swap-side-head">
                  <span className="fine">{tick(pool.mintB)}, at the pool's ratio</span>
                  <span className="fine">Balance {fmt(heldB, dp(pool.mintB))}</span>
                </div>
                <span className="swap-amount mono" style={{ opacity: inB > 0n ? 1 : 0.4 }}>
                  {inB > 0n ? fmt(inB, dp(pool.mintB)) : '0'}
                </span>
              </div>
            </div>
          ) : (
            <div className="stack" style={{ marginTop: 16 }}>
              <div className="swap-side">
                <div className="swap-side-head">
                  <span className="fine">LP tokens to burn</span>
                  <span className="fine">
                    Holding {fmt(heldLp)}
                    {heldLp > 0n && (
                      <button className="linkish" onClick={() => setLpAmount(String(Number(heldLp) / 1e6))}>MAX</button>
                    )}
                  </span>
                </div>
                <input
                  className="swap-amount mono"
                  value={lpAmount}
                  onChange={(e) => setLpAmount(e.target.value)}
                  placeholder="0"
                  inputMode="decimal"
                />
              </div>
              {burnLp > 0n && (
                <div className="rows">
                  <div className="row">
                    <span>You get back</span>
                    <b className="mono">
                      {fmt(outA, dp(pool.mintA))} {tick(pool.mintA)} · {fmt(outB, dp(pool.mintB))} {tick(pool.mintB)}
                    </b>
                  </div>
                </div>
              )}
            </div>
          )}

          {blocker && <p className="notice bad" style={{ marginTop: 14 }}>{blocker}</p>}

          <button
            className="btn"
            style={{ width: '100%', marginTop: 14 }}
            onClick={go}
            disabled={!!blocker || step !== null || (side === 'add' ? inA <= 0n : burnLp <= 0n)}
          >
            {step === 'opening' ? 'Opening your token accounts…'
              : step === 'signing' ? 'Signing…'
              : !hasWallet() ? 'Connect a wallet first'
              : side === 'add' ? 'Add liquidity' : 'Remove liquidity'}
          </button>

          {error && <p className="notice bad" style={{ marginTop: 12 }}>{error}</p>}
          {done && (
            <p className="notice" style={{ marginTop: 12 }}>
              Done. <Link className="mono" to={`/tx/${done}`}>{short(done)}</Link>
            </p>
          )}

          <p className="fine" style={{ marginTop: 14, lineHeight: 1.65 }}>Deposits go in at the pool's ratio, so the second amount is worked out for you.</p>
        </>
      )}
    </section>
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
        <h1 className="h1">Swap</h1>
        <p className="lede">A constant product market maker, running on chain.</p>
        <NotLive what="thruswap" />
      </div>
    )
  }

  const pools = data?.pools ?? []
  const shared = { pools, balances, tickers, decimalsOf, reload }

  const swapTab = (
    <div className="wrap wrap-top">
      {error && <p className="notice bad">Could not read the pool registry. It may be mid-reset.</p>}
      {pools.length > 0
        ? <SwapPanel {...shared} />
        : !error && <EmptyPools loading={loading} />}
    </div>
  )

  const liquidityTab = (
    <div className="wrap wrap-top">
      {pools.length > 0 ? (
        <>
          <Positions pools={pools} balances={balances} tickers={tickers} decimalsOf={decimalsOf} />
          <LiquidityPanel {...shared} />
        </>
      ) : <EmptyPools loading={loading} />}
    </div>
  )

  const poolsTab = (
    <div className="wrap wrap-top">
      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="h2">Pools</h2>
            <p className="sub">{data ? `${pools.length} of ${data.capacity} slots in use` : 'reading the chain'}</p>
          </div>
          <button className="btn ghost" onClick={reload} disabled={loading}>{loading ? 'Reading' : 'Refresh'}</button>
        </div>
        {!error && data && pools.length === 0 && (
          <p className="fine" style={{ marginTop: 12 }}>No pools have been created yet.</p>
        )}
        <div className="rows" style={{ marginTop: 12 }}>
          {pools.map((p) => (
            <PoolRow key={p.id} pool={p} balances={balances} tickers={tickers} decimalsOf={decimalsOf} />
          ))}
        </div>
      </section>
      {pools.map((p) => <PoolChart key={p.id} pool={p} tickers={tickers} decimalsOf={decimalsOf} />)}
    </div>
  )

  return (
    <Tabs
      title="Swap"
      lede="Constant-product pools on Thru."
      tabs={[
        { key: 'swap', label: 'Swap', el: swapTab },
        { key: 'liquidity', label: 'Liquidity', el: liquidityTab },
        { key: 'pools', label: 'Pools', el: poolsTab, badge: pools.length || null },
      ]}
    />
  )
}

/**
 * Handing it back.
 *
 * A faucet is a shared tap and this is a test network, so someone sitting on
 * 9,000 tUSD they are finished with is holding it away from the next person.
 * Neither of these can be undone, so neither happens without a second click.
 *
 * The two work differently, and the card says so rather than pretending
 * otherwise. tUSD is burned, because ThruScan's sponsor is the mint authority:
 * the faucet does not own a pile it lends out, it creates tokens on demand and
 * the supply rises. Burning is the exact inverse and puts the supply back.
 * THRU is genuinely transferred, because Thru's faucet is an account with a
 * balance in it, and refilling that account is what lets the next person draw.
 *
 * Both are signed by this wallet. Nobody, including ThruScan, can push a return
 * on your behalf.
 */
export function ReturnCard() {
  const wallet = useWallet()
  const confirm = useConfirm()
  const gate = useUnlockGate()
  const [busy, setBusy] = useState(null)
  const [note, setNote] = useState(null)
  const [error, setError] = useState(null)

  const tusd = wallet.balances?.[TUSD_MINT]?.amount ?? 0n
  const thru = wallet.native ?? 0n

  // Fees come out of the native balance, so returning every last unit leaves
  // the wallet unable to pay for anything, including this transaction. Keep a
  // float back.
  const FLOAT = 500n
  const thruReturnable = thru > FLOAT ? thru - FLOAT : 0n

  const run = async (kind) => {
    setError(null); setNote(null)
    try { await gate.ensure() } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return
    }

    const ok = kind === 'tusd'
      ? await confirm.ask({
        title: 'Send your tUSD back?',
        body: 'This burns the whole balance, which is how tUSD returns to the faucet: '
          + 'the supply goes back down by exactly what you hand in. It cannot be undone, '
          + 'though you can claim again tomorrow.',
        detail: [{ label: 'Burning', value: `${fmt(tusd)} tUSD` }],
        confirmLabel: 'Burn it',
      })
      : await confirm.ask({
        title: 'Send your THRU back?',
        body: 'This transfers your THRU to Thru\'s own faucet account, where the next person can '
          + 'draw it. A small float stays behind so your wallet can still pay transaction fees. '
          + 'It cannot be undone, though the faucet will hand it back on request.',
        detail: [
          { label: 'Returning', value: `${thruReturnable.toString()} THRU` },
          { label: 'Kept for fees', value: `${(thru - thruReturnable).toString()} THRU` },
        ],
        confirmLabel: 'Send it back',
      })
    if (!ok) return

    setBusy(kind)
    try {
      if (kind === 'tusd') {
        await burnToken(TUSD_MINT, tusd)
        setNote(`${fmt(tusd)} tUSD returned. The supply is back where it was.`)
      } else {
        await returnNativeThru(thruReturnable)
        setNote(`${thruReturnable.toString()} THRU returned to the faucet.`)
      }
      await new Promise((r) => setTimeout(r, 2500))
      await wallet.refresh()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(null)
    }
  }

  if (!wallet.address) return null

  return (
    <section className="card">
      {gate.modal}
      {confirm.modal}

      <div className="card-head">
        <div>
          <h2 className="h2">Give it back</h2>
          <p className="sub">Done testing? Put it back in the tap</p>
        </div>
      </div>

      <div className="rows" style={{ marginTop: 12 }}>
        <div className="row">
          <span>
            <b>tUSD</b> <span className="fine">{fmt(tusd)} held, burned on return</span>
          </span>
          <button
            className="btn ghost danger"
            onClick={() => run('tusd')}
            disabled={busy !== null || tusd <= 0n}
          >
            {busy === 'tusd' ? 'Returning' : 'Return all'}
          </button>
        </div>
        <div className="row">
          <span>
            <b>THRU</b>{' '}
            <span className="fine">
              {thru.toString()} held, {thruReturnable.toString()} returnable
            </span>
          </span>
          <button
            className="btn ghost danger"
            onClick={() => run('thru')}
            disabled={busy !== null || thruReturnable <= 0n}
          >
            {busy === 'thru' ? 'Returning' : 'Return most'}
          </button>
        </div>
      </div>

      {note && <p className="notice" style={{ marginTop: 14 }}>{note}</p>}
      {error && <p className="notice bad" style={{ marginTop: 14 }}>{error}</p>}

    </section>
  )
}

function EmptyPools({ loading }) {
  return (
    <section className="card">
      <h2 className="h2">{loading ? 'Reading the chain' : 'No pools yet'}</h2>
      <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
        {loading
          ? 'Reading the chain.'
          : 'Nothing listed yet.'}
      </p>
    </section>
  )
}


/**
 * The bonding curve, drawn.
 *
 * Not a price history. Reconstructing one would mean replaying every trade this
 * launch has ever taken, and it would tell you less than this does, because a
 * constant product curve's whole future is already determined: price is
 * vq/vt, and every token sold moves both terms in a way the maths fixes in
 * advance. So the line is price against supply sold, and the dot is where this
 * launch is on it.
 *
 * What that buys you: the steepness ahead of the dot is exactly what your buy
 * will cost you in slippage, and it is visible rather than discovered.
 */
function CurveChart({ vq, vt, tokensSold, symbol, quote }) {
  const W = 560, H = 180, PAD = 4

  const { path, area, dot, priceNow, priceAtGrad } = useMemo(() => {
    const vq0 = Number(vq), vt0 = Number(vt)
    if (!(vq0 > 0) || !(vt0 > 0)) return {}

    // k is fixed, so price at any point is k / t^2 where t is the token
    // reserve. Walk t down from here and the curve draws itself.
    const k = vq0 * vt0
    const sold = Number(tokensSold)
    const total = vt0 + sold                     // the supply this curve started with
    const pts = []
    const N = 64
    for (let i = 0; i <= N; i++) {
      const soldAt = (total * 0.98) * (i / N)    // never quite to zero reserve
      const t = total - soldAt
      pts.push([soldAt / total, k / (t * t)])
    }

    const maxP = pts[pts.length - 1][1]
    const x = (u) => PAD + u * (W - PAD * 2)
    const y = (pr) => {
      // log scale: a constant product curve spans orders of magnitude and a
      // linear axis renders it as a flat line then a wall.
      const lo = Math.log(pts[0][1]), hi = Math.log(maxP)
      const f = hi > lo ? (Math.log(pr) - lo) / (hi - lo) : 0
      return H - PAD - f * (H - PAD * 2)
    }

    const path = pts.map(([u, pr], i) => `${i ? 'L' : 'M'}${x(u).toFixed(1)},${y(pr).toFixed(1)}`).join(' ')
    const area = `${path} L${x(1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`

    const u = total > 0 ? sold / total : 0
    const pNow = k / (vt0 * vt0)
    return {
      path, area,
      dot: [x(u), y(pNow)],
      priceNow: pNow,
      priceAtGrad: maxP,
    }
  }, [vq, vt, tokensSold])

  if (!path) return null

  return (
    <div className="curve-box">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
           aria-label={`Price of ${symbol} against supply sold`}>
        <defs>
          <linearGradient id="curvefill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ink, #16181d)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--ink, #16181d)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#curvefill)" />
        <path d={path} fill="none" stroke="var(--ink, #16181d)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <circle cx={dot[0]} cy={dot[1]} r="4.5" fill="var(--ink, #16181d)" />
        <circle cx={dot[0]} cy={dot[1]} r="9" fill="var(--ink, #16181d)" opacity="0.18" />
      </svg>
      <div className="curve-legend">
        <span>none sold</span>
        <span>now: {priceNow.toExponential(2)} {quote} per {symbol}</span>
        <span>whole supply</span>
      </div>
    </div>
  )
}


/** One launch in the list. A row that goes somewhere, not a page of its own
 *  stacked ten deep under nine others. */
function LaunchRow({ launch, balances, tickers, threshold, meta }) {
  const quote = tickers?.[launch.quoteMint] || short(launch.quoteMint)
  const quoteHeld = balances[launch.quoteVault] ?? 0n
  const raised = quoteHeld > launch.creatorFees ? quoteHeld - launch.creatorFees : 0n
  const progress = graduationProgress(raised, threshold)
  const price = Number(launch.vq) / Number(launch.vt || 1n)

  return (
    <Link className="launch-row" to={`/launch/${launch.id}`}>
      <TokenIcon meta={meta} symbol={launch.symbol} mint={launch.mint} size={38} />
      <div className="lr-main">
        <div className="lr-title">
          <span className="nm">{launch.name}</span>
          <span className="sy">${launch.symbol} · {quote}</span>
        </div>
        <div className="progress-track bar">
          <div className="progress-fill" style={{ width: `${Math.max(2, progress * 100)}%` }} />
        </div>
        <div className="fine lr-note">
          {fmt(raised)} of {fmt(threshold)} {quote} · {(progress * 100).toFixed(1)}% to graduation
        </div>
      </div>
      <div className="rt">
        <div className="mono">{price.toExponential(2)}</div>
        <div className="fine">{launch.graduated ? 'Graduated' : `${Number(launch.tradeCount)} trades`}</div>
      </div>
    </Link>
  )
}


/**
 * One launch, on its own page.
 *
 * The black banner is gone. It was a solid slab of ink with three numbers on
 * it, which made the least important part of the card the loudest, and it
 * repeated on every launch in the list so the page read as a stack of dark
 * bars. The numbers are the same; they are now in a strip that does not shout.
 */
export function LaunchDetail({ id }) {
  const launchId = Number(id)
  const [slot, setSlot] = useState(null)
  const [allMeta, setAllMeta] = useState({})
  const { loading, error, data, balances, tickers, decimals, reload } = useChainData(
    PAD_REGISTRY,
    decodePadRegistry,
    (d) => d.launches.flatMap((l) => [l.quoteVault, l.tokenVault]),
    (d) => d.launches.map((l) => l.quoteMint),
  )

  useEffect(() => {
    let alive = true
    const tick = () => {
      fetch('/api/rpc?action=height')
        .then((r) => r.json())
        .then((j) => { if (alive && j?.ok) setSlot(BigInt(j.height ?? j.blockHeight ?? 0)) })
        .catch(() => {})
    }
    tick()
    const id2 = setInterval(tick, 15000)
    return () => { alive = false; clearInterval(id2) }
  }, [])

  // Other people's trades move the curve too, so re-read it every few seconds
  // while the page is on screen.
  useEffect(() => {
    const id3 = setInterval(() => { if (!document.hidden) reload() }, 5000)
    return () => clearInterval(id3)
  }, [reload])

  useEffect(() => {
    let alive = true
    allTokenMeta().then((m) => { if (alive) setAllMeta(m) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const launch = data?.launches?.find((l) => l.id === launchId) ?? null
  const meta = launch ? allMeta[launch.mint] : null

  if (loading && !data) {
    return <div className="wrap wrap-top"><p className="fine">Reading the chain.</p></div>
  }
  if (error || !launch) {
    return (
      <div className="wrap wrap-top">
        <section className="card">
          <h2 className="h2">Not found</h2>
          <p className="fine" style={{ marginTop: 10 }}>No launch with that id.</p>
          <p style={{ marginTop: 12 }}><Link to="/launchpad">Back to the launchpad</Link></p>
        </section>
      </div>
    )
  }

  const quoteMint = launch.quoteMint
  const quote = tickers?.[quoteMint] || short(quoteMint)
  const quoteHeld = balances[launch.quoteVault] ?? 0n
  const raised = quoteHeld > launch.creatorFees ? quoteHeld - launch.creatorFees : 0n
  const threshold = data.gradThreshold
  const progress = graduationProgress(raised, threshold)
  const price = Number(launch.vq) / Number(launch.vt || 1n)
  const supply = launch.vt + launch.tokensSold

  return (
    <div className="wrap wrap-top">
      <p style={{ marginBottom: 12 }}><Link className="linkish" to="/launchpad">← All launches</Link></p>

      <section className="card">
        <div className="card-head">
          <div className="launch-id">
            <TokenIcon meta={meta} symbol={launch.symbol} mint={launch.mint} size={44} />
            <div style={{ minWidth: 0 }}>
              <h1 className="h1" style={{ fontSize: 26, margin: 0 }}>{launch.name}</h1>
              <p className="sub">${launch.symbol} · paired {quote} · {launch.feeBps / 100}% creator fee · <Link className="plain-link" to={`/token/${launch.mint}`}>token page</Link></p>
              <TokenLinks meta={meta} />
            </div>
          </div>
          <span className="hero-tag">{launch.graduated ? 'Graduated' : 'Live'}</span>
        </div>

        <div className="rows" style={{ marginTop: 14 }}>
          <div className="row"><span>Mint</span><AddressChip address={launch.mint} /></div>
          <div className="row"><span>Creator</span><AddressChip address={launch.creator} /></div>
          <div className="row"><span>Supply</span><b className="mono">{fmt(supply)} {launch.symbol}</b></div>
          <div className="row"><span>Unclaimed creator fees</span><span className="mono">{fmt(launch.creatorFees, decimals?.[quoteMint] ?? DECIMALS)} {quote}</span></div>
        </div>

      </section>

      <div className="stat-strip" style={{ marginTop: 16 }}>
        <div className="stat-cell">
          <span className="k">Price</span>
          <span className="v mono">{sig4(price)}</span>
        </div>
        <div className="stat-cell">
          <span className="k">Raised</span>
          <span className="v mono">{fmt(raised, decimals?.[quoteMint] ?? DECIMALS)} {quote}</span>
        </div>
        <div className="stat-cell">
          <span className="k">To graduation</span>
          <span className="v">{(progress * 100).toFixed(1)}%</span>
        </div>
        <div className="stat-cell">
          <span className="k">Trades</span>
          <span className="v">{Number(launch.tradeCount)}</span>
        </div>
      </div>

      <div className="launch-grid" style={{ marginTop: 16 }}>
        <TradePanel
          launch={launch}
          quote={quote}
          quoteMint={quoteMint}
          quoteDecimals={decimals?.[quoteMint] ?? DECIMALS}
          slot={slot}
          threshold={threshold}
          raised={raised}
          progress={progress}
          onTraded={reload}
        />

        <div className="stack">
          <TradeChart
            quoteVault={launch.quoteVault}
            tokenVault={launch.tokenVault}
            quote={quote}
            symbol={launch.symbol}
            quoteDecimals={decimals?.[quoteMint] ?? DECIMALS}
            tokenDecimals={DECIMALS}
          />
          <CurveChart
            vq={launch.vq}
            vt={launch.vt}
            tokensSold={launch.tokensSold}
            symbol={launch.symbol}
            quote={quote}
          />

        </div>
      </div>
    </div>
  )
}


/** What App.jsx mounts at /launch/:id. */
export function LaunchDetailPage() {
  const { id } = useParams()
  return <LaunchDetail id={id} />
}


/** Buy and sell, for one launch. */
function TradePanel({ launch, quote, quoteMint, quoteDecimals = DECIMALS, slot, threshold, raised, progress, onTraded }) {
  const [side, setSide] = useState('buy')
  const [amount, setAmount] = useState('')
  const wallet = useWallet()

  // What you hold of both sides, read from the chain, so Max has a number.
  useEffect(() => {
    if (wallet.address) wallet.refresh([quoteMint, launch.mint])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address, quoteMint, launch.mint])

  /* Emptied the moment a trade lands. Leaving the number sitting there after a
     successful buy is how someone buys twice: the button is still live, the
     figure is still in the box, and nothing on screen distinguishes "about to
     spend 50" from "just spent 50". */
  const traded = () => {
    setAmount(''); onTraded?.()
    wallet.refresh([quoteMint, launch.mint])
  }

  const tax = slot != null ? snipeBps(launch.startSlot, slot) : 0n
  // Buys spend the quote asset and sells spend the token, and the two need not
  // share decimals: WTHRU has 8, launch tokens 6.
  const inDecimals = side === 'buy' ? quoteDecimals : DECIMALS
  const outDecimals = side === 'buy' ? DECIMALS : quoteDecimals
  const amountIn = toUnits(amount, inDecimals)
  const spendMint = side === 'buy' ? quoteMint : launch.mint
  const held = wallet.balances?.[spendMint]
  const holding = held?.exists ? held.amount : (held ? 0n : null)

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
    try {
      const args = {
        registry: PAD_REGISTRY, launchId: launch.id,
        tokenVault: launch.tokenVault, quoteVault: launch.quoteVault,
        userToken: 'YOUR_TOKEN_ACCOUNT', userQuote: 'YOUR_QUOTE_ACCOUNT',
        amountIn, minOut: 1n,
      }
      return side === 'buy' ? buildBuyInstruction(args) : buildSellInstruction(args)
    } catch { return null }
  }, [side, launch, amountIn, out])

  return (
    <section className="card">
      <div style={{ marginBottom: 14 }}>
        <div className="row" style={{ borderBottom: 0, padding: 0, marginBottom: 8 }}>
          <span className="fine">Bonding curve</span>
          <span className="fine">{(progress * 100).toFixed(0)}% to graduation</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${Math.max(2, progress * 100)}%` }} />
        </div>
        <p className="fine" style={{ marginTop: 8, lineHeight: 1.6 }}>{fmt(raised, quoteDecimals)} of {fmt(threshold, quoteDecimals)} {quote} raised</p>
      </div>

      {launch.graduated ? (
        <p className="notice">Graduated. Trade it on the swap page.</p>
      ) : (
        <>
          <div className="inline" style={{ marginBottom: 12 }}>
            <button className="btn ghost" onClick={() => setSide('buy')} aria-current={side === 'buy'}>Buy</button>
            <button className="btn ghost" onClick={() => setSide('sell')} aria-current={side === 'sell'}>Sell</button>
          </div>

          <div className="swap-side">
            <div className="swap-side-head">
              <span className="fine">{side === 'buy' ? `Spend ${quote}` : `Sell ${launch.symbol}`}</span>
              {wallet.address && (
                <span className="fine">
                  Balance {holding === null ? '—' : fmt(holding, inDecimals)} {side === 'buy' ? quote : launch.symbol}
                  {holding > 0n && (
                    <button
                      className="linkish"
                      onClick={() => setAmount(String(Number(holding) / 10 ** inDecimals))}
                    >MAX</button>
                  )}
                </span>
              )}
            </div>
            <input
              className="swap-amount mono"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              inputMode="decimal"
            />
          </div>

          {amountIn > 0n && (
            out > 0n ? (
              <div className="rows" style={{ marginTop: 12 }}>
                <div className="row">
                  <span>You receive</span>
                  <b className="mono">{fmt(out, outDecimals)} {side === 'buy' ? launch.symbol : quote}</b>
                </div>
                <div className="row"><span>Creator fee</span><span className="mono">{fmt(q.creatorFee, quoteDecimals)} {quote}</span></div>
                {side === 'buy' && q.snipeTax > 0n && (
                  <div className="row"><span>Anti-snipe tax</span><span className="mono">{fmt(q.snipeTax, quoteDecimals)} {quote}</span></div>
                )}
              </div>
            ) : (
              <p className="notice bad" style={{ marginTop: 12 }}>Cannot quote: {q.reason}.</p>
            )
          )}

          {tax > 0n && (
            <p className="notice" style={{ marginTop: 12 }}>Anti-snipe tax {(Number(tax) / 100).toFixed(1)}%, falling to zero in seconds.</p>
          )}

          {built && (
            <div style={{ marginTop: 12 }}>
              <Execute
                program={PAD_PROGRAM}
                needs={{ userToken: launch.mint, userQuote: quoteMint }}
                spend={side === 'buy'
                  ? { mint: quoteMint, amount: amountIn, ticker: quote }
                  : { mint: launch.mint, amount: amountIn, ticker: launch.symbol }}
                buildWith={(a) => {
                  const args = {
                    registry: PAD_REGISTRY, launchId: launch.id,
                    tokenVault: launch.tokenVault, quoteVault: launch.quoteVault,
                    userToken: a.userToken, userQuote: a.userQuote,
                    amountIn, minOut: 1n,
                  }
                  return side === 'buy' ? buildBuyInstruction(args) : buildSellInstruction(args)
                }}
                cli={cliCommand(PAD_PROGRAM, built)}
                label={side === 'buy'
                  ? `Buy ${launch.symbol} with ${amount} ${quote}`
                  : `Sell ${amount} ${launch.symbol}`}
                onDone={traded}
              />
            </div>
          )}
        </>
      )}
    </section>
  )
}


export function LaunchpadPage() {
  const [slot, setSlot] = useState(null)
  const [creating, setCreating] = useState(false)
  const [meta, setMeta] = useState({})
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

  // Pictures and links for every launch in one request, refreshed slowly: they
  // change when a creator edits them, which is rare, and a list of rows should
  // not make a request per row.
  useEffect(() => {
    let alive = true
    const read = () => allTokenMeta().then((m) => { if (alive) setMeta(m) }).catch(() => {})
    read()
    const id = setInterval(() => { if (!document.hidden) read() }, 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  if (!PAD_PROGRAM || !PAD_REGISTRY) {
    return (
      <div className="wrap">
        <h1 className="h1">Launchpad</h1>
        <p className="lede">Put a token on a bonding curve and let the chain price it.</p>
        <NotLive what="thrupad" />
      </div>
    )
  }

  /* The title, the count and the two buttons on one line. This used to be a
     heading, a lede, then a whole card whose only content was a subtitle and a
     refresh button, which is three bands of chrome before the first launch. */
  return (
    <div className="wrap">
      <div className="page-head pad-head">
        <div>
          <h1 className="h1">Launchpad</h1>
          <p className="sub">
            {data
              ? `${data.launches.length} of ${data.capacity} slots · graduates at ${fmt(data.gradThreshold)} tUSD`
              : 'Fixed-supply tokens on a bonding curve'}
          </p>
        </div>
        <div className="inline">
          <button className="btn ghost sm" onClick={reload} disabled={loading}>{loading ? 'Reading' : 'Refresh'}</button>
          {/* Hidden while the form is open: the form has a Close of its own,
              and two buttons that both close it is one too many. */}
          {!creating && <button className="btn" onClick={() => setCreating(true)}>Create a token</button>}
        </div>
      </div>

      {creating && (
        <CreateLaunchCard
          nextId={data ? (data.launches.reduce((m, l) => Math.max(m, l.id), -1) + 1) : 0}
          registry={PAD_REGISTRY}
          threshold={data?.gradThreshold}
          onClose={() => setCreating(false)}
          onLaunched={reload}
        />
      )}

      {error && <p className="notice bad" style={{ marginTop: 12 }}>Could not read the launch registry. It may be mid-reset.</p>}
      {!error && data && data.launches.length === 0 && (
        <section className="card"><p className="fine">Nothing has launched yet.</p></section>
      )}

      {data?.launches.map((l) => (
        <LaunchRow
          key={l.id}
          launch={l}
          balances={balances}
          tickers={tickers}
          threshold={data.gradThreshold}
          meta={meta[l.mint]}
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

  const getTab = (
    <div className="wrap wrap-top">
      {wallet.unlocked && wallet.registered
        ? <TopUpCard />
        : (
          <section className="card">
            <h2 className="h2">Open a wallet first</h2>
            <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}><Link to="/wallet">Open a wallet</Link> and it claims both for you.</p>
          </section>
        )}

      <TerminalFaucet />

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

  const returnTab = (
    <div className="wrap wrap-top">
      {wallet.unlocked
        ? <ReturnCard />
        : (
          <section className="card">
            <h2 className="h2">Unlock first</h2>
            <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>Unlock your wallet to return funds.</p>
          </section>
        )}
    </div>
  )

  return (
    <Tabs
      title="Faucet"
      lede="Test tUSD to trade with, THRU for fees. Neither has value."
      tabs={[
        { key: 'get', label: 'Get funds', el: getTab },
        { key: 'return', label: 'Give it back', el: returnTab },
      ]}
    />
  )
}
