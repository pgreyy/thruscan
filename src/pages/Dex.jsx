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
import { createPortal } from 'react-dom'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { getAccount } from '../lib/rpcClient.js'
import {
  decodeSwapRegistry, quoteSwap, buildSwapInstruction, buildSwapPayingInThru, toHex,
  buildAddLiquidityInstruction, buildRemoveLiquidityInstruction,
} from '../lib/swap.js'
import {
  decodePadRegistry, quoteBuy, quoteSell, snipeBps, graduationProgress,
  buildBuyInstruction, buildSellInstruction, buildLaunchInstruction,
} from '../lib/pad.js'

import { decodeMintAccount } from '../lib/token.js'
import { useWallet, sendBuilt, TopUpCard, AddToken } from './Wallet.jsx'
import { customMints, customMeta, onCustomMintsChange } from '../lib/customTokens.js'
import { displayDecimals } from '../lib/wthru.js'
import {
  deriveTokenAccount, openTokenAccount, hasWallet, createLaunchAccounts,
  burnToken, returnNativeThru, wrapThru, unwrapThru, waitForResult, tokenBalances,
} from '../lib/wallet.js'
import { useUnlockGate, isDismissal } from '../components/Unlock.jsx'
import { TokenIcon } from '../components/TokenMeta.jsx'
import { cleanMeta, saveTokenMeta, allTokenMeta } from '../lib/tokenmeta.js'
import { squareImage, uploadImage, fileProblem, NoStoreError } from '../lib/imagefile.js'
import { signUserMessage } from '../lib/wallet.js'
import { TradeChart, useTrades } from '../components/TradeChart.jsx'
import { CopyId } from '../components/CopyId.jsx'
import { loadNames } from '../lib/feed.js'
import { relTime, fullUtc } from '../lib/when.js'
import { network } from '../lib/networks.js'
import { useConfirm } from '../components/Confirm.jsx'
import {
  THRUSWAP_PROGRAM as SWAP_PROGRAM,
  THRUSWAP_REGISTRY as SWAP_REGISTRY,
  THRUPAD_PROGRAM as PAD_PROGRAM,
  THRUPAD_REGISTRY as PAD_REGISTRY,
  TUSD_MINT,
  WTHRU_MINT,
} from '../lib/addresses.js'
import { useDismiss } from '../lib/dismiss.js'
import { connectWallet } from '../lib/connect.js'
import { Icon } from '../components/Icon.jsx'
import { TxDialog, useTxFlow, NETWORK_ROW } from '../components/TxDialog.jsx'
import { useTab } from '../lib/useTab.js'
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
/* Base units back to the text a person would type. The inverse of toUnits,
   and needed by the percentage buttons: a quarter of a balance is a number
   somebody has to be able to see in the box and edit. */
function fromUnits(units, decimals = DECIMALS) {
  const neg = units < 0n
  const v = neg ? -units : units
  const base = 10n ** BigInt(decimals)
  const whole = v / base
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

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

export function NotLive({ what }) {
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
export function useChainData(registry, decode, vaultsOf, mintsOf) {
  const [state, setState] = useState({ loading: true, error: null, data: null, balances: {}, tickers: {}, decimals: {} })

  /* `quiet` is a poll rather than a first load. It leaves the last good data
     on screen instead of flashing a loading state every few seconds, which is
     the whole difference between a page that keeps itself current and one that
     blinks at you. */
  const load = useCallback(async (quiet = false) => {
    if (!registry) { setState({ loading: false, error: null, data: null, balances: {}, tickers: {}, decimals: {} }); return }
    if (!quiet) setState((s) => ({ ...s, loading: true, error: null }))
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
      /* A failed poll keeps what is on screen. Prices that were right ten
         seconds ago beat an error where the page was. */
      if (quiet) return
      setState({ loading: false, error: String(err?.message ?? err), data: null, balances: {}, tickers: {}, decimals: {} })
    }
  }, [registry])

  useEffect(() => { load() }, [load])

  /* This is a trading page, so it keeps itself current instead of offering a
     Refresh button. Paused while the tab is hidden, because a background tab
     polling a chain is just someone else's bandwidth. */
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) load(true) }, 8000)
    const onShow = () => { if (!document.hidden) load(true) }
    document.addEventListener('visibilitychange', onShow)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onShow) }
  }, [load])

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
/**
 * Create a token (Core Screens 3h/3i).
 *
 * A full page in place of the ThruPad home while it is open. Three numbered
 * panels hold exactly the fields the launch instruction takes: name and
 * symbol; supply, the quote asset, the opening liquidity and your fee; and the
 * optional picture and links, which are stored beside the chain and can be
 * changed later with a signature. Graduation is the registry's own threshold,
 * read, not typed. The column on the right shows the token as it will appear,
 * what happens next and what it costs, and the button that says why it cannot
 * be pressed yet.
 */
export function CreateLaunchCard({ nextId, registry, threshold, registryDown, onClose, onLaunched }) {
  const wallet = useWallet()
  const gate = useUnlockGate()
  const flow = useTxFlow()
  const navigate = useNavigate()
  const fileRef = useRef(null)

  const [form, setForm] = useState({ name: '', symbol: '', supply: '1000000000', feePct: '1', virtQuote: '30' })
  const [social, setSocial] = useState({ x: '', telegram: '', website: '' })
  const [image, setImage] = useState(null)        // { url } once uploaded
  const [uploading, setUploading] = useState(false)
  const [over, setOver] = useState(false)
  const [error, setError] = useState(null)
  const [imageError, setImageError] = useState(null)
  const [metaNote, setMetaNote] = useState(null)
  const [touched, setTouched] = useState({})

  /* WTHRU, and only WTHRU. tUSD was the other choice and it does not exist any
     more: it was a token we minted, the network was reset, and it is not coming
     back. Leaving a dead option selectable meant every launch failed on its
     first transaction. */
  const quoteMint = WTHRU_MINT
  const quoteTicker = 'WTHRU'
  /* WTHRU is one base unit per native THRU, so its amounts are whole numbers.
     Formatting them with six decimal places turned 50,000 into 0.05. */
  const quoteDecimals = 0

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const setSoc = (k) => (e) => setSocial((s) => ({ ...s, [k]: e.target.value }))
  const touch = (k) => () => setTouched((t) => ({ ...t, [k]: true }))
  const symbol = form.symbol.trim().toUpperCase().slice(0, 8)
  const feeBps = Math.round(Math.min(10, Math.max(0, Number(form.feePct) || 0)) * 100)
  const name = form.name.trim()

  /* Each field's own problem, shown under it once it has been touched, and the
     first of them beside the button. */
  const fieldError = {
    name: !name ? 'Give it a name.' : null,
    symbol: !/^[A-Z0-9]{2,8}$/.test(symbol) ? 'Letters and numbers only (2–8)' : null,
    supply: toUnits(form.supply) <= 0n ? 'Supply has to be more than zero.' : null,
    virtQuote: toUnits(form.virtQuote, quoteDecimals) <= 0n ? 'Opening liquidity has to be more than zero.' : null,
    feePct: Number(form.feePct) > 10 || Number(form.feePct) < 0 || !/^\d*\.?\d*$/.test(form.feePct.trim()) ? 'Between 0 and 10 percent.' : null,
  }
  const reason = (() => {
    if (registryDown) return 'Paused until the registry can be read'
    if (fieldError.name) return 'Name the token to continue'
    if (fieldError.symbol) return 'Fix the symbol to continue'
    if (fieldError.supply) return 'Set a supply to continue'
    if (fieldError.virtQuote) return 'Set the opening liquidity to continue'
    if (fieldError.feePct) return 'Fix the fee to continue'
    return null
  })()
  const show = (k) => (touched[k] || form[k] !== '') && fieldError[k]

  const run = async (progress) => {
    progress('accounts')
    const made = await createLaunchAccounts({ symbol, quoteMint, padProgram: PAD_PROGRAM })
    if (!made.ok) throw new Error(made.error)
    // The vaults land a slot or two after they are submitted, and launching
    // against a vault that is not there yet fails for a reason nobody could
    // guess from this form.
    await new Promise((r) => setTimeout(r, 3000))

    progress('sign')
    const built = buildLaunchInstruction({
      registry,
      launchId: Number(nextId) || 0,
      mint: made.mint,
      tokenVault: made.tokenVault,
      quoteVault: made.quoteVault,
      quoteMint,
      feeBps,
      supply: toUnits(form.supply),
      /* In the QUOTE's units, not the token's: WTHRU has no decimals. */
      virtQuote: toUnits(form.virtQuote, quoteDecimals),
      name: form.name,
      symbol,
    })
    const result = await sendBuilt(PAD_PROGRAM, built, (sig) => progress('sent', sig))
    if (result.settled && !result.succeeded) return { ok: false, signature: result.signature, error: explainRevert(result) }
    onLaunched?.()

    // The picture and links are stored beside the chain and authorised by a
    // signature from the creator, so this can only run once the launch is in
    // the registry for the server to check against. If it does not take, the
    // token is still launched, and the same fields are on the token page.
    const meta = cleanMeta({ image: image?.url ?? '', ...social })
    if (meta.image || meta.x || meta.telegram || meta.website) {
      try {
        await saveTokenMeta({ mint: made.mint, meta, address: wallet.address, sign: signUserMessage })
      } catch (e) {
        setMetaNote(`The picture and links did not save: ${String(e?.message ?? e)}. You can add them from the token page.`)
      }
    }
    return { ok: true, signature: result.signature }
  }

  const review = async () => {
    setError(null)
    try { await gate.ensure() } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return
    }
    if (!wallet.registered) {
      setError('Your wallet needs an account on chain first. Open the Wallet page and register it.')
      return
    }
    flow.open()
  }

  const takeFile = async (file) => {
    const problem = fileProblem(file)
    if (problem) { setImageError(problem); return }
    setImageError(null); setUploading(true)
    try {
      const shaped = await squareImage(file)
      try {
        const url = await uploadImage(shaped.blob, { kind: 'token' })
        setImage({ url })
      } finally { URL.revokeObjectURL(shaped.url) }
    } catch (e) {
      setImageError(e instanceof NoStoreError
        ? 'Pictures are not switched on for this site yet. Everything else still works.'
        : String(e?.message ?? e))
    } finally { setUploading(false) }
  }

  const takePaste = (e) => {
    const file = [...(e.clipboardData?.files ?? [])][0]
    if (file) { e.preventDefault(); takeFile(file) }
  }

  const preview = { image: image?.url ?? '' }
  const gradText = threshold != null ? `${fmt(threshold, quoteDecimals, 0)} ${quoteTicker} raised` : 'set by the program'

  const cta = (() => {
    if (!hasWallet()) return { kind: 'connect', why: <>The launch is signed by you, so ThruScan needs a wallet to ask. Your form is kept. <Link to="/get-wallet">I don&rsquo;t have one yet</Link></> }
    if (!wallet.unlocked) return { kind: 'unlock', label: 'Unlock and continue', onClick: () => gate.ensure().catch(() => {}), why: 'Your browser wallet is locked. Enter its password to sign. Your form is kept.' }
    if (reason) return { kind: 'off', label: 'Review launch', why: null }
    return { kind: 'go', label: 'Review launch', onClick: review }
  })()

  return (
    <div className="cr">
      {gate.modal}
      <div className="cr-main">
        <div className="cr-intro">
          <button className="cr-crumb" onClick={onClose}>ThruPad /</button>
          <h1 className="cr-h1">Create a token</h1>
          <p className="cr-lead">Your token is sold from a bonding curve: the ThruPad program sells it at a price that rises as people buy, priced in WTHRU. You can&rsquo;t change name, symbol or supply after launch.</p>
        </div>

        <section className="cr-panel">
          <div className="cr-panel-head"><span className="cr-n done">1</span><h2>Name and symbol</h2></div>
          <div className="cr-panel-body cr-cols-name">
            <div className="cr-field">
              <label className="label" htmlFor="cr-name">Token name</label>
              <input id="cr-name" className={`field${show('name') ? ' bad' : ''}`} value={form.name} onChange={set('name')} onBlur={touch('name')} maxLength={32} aria-invalid={!!show('name')} />
              {show('name')
                ? <span className="helper bad"><Icon name="failed" size={14} stroke={2} />{fieldError.name}</span>
                : <span className="helper">Shown in lists. Up to 32 characters.</span>}
            </div>
            <div className="cr-field">
              <label className="label" htmlFor="cr-symbol">Symbol</label>
              <input id="cr-symbol" className={`field mono${show('symbol') ? ' bad' : ''}`} value={form.symbol} onChange={set('symbol')} onBlur={touch('symbol')} maxLength={8} aria-invalid={!!show('symbol')} />
              {show('symbol')
                ? <span className="helper bad"><Icon name="failed" size={14} stroke={2} />{fieldError.symbol}</span>
                : <span className="helper">Letters and numbers, 2–8.</span>}
            </div>
          </div>
        </section>

        <section className="cr-panel">
          <div className="cr-panel-head"><span className="cr-n done">2</span><h2>Supply and curve</h2></div>
          <div className="cr-panel-body">
            <div className="cr-cols">
              <div className="cr-field">
                <label className="label" htmlFor="cr-supply">Total supply</label>
                <span className={`field cr-suffixed${show('supply') ? ' bad' : ''}`}>
                  <input id="cr-supply" className="mono" value={form.supply} onChange={set('supply')} onBlur={touch('supply')} inputMode="decimal" />
                  <span className="mono">{symbol || 'tokens'}</span>
                </span>
                {show('supply') ? <span className="helper bad"><Icon name="failed" size={14} stroke={2} />{fieldError.supply}</span> : <span className="helper">Fixed forever. All of it starts on the curve.</span>}
              </div>
              <div className="cr-field">
                <span className="label">Priced in</span>
                <span className="field cr-fixed"><TokenIcon mint={WTHRU_MINT} size={22} />{quoteTicker}</span>
                <span className="helper">Buyers pay WTHRU; you get it on Swap.</span>
              </div>
              <div className="cr-field">
                <label className="label" htmlFor="cr-virt"><span className="term" title="The curve starts with this much virtual WTHRU in its reserve. It sets the opening price; more makes the price start higher and rise more gently.">Opening liquidity</span></label>
                <span className={`field cr-suffixed${show('virtQuote') ? ' bad' : ''}`}>
                  <input id="cr-virt" className="mono" value={form.virtQuote} onChange={set('virtQuote')} onBlur={touch('virtQuote')} inputMode="decimal" />
                  <span className="mono">{quoteTicker}</span>
                </span>
                {show('virtQuote') ? <span className="helper bad"><Icon name="failed" size={14} stroke={2} />{fieldError.virtQuote}</span> : <span className="helper">Virtual reserve the curve starts with. It sets the opening price.</span>}
              </div>
              <div className="cr-field">
                <label className="label" htmlFor="cr-fee"><span className="term" title="Taken from every buy and sell on your token's curve and paid to you. You can claim it at any time.">Your fee</span></label>
                <span className={`field cr-suffixed${show('feePct') ? ' bad' : ''}`}>
                  <input id="cr-fee" className="mono" value={form.feePct} onChange={set('feePct')} onBlur={touch('feePct')} inputMode="decimal" />
                  <span className="mono">%</span>
                </span>
                {show('feePct') ? <span className="helper bad"><Icon name="failed" size={14} stroke={2} />{fieldError.feePct}</span> : <span className="helper">On every trade, up to 10%. Claim it any time.</span>}
              </div>
              <div className="cr-field">
                <span className="label"><span className="term" title="When the WTHRU raised on the curve reaches this, the program moves the liquidity into a Swap pool.">Graduation</span></span>
                <span className="field cr-fixed mono">{gradText}</span>
                <span className="helper">When the curve fills, liquidity moves to a Swap pool.</span>
              </div>
            </div>
            <div className="cr-explain">
              <svg width="240" height="96" viewBox="0 0 240 96" aria-hidden="true" className="cr-explain-art">
                <path d="M0 92 C90 90 160 66 240 6 L240 96 L0 96Z" className="cr-art-fill" />
                <path d="M0 92 C90 90 160 66 240 6" fill="none" className="cr-art-line" strokeWidth="2" />
                <path d="M239 0V96" className="cr-art-grad" strokeDasharray="3 3" />
              </svg>
              <span>Price starts near zero and rises with every token bought. The dashed line is graduation. Sellers sell back to the same curve.</span>
            </div>
          </div>
        </section>

        <section className="cr-panel">
          <div className="cr-panel-head">
            <span className="cr-n">3</span><h2>Image and links</h2>
            <span className="cr-optional">optional, editable later with your signature</span>
          </div>
          <div className="cr-panel-body cr-cols-media">
            <div className="cr-drop-wrap">
              <button
                type="button"
                className={`cr-drop${over ? ' over' : ''}${image ? ' has' : ''}`}
                onClick={() => fileRef.current?.click()}
                onPaste={takePaste}
                onDragOver={(e) => { e.preventDefault(); setOver(true) }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer?.files?.[0]; if (f) takeFile(f) }}
                disabled={uploading}
                aria-label={image ? 'Change the picture' : 'Add a picture: drop, paste or choose a file'}
              >
                {image
                  ? <TokenIcon meta={preview} symbol={symbol} mint={form.name} size={118} />
                  : <span className="mono">{uploading ? 'uploading…' : <>drop image<br />or paste</>}</span>}
              </button>
              <input
                ref={fileRef} type="file" hidden
                accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) takeFile(f) }}
              />
              {imageError && <span className="helper bad">{imageError}</span>}
            </div>
            <div className="cr-links">
              <div className="cr-field">
                <label className="label" htmlFor="cr-web">Website</label>
                <input id="cr-web" className="field" value={social.website} onChange={setSoc('website')} placeholder="https://" />
              </div>
              <div className="cr-field">
                <label className="label" htmlFor="cr-x">X</label>
                <input id="cr-x" className="field" value={social.x} onChange={setSoc('x')} placeholder="@handle" />
              </div>
              <div className="cr-field">
                <label className="label" htmlFor="cr-tg">Telegram</label>
                <input id="cr-tg" className="field" value={social.telegram} onChange={setSoc('telegram')} placeholder="@handle" />
              </div>
            </div>
          </div>
        </section>
      </div>

      <aside className="cr-side">
        <section className="cr-summary">
          <span className="cr-k">Preview in ThruPad</span>
          <div className="cr-preview">
            <TokenIcon meta={preview} symbol={symbol} mint={form.name} size={36} />
            <span className="cr-preview-body">
              <span><b>{name || 'Your token'}</b> <span className="mono">{symbol || 'SYMBOL'}</span></span>
              <span className="progress thin"><span style={{ width: 0 }} /></span>
            </span>
            <span className="mono dim">0%</span>
          </div>

          <div className="cr-next">
            <span className="cr-k">What happens next</span>
            <span><i className="mono">1</i>ThruScan opens the launch accounts and pays for them</span>
            <span><i className="mono">2</i>You review and sign the launch in your wallet</span>
            <span><i className="mono">3</i>Your token page opens and trading starts</span>
          </div>

          <div className="cr-fees">
            <div><span>Account opening</span><span>Paid by ThruScan</span></div>
            <div><span>Launch fee</span><span className="mono">None</span></div>
            <div><span><span className="term" title="Your fee, taken on every buy and sell.">Creator fee</span> on trades</span><span className="mono">{(feeBps / 100).toFixed(2)}%</span></div>
          </div>

          <Cta state={cta} />
          {cta.kind === 'off' && reason && (
            <span className={`why${registryDown ? '' : ' bad'}`}>{!registryDown && <Icon name="failed" size={14} stroke={2} />}{reason}</span>
          )}
          {error && <p className="notice bad">{error}</p>}
          {metaNote && <p className="notice"><Icon name="warning" size={18} /><span>{metaNote}</span></p>}
        </section>
        <p className="cr-note">Test network. Your token will have no value and will disappear if {network.label.toLowerCase()} resets.</p>
      </aside>

      <TxDialog
        flow={flow}
        title={`Launch ${name || 'your token'} (${symbol})?`}
        rows={[
          { k: 'Supply', v: `${Number(form.supply || 0).toLocaleString('en-US')} ${symbol}` },
          { k: 'Priced in', v: quoteTicker },
          { k: 'Opening liquidity', v: `${Number(form.virtQuote || 0).toLocaleString('en-US')} ${quoteTicker}` },
          { k: 'Your fee', v: `${(feeBps / 100).toFixed(2)}%` },
          NETWORK_ROW,
        ]}
        technical={{ program: PAD_PROGRAM, extra: [{ k: 'Launch', v: `#${Number(nextId) || 0}` }] }}
        note="Name, symbol and supply can't be changed after this."
        signLabel="Sign launch"
        needsAccounts
        run={run}
        words={{
          accounts: 'Launch accounts opened',
          pendingTitle: 'Launch submitted',
          closeNote: 'Don’t close this tab until it lands.',
          landed: `${name} is live on ThruPad`,
          landedSub: metaNote ?? 'Open your token page to share the link, or buy the first tokens yourself.',
          failed: 'Launch failed',
          rejected: 'Nothing was launched. The accounts ThruScan opened are reused if you try again.',
        }}
        landedLinks={[{ to: `/launch/${Number(nextId) || 0}`, label: 'Open token page', strong: true }]}
        onDone={() => navigate(`/launch/${Number(nextId) || 0}`)}
      />
    </div>
  )
}
/* Nothing on this page offers to do the job from a terminal any more.
 *
 * Those panels were written for a testnet where the site could not always be
 * trusted to land a transaction and a command line was the honest fallback.
 * Nobody arriving to buy a token has a terminal open, and showing them one
 * says the buttons might not work. */

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

/* Who a token is, in the picker's second line. The system tokens are named by
   what they are; every other token was named by whoever created it. */
function tokenSubtitle(t) {
  if (t.native) return 'Thru’s own coin · native'
  if (t.mint === WTHRU_MINT) return 'Wrapped THRU · system'
  if (t.mint === TUSD_MINT) return 'Test USD · ThruScan faucet'
  return `Creator-named · ${short(t.mint)}`
}

/** The token selector (2j): a pill that opens a searchable menu. */
function TokenPicker({ tokens, value, onChange, exclude, label, onAdded, surface }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const boxRef = useRef(null)

  useDismiss(boxRef, open, useCallback(() => setOpen(false), []))

  const chosen = tokens.find((t) => t.mint === value)
  const needle = q.trim().toLowerCase()
  const shown = tokens
    .filter((t) => t.mint !== exclude)
    .filter((t) => !needle || t.ticker.toLowerCase().includes(needle) || t.mint.toLowerCase() === needle)

  return (
    <div className="picker" ref={boxRef}>
      <button className={`picker-trigger${surface ? ' on-sunken' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="listbox">
        {chosen
          ? <><TokenIcon symbol={chosen.ticker} mint={chosen.mint} size={26} /><b>{chosen.ticker}</b></>
          : <span>{label}</span>}
        <Icon name="expand" size={16} />
      </button>

      {open && (
        <>
          {/* Only drawn on a phone, where the menu is a sheet. */}
          <button className="picker-scrim" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} />
          <div className="picker-menu" role="listbox">
            <label className="picker-search">
              <Icon name="search" size={16} />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Symbol or mint address" aria-label="Symbol or mint address" spellCheck={false} />
            </label>
            {shown.map((t) => (
              <button
                key={t.mint}
                role="option"
                aria-selected={t.mint === value}
                className="picker-item"
                onClick={() => { onChange(t.mint); setOpen(false); setQ('') }}
              >
                <TokenIcon symbol={t.ticker} mint={t.mint} size={28} />
                <span className="picker-item-name">
                  <b>{t.ticker}</b>
                  <span>{tokenSubtitle(t)}</span>
                </span>
                <span className="mono">{t.known ? fmt(t.balance, t.decimals) : '—'}</span>
              </button>
            ))}
            {shown.length === 0 && (
              <p className="picker-none">{needle ? 'No token matches that.' : 'Nothing to pick yet.'}</p>
            )}
            <div className="picker-add">
              <AddToken compact known={tokens.map((t) => t.mint)}
                onAdded={(mint) => { onAdded?.(mint); onChange(mint); setOpen(false) }} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** The editable amount (2e): white, an ink edge, a 32px mono number. */
function AmountIn({ label, value, onChange, balance, onMax, children }) {
  return (
    <div className="amt amt-in">
      <div className="amt-top">
        <label className="amt-label">{label}</label>
        {balance !== undefined && (
          <span className="amt-bal mono">
            Balance {balance}
            {onMax && <> <button className="amt-max" onClick={onMax}>Max</button></>}
          </span>
        )}
      </div>
      <div className="amt-main">
        <input className="amt-num mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0" inputMode="decimal" aria-label={label} />
        {children}
      </div>
    </div>
  )
}

/** The calculated amount: sunken, no edge, prefixed with ≈ and labelled. */
function AmountOut({ label, value, balance, children }) {
  return (
    <div className="amt amt-out">
      <div className="amt-top">
        <span className="amt-label">{label}</span>
        {balance !== undefined && <span className="amt-bal mono">Balance {balance}</span>}
      </div>
      <div className="amt-main">
        <span className={`amt-num mono${value ? '' : ' amt-zero'}`}>{value ? `≈ ${value}` : '0'}</span>
        {children}
      </div>
    </div>
  )
}

/** The primary action with its reason. Disabled buttons always say why. */
function Cta({ state }) {
  return (
    <div className="cta">
      {state.kind === 'connect' && <button className="btn lg full" onClick={connectWallet}><Icon name="wallet" size={18} />Connect wallet</button>}
      {state.kind === 'unlock' && <button className="btn secondary lg full" onClick={state.onClick}><Icon name="locked" size={18} />{state.label}</button>}
      {state.kind === 'go' && <button className={`btn lg full${state.variant ? ` ${state.variant}` : ''}`} onClick={state.onClick}>{state.label}</button>}
      {state.kind === 'off' && <button className={`btn lg full${state.variant ? ` ${state.variant}` : ''}`} disabled>{state.label}</button>}
      {state.why && <p className="why">{state.why}</p>}
    </div>
  )
}

function SwapPanel({ pools, balances, tickers, decimalsOf, reload, registryDown, onPool }) {
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
    wallet.refresh([...new Set([WTHRU_MINT, ...pools.flatMap((p) => [p.mintA, p.mintB]), ...custom])])
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

    /* WTHRU, always, whether or not a pool mentions it.
     *
     * THRU to WTHRU is a wrap, not a trade: it goes straight to the WTHRU
     * program and needs no pool, no reserves and no registry read at all. It
     * is also the first thing most people want, because every pool and every
     * launch is priced in WTHRU.
     *
     * The list used to be built out of the pools alone, so when the registry
     * could not be read there was nothing to pick, and the one operation still
     * working was the one you could not reach. Its name and scale are written
     * here rather than read from the mint for the same reason: a wrap must not
     * depend on a read that can fail. */
    if (!seen.has(WTHRU_MINT)) {
      const row = wallet.balances?.[WTHRU_MINT]
      seen.set(WTHRU_MINT, {
        mint: WTHRU_MINT,
        ticker: 'WTHRU',
        decimals: displayDecimals(WTHRU_MINT),
        balance: row?.amount ?? 0n,
        /* With no wallet there is nothing to look up, so zero is the answer
           rather than a pending one. THRU reads the same way, and the two
           sitting side by side as "0" and "—" looked like one of them had
           failed. */
        known: !wallet.address || row !== undefined,
      })
    }

    return [thru, ...seen.values()]
  }, [pools, tickers, wallet.balances, wallet.tickers, wallet.native, wallet.address, custom])

  const [fromMint, setFromMint] = useState(null)
  const [toMint, setToMint] = useState(null)
  const [amount, setAmount] = useState('')
  const [error, setError] = useState(null)

  /* Open on the pair the wallet can actually trade, so the first thing you see
     is something you could do rather than something you cannot. Balances decide
     which pair that is. They must not decide whether the page works at all.

     Waiting for every balance to be known was unbounded: with no wallet they
     are never known, and with a wallet whose reads are failing they are never
     known either, so both pickers sat on "Select" for ever and the page read
     as hung. The wait now has an end. After it, open on whatever is sensible
     with what is known, which with no pools is THRU to WTHRU: the one trade
     that needs nothing read. */
  const [waited, setWaited] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 2500)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (fromMint || tokens.length < 2) return
    if (wallet.address && !waited && !tokens.every((t) => t.known)) return
    const held = tokens.find((t) => t.balance > 0n) ?? tokens[0]
    const other = tokens.find((t) => t.mint !== held.mint)
    setFromMint(held.mint)
    setToMint(other?.mint ?? null)
  }, [tokens, fromMint, wallet.address, waited])

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

  const flow = useTxFlow()
  const needsOpen = !wrapOnly && !!pool && [poolFrom, poolTo].some((m) => !wallet.balances?.[m]?.exists)

  /* The whole trade, step by step, for the review dialog. */
  const run = async (progress) => {
    const landed = async (sig, what) => {
      const r = await waitForResult(sig)
      if (r.settled && !r.succeeded) return { ok: false, signature: sig, error: `${what} failed (error ${r.userError || r.vmError})` }
      return null
    }

    // THRU <-> WTHRU needs no pool: it is a wrap or an unwrap.
    if (wrapOnly) {
      progress('sign')
      const sig = fromMint === THRU ? await wrapThru(amountIn) : await unwrapThru(amountIn)
      progress('sent', sig)
      const bad = await landed(sig, fromMint === THRU ? 'Wrapping' : 'Unwrapping')
      if (bad) return bad
      setAmount('')
      await wallet.refresh([WTHRU_MINT])
      return { ok: true, signature: sig }
    }

    if (needsOpen) progress('accounts')
    const accounts = {}
    for (const [key, mint] of [['userIn', poolFrom], ['userOut', poolTo]]) {
      const known = wallet.balances[mint]
      if (known?.exists) { accounts[key] = known.account; continue }
      const made = await openTokenAccount(mint)
      accounts[key] = made.account ?? (await deriveTokenAccount(mint, wallet.address))
    }

    // Buying THRU: note the WTHRU held now, so exactly what the trade brings
    // in is unwrapped afterwards and nothing already held is touched.
    const wthruBefore = toMint === THRU
      ? BigInt((await tokenBalances([WTHRU_MINT], wallet.address))[0]?.amount ?? 0)
      : 0n

    progress('sign')
    const sent = (sig) => progress('sent', sig)
    // Selling THRU wraps it on the way through, in the same transaction, so
    // it is one approval rather than two. Buying THRU cannot do the same in
    // reverse: see buildSwapPayingInThru for why.
    const result = fromMint === THRU
      ? await sendBuilt(null, buildSwapPayingInThru({
        payer: wallet.address, program: SWAP_PROGRAM,
        registry: SWAP_REGISTRY, poolId: pool.id, vaultIn, vaultOut,
        userIn: accounts.userIn, userOut: accounts.userOut,
        amountIn, minOut: 1n, wrap: amountIn,
      }), sent)
      : await sendBuilt(SWAP_PROGRAM, buildSwapInstruction({
        registry: SWAP_REGISTRY, poolId: pool.id, vaultIn, vaultOut,
        userIn: accounts.userIn, userOut: accounts.userOut,
        amountIn, minOut: 1n,
      }), sent)

    if (result.settled && !result.succeeded) return { ok: false, signature: result.signature, error: explainRevert(result) }

    if (toMint === THRU) {
      let got = 0n
      for (let i = 0; i < 8 && got <= 0n; i++) {
        const now = BigInt((await tokenBalances([WTHRU_MINT], wallet.address))[0]?.amount ?? 0)
        got = now - wthruBefore
        if (got <= 0n) await new Promise((r) => setTimeout(r, 1000))
      }
      if (got > 0n) {
        const bad = await landed(await unwrapThru(got), 'Unwrapping to THRU')
        if (bad) return bad
      }
    }
    setAmount('')
    await wallet.refresh(tokens.filter((t) => !t.native).map((t) => t.mint))
    reload()
    return { ok: true, signature: result.signature }
  }

  const review = async () => {
    setError(null)
    try { await gate.ensure() } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return
    }
    flow.open()
  }

  const flip = () => { setFromMint(toMint); setToMint(fromMint); setAmount('') }

  /* The rate at the pool's current reserves, before any amount is typed. */
  const rate = (() => {
    if (!from || !to) return '–'
    if (wrapOnly) return `1 ${from.ticker} = 1 ${to.ticker}`
    if (!pool || reserveIn === 0n || reserveOut === 0n) return '–'
    if (amountIn > 0n && quote?.amountOut > 0n) {
      return `1 ${from.ticker} = ${fmt((quote.amountOut * 10n ** BigInt(from.decimals)) / amountIn, to.decimals)} ${to.ticker}`
    }
    return `1 ${from.ticker} = ${fmt((reserveOut * 10n ** BigInt(from.decimals)) / reserveIn, to.decimals)} ${to.ticker}`
  })()
  const feeText = pool ? `${(pool.feeBps / 100).toFixed(2)}%` : null
  const feeAmount = pool && amountIn > 0n ? `${fmt((amountIn * BigInt(pool.feeBps)) / 10000n, from.decimals)} ${from.ticker}` : '–'
  const outText = quote?.amountOut > 0n && to ? fmt(quote.amountOut, to.decimals ?? DECIMALS) : null

  /* What the button says, and why when it cannot be pressed. */
  const cta = (() => {
    if (!hasWallet()) return { kind: 'connect', why: <>No wallet yet? <Link to="/get-wallet">Get ThruScan Wallet</Link> or create one in this browser.</> }
    if (!wallet.unlocked) return { kind: 'unlock', label: 'Unlock to swap', onClick: () => gate.ensure().catch(() => {}), why: 'Your browser wallet is locked. Enter its password to sign.' }
    if (registryDown && !wrapOnly) {
      return { kind: 'off', label: 'Quote unavailable', why: <>The pool registry can&rsquo;t be read. The form stays; swapping resumes when it can. <button className="btn plain" onClick={() => reload()}>Retry</button></> }
    }
    if (!from || !to) return { kind: 'off', label: 'Pick two tokens', why: 'Choose what you pay and what you receive.' }
    if (amountIn <= 0n) return { kind: 'off', label: 'Enter an amount', why: blocker && !/^You have/.test(blocker) ? blocker : null }
    if (shortOfFunds) {
      const faucet = from.native || from.mint === WTHRU_MINT
      return {
        kind: 'off', label: `Not enough ${from.ticker}`,
        why: <>You have {fmt(spendable, from.decimals)} {from.ticker}{from.native ? ' to spend after fees' : ''}.{faucet && <> <Link to="/faucet">Get more from the faucet</Link>.</>}</>,
      }
    }
    if (blocker) return { kind: 'off', label: 'Review swap', why: blocker }
    return { kind: 'go', label: wrapOnly ? (fromMint === THRU ? 'Review wrap' : 'Review unwrap') : 'Review swap', onClick: review }
  })()

  useEffect(() => { onPool?.({ pool, from, to, wrapOnly }) }, [pool, from, to, wrapOnly])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <section className="swap-panel">
        {gate.modal}
        <AmountIn
          label="You pay" value={amount} onChange={setAmount}
          balance={from ? (from.known ? fmt(from.balance, from.decimals) : '—') : undefined}
          onMax={from && from.balance > 0n ? () => setAmount(fromUnits(spendable, from.decimals)) : null}
        >
          <TokenPicker tokens={tokens} value={fromMint} onChange={setFromMint} exclude={toMint} label="Select" />
        </AmountIn>

        <div className="swap-flip">
          <button className="flip-btn" onClick={flip} aria-label="Swap direction"><Icon name="flip" size={18} /></button>
        </div>

        <AmountOut label="You receive (estimate)" value={outText} balance={to ? (to.known ? fmt(to.balance, to.decimals) : '—') : undefined}>
          <TokenPicker tokens={tokens} value={toMint} onChange={setToMint} exclude={fromMint} label="Select" surface />
        </AmountOut>

        <div className="swap-rows">
          <div><span>Rate</span><span className="mono">{rate}</span></div>
          {!wrapOnly && <div><span>Pool fee{feeText ? ` (${feeText}, paid to LPs)` : ''}</span><span className="mono">{feeAmount}</span></div>}
          <div><span>Network fee</span><span className="mono">shown by your wallet</span></div>
        </div>

        {veryThin && (
          <p className="notice bad">Thin pool: this trade moves the price {(Number(impactBps) / 100).toFixed(0)}% and you&rsquo;d get far less than fair value. Trade smaller.</p>
        )}
        {thin && !veryThin && (
          <p className="notice"><Icon name="warning" size={18} /><span>Thin pool: this moves the price {(Number(impactBps) / 100).toFixed(1)}%. Smaller trades get a better rate.</span></p>
        )}

        <Cta state={cta} />
        {error && <p className="notice bad">{error}</p>}
      </section>
      <p className="swap-caption">Quotes come from the pool&rsquo;s current reserves. The final amount can differ if someone else trades first.</p>

      <TxDialog
        flow={flow}
        title={wrapOnly ? (fromMint === THRU ? 'Review wrap' : 'Review unwrap') : 'Review swap'}
        pay={{ value: `${amount || '0'} ${from?.ticker ?? ''}` }}
        receive={{ value: `${outText ?? '0'} ${to?.ticker ?? ''}`, exact: wrapOnly }}
        rows={[
          { k: 'Rate', v: rate },
          ...(wrapOnly ? [] : [
            { k: `Pool fee (${feeText}, to LPs)`, v: feeAmount },
            { k: 'Minimum received', v: 'No minimum set' },
          ]),
          NETWORK_ROW,
        ]}
        technical={wrapOnly ? null : { program: SWAP_PROGRAM, extra: [{ k: 'Pool', v: pool ? `#${pool.id}` : '–' }] }}
        note={wrapOnly
          ? 'Your wallet will ask you to sign. Wrapping goes straight through Thru’s WTHRU program, one for one.'
          : 'Your wallet will ask you to sign. The final amount can differ if the pool changes before your swap lands.'}
        needsAccounts={needsOpen}
        run={run}
        words={{
          pendingTitle: wrapOnly ? 'Wrap submitted' : 'Swap submitted',
          landed: wrapOnly ? (fromMint === THRU ? 'Wrap confirmed' : 'Unwrap confirmed') : 'Swap confirmed',
          landedSub: outText && to ? `About ${outText} ${to.ticker} is on its way to your wallet; the balance updates in a moment.` : undefined,
          failed: wrapOnly ? 'Wrap failed' : 'Swap failed',
        }}
        landedLinks={toMint === WTHRU_MINT ? [{ to: '/', label: 'Buy on ThruPad', strong: true }] : []}
      />
    </>
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
          {mine.length > 0 && <p className="sub">{`${mine.length} pool${mine.length === 1 ? '' : 's'}`}</p>}
        </div>
      </div>

      {mine.length === 0 ? (
        <p className="fine" style={{ marginTop: 12, lineHeight: 1.65 }}>Nothing deposited yet. A new deposit shows here within a few seconds.</p>
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


function LiquidityPanel({ pools, balances, tickers, decimalsOf, reload, onPool }) {
  const wallet = useWallet()
  const gate = useUnlockGate()

  const [poolId, setPoolId] = useState(null)
  const [side, setSide] = useState('add')
  const [amountA, setAmountA] = useState('')
  const [lpAmount, setLpAmount] = useState('')
  const [error, setError] = useState(null)

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

  const flow = useTxFlow()
  const needsOpen = !!pool && [pool.mintA, pool.mintB, pool.lpMint].some((m) => !wallet.balances?.[m]?.exists)

  const run = async (progress) => {
    const need = [pool.mintA, pool.mintB, pool.lpMint]
    if (needsOpen) progress('accounts')
    const accounts = {}
    for (const mint of need) {
      const known = wallet.balances[mint]
      if (known?.exists) { accounts[mint] = known.account; continue }
      const made = await openTokenAccount(mint)
      if (!made.already) await new Promise((r) => setTimeout(r, 2800))
      accounts[mint] = made.account ?? (await deriveTokenAccount(mint, wallet.address))
    }

    progress('sign')
    const args = {
      registry: SWAP_REGISTRY, poolId: pool.id,
      vaultA: pool.vaultA, vaultB: pool.vaultB,
      userA: accounts[pool.mintA], userB: accounts[pool.mintB],
      lpMint: pool.lpMint, userLp: accounts[pool.lpMint],
    }
    const built = side === 'add'
      ? buildAddLiquidityInstruction({ ...args, amountA: inA, amountB: inB })
      : buildRemoveLiquidityInstruction({ ...args, lpAmount: burnLp })

    const result = await sendBuilt(SWAP_PROGRAM, built, (sig) => progress('sent', sig))
    if (result.settled && !result.succeeded) return { ok: false, signature: result.signature, error: explainRevert(result) }

    setAmountA(''); setLpAmount('')
    await wallet.refresh(need)
    reload()
    return { ok: true, signature: result.signature }
  }

  const review = async () => {
    setError(null)
    try { await gate.ensure() } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return
    }
    flow.open()
  }

  useEffect(() => { onPool?.(pool) }, [pool])  // eslint-disable-line react-hooks/exhaustive-deps

  if (!pools.length) return null

  const adding = side === 'add'
  const cta = (() => {
    const label = adding ? 'Add liquidity' : 'Remove liquidity'
    const variant = adding ? 'secondary' : 'danger'
    if (!hasWallet()) return { kind: 'connect', why: <>No wallet yet? <Link to="/get-wallet">Get ThruScan Wallet</Link> or create one in this browser.</> }
    if (!wallet.unlocked) return { kind: 'unlock', label: 'Unlock to continue', onClick: () => gate.ensure().catch(() => {}), why: 'Your browser wallet is locked. Enter its password to sign.' }
    if (adding ? inA <= 0n : burnLp <= 0n) return { kind: 'off', label, variant, why: blocker ?? (adding ? 'Enter an amount.' : 'Enter how many LP tokens to burn.') }
    if (blocker) return { kind: 'off', label, variant, why: blocker }
    return { kind: 'go', label, variant, onClick: review }
  })()

  return (
    <>
      <section className="swap-panel">
        {gate.modal}
        {pools.length > 1 && (
          <div className="chips liq-pools" role="group" aria-label="Pool">
            {pools.map((p) => (
              <button key={p.id} className="chip" aria-pressed={p.id === poolId}
                onClick={() => { setPoolId(p.id); setAmountA(''); setLpAmount('') }}>
                {tick(p.mintA)} / {tick(p.mintB)}
              </button>
            ))}
          </div>
        )}
        <div className="seg" role="group" aria-label="Add or remove">
          <button aria-pressed={adding} onClick={() => setSide('add')}>Add</button>
          <button aria-pressed={!adding} onClick={() => setSide('remove')}>Remove</button>
        </div>

        {pool && adding && (
          <>
            <AmountIn
              label={`You add · ${tick(pool.mintA)}`} value={amountA} onChange={setAmountA}
              balance={fmt(heldA, dp(pool.mintA))}
              onMax={heldA > 0n ? () => setAmountA(fromUnits(heldA, dp(pool.mintA))) : null}
            >
              <span className="amt-unit"><TokenIcon symbol={tick(pool.mintA)} mint={pool.mintA} size={26} /><b>{tick(pool.mintA)}</b></span>
            </AmountIn>
            <AmountOut label={`And ${tick(pool.mintB)}, at the pool's ratio (estimate)`} value={inB > 0n ? fmt(inB, dp(pool.mintB)) : null} balance={fmt(heldB, dp(pool.mintB))}>
              <span className="amt-unit"><TokenIcon symbol={tick(pool.mintB)} mint={pool.mintB} size={26} /><b>{tick(pool.mintB)}</b></span>
            </AmountOut>
          </>
        )}

        {pool && !adding && (
          <>
            <AmountIn
              label="LP tokens to burn" value={lpAmount} onChange={setLpAmount}
              balance={fmt(heldLp)}
              onMax={heldLp > 0n ? () => setLpAmount(fromUnits(heldLp, DECIMALS)) : null}
            >
              <span className="amt-unit"><b>LP</b></span>
            </AmountIn>
            <AmountOut label="You get back (estimate)" value={burnLp > 0n ? `${fmt(outA, dp(pool.mintA))} ${tick(pool.mintA)} · ${fmt(outB, dp(pool.mintB))} ${tick(pool.mintB)}` : null} />
          </>
        )}

        {pool && (
          <div className="swap-rows">
            <div><span>Fee to providers</span><span className="mono">{pool.feeBps / 100}% of every trade</span></div>
            <div><span>Your share</span><span className="mono">{heldLp > 0n ? `${sharePct.toFixed(2)}% · ${fmt(heldLp)} LP` : 'none'}</span></div>
          </div>
        )}

        <Cta state={cta} />
        {error && <p className="notice bad">{error}</p>}
      </section>
      <p className="swap-caption">Deposits go in at the pool&rsquo;s ratio, so the second amount is worked out for you. Your share tracks what the pool holds now, not what you put in.</p>

      {pool && (
        <TxDialog
          flow={flow}
          title={adding ? 'Review deposit' : 'Review withdrawal'}
          pay={adding
            ? { label: 'You add', value: `${amountA || '0'} ${tick(pool.mintA)} + ${fmt(inB, dp(pool.mintB))} ${tick(pool.mintB)}` }
            : { label: 'You burn', value: `${lpAmount || '0'} LP` }}
          receive={adding ? null : { label: 'You get back (estimate)', value: `${fmt(outA, dp(pool.mintA))} ${tick(pool.mintA)} · ${fmt(outB, dp(pool.mintB))} ${tick(pool.mintB)}` }}
          rows={[
            { k: 'Pool', v: `${tick(pool.mintA)} / ${tick(pool.mintB)}`, plain: true },
            { k: 'Fee to providers', v: `${pool.feeBps / 100}%` },
            NETWORK_ROW,
          ]}
          technical={{ program: SWAP_PROGRAM, extra: [{ k: 'Pool', v: `#${pool.id}` }] }}
          note="Your wallet will ask you to sign. The amounts can shift if someone trades through the pool before this lands."
          needsAccounts={needsOpen}
          run={run}
          words={{
            pendingTitle: adding ? 'Deposit submitted' : 'Withdrawal submitted',
            landed: adding ? 'Liquidity added' : 'Liquidity removed',
            failed: adding ? 'Deposit failed' : 'Withdrawal failed',
          }}
        />
      )}
    </>
  )
}


/** The pool the panel is quoting against: reserves, your share, pricing. */
function PoolPanel({ info, balances, tickers, decimalsOf, liquidity }) {
  const wallet = useWallet()
  const pool = info?.pool
  if (info?.wrapOnly) {
    return (
      <section className="pool-panel">
        <div className="pool-head"><h2 className="h3">THRU / WTHRU</h2></div>
        <p className="pool-text">A wrap, not a pool trade: THRU goes through Thru&rsquo;s WTHRU program one for one, with no reserves and no pool fee.</p>
      </section>
    )
  }
  if (!pool) {
    return (
      <section className="pool-panel">
        <div className="pool-head"><h2 className="h3">Pool</h2></div>
        <p className="pool-text">{liquidity ? 'No pool can be read right now.' : info?.from && info?.to ? `There is no ${info.from.ticker} / ${info.to.ticker} pool yet.` : 'Pick two tokens to see their pool.'}</p>
      </section>
    )
  }
  const tick = (m) => tickers?.[m] || short(m)
  const lp = wallet.balances?.[pool.lpMint]?.amount ?? 0n
  const share = pool.lpSupply > 0n ? Number((lp * 1000000n) / pool.lpSupply) / 10000 : 0
  return (
    <section className="pool-panel">
      <div className="pool-head">
        <h2 className="h3">{tick(pool.mintA)} / {tick(pool.mintB)} pool</h2>
        <span className="mono dim">#{pool.id}</span>
      </div>
      <div className="pool-rows">
        <div><span>{tick(pool.mintA)} reserve</span><span className="mono">{fmt(balances[pool.vaultA] ?? 0n, decimalsOf(pool.mintA))}</span></div>
        <div><span>{tick(pool.mintB)} reserve</span><span className="mono">{fmt(balances[pool.vaultB] ?? 0n, decimalsOf(pool.mintB))}</span></div>
        <div><span>Your pool share</span><span className="mono">{wallet.address ? `${share.toFixed(2)}%` : '–'}</span></div>
        <div><span>Swaps</span><span className="mono">{Number(pool.swapCount).toLocaleString('en-US')}</span></div>
        <div><span>Pricing</span><span>Constant product (x·y=k)</span></div>
      </div>
    </section>
  )
}

function WhyWthru() {
  return (
    <section className="why-wthru">
      <b>Why WTHRU?</b>
      <p>Every ThruPad launch is bought and sold in WTHRU, a wrapped form of THRU. Wrap THRU into WTHRU here, then buy on ThruPad.</p>
      <Link to="/">Go to ThruPad</Link>
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
  const [tab, pick] = useTab(['swap', 'liquidity', 'pools'])
  const [info, setInfo] = useState(null)

  if (!SWAP_PROGRAM || !SWAP_REGISTRY) {
    return (
      <div className="page swap-page">
        <div className="swap-main">
          <h1 className="swap-h1">Swap</h1>
          <NotLive what="thruswap" />
        </div>
      </div>
    )
  }

  const pools = data?.pools ?? []
  const shared = { pools, balances, tickers, decimalsOf, reload }

  return (
    <div className="page swap-page">
      <div className="swap-main">
        <div className="swap-head">
          <h1 className="swap-h1">Swap</h1>
          <div className="tabs swap-tabs" role="tablist">
            {[['swap', 'Swap'], ['liquidity', 'Liquidity'], ['pools', 'Pools']].map(([k, label]) => (
              <button key={k} role="tab" className="tab-btn" aria-selected={tab === k} onClick={() => { setInfo(null); pick(k) }}>{label}</button>
            ))}
          </div>
        </div>

        {/* The swap panel is always on the page. THRU to WTHRU is a wrap
            straight through Thru's own WTHRU program, with no pool and no
            registry in the path, so it works whatever the registry says. */}
        {tab === 'swap' && (
          <>
            {error && <RegistryDown what="pool" error={error} note="Wrapping and unwrapping THRU still work." onRetry={reload} />}
            <SwapPanel {...shared} registryDown={!!error} onPool={setInfo} />
          </>
        )}

        {/* Liquidity genuinely needs the registry: you cannot add to a pool the
            page cannot name. */}
        {tab === 'liquidity' && (
          error
            ? <RegistryDown what="pool" error={error} note="Adding liquidity needs it." onRetry={reload} />
            : pools.length > 0
              ? <LiquidityPanel {...shared} onPool={(pool) => setInfo({ pool })} />
              : <EmptyPools loading={loading} />
        )}

        {tab === 'pools' && (
          <>
            {error && <RegistryDown what="pool" error={error} note="Pools can't be listed until it reads again." onRetry={reload} />}
            <section className="pool-list">
              <div className="pool-head"><h2 className="h3">Pools</h2><span className="fine">{data ? `${pools.length} of ${data.capacity} slots in use` : error ? 'registry unavailable' : 'reading the chain'}</span></div>
              {!error && data && pools.length === 0 && <p className="pool-text">No pools have been created yet.</p>}
              {pools.map((p) => <PoolRow key={p.id} pool={p} balances={balances} tickers={tickers} decimalsOf={decimalsOf} />)}
            </section>
            <Positions pools={pools} balances={balances} tickers={tickers} decimalsOf={decimalsOf} />
            {pools.map((p) => <PoolChart key={p.id} pool={p} tickers={tickers} decimalsOf={decimalsOf} />)}
          </>
        )}
      </div>

      {tab !== 'pools' && (
        <aside className="swap-side-col">
          <PoolPanel info={info} liquidity={tab === 'liquidity'} balances={balances} tickers={tickers} decimalsOf={decimalsOf} />
          <WhyWthru />
        </aside>
      )}
    </div>
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
    <section className="empty">
      <span className="empty-title">{loading ? 'Reading from the chain…' : 'No pools yet'}</span>
      <p>{loading ? 'The pool registry is being read.' : 'No pools have been created on this network yet.'}</p>
    </section>
  )
}

/**
 * One registry could not be read, said plainly, above a page that still works.
 *
 * The banner says which list is missing and what is still possible, and the
 * buttons below it stay where they were. The raw error is for whoever is
 * debugging, so it lives in the tooltip rather than on the page.
 *
 * `missing` is the common case and worth its own words. A registry is one
 * account; when the node answers that it does not exist, the list of pools or
 * launches is unreadable but every program behind them is untouched.
 */
function RegistryDown({ what, error, note, onRetry }) {
  const missing = /not\s*found|does not exist|NOT_FOUND|no account/i.test(String(error ?? ''))
  return (
    <div className="notice" role="status" title={String(error ?? '')}>
      <Icon name="warning" size={18} />
      <span>
        <b>The {what} registry can&rsquo;t be read right now.</b>{' '}
        {missing ? `Its account is missing on chain.` : 'The node did not answer. Retrying.'}
        {note ? ` ${note}` : ''}
        {onRetry && <> <button className="btn plain" onClick={() => onRetry()}>Retry</button></>}
      </span>
    </div>
  )
}

/* ---------- the charts (3j) ----------
 *
 * One panel, two views. Price is what each trade actually paid, read from the
 * quote vault's history, over the last hour, the last day, or everything read.
 * Curve is the bonding curve itself: price against supply sold, on a log
 * scale, with a dot where the launch is now and a dashed line where it
 * graduates. Ink line, an 18% amber area under it, hairline gridlines, a mono
 * axis. */

const CW = 800, CH = 260

function axisPrice(v) {
  if (!Number.isFinite(v) || v <= 0) return '0'
  return v.toLocaleString('en-US', { maximumSignificantDigits: 3 })
}

/** A price with four significant figures, as the design writes them: 0.00042180. */
function fullPrice(v) {
  if (!Number.isFinite(v) || v <= 0) return '0'
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  return v.toLocaleString('en-US', { maximumSignificantDigits: 4, minimumSignificantDigits: 4 })
}

function axisTime(ms, spanMs) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  if (spanMs > 2 * 86400000) return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()}`
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function PriceLines({ points, nowPrice, nowMs, range, symbol, quote }) {
  const cutoff = range === '1h' ? nowMs - 3600000 : range === '24h' ? nowMs - 86400000 : -Infinity
  const shown = points.filter((p) => p.time !== null && p.time >= cutoff)
  if (!shown.length) {
    return <p className="lc-empty">{points.length ? `No trades in the last ${range === '1h' ? 'hour' : '24 h'}.` : 'No trades yet. The first buy starts the line.'}</p>
  }
  const series = [...shown.map((p) => ({ t: p.time, v: p.price })), ...(Number.isFinite(nowPrice) ? [{ t: nowMs, v: nowPrice }] : [])]
  const t0 = range === 'All' ? series[0].t : cutoff
  const t1 = nowMs
  const vals = series.map((s) => s.v)
  let lo = Math.min(...vals), hi = Math.max(...vals)
  if (hi === lo) { lo = lo * 0.9; hi = hi * 1.1 || 1 }
  const pad = (hi - lo) * 0.12
  lo = Math.max(0, lo - pad); hi += pad
  const x = (t) => (t1 === t0 ? CW / 2 : ((t - t0) / (t1 - t0)) * CW)
  const y = (v) => CH - ((v - lo) / (hi - lo)) * CH
  const line = series.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)} ${y(s.v).toFixed(1)}`).join(' ')
  const area = `${line} L${x(series[series.length - 1].t).toFixed(1)} ${CH} L${x(series[0].t).toFixed(1)} ${CH}Z`
  const ticks = [0, 1, 2, 3].map((i) => hi - ((hi - lo) * (i + 0.5)) / 4)
  const span = t1 - t0
  const times = [0, 1, 2, 3, 4, 5].map((i) => t0 + (span * i) / 5)
  return (
    <ChartFrame ticks={ticks.map(axisPrice)} xLabels={times.map((t) => axisTime(t, span))}
      label={`Price of ${symbol} in ${quote} over ${range === 'All' ? 'every trade read' : `the last ${range}`}`}>
      <path d={area} className="lc-area" />
      <path d={line} className="lc-line" vectorEffect="non-scaling-stroke" />
    </ChartFrame>
  )
}

function ChartFrame({ ticks, xLabels, label, children }) {
  return (
    <div className="lc-frame">
      <div className="lc-plot">
        <svg viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none" role="img" aria-label={label}>
          <g className="lc-grid">
            {[1, 3, 5, 7].map((i) => <path key={i} d={`M0 ${(CH * i) / 8}H${CW}`} vectorEffect="non-scaling-stroke" />)}
          </g>
          {children}
        </svg>
        <div className="lc-y mono" aria-hidden="true">{ticks.map((t, i) => <span key={i}>{t}</span>)}</div>
      </div>
      <div className="lc-x mono" aria-hidden="true">{xLabels.map((t, i) => <span key={i}>{t}</span>)}</div>
    </div>
  )
}

/** Price against supply sold, from the curve's own constant. */
function CurveChart({ vq, vt, tokensSold, raised, threshold, symbol, quote, quoteDecimals }) {
  const shape = useMemo(() => {
    const vq0 = Number(vq), vt0 = Number(vt)
    if (!(vq0 > 0) || !(vt0 > 0)) return null
    const k = vq0 * vt0
    const sold = Number(tokensSold)
    const total = vt0 + sold
    const scale = 10 ** DECIMALS / 10 ** quoteDecimals
    const priceAt = (t) => (k / (t * t)) * scale
    const N = 64
    const pts = []
    for (let i = 0; i <= N; i++) {
      const s = total * 0.98 * (i / N)
      pts.push([s / total, priceAt(total - s)])
    }
    // Where the curve graduates: the quote reserve it reaches when the raised
    // amount meets the threshold, and the token reserve that leaves.
    let grad = null
    const r = Number(raised), th = Number(threshold)
    if (th > 0) {
      const vqGrad = vq0 - r + th
      if (vqGrad > 0) { const tGrad = k / vqGrad; grad = Math.max(0, Math.min(1, (total - tGrad) / total)) }
    }
    return { pts, u: total > 0 ? sold / total : 0, now: priceAt(vt0), grad }
  }, [vq, vt, tokensSold, raised, threshold, quoteDecimals])

  if (!shape) return <p className="lc-empty">The curve can&rsquo;t be drawn until the launch has reserves.</p>
  const { pts, u, now, grad } = shape
  const lo = Math.log(pts[0][1]), hi = Math.log(pts[pts.length - 1][1])
  const x = (f) => f * CW
  const y = (p) => CH - 6 - ((Math.log(p) - lo) / (hi - lo || 1)) * (CH - 12)
  const line = pts.map(([f, p], i) => `${i ? 'L' : 'M'}${x(f).toFixed(1)} ${y(p).toFixed(1)}`).join(' ')
  const area = `${line} L${CW} ${CH} L0 ${CH}Z`
  const ticks = [0, 1, 2, 3].map((i) => Math.exp(hi - ((hi - lo) * (i + 0.5)) / 4))
  return (
    <ChartFrame ticks={ticks.map(axisPrice)} xLabels={['none sold', '', 'half the supply', '', '', 'whole supply']}
      label={`Price of ${symbol} in ${quote} against supply sold; now ${axisPrice(now)}`}>
      <path d={area} className="lc-area" />
      <path d={line} className="lc-line" vectorEffect="non-scaling-stroke" />
      {grad !== null && <path d={`M${x(grad)} 0V${CH}`} className="lc-grad" vectorEffect="non-scaling-stroke" />}
      <path d={`M${x(u)} ${y(now)}h0.01`} className="lc-dot" vectorEffect="non-scaling-stroke" />
    </ChartFrame>
  )
}

function LaunchChart({ points, nowPrice, curve, symbol, quote }) {
  const [view, setView] = useState('price')
  const [range, setRange] = useState('24h')
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30000)
    return () => clearInterval(id)
  }, [])
  return (
    <section className="lc-panel">
      <div className="lc-head">
        <div className="seg lc-seg" role="group" aria-label="Chart">
          <button aria-pressed={view === 'price'} onClick={() => setView('price')}>Price</button>
          <button aria-pressed={view === 'curve'} onClick={() => setView('curve')}>Curve</button>
        </div>
        {view === 'price' && (
          <div className="lc-ranges" role="group" aria-label="Range">
            {['1h', '24h', 'All'].map((r) => (
              <button key={r} className="lc-range mono" aria-pressed={range === r} onClick={() => setRange(r)}>{r}</button>
            ))}
          </div>
        )}
      </div>
      {view === 'price'
        ? (points === null ? <p className="lc-empty">Reading trades from the chain…</p>
          : <PriceLines points={points} nowPrice={nowPrice} nowMs={nowMs} range={range} symbol={symbol} quote={quote} />)
        : <CurveChart {...curve} symbol={symbol} quote={quote} />}
    </section>
  )
}

/** One launch in the list. A row that goes somewhere, not a page of its own
 *  stacked ten deep under nine others. */
/* ---------- a launch, as a card ----------
 *
 * A launchpad is a place you scan, not a list you read: which of these is
 * moving, and what is it worth. So each one is a card with its picture, its
 * ticker, what the curve values it at, and how far along it is. The list used
 * to be full-width rows a hundred pixels tall, which fit four on a screen and
 * told you no more than these do at a fifth of the size.
 */
export function marketCap(launch, quoteDecimals) {
  const vq = Number(launch.vq), vt = Number(launch.vt), sold = Number(launch.tokensSold)
  if (!(vt > 0)) return null
  return (vq / vt) * (vt + sold) / 10 ** quoteDecimals
}

/** 1,234 -> 1.2K, 1,200,000 -> 1.2M. A market cap is read, not counted. */
export function compactNumber(n) {
  if (n === null || !isFinite(n)) return '–'
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 2)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 2)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`
  if (abs >= 1) return n.toFixed(2)
  if (abs === 0) return '0'
  return n.toPrecision(2)
}

function LaunchCard({ launch, balances, tickers, decimals, threshold, meta }) {
  const quote = tickers?.[launch.quoteMint] || short(launch.quoteMint)
  const qd = decimals?.[launch.quoteMint] ?? DECIMALS
  const quoteHeld = balances[launch.quoteVault] ?? 0n
  const raised = quoteHeld > launch.creatorFees ? quoteHeld - launch.creatorFees : 0n
  const progress = graduationProgress(raised, threshold)
  const cap = marketCap(launch, qd)

  return (
    <Link className="lcard" to={`/launch/${launch.id}`}>
      <span className="lcard-art">
        <TokenIcon meta={meta} symbol={launch.symbol} mint={launch.mint} size={160} className="lcard-icon" />
        {launch.graduated && <span className="lcard-flag">Graduated</span>}
      </span>
      <span className="lcard-body">
        <span className="lcard-line">
          <b>{launch.name}</b>
          <i className="mono">${launch.symbol}</i>
        </span>
        <span className="lcard-cap mono">{compactNumber(cap)} {quote}<em>market cap</em></span>
        {!launch.graduated && (
          <>
            <span className="progress-track lcard-bar">
              <span className="progress-fill" style={{ width: `${Math.max(2, progress * 100)}%` }} />
            </span>
            <span className="lcard-note">
              {(progress * 100).toFixed(1)}% of the way · {Number(launch.tradeCount)} {Number(launch.tradeCount) === 1 ? 'trade' : 'trades'}
            </span>
          </>
        )}
        {launch.graduated && (
          <span className="lcard-note">{Number(launch.tradeCount)} trades · the curve is frozen</span>
        )}
      </span>
    </Link>
  )
}

/**
 * One launch, on its own page (Core Screens 3j/3k).
 *
 * The header names the token and who made it, with the curve price on the
 * right. Below, the chart, the curve's progress with the graduation caveat,
 * and the trades; the trade panel sits beside them on a desktop, above them
 * from 820 to 1023, and in a bottom sheet behind a sticky Buy / Sell bar on a
 * phone. Names, images and links are the creator's and say so.
 */
export function LaunchDetail({ id }) {
  const launchId = Number(id)
  const [slot, setSlot] = useState(null)
  const [blockMs, setBlockMs] = useState(null)
  const [allMeta, setAllMeta] = useState({})
  const [names, setNames] = useState(() => new Map())
  const [sheet, setSheet] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const { loading, error, data, balances, tickers, decimals, reload } = useChainData(
    PAD_REGISTRY,
    decodePadRegistry,
    (d) => d.launches.flatMap((l) => [l.quoteVault, l.tokenVault]),
    /* The registry's own default quote mint is in here too. Without it, a pad
       with no launches yet has nothing to read a ticker from. */
    (d) => [d.quoteMint, ...d.launches.map((l) => l.quoteMint)],
  )

  useEffect(() => {
    let alive = true
    const tick = () => {
      fetch('/api/rpc?action=overview')
        .then((r) => r.json())
        .then((j) => {
          if (!alive || !j?.ok) return
          if (j.finalized) setSlot(BigInt(j.finalized))
          if (j.blockTimeMs) setBlockMs(j.blockTimeMs)
          setNow(Date.now())
        })
        .catch(() => {})
    }
    tick()
    const id2 = setInterval(tick, 15000)
    return () => { alive = false; clearInterval(id2) }
  }, [])

  // Other people's trades move the curve too, so re-read it every few seconds
  // while the page is on screen.
  useEffect(() => {
    const id3 = setInterval(() => { if (!document.hidden) reload(true) }, 5000)
    return () => clearInterval(id3)
  }, [reload])

  useEffect(() => {
    let alive = true
    allTokenMeta().then((m) => { if (alive) setAllMeta(m) }).catch(() => {})
    loadNames().then((m) => { if (alive) setNames(m) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const launch = data?.launches?.find((l) => l.id === launchId) ?? null
  const quoteMint = launch?.quoteMint
  const quoteDecimals = decimals?.[quoteMint] ?? DECIMALS
  const { trades } = useTrades(launch?.quoteVault, launch?.tokenVault)

  const points = useMemo(() => (trades === null ? null : trades
    .map((t) => ({
      ...t,
      price: (Number(t.quote) / 10 ** quoteDecimals) / (Number(t.tokens) / 10 ** DECIMALS),
    }))
    .filter((t) => Number.isFinite(t.price) && t.price > 0)), [trades, quoteDecimals])

  if (loading && !data) {
    return (
      <div className="page ld">
        <div className="ld-loading">
          <span className="skel" style={{ width: 64, height: 64, borderRadius: 10 }} />
          <span className="skel" style={{ width: 220, height: 28 }} />
        </div>
        <p className="why">Reading from Thru {network.label.toLowerCase()}…</p>
      </div>
    )
  }
  if (error || !launch) {
    return (
      <div className="page ld">
        <section className="empty">
          <span className="empty-title">{error ? 'The launch registry can’t be read right now' : 'No launch with that id'}</span>
          <p>{error ? 'This page reads the launch from the chain, so it can’t show it until the registry answers.' : 'It may have been on a network that has since been reset.'}</p>
          <div className="mk-actions-row">
            {error && <button className="btn secondary" onClick={() => reload()}>Retry</button>}
            <Link className="btn tertiary" to="/">Back to ThruPad</Link>
          </div>
        </section>
      </div>
    )
  }

  const meta = allMeta[launch.mint]
  const quote = tickers?.[quoteMint] || (quoteMint === WTHRU_MINT ? 'WTHRU' : quoteMint === TUSD_MINT ? 'tUSD' : short(quoteMint))
  const quoteHeld = balances[launch.quoteVault] ?? 0n
  const raised = quoteHeld > launch.creatorFees ? quoteHeld - launch.creatorFees : 0n
  const threshold = data.gradThreshold
  const progress = launch.graduated ? 1 : graduationProgress(raised, threshold)
  const nowPrice = Number(launch.vt) > 0 ? (Number(launch.vq) / 10 ** quoteDecimals) / (Number(launch.vt) / 10 ** DECIMALS) : null
  const supply = launch.vt + launch.tokensSold
  const ageMs = slot !== null && blockMs ? Math.max(0, Number(slot - BigInt(launch.startSlot))) * blockMs : null

  // The change: against the last trade before 24 hours ago when the history
  // read reaches that far, otherwise against the oldest trade read.
  const change = (() => {
    if (!points?.length || !Number.isFinite(nowPrice)) return null
    const dayAgo = now - 86400000
    const before = [...points].reverse().find((p) => p.time !== null && p.time <= dayAgo)
    const base = before ?? points[0]
    if (!base?.price) return null
    return { pct: ((nowPrice - base.price) / base.price) * 100, label: before ? '24 h' : 'since the first trade read' }
  })()

  const tradePanel = (mode, initialSide) => (
    <TradePanel
      launch={launch} quote={quote} quoteMint={quoteMint} quoteDecimals={quoteDecimals}
      slot={slot} onTraded={() => reload(true)} mode={mode} initialSide={initialSide}
      onClose={() => setSheet(null)}
    />
  )

  return (
    <div className="page ld">
      <header className="ld-head">
        <div className="ld-id">
          <TokenIcon meta={meta} symbol={launch.symbol} mint={launch.mint} size={64} className="ld-avatar" />
          <div className="ld-id-text">
            <div className="ld-name">
              <h1>{launch.name || launch.symbol}</h1>
              <span className="mono">{launch.symbol}</span>
              {launch.graduated && <span className="status-pill ok"><Icon name="success" size={12} stroke={2.4} />Graduated</span>}
            </div>
            <div className="ld-meta">
              <span>Creator <CopyId value={launch.creator} label={names.get(launch.creator)} /></span>
              <span className="ld-meta-more">Mint <CopyId value={launch.mint} to={`/token/${launch.mint}`} /></span>
              {meta?.website && <a className="ld-meta-more" href={meta.website} target="_blank" rel="noreferrer">{meta.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>}
              {meta?.x && <a className="ld-meta-more" href={`https://x.com/${String(meta.x).replace(/^@/, '')}`} target="_blank" rel="noreferrer">X</a>}
              {meta?.telegram && <a className="ld-meta-more" href={`https://t.me/${String(meta.telegram).replace(/^@/, '')}`} target="_blank" rel="noreferrer">Telegram</a>}
              {ageMs !== null && <span className="ld-meta-more" title="From the slot the launch started in and the chain's block time">Launched {ageMs < 86400000 ? `${relTime(now - ageMs, now)} ago` : `on ${relTime(now - ageMs, now)}`}</span>}
            </div>
          </div>
        </div>
        <div className="ld-price">
          <span className="ld-price-k">Curve price</span>
          <span className="ld-price-v mono">{nowPrice !== null ? fullPrice(nowPrice) : '–'} <small>{quote}</small></span>
          {change && (
            <span className={`ld-chg mono ${change.pct > 0.05 ? 'up' : change.pct < -0.05 ? 'down' : ''}`}>
              {change.pct > 0.05 ? '▲ +' : change.pct < -0.05 ? '▼ −' : ''}{Math.abs(change.pct).toFixed(1)}% · {change.label}
            </span>
          )}
        </div>
      </header>

      <div className="ld-grid">
        <div className="ld-trade-wide">{tradePanel('panel')}</div>

        <div className="ld-main">
          <LaunchChart
            points={points} nowPrice={nowPrice} symbol={launch.symbol} quote={quote}
            curve={{ vq: launch.vq, vt: launch.vt, tokensSold: launch.tokensSold, raised, threshold, quoteDecimals }}
          />

          <section className="ld-curve">
            <div className="ld-curve-main">
              <div className="ld-curve-top">
                <b><span className="term" title="The program sells the token at a price that rises as more is bought, and lowers as it is sold back. No order book; the curve is the counterparty.">Bonding curve</span> progress</b>
                <span className="mono">{(progress * 100).toFixed(1)}%</span>
              </div>
              <div className="progress thick"><span style={{ width: `${progress * 100}%` }} /></div>
              <div className="ld-curve-foot mono">
                <span>{fmt(raised, quoteDecimals, 1)} {quote} raised</span>
                <span>graduates at {fmt(threshold, quoteDecimals, 1)}</span>
              </div>
              <div className="ld-caveat">
                <Icon name="warning" size={16} />
                <span>At graduation the program moves liquidity into a Swap pool. This is written into ThruPad but has not yet been seen happen on {network.label.toLowerCase()}.</span>
              </div>
            </div>
            <dl className="ld-stats">
              <div><dt>Total supply</dt><dd className="mono">{fmt(supply, DECIMALS, 0)}</dd></div>
              <div><dt>Sold from curve</dt><dd className="mono">{fmt(launch.tokensSold, DECIMALS, 0)}</dd></div>
              <div><dt>Left on curve</dt><dd className="mono">{fmt(launch.vt, DECIMALS, 0)}</dd></div>
              <div><dt>Trades</dt><dd className="mono">{Number(launch.tradeCount).toLocaleString('en-US')}</dd></div>
              <div><dt>Creator fee</dt><dd className="mono">{(launch.feeBps / 100).toFixed(2)}%</dd></div>
              <div><dt>Unclaimed fees</dt><dd className="mono">{fmt(launch.creatorFees, quoteDecimals)} {quote}</dd></div>
            </dl>
          </section>

          <section className="ld-trades">
            <div className="ld-trades-head">
              <h2 className="h3">Trades</h2>
              <Link to={`/token/${launch.mint}`}>All {launch.symbol} activity</Link>
            </div>
            {points === null && <p className="why">Reading trades from the chain…</p>}
            {points?.length === 0 && <p className="why">No trades yet. The first buy starts the curve moving.</p>}
            {points?.length > 0 && (
              <div className="ld-table" role="table" aria-label={`${launch.symbol} trades`}>
                <div className="ld-tr ld-th" role="row">
                  <span role="columnheader">Side</span>
                  <span role="columnheader" className="r">{launch.symbol}</span>
                  <span role="columnheader" className="r">{quote}</span>
                  <span role="columnheader" className="r">Price</span>
                  <span role="columnheader" className="ld-trader">Trader</span>
                  <span role="columnheader" className="r">Time</span>
                </div>
                {[...points].reverse().slice(0, 12).map((t) => (
                  <Link key={t.signature} to={`/tx/${t.signature}`} className="ld-tr" role="row">
                    <span role="cell" className={`ld-side ${t.side}`}>{t.side === 'buy' ? 'Buy' : 'Sell'}</span>
                    <span role="cell" className="mono r">{fmt(t.tokens, DECIMALS, 0)}</span>
                    <span role="cell" className="mono r">{fmt(t.quote, quoteDecimals)}</span>
                    <span role="cell" className="mono r">{fullPrice(t.price)}</span>
                    <span role="cell" className="mono ld-trader" title={t.trader}>{names.get(t.trader) ?? short(t.trader)}</span>
                    <span role="cell" className="mono r dim" title={fullUtc(t.time)}>{t.time ? relTime(t.time, now) : '—'}</span>
                    <span className="ld-c" aria-hidden="true">
                      <span><b className={`ld-side ${t.side}`}>{t.side === 'buy' ? 'Buy' : 'Sell'}</b> <span className="mono">{fmt(t.tokens, DECIMALS, 0)} {launch.symbol}</span></span>
                      <span className="mono dim">{t.time ? relTime(t.time, now) : '—'}</span>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="ld-side">{tradePanel('panel')}</aside>
      </div>

      {/* Phones: a sticky Buy / Sell bar that opens the same panel in a sheet. */}
      {!launch.graduated && (
        <div className="ld-bar">
          <button className="btn secondary lg" onClick={() => setSheet('sell')}>Sell</button>
          <button className="btn lg" onClick={() => setSheet('buy')}>Buy</button>
        </div>
      )}
      {sheet && createPortal(
        <div className="sheet-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setSheet(null) }}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label={`${sheet === 'buy' ? 'Buy' : 'Sell'} ${launch.symbol}`}>
            <span className="sheet-grab" aria-hidden="true" />
            {tradePanel('sheet', sheet)}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

/** What App.jsx mounts at /launch/:id. */
export function LaunchDetailPage() {
  const { id } = useParams()
  return <LaunchDetail id={id} />
}


/** Buy and sell, for one launch (the 3j panel, and the 3k sheet). */
function TradePanel({ launch, quote, quoteMint, quoteDecimals = DECIMALS, slot, onTraded, mode = 'panel', initialSide = 'buy', onClose }) {
  const [side, setSide] = useState(initialSide)
  const [amount, setAmount] = useState('')
  const [error, setError] = useState(null)
  const wallet = useWallet()
  const gate = useUnlockGate()
  const flow = useTxFlow()

  // What you hold of both sides, read from the chain, so Max has a number.
  useEffect(() => {
    if (wallet.address) wallet.refresh([quoteMint, launch.mint])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address, quoteMint, launch.mint])

  useEffect(() => {
    if (mode !== 'sheet') return undefined
    const key = (e) => { if (e.key === 'Escape' && !flow.phase) onClose?.() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [mode, onClose, flow.phase])

  const tax = slot != null ? snipeBps(launch.startSlot, slot) : 0n
  // Buys spend the quote asset and sells spend the token, and the two need not
  // share decimals.
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

  /* Average price and the price after, from the same arithmetic as the quote. */
  const per = (quoteUnits, tokenUnits) => (Number(quoteUnits) / 10 ** quoteDecimals) / (Number(tokenUnits) / 10 ** DECIMALS)
  const avg = amountIn > 0n && out > 0n ? (side === 'buy' ? per(amountIn, out) : per(out, amountIn)) : null
  const after = (() => {
    if (!(amountIn > 0n && out > 0n)) return null
    const vq = BigInt(launch.vq), vt = BigInt(launch.vt)
    if (side === 'buy') {
      const net = amountIn - q.creatorFee - q.snipeTax
      return per(vq + net, vt - out)
    }
    const gross = out + q.creatorFee
    return per(vq - gross, vt + amountIn)
  })()

  const traded = () => {
    setAmount(''); onTraded?.()
    wallet.refresh([quoteMint, launch.mint])
  }

  const needsOpen = [launch.mint, quoteMint].some((m) => !wallet.balances?.[m]?.exists)
  const run = async (progress) => {
    const needs = { userToken: launch.mint, userQuote: quoteMint }
    const resolved = {}
    if (needsOpen) progress('accounts')
    for (const [key, mint] of Object.entries(needs)) {
      const account = await deriveTokenAccount(mint, wallet.address)
      const known = wallet.balances[mint]
      if (!known?.exists) {
        const made = await openTokenAccount(mint)
        // Opening lands a slot or two later, and trading into an account that
        // is not there yet fails for a reason nobody could guess from the UI.
        if (!made.already) await new Promise((r) => setTimeout(r, 2800))
        resolved[key] = made.account ?? account
      } else {
        resolved[key] = known.account ?? account
      }
    }
    progress('sign')
    const args = {
      registry: PAD_REGISTRY, launchId: launch.id,
      tokenVault: launch.tokenVault, quoteVault: launch.quoteVault,
      userToken: resolved.userToken, userQuote: resolved.userQuote,
      amountIn, minOut: 1n,
    }
    const built = side === 'buy' ? buildBuyInstruction(args) : buildSellInstruction(args)
    const result = await sendBuilt(PAD_PROGRAM, built, (sig) => progress('sent', sig))
    if (result.settled && !result.succeeded) return { ok: false, signature: result.signature, error: explainRevert(result) }
    traded()
    return { ok: true, signature: result.signature }
  }

  const review = async () => {
    setError(null)
    try { await gate.ensure() } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return
    }
    flow.open()
  }

  /* Quick amounts: 1, 5 and 10 of the quote asset to buy with, or a share of
     what you hold to sell. Max is the whole balance either way. */
  const chips = side === 'buy'
    ? [['1', '1'], ['5', '5'], ['10', '10']]
    : [['25%', 25], ['50%', 50], ['75%', 75]]
  const pick = (v) => {
    if (side === 'buy') { setAmount(v); return }
    if (!holding || holding <= 0n) return
    setAmount(fromUnits((holding * BigInt(v)) / 100n, inDecimals))
  }
  const max = () => { if (holding && holding > 0n) setAmount(fromUnits(holding, inDecimals)) }
  const chipOn = (v) => (side === 'buy' ? amount === v : holding > 0n && amountIn === (holding * BigInt(v)) / 100n)

  const payTicker = side === 'buy' ? quote : launch.symbol
  const getTicker = side === 'buy' ? launch.symbol : quote
  const verb = side === 'buy' ? 'Buy' : 'Sell'

  const cta = (() => {
    if (!hasWallet()) return { kind: 'connect', why: <>No wallet yet? <Link to="/get-wallet">Get ThruScan Wallet</Link> or create one in this browser.</> }
    if (!wallet.unlocked) return { kind: 'unlock', label: `Unlock to ${verb.toLowerCase()}`, onClick: () => gate.ensure().catch(() => {}), why: 'Your browser wallet is locked. Enter its password to sign.' }
    if (amountIn <= 0n) return { kind: 'off', label: 'Enter an amount' }
    if (holding !== null && amountIn > holding) {
      return {
        kind: 'off', label: `Not enough ${payTicker}`,
        why: side === 'buy'
          ? <>You have {fmt(holding, inDecimals)} {payTicker}. <Link to="/swap">Swap for more</Link>.</>
          : <>You have {fmt(holding, inDecimals)} {payTicker}.</>,
      }
    }
    if (out <= 0n) return { kind: 'off', label: `${verb} ${launch.symbol}`, why: `Can't quote: ${q.reason}.` }
    return { kind: 'go', label: mode === 'sheet' ? `Review ${side}` : `${verb} ${launch.symbol}`, onClick: review }
  })()

  const outText = amountIn > 0n && out > 0n ? fmt(out, outDecimals) : null

  return (
    <section className={`tp tp-${mode}`}>
      {gate.modal}
      {mode === 'sheet' && (
        <div className="tp-sheet-head">
          <b>{verb} {launch.symbol}</b>
          <button className="txd-x" onClick={onClose} aria-label="Close"><Icon name="failed" size={20} /></button>
        </div>
      )}
      {launch.graduated ? (
        <p className="notice"><Icon name="success" size={18} /><span>Graduated: the curve is closed. <Link to="/swap">Trade it on Swap</Link>.</span></p>
      ) : (
        <>
          <div className="seg tp-seg" role="group" aria-label="Buy or sell">
            <button aria-pressed={side === 'buy'} onClick={() => { setSide('buy'); setAmount('') }}>Buy</button>
            <button aria-pressed={side === 'sell'} onClick={() => { setSide('sell'); setAmount('') }}>Sell</button>
          </div>

          <div className="amt amt-in">
            <div className="amt-top">
              <label className="amt-label" htmlFor={`tp-in-${mode}`}>You pay</label>
              <span className="amt-bal mono">{wallet.address ? `${holding === null ? '—' : fmt(holding, inDecimals)} ${payTicker}` : ''}</span>
            </div>
            <div className="amt-main">
              <input id={`tp-in-${mode}`} className="amt-num tp-num mono" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" inputMode="decimal" />
              <span className="tp-unit mono">{payTicker}</span>
            </div>
            <div className="tp-chips">
              {chips.map(([label, v]) => (
                <button key={label} className="tp-chip mono" aria-pressed={chipOn(v)} onClick={() => pick(v)} disabled={side === 'sell' && !(holding > 0n)}>{label}</button>
              ))}
              <button className="tp-chip" aria-pressed={holding > 0n && amountIn === holding} onClick={max} disabled={!(holding > 0n)}>Max</button>
            </div>
          </div>

          <div className="amt amt-out">
            <span className="amt-label">You receive (estimate)</span>
            <div className="amt-main">
              <span className={`amt-num tp-num mono${outText ? '' : ' amt-zero'}`}>{outText ? `≈ ${outText}` : '0'}</span>
              <span className="tp-unit mono">{getTicker}</span>
            </div>
          </div>

          <div className="swap-rows tp-rows">
            <div><span>Average price</span><span className="mono">{avg !== null ? fullPrice(avg) : '–'}</span></div>
            <div><span>Price after</span><span className="mono">{after !== null ? fullPrice(after) : '–'}</span></div>
            <div><span className="term" title="Set by the creator at launch, up to 10%, taken on every trade.">Creator fee</span><span className="mono">{(launch.feeBps / 100).toFixed(2)}%{amountIn > 0n && out > 0n ? ` · ${fmt(q.creatorFee, quoteDecimals)} ${quote}` : ''}</span></div>
            {side === 'buy' && tax > 0n && (
              <div><span>Anti-snipe tax</span><span className="mono">{(Number(tax) / 100).toFixed(1)}%{q.snipeTax > 0n ? ` · ${fmt(q.snipeTax, quoteDecimals)} ${quote}` : ''}</span></div>
            )}
          </div>
          {side === 'buy' && tax > 0n && <p className="why">The anti-snipe tax falls to zero within seconds of launch.</p>}

          <Cta state={cta} />
          {error && <p className="notice bad">{error}</p>}
          <p className="why">Need more {quote}? <Link to="/swap">Swap for it</Link>. Name, image and links are set by the creator.</p>
        </>
      )}

      <TxDialog
        flow={flow}
        title={`Review ${side}`}
        pay={{ value: `${amount || '0'} ${payTicker}` }}
        receive={{ value: `${outText ?? '0'} ${getTicker}` }}
        rows={[
          { k: 'Average price', v: avg !== null ? `${fullPrice(avg)} ${quote}` : '–' },
          { k: 'Price after', v: after !== null ? `${fullPrice(after)} ${quote}` : '–' },
          { k: `Creator fee (${(launch.feeBps / 100).toFixed(2)}%)`, v: `${fmt(q.creatorFee, quoteDecimals)} ${quote}` },
          ...(side === 'buy' && q.snipeTax > 0n ? [{ k: 'Anti-snipe tax', v: `${fmt(q.snipeTax, quoteDecimals)} ${quote}` }] : []),
          { k: 'Minimum received', v: 'No minimum set' },
          NETWORK_ROW,
        ]}
        technical={{ program: PAD_PROGRAM, extra: [{ k: 'Launch', v: `#${launch.id}` }] }}
        note={`Your wallet will ask you to sign. The amount can differ if someone else trades ${launch.symbol} before yours lands.`}
        needsAccounts={needsOpen}
        run={run}
        words={{
          pendingTitle: `${verb} submitted`,
          landed: `${verb} confirmed`,
          landedSub: outText ? `About ${outText} ${getTicker} is on its way to your wallet.` : undefined,
          failed: `${verb} failed`,
        }}
        onDone={() => { if (mode === 'sheet') onClose?.() }}
      />
    </section>
  )
}


/* ==========================================================================
   FAUCET
   ========================================================================== */

export function FaucetPage() {
  const wallet = useWallet()
  const [tab, pick] = useTab(['get', 'return'])

  return (
    <div className="page faucet-page">
      <div className="faucet-head">
        <h1 className="h1">Faucet</h1>
        <p className="lede">Test THRU, free, for this test network. It has no value and disappears when the network resets.</p>
        <div className="tabs" role="tablist">
          <button role="tab" className="tab-btn" aria-selected={tab === 'get'} onClick={() => pick('get')}>Get funds</button>
          <button role="tab" className="tab-btn" aria-selected={tab === 'return'} onClick={() => pick('return')}>Give it back</button>
        </div>
      </div>

      {tab === 'get' && (
        <>
          {wallet.unlocked && wallet.registered
            ? <TopUpCard />
            : (
              <section className="card">
                <h2 className="h3">{!hasWallet() ? 'Open a wallet first' : !wallet.unlocked ? 'Unlock your wallet first' : 'Register your wallet first'}</h2>
                <p className="why" style={{ marginTop: 6 }}>
                  {!hasWallet()
                    ? <><Link to="/get-wallet">Get a wallet</Link>, then come back to claim THRU.</>
                    : !wallet.unlocked
                      ? 'The faucet sends THRU to your wallet, so it needs to be unlocked first.'
                      : <>The faucet sends THRU to an account on chain, and this wallet has none yet. <Link to="/wallet">Register it on the Wallet page</Link>; ThruScan pays for that.</>}
                </p>
                {!hasWallet() && <button className="btn" style={{ marginTop: 12 }} onClick={connectWallet}><Icon name="wallet" size={18} />Connect wallet</button>}
                {hasWallet() && !wallet.unlocked && <button className="btn secondary" style={{ marginTop: 12 }} onClick={connectWallet}><Icon name="locked" size={18} />Unlock</button>}
              </section>
            )}

          <TerminalFaucet />

          <section className="card">
            <h2 className="h3">What to do with it</h2>
            <div className="rows" style={{ marginTop: 12 }}>
              <div className="row"><span><Link to="/swap">Wrap it into WTHRU</Link></span><span className="fine">On Swap, one for one</span></div>
              <div className="row"><span><Link to="/">Buy a launch</Link></span><span className="fine">On ThruPad, along a bonding curve</span></div>
              <div className="row"><span><Link to="/">Launch your own</Link></span><span className="fine">Create a token and earn a fee on every trade</span></div>
            </div>
          </section>
        </>
      )}

      {tab === 'return' && (
        wallet.unlocked
          ? <ReturnCard />
          : (
            <section className="card">
              <h2 className="h3">Unlock first</h2>
              <p className="why" style={{ marginTop: 6 }}>Unlock your wallet to return funds.</p>
            </section>
          )
      )}
    </div>
  )
}
