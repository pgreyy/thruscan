// src/pages/Names.jsx
//
// ThruNames. A `.id` name for a Thru account, claimed in one click and free.
//
// It runs on Thru's own name service rather than a program of ours, so a name
// registered here is a fact about the chain that any other explorer or wallet
// can read. We do not own `.thru`, which is Unto Labs', so ThruScan runs its own
// root and the suffix is `.id`.
//
// The division of labour is worth understanding before reading the code, because
// it is what makes free names honest:
//
//   Claiming is sponsored. Registering under a root needs the root's authority,
//   and a Thru transaction carries one signature, so ThruScan has to sign and
//   pay. What stops every name ending up owned by ThruScan is that the
//   instruction takes the owner as an account index, so the visitor's wallet
//   goes in the owner field.
//
//   Records are not sponsored. The name service checks the domain's owner
//   before it writes, and that is the visitor. So they sign their own records,
//   and ThruScan cannot edit a name it gave away.

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  nameProblem, withSuffix, decodeDomain, addressOf, ROOT_SUFFIX,
} from '../lib/names.js'
import { checkName, claimName, setNameRecord, waitForResult } from '../lib/wallet.js'
import { useWallet } from './Wallet.jsx'
import { useUnlockGate, isDismissal } from '../components/Unlock.jsx'
import { hasWallet } from '../lib/wallet.js'
import { ownedNames } from '../lib/holdings.js'

const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '')

function decodeBase64(b64) {
  if (!b64) return null
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/* ---------- claiming ---------- */

/**
 * Claiming, and re-finding.
 *
 * Names are not indexed by owner on chain: a domain account records who owns
 * it, but nothing maps an owner back to their domains, and there is no way to
 * ask the node for one without scanning every account of the right size, which
 * is far too slow for a page load. I tried; it does not finish.
 *
 * So this browser keeps a list of the names claimed through it, and that list
 * is a cache, not the truth. The truth is on chain. The catch was that a second
 * device has an empty cache, so your own names looked like they did not exist,
 * which is exactly what happened on the phone.
 *
 * The fix is to let you rebuild the cache by naming what you already own. Type
 * it, and if it is taken by YOUR wallet, the card says so and offers to add it
 * back here. The chain decides; the browser just remembers.
 */
function Claim({ wallet, onClaimed }) {
  const gate = useUnlockGate()
  const [name, setName] = useState('')
  const [state, setState] = useState(null)   // { taken, account } | null
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const problem = name ? nameProblem(name) : null

  // Check as they type, but only once they stop, so a five-letter name is one
  // request rather than five.
  useEffect(() => {
    setState(null); setError(null)
    if (!name || problem) return
    let cancelled = false
    setChecking(true)
    const t = setTimeout(async () => {
      try {
        const r = await checkName(name)
        // A taken name is not necessarily someone else's. Decode the domain and
        // see whose it is, so "taken" can become "yours" where that is true.
        if (r?.taken && r?.data) {
          try {
            const domain = decodeDomain(decodeBase64(r.data))
            const holder = domain && (addressOf(domain) || domain.owner)
            r.mine = Boolean(holder) && holder === wallet.address
          } catch { /* if it will not decode, leave it as simply taken */ }
        }
        if (!cancelled) setState(r)
      } catch { /* leave it unknown rather than claiming it is free */ }
      finally { if (!cancelled) setChecking(false) }
    }, 350)
    return () => { cancelled = true; clearTimeout(t); setChecking(false) }
  }, [name, problem])

  const claim = async () => {
    setError(null)
    // Ask for the password here rather than sending them to another page and
    // leaving them there. Claiming is one action and should feel like one.
    try { await gate.ensure() } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return
    }
    setBusy(true)
    try {
      const r = await claimName(name)
      if (!r.ok) throw new Error(r.error)
      // Registration lands a slot or two later.
      await new Promise((res) => setTimeout(res, 3000))
      onClaimed?.(name)
      setName('')
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
          <h2 className="h2">Claim a name</h2>
          <p className="sub">Free, and yours on chain</p>
        </div>
      </div>

      <div className="stack" style={{ marginTop: 16 }}>
        {/* The verdict sits in the field rather than under it. It was already
            being checked on every keystroke, but a grey line of small text
            below the box reads as a hint rather than as an answer, so people
            typed a name, saw nothing they recognised as a result, and went
            looking for a separate lookup box to do the same job. */}
        <div className="name-field" data-state={
          problem ? 'invalid'
            : !name ? 'empty'
            : checking ? 'checking'
            : state?.mine ? 'yours'
            : state?.taken ? 'taken'
            : state ? 'free'
            : 'empty'
        }>
          <input
            className="field mono"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().trim())}
            placeholder="yourname"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="name-verdict"
          />
          <span className="name-suffix mono">.{ROOT_SUFFIX}</span>
          <span className="name-verdict" id="name-verdict" role="status">
            {problem ? 'not allowed'
              : !name ? ''
              : checking ? 'checking'
              : state?.mine ? 'yours'
              : state?.taken ? 'taken'
              : state ? 'available'
              : ''}
          </span>
        </div>

        {problem && <p className="fine">{problem}</p>}

        {!problem && name && state?.taken && !state?.mine && (
          <p className="fine">
            Taken. Try another.
          </p>
        )}

        {!problem && name && state?.mine && (
          <>
            <p className="fine" style={{ lineHeight: 1.65 }}>
              Registered to this wallet. Add it to this browser, free.
            </p>
            <button className="btn" onClick={() => { onClaimed?.(name); setName('') }}>
              Add {withSuffix(name)} to this browser
            </button>
          </>
        )}

        {!hasWallet() && (
          <p className="fine">
            <Link to="/wallet">Open a wallet</Link> to claim one.
          </p>
        )}

        {hasWallet() && wallet.unlocked && !wallet.registered && (
          <p className="fine">
            <Link to="/wallet">Register your wallet</Link> first.
          </p>
        )}

        {hasWallet() && !state?.mine && (wallet.unlocked ? wallet.registered : true) && (
          <button
            className="btn"
            onClick={claim}
            disabled={busy || checking || !state || state.taken || !!problem}
          >
            {busy ? 'Claiming' : name ? `Claim ${withSuffix(name)}` : 'Claim'}
          </button>
        )}
      </div>

      {gate.modal}

      {error && <p className="notice bad" style={{ marginTop: 14 }}>{error}</p>}

      <p className="fine" style={{ marginTop: 14, lineHeight: 1.65 }}>
        a-z, 0-9 and hyphens, 3 to 32 characters.
      </p>
    </section>
  )
}

/* ---------- looking one up ---------- */

function Lookup() {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const look = async () => {
    const clean = query.trim().toLowerCase().replace(new RegExp(`\\.${ROOT_SUFFIX}$`), '')
    if (!clean) return
    setBusy(true); setError(null); setResult(null)
    try {
      const r = await checkName(clean)
      if (!r.ok) throw new Error(r.error)
      if (!r.taken) { setError(`${withSuffix(clean)} is not registered.`); return }
      setResult({ ...decodeDomain(decodeBase64(r.data)), account: r.account })
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2 className="h2">Look one up</h2>
      <div className="stack" style={{ marginTop: 14 }}>
        <div className="inline">
          <input
            className="field mono"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setError(null); setResult(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter') look() }}
            placeholder={`someone.${ROOT_SUFFIX}`}
          />
          <button className="btn ghost" onClick={look} disabled={busy || !query.trim()}>
            {busy ? 'Looking' : 'Resolve'}
          </button>
        </div>
      </div>

      {error && <p className="notice bad" style={{ marginTop: 14 }}>{error}</p>}

      {result && (
        <div className="rows" style={{ marginTop: 14 }}>
          <div className="row"><span>Name</span><b className="mono">{withSuffix(result.name)}</b></div>
          <div className="row">
            <span>Owner</span>
            <Link className="mono" to={`/account/${result.owner}`}>{short(result.owner)}</Link>
          </div>
          <div className="row">
            <span>Resolves to</span>
            <span className="mono">{short(addressOf(result))}</span>
          </div>
          {result.records.map((r) => (
            <div className="row" key={r.key}>
              <span>{r.key}</span>
              <span className="mono" style={{ wordBreak: 'break-all' }}>{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/* ---------- names you own ----------
   One card, one row per name. A row opens to show its records and the two
   things you can do with it. */

function NameItem({ domain, account, wallet, onChanged }) {
  const gate = useUnlockGate()
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const add = async (k, v) => {
    setError(null)
    try { await gate.ensure() } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return
    }
    setBusy(true)
    try {
      const sig = await setNameRecord(account, k, v)
      const r = await waitForResult(sig)
      if (r.settled && !r.succeeded) throw new Error(`The chain rejected it (error ${r.userError || r.vmError}).`)
      setKey(''); setValue('')
      await new Promise((res) => setTimeout(res, 2500))
      onChanged?.()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const addr = domain.records.find((r) => r.key === 'addr')?.value
  const others = domain.records.filter((r) => r.key !== 'addr')

  return (
    <details className="name-item">
      <summary className="name-row">
        <b className="mono">{withSuffix(domain.name)}</b>
        <span className="fine mono">{addr ? `→ ${short(addr)}` : 'no address set'}</span>
      </summary>

      <div className="name-body">
        {!addr && (
          <button className="btn" onClick={() => add('addr', wallet.address)} disabled={busy}>
            {busy ? 'Signing' : 'Point it at my wallet'}
          </button>
        )}

        {others.length > 0 && (
          <div className="rows">
            {others.map((r) => (
              <div className="row" key={r.key}>
                <span>{r.key}</span>
                <span className="mono" style={{ wordBreak: 'break-all' }}>{r.value}</span>
              </div>
            ))}
          </div>
        )}

        <div className="inline name-add">
          <input className="field mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="key, e.g. x" />
          <input className="field mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" />
          <button className="btn ghost" onClick={() => add(key.trim(), value.trim())} disabled={busy || !key.trim() || !value.trim()}>
            {busy ? 'Signing' : 'Add'}
          </button>
        </div>

        {error && <p className="notice bad">{error}</p>}
      </div>
      {gate.modal}
    </details>
  )
}

/* ---------- the page ---------- */

export function NamesPage() {
  const wallet = useWallet()
  const [mine, setMine] = useState([])   // [{ name, account, domain }]

  /* Names are not indexed by owner on chain, so this browser remembers which
     ones it claimed. Losing that list loses nothing: the names are still yours,
     and Look one up finds them. Storing the NAME rather than the account is
     what makes them re-readable, since the check endpoint is keyed by name. */
  const storeKey = wallet.address ? `thruscan.names.${wallet.address}` : null

  const remember = useCallback((name) => {
    if (!storeKey) return
    try {
      const held = JSON.parse(localStorage.getItem(storeKey) || '[]')
      if (!held.includes(name)) localStorage.setItem(storeKey, JSON.stringify([...held, name]))
    } catch { /* private mode; the name is still registered */ }
  }, [storeKey])

  /* The chain first: a name registration names its owner, so this wallet's own
     history lists every name it claimed, on any device. The browser's list is
     added in case the history is too long to reach back that far. Each name is
     then checked for its current owner, so a moved name drops off. */
  const load = useCallback(async () => {
    if (!storeKey) { setMine([]); return }
    let names = []
    try { names = JSON.parse(localStorage.getItem(storeKey) || '[]') } catch {}
    const rows = await ownedNames(wallet.address, names).catch(() => null)
    if (!rows) return   // a failed read is not an empty list; keep what we had
    // Keep the order this browser already had, so the first name stays first.
    const rank = (n) => { const i = names.indexOf(n); return i < 0 ? names.length : i }
    rows.sort((a, b) => rank(a.name) - rank(b.name))
    try { localStorage.setItem(storeKey, JSON.stringify(rows.map((r) => r.name))) } catch {}
    setMine(rows)
  }, [storeKey, wallet.address])

  useEffect(() => { load() }, [load])

  const claimed = useCallback(async (name) => {
    remember(name)
    await load()
  }, [remember, load])

  return (
    <div className="wrap">
      <h1 className="h1">Names</h1>
      <p className="lede">A readable <span className="mono">.{ROOT_SUFFIX}</span> name for your address, on Thru's name service.</p>

      <Claim wallet={wallet} onClaimed={claimed} />

      {mine.length > 0 && (
        <section className="card">
          <h2 className="h2">Your names</h2>
          <div className="name-list">
            {mine.map(({ account, domain }) => domain && (
              <NameItem key={account} account={account} domain={domain} wallet={wallet} onChanged={load} />
            ))}
          </div>
        </section>
      )}

      {/* The lookup card is gone. It asked for a name and told you whether it
          was taken, which is exactly what the claim field above does while you
          type, so it was a second answer to a question already answered. */}

    </div>
  )
}
