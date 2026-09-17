// src/pages/Wallet.jsx
//
// The wallet page, plus the small pieces the Swap and Launchpad pages use to
// turn a quote into a button.
//
// The key is made in this browser, encrypted with a password only the visitor
// knows, and kept in localStorage. Nothing here ever sends it anywhere. What
// the server does see is a public key, a signature, and finished transaction
// bytes it can forward but not alter.
//
// Two things about the shape of this that are worth knowing before reading it:
//
//   A wallet address holds no tokens. Balances live in token accounts, one per
//   mint, at an address fixed by owner and mint. So the page can show every
//   balance without asking the visitor to paste anything, and "open an account"
//   is a real step with a real cost rather than a formality.
//
//   Registering and opening are paid for by the sponsor; trading is not. A Thru
//   transaction carries one signature, the fee payer's, so the only way to spend
//   your tokens is to be the fee payer, and the only way to do that is to hold
//   the key. That is the whole security model, and it is why this is worth
//   building rather than faking with a shared account.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createWallet, importWallet, unlock, locked, forgetWallet,
  hasWallet, storedWallet, isUnlocked, currentAddress,
  registerAndFund, openTokenAccount, tokenBalances, accountExists,
  deriveTokenAccount, exportPrivateKey, signAndSend, waitForResult,
  claimNativeThru, claimTusd, nativeBalance,
} from '../lib/wallet.js'
import { TUSD_MINT } from '../lib/addresses.js'

const DECIMALS = 6

/* ---------- a tiny shared store ----------
   The wallet is one thing, and several pages show it at once. Rather than pass
   callbacks down or reach for a state library, this keeps one object and tells
   subscribers when it changes. */

const listeners = new Set()
let state = {
  address: currentAddress(),
  unlocked: isUnlocked(),
  registered: false,
  native: 0n,          // native THRU, which is what pays fees
  balances: {},        // mint -> { account, exists, amount (BigInt) }
}

function setState(patch) {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn(state))
}

export function useWallet() {
  const [snapshot, setSnapshot] = useState(state)
  useEffect(() => {
    listeners.add(setSnapshot)
    setSnapshot(state)
    return () => listeners.delete(setSnapshot)
  }, [])

  const refresh = useCallback(async (mints = []) => {
    if (!isUnlocked()) return
    const wanted = Array.from(new Set([TUSD_MINT, ...mints, ...Object.keys(state.balances)]))
    try {
      const [registered, native, rows] = await Promise.all([
        accountExists(currentAddress()),
        nativeBalance().catch(() => 0n),
        wanted.length ? tokenBalances(wanted) : Promise.resolve([]),
      ])
      const balances = { ...state.balances }
      for (const r of rows) {
        balances[r.mint] = { account: r.account, exists: r.exists, amount: BigInt(r.amount) }
      }
      setState({ registered, native, balances, address: currentAddress(), unlocked: true })
    } catch { /* leave what we had; a failed refresh is not a failed wallet */ }
  }, [])

  return { ...snapshot, refresh, setState }
}

export function notifyWalletChanged(patch) { setState(patch) }

/* ---------- formatting ---------- */

function fmt(units, decimals = DECIMALS, maxFrac = 4) {
  const n = Number(units ?? 0n) / 10 ** decimals
  if (!isFinite(n)) return '0'
  if (n !== 0 && Math.abs(n) < 10 ** -maxFrac) return `<${10 ** -maxFrac}`
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac })
}

const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '')

function Copyable({ text, label }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="btn ghost"
      onClick={() => {
        navigator.clipboard?.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1400)
      }}
    >
      {done ? 'Copied' : label}
    </button>
  )
}

/* ---------- setup ---------- */

function CreateWallet({ onDone }) {
  const [mode, setMode] = useState('create')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [keyHex, setKeyHex] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const go = async () => {
    setError(null)
    if (password.length < 8) return setError('Use a password of at least 8 characters.')
    if (mode === 'create' && password !== confirm) return setError('The two passwords do not match.')
    setBusy(true)
    try {
      const { address } = mode === 'create'
        ? await createWallet(password)
        : await importWallet(keyHex, password)
      setState({ address, unlocked: true, registered: false, balances: {} })
      onDone?.()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="h2">{mode === 'create' ? 'Create a wallet' : 'Import a key'}</h2>
          <p className="sub">
            {mode === 'create'
              ? 'Made in this browser, encrypted with your password'
              : 'Use a key you already have, so the CLI and the browser are one account'}
          </p>
        </div>
        <button className="btn ghost" onClick={() => { setMode(mode === 'create' ? 'import' : 'create'); setError(null) }}>
          {mode === 'create' ? 'I have a key' : 'Make a new one'}
        </button>
      </div>

      <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
        The private key is generated here and never leaves this browser. It is encrypted with your
        password before it is stored, so anyone reading this browser's storage gets ciphertext.
        There is no reset: if you forget the password the key is gone, which is why the export
        button exists.
      </p>

      <div className="stack" style={{ marginTop: 16 }}>
        {mode === 'import' && (
          <input
            className="field mono"
            value={keyHex}
            onChange={(e) => { setKeyHex(e.target.value); setError(null) }}
            placeholder="Private key, 64 hex characters"
            autoComplete="off"
            spellCheck={false}
          />
        )}
        <input
          className="field"
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(null) }}
          placeholder="Password"
          autoComplete="new-password"
        />
        {mode === 'create' && (
          <input
            className="field"
            type="password"
            value={confirm}
            onChange={(e) => { setConfirm(e.target.value); setError(null) }}
            placeholder="Password again"
            autoComplete="new-password"
          />
        )}
        <button className="btn" onClick={go} disabled={busy || !password}>
          {busy ? 'Working' : mode === 'create' ? 'Create wallet' : 'Import key'}
        </button>
      </div>

      {error && <p className="notice bad" style={{ marginTop: 14 }}>{error}</p>}

      <p className="fine" style={{ marginTop: 14 }}>
        This is alphanet. Everything here is a test token with no value, and every account
        disappears when the network resets from genesis. Do not reuse a password you care about.
      </p>
    </section>
  )
}

function UnlockWallet({ onDone }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const stored = storedWallet()

  const go = async () => {
    setBusy(true); setError(null)
    try {
      const { address } = await unlock(password)
      setState({ address, unlocked: true })
      onDone?.()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="h2">Unlock</h2>
          <p className="sub mono">{short(stored?.address)}</p>
        </div>
      </div>
      <div className="stack" style={{ marginTop: 16 }}>
        <input
          className="field"
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && password) go() }}
          placeholder="Password"
          autoComplete="current-password"
          autoFocus
        />
        <button className="btn" onClick={go} disabled={busy || !password}>
          {busy ? 'Unlocking' : 'Unlock'}
        </button>
      </div>
      {error && <p className="notice bad" style={{ marginTop: 14 }}>{error}</p>}
      <p className="fine" style={{ marginTop: 14 }}>
        Lost the password? There is no way back into this key. You can{' '}
        <button
          className="btn ghost"
          style={{ padding: '2px 8px' }}
          onClick={() => {
            if (confirm('This deletes the stored key. If you did not export it, it is gone for good. Continue?')) {
              forgetWallet()
              setState({ address: null, unlocked: false, registered: false, balances: {} })
            }
          }}
        >
          start over
        </button>{' '}
        with a new one.
      </p>
    </section>
  )
}

/* ---------- the live wallet ---------- */

function Balances({ wallet, mints }) {
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const open = async (mint) => {
    setBusy(mint); setError(null)
    try {
      await openTokenAccount(mint)
      // The account lands a slot or two later, so give the chain a moment
      // rather than showing "missing" immediately after opening it.
      await new Promise((r) => setTimeout(r, 2500))
      await wallet.refresh(mints.map((m) => m.mint))
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="h2">Balances</h2>
          <p className="sub">One account per token, at an address fixed by you and the mint</p>
        </div>
        <button className="btn ghost" onClick={() => wallet.refresh(mints.map((m) => m.mint))}>Refresh</button>
      </div>

      <div className="rows" style={{ marginTop: 12 }}>
        {mints.map(({ mint, ticker }) => {
          const row = wallet.balances[mint]
          return (
            <div className="row" key={mint}>
              <span>
                <b>{ticker}</b>{' '}
                <span className="fine mono">{short(row?.account ?? '')}</span>
              </span>
              {row?.exists
                ? <b className="mono">{fmt(row.amount)}</b>
                : (
                  <button className="btn ghost" onClick={() => open(mint)} disabled={busy === mint}>
                    {busy === mint ? 'Opening' : 'Open account'}
                  </button>
                )}
            </div>
          )
        })}
      </div>

      {error && <p className="notice bad" style={{ marginTop: 14 }}>{error}</p>}
      <p className="fine" style={{ marginTop: 12 }}>
        Opening an account is paid for by ThruScan. Trading is not: a Thru transaction carries one
        signature, the fee payer's, so your tokens only move when you sign for them yourself.
      </p>
    </section>
  )
}

/**
 * Two currencies, two buttons, and they are genuinely different things.
 *
 * tUSD is our test token: it is what pools and launches are priced in, and
 * ThruScan mints it. THRU is the network's own asset, it is what pays fees, and
 * it comes from Thru's faucet rather than from us. The wallet claims that one
 * for itself, signing and paying for the claim, because the faucet pays
 * whoever paid the fee and so cannot be pointed at anybody else.
 */
export function TopUpCard() {
  const wallet = useWallet()
  const [busy, setBusy] = useState(null)
  const [note, setNote] = useState(null)
  const [error, setError] = useState(null)

  const claimTokens = async () => {
    setBusy('tusd'); setError(null); setNote(null)
    try {
      const j = await claimTusd()
      setNote(`${fmt(j.amount)} tUSD on the way.`)
      await new Promise((r) => setTimeout(r, 2500))
      await wallet.refresh()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(null)
    }
  }

  const claimGas = async () => {
    setBusy('thru'); setError(null); setNote(null)
    try {
      await claimNativeThru()
      setNote('10,000 THRU on the way. That is what pays your transaction fees.')
      await new Promise((r) => setTimeout(r, 3000))
      await wallet.refresh()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="h2">Top up</h2>
          <p className="sub">tUSD to trade with, THRU to pay fees with</p>
        </div>
      </div>

      <div className="rows" style={{ marginTop: 12 }}>
        <div className="row">
          <span>
            <b>tUSD</b>{' '}
            <span className="fine">what pools and launches are priced in</span>
          </span>
          <button className="btn" onClick={claimTokens} disabled={busy !== null}>
            {busy === 'tusd' ? 'Sending' : 'Claim 1,000'}
          </button>
        </div>
        <div className="row">
          <span>
            <b>THRU</b>{' '}
            <span className="fine">
              the network's own asset, {wallet.native?.toString() ?? '0'} held
            </span>
          </span>
          <button className="btn ghost" onClick={claimGas} disabled={busy !== null}>
            {busy === 'thru' ? 'Claiming' : 'Claim 10,000'}
          </button>
        </div>
      </div>

      {note && <p className="notice" style={{ marginTop: 14 }}>{note}</p>}
      {error && <p className="notice bad" style={{ marginTop: 14 }}>{error}</p>}

      <p className="fine" style={{ marginTop: 12, lineHeight: 1.65 }}>
        tUSD is capped at one claim per account every six hours, and opens your token account for
        you if you do not have one. THRU comes from Thru's own faucet rather than from ThruScan, so
        it is capped at 10,000 a time by the network and you can come back for more.
      </p>
    </section>
  )
}

function Danger({ wallet }) {
  const [shown, setShown] = useState(null)

  return (
    <section className="card">
      <h2 className="h2">Your key</h2>
      <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
        Export it and you can use the same account from the CLI, or bring it back after clearing
        this browser. Anyone who sees it controls the account, so treat the screen as public.
      </p>

      <div className="form-row" style={{ marginTop: 14, gap: 10, flexWrap: 'wrap' }}>
        <button className="btn ghost" onClick={() => setShown(shown ? null : exportPrivateKey())}>
          {shown ? 'Hide key' : 'Show private key'}
        </button>
        <button
          className="btn ghost"
          onClick={() => { locked(); setState({ unlocked: false, balances: {} }) }}
        >
          Lock
        </button>
        <button
          className="btn ghost"
          onClick={() => {
            if (confirm('This deletes the key from this browser. Export it first if you want it back. Continue?')) {
              forgetWallet()
              setState({ address: null, unlocked: false, registered: false, balances: {} })
            }
          }}
        >
          Forget this wallet
        </button>
      </div>

      {shown && (
        <div className="stack" style={{ marginTop: 14 }}>
          <div className="codewrap"><code className="mono" style={{ wordBreak: 'break-all' }}>{shown}</code></div>
          <Copyable text={shown} label="Copy private key" />
        </div>
      )}
    </section>
  )
}

const STEP_LABEL = {
  registering: 'Registering',
  waiting: 'Waiting for the chain',
  funding: 'Claiming THRU for fees',
}

function LiveWallet({ wallet, mints }) {
  const [step, setStep] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => { wallet.refresh(mints.map((m) => m.mint)) /* eslint-disable-next-line */ }, [])

  const register = async () => {
    setStep('registering'); setError(null)
    try {
      await registerAndFund(setStep)
      await wallet.refresh(mints.map((m) => m.mint))
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setStep(null)
    }
  }

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div>
            <p className="eyebrow">Your address</p>
            <h2 className="h2 mono" style={{ wordBreak: 'break-all' }}>{wallet.address}</h2>
          </div>
          <Copyable text={wallet.address} label="Copy address" />
        </div>

        {!wallet.registered && (
          <>
            <p className="fine" style={{ marginTop: 12, lineHeight: 1.65 }}>
              This key exists, but it has no account on chain yet. A brand new key cannot pay its
              own way into existence, so ThruScan pays for that one transaction. It is authorised by
              a signature made here with your key, which names this chain and this payer, so it
              cannot be reused for anything else. Straight after, the wallet claims THRU from Thru's
              own faucet and starts paying its own fees.
            </p>
            <button className="btn" style={{ marginTop: 14 }} onClick={register} disabled={step !== null}>
              {step ? `${STEP_LABEL[step] ?? 'Working'}…` : 'Register on chain'}
            </button>
          </>
        )}

        {wallet.registered && (
          <div className="rows" style={{ marginTop: 12 }}>
            <div className="row"><span>Status</span><b>Live on alphanet</b></div>
            <div className="row">
              <span>Fees</span>
              <b className="mono">
                {wallet.native > 0n ? `${wallet.native.toString()} THRU` : 'unfunded, paying zero'}
              </b>
            </div>
            <div className="row">
              <span>Explorer</span>
              <a className="mono" href={`/account/${wallet.address}`}>{short(wallet.address)}</a>
            </div>
          </div>
        )}

        {error && <p className="notice bad" style={{ marginTop: 14 }}>{error}</p>}
      </section>

      {wallet.registered && <TopUpCard />}
      {wallet.registered && <Balances wallet={wallet} mints={mints} />}
      <Danger wallet={wallet} />
    </>
  )
}

/* ---------- the page ---------- */

export function WalletPage() {
  const wallet = useWallet()
  const [, bump] = useState(0)
  const mints = useMemo(() => {
    const known = [{ mint: TUSD_MINT, ticker: 'tUSD' }]
    for (const mint of Object.keys(wallet.balances)) {
      if (!known.some((k) => k.mint === mint)) known.push({ mint, ticker: short(mint) })
    }
    return known
  }, [wallet.balances])

  return (
    <div className="wrap">
      <p className="eyebrow">Beta</p>
      <h1 className="h1">Wallet</h1>
      <p className="lede">
        A wallet that lives in this browser, so you can trade on ThruScan without a terminal. The
        key is made here and encrypted with your password before it is stored. It is never sent
        anywhere, and no part of ThruScan can move your tokens: every trade is signed by you.
      </p>

      {!hasWallet() && <CreateWallet onDone={() => bump((n) => n + 1)} />}
      {hasWallet() && !wallet.unlocked && <UnlockWallet onDone={() => bump((n) => n + 1)} />}
      {hasWallet() && wallet.unlocked && <LiveWallet wallet={wallet} mints={mints} />}

      <section className="card">
        <h2 className="h2">What this is, and what it is not</h2>
        <div className="rows" style={{ marginTop: 12 }}>
          <div className="row">
            <span>Custody</span>
            <span className="fine">Yours. The key is in this browser and nowhere else</span>
          </div>
          <div className="row">
            <span>Recovery</span>
            <span className="fine">Only by exporting the key. There is no reset</span>
          </div>
          <div className="row">
            <span>Paid for by ThruScan</span>
            <span className="fine">Registering, and opening token accounts</span>
          </div>
          <div className="row">
            <span>Paid for and signed by you</span>
            <span className="fine">Every swap, buy, sell and launch</span>
          </div>
          <div className="row">
            <span>When mainnet comes</span>
            <span className="fine">Export the key, or move to Privy or Thru's own wallet</span>
          </div>
        </div>
      </section>
    </div>
  )
}

/* ---------- what the trading pages use ---------- */

/**
 * Sign and send one of the builder payloads from swap.js or pad.js, then wait
 * for the chain's verdict. Returns { signature, succeeded }.
 *
 * The builders already sort the accounts and derive their indices from the
 * sorted order, so their readWrite and readOnly go straight through.
 */
export async function sendBuilt(program, built) {
  const signature = await signAndSend({
    program,
    readWrite: built.readWrite,
    readOnly: built.readOnly,
    data: built.data,
  })
  const result = await waitForResult(signature)
  return { signature, ...result }
}

export { deriveTokenAccount, openTokenAccount, isUnlocked, currentAddress }
