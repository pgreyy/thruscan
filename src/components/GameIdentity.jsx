// src/components/GameIdentity.jsx
//
// Replaces the games' "Claim a name" card.
//
// The old card asked you to claim a name in a registry that only the games use,
// and to copy an eight byte code around to move between devices. Both of those
// now have better answers elsewhere: your wallet is the identity and your .id
// is the name, so this card's job is to connect the two rather than to be a
// third one.
//
// What it does not do is delete anything. Someone playing as a guest keeps
// working exactly as before, because making people open a wallet before their
// first game of Wordle is how you lose them, and that was the original reason
// the separate system existed.

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useWallet } from '../pages/Wallet.jsx'
import { hasWallet } from '../lib/wallet.js'
import {
  playerCodeForWallet, currentPlayerCode, usePlayerCodeFromWallet, newGuestCode,
} from '../lib/gameid.js'
import { withSuffix, ROOT_SUFFIX } from '../lib/names.js'

const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '')

/** The first .id name this browser claimed for an address, if any. */
function localName(address) {
  if (!address) return null
  try {
    const held = JSON.parse(localStorage.getItem(`thruscan.names.${address}`) || '[]')
    return held.length ? held[0] : null
  } catch { return null }
}

export function GameIdentity({ registry, onChanged }) {
  const wallet = useWallet()
  const [code, setCode] = useState(() => currentPlayerCode())
  const [walletCode, setWalletCode] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  const label = localName(wallet.address)
  const registered = registry?.byId?.get(code) ?? null
  const following = Boolean(walletCode) && walletCode === code

  // Work out what this wallet's code would be, without switching to it. Knowing
  // the answer is what lets the card say "you are playing as someone else"
  // rather than silently taking over an identity the person may not want moved.
  useEffect(() => {
    let alive = true
    playerCodeForWallet().then((c) => { if (alive) setWalletCode(c) }).catch(() => {})
    return () => { alive = false }
  }, [wallet.unlocked, wallet.address])

  const follow = useCallback(async () => {
    setBusy('switch'); setError(null); setDone(null)
    try {
      const { code: next } = await usePlayerCodeFromWallet()
      if (!next) throw new Error('Unlock your wallet first.')
      setCode(next)
      setDone('Your games now follow this wallet. Restore it anywhere and your scores come with it.')
      onChanged?.()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(null)
    }
  }, [onChanged])

  /* Registering the .id in the games registry is still a write, because the
     games read names from their own account and cannot resolve a .id on chain
     themselves. This is a copy, not a second source of truth: the .id stays
     the thing that is actually yours. */
  const syncName = useCallback(async () => {
    if (!label) return
    setBusy('name'); setError(null); setDone(null)
    try {
      const res = await fetch('/api/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'register', playerId: code, name: label }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.detail ? `${data.error} (${data.detail})` : data.error)
      setDone(`Leaderboards will show ${withSuffix(label)}.`)
      onChanged?.()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(null)
    }
  }, [code, label, onChanged])

  const goGuest = () => {
    setCode(newGuestCode())
    setDone('Playing as a guest. Scores stay in this browser only.')
    onChanged?.()
  }

  /* ---------------------------------------------------------- no wallet */

  if (!hasWallet()) {
    return (
      <section className="card">
        <h2 className="h2">Playing as a guest</h2>
        <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
          Your scores are tied to this browser and nothing else, so clearing it loses them and
          they do not follow you to your phone.
        </p>
        <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
          <Link to="/wallet">Open a wallet</Link> and your games follow it instead: the same scores
          on every device you restore it on, and your .{ROOT_SUFFIX} name on the leaderboard rather
          than "Anonymous". It takes about fifteen seconds and you can keep playing either way.
        </p>
      </section>
    )
  }

  /* ------------------------------------------------- wallet, but locked */

  if (!wallet.unlocked) {
    return (
      <section className="card">
        <h2 className="h2">Unlock to play as yourself</h2>
        <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
          Your games identity comes from your wallet key, not from your address, so it cannot be
          worked out by anyone reading a leaderboard. That does mean the wallet has to be unlocked
          before the games know who you are. Until then you are playing as a guest.
        </p>
      </section>
    )
  }

  /* ------------------------------------------------------------ unlocked */

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="h2">
            {registered ? `You are ${registered}` : following ? 'Playing as your wallet' : 'Playing as a guest'}
          </h2>
          <p className="sub">
            {following
              ? 'Scores follow this wallet to any device'
              : 'Your scores are tied to this browser'}
          </p>
        </div>
      </div>

      <div className="rows" style={{ marginTop: 12 }}>
        <div className="row">
          <span>Wallet</span>
          <span className="mono">{short(wallet.address)}</span>
        </div>
        <div className="row">
          <span>Name on leaderboards</span>
          <b>{registered || (label ? withSuffix(label) : 'Anonymous')}</b>
        </div>
      </div>

      {!following && (
        <>
          <p className="fine" style={{ marginTop: 14, lineHeight: 1.65 }}>
            This browser is still playing under its own code rather than under your wallet.
            Switching moves future games onto the wallet, so restoring it anywhere brings them with
            it. Scores already recorded under the old code stay where they are: they belong to that
            code, and nothing here can move them without being able to prove both are you.
          </p>
          <button className="btn" style={{ marginTop: 12 }} onClick={follow} disabled={busy !== null}>
            {busy === 'switch' ? 'Switching' : 'Play as this wallet'}
          </button>
        </>
      )}

      {following && !registered && label && (
        <>
          <p className="fine" style={{ marginTop: 14, lineHeight: 1.65 }}>
            You hold <b>{withSuffix(label)}</b>. The games keep their own small list of names,
            because they read the leaderboard straight out of one account and cannot resolve a name
            through the name service while doing it. One click copies it across.
          </p>
          <button className="btn" style={{ marginTop: 12 }} onClick={syncName} disabled={busy !== null}>
            {busy === 'name' ? 'Saving' : `Use ${withSuffix(label)} on leaderboards`}
          </button>
        </>
      )}

      {following && !registered && !label && (
        <p className="fine" style={{ marginTop: 14, lineHeight: 1.65 }}>
          You show as Anonymous because no name points at this wallet yet.{' '}
          <Link to="/names">Claim a .{ROOT_SUFFIX} name</Link> and it becomes your username here,
          on the wall, and anywhere else that has to call you something.
        </p>
      )}

      {error && <p className="notice bad" style={{ marginTop: 14 }}>{error}</p>}
      {done && <p className="notice" style={{ marginTop: 14 }}>{done}</p>}

      <details style={{ marginTop: 16 }}>
        <summary className="fine">Play as a guest instead</summary>
        <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
          Starts a fresh anonymous identity in this browser only. Your wallet's scores are not
          touched and switching back returns to them, because the wallet's code is derived rather
          than stored.
        </p>
        <button className="btn ghost" style={{ marginTop: 10 }} onClick={goGuest} disabled={busy !== null}>
          Start a guest identity
        </button>
      </details>
    </section>
  )
}

export default GameIdentity
