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
  registerOnChain, openTokenAccount, tokenBalances, accountExists,
  deriveTokenAccount, exportPrivateKey, signAndSend, waitForResult,
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
      const [registered, rows] = await Promise.all([
        accountExists(currentAddress()),
        wanted.length ? tokenBalances(wanted) : Promise.resolve([]),
      ])
      const balances = { ...state.balances }
      for (const r of rows) {
        balances[r.mint] = { account: r.account, exists: r.exists, amount: BigInt(r.amount) }
      }
      setState({ registered, balances, address: currentAddress(), unlocked: true })
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

function Faucet({ wallet }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  const [error, setError] = useState(null)
  const tusd = wallet.balances[TUSD_MINT]

  const claim = async () => {
    setBusy(true); setError(null); setNote(null)
    try {
      let account = tusd?.account
      if (!tusd?.exists) {
        const opened = await openTokenAccount(TUSD_MINT)
        account = opened.account
        await new Promise((r) => setTimeout(r, 2500))
      }
      const r = await fetch('/api/faucet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'That did not go through.')
      setNote(`${fmt(j.amount)} tUSD on the way.`)
      await new Promise((r) => setTimeout(r, 2500))
      await wallet.refresh()
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
          <h2 className="h2">Get tUSD</h2>
          <p className="sub">The test currency every pool and every launch is priced in</p>
        </div>
        <button className="btn" onClick={claim} disabled={busy}>
          {busy ? 'Sending' : 'Claim 1,000 tUSD'}
        </button>
      </div>
      {note && <p className="notice" style={{ marginTop: 14 }}>{note}</p>}
      {error && <p className="notice bad" style={{ marginTop: 14 }}>{error}</p>}
      <p className="fine" style={{ marginTop: 12 }}>
        One claim per account every six hours. If you have no tUSD account yet, this opens one first.
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

function LiveWallet({ wallet, mints }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => { wallet.refresh(mints.map((m) => m.mint)) /* eslint-disable-next-line */ }, [])

  const register = async () => {
    setBusy(true); setError(null)
    try {
      await registerOnChain()
      for (let i = 0; i < 10 && !state.registered; i++) {
        await new Promise((r) => setTimeout(r, 1800))
        await wallet.refresh(mints.map((m) => m.mint))
        if (state.registered) break
      }
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(false)
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
              cannot be reused for anything else.
            </p>
            <button className="btn" style={{ marginTop: 14 }} onClick={register} disabled={busy}>
              {busy ? 'Registering' : 'Register on chain'}
            </button>
          </>
        )}

        {wallet.registered && (
          <div className="rows" style={{ marginTop: 12 }}>
            <div className="row"><span>Status</span><b>Live on alphanet</b></div>
            <div className="row">
              <span>Explorer</span>
              <a className="mono" href={`/account/${wallet.address}`}>{short(wallet.address)}</a>
            </div>
          </div>
        )}

        {error && <p className="notice bad" style={{ marginTop: 14 }}>{error}</p>}
      </section>

      {wallet.registered && <Faucet wallet={wallet} />}
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
