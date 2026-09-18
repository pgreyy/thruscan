// src/components/Unlock.jsx
//
// Asking for the password where you are, instead of somewhere else.
//
// The old flow sent people to the Wallet page to unlock and left them there,
// which is bad on its own and was made worse by a second bug: every internal
// link was a plain <a href>, so each one was a full page load, and a full page
// load wipes the key from memory. Unlocking on one page and acting on another
// was therefore impossible by construction. The links are now router links, and
// this is the prompt that appears in place.
//
// The key still only lives in memory. Nothing here writes it anywhere, so
// closing the tab still locks the wallet, which is the behaviour a wallet
// should have.
//
// Usage:
//
//   const gate = useUnlockGate()
//   ...
//   await gate.ensure()      // resolves once unlocked, rejects if dismissed
//   ...
//   {gate.modal}             // render once, anywhere in the component

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { unlock, isUnlocked, hasWallet, storedWallet } from '../lib/wallet.js'
import { notifyWalletChanged } from '../pages/Wallet.jsx'

const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '')

function Modal({ onDone, onCancel }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onCancel])

  const go = async () => {
    setBusy(true); setError(null)
    try {
      const { address } = await unlock(password)
      notifyWalletChanged({ address, unlocked: true })
      onDone()
    } catch (e) {
      setError(String(e?.message ?? e))
      setBusy(false)
    }
  }

  return createPortal(
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Unlock your wallet">
        <h2 className="h2">Unlock</h2>
        <p className="sub mono" style={{ marginTop: 4 }}>{short(storedWallet()?.address)}</p>

        <input
          ref={inputRef}
          className="field"
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && password) go() }}
          placeholder="Password"
          autoComplete="current-password"
          style={{ marginTop: 16 }}
        />

        <div className="inline" style={{ marginTop: 12 }}>
          <button className="btn" onClick={go} disabled={busy || !password} style={{ flex: 1 }}>
            {busy ? 'Unlocking' : 'Unlock'}
          </button>
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
        </div>

        {error && <p className="notice bad" style={{ marginTop: 12 }}>{error}</p>}

        <p className="fine" style={{ marginTop: 14, lineHeight: 1.6 }}>
          The key stays in this tab only. Closing it locks the wallet again, which is what a wallet
          should do.
        </p>
      </div>
    </div>,
    document.body,
  )
}

/**
 * A promise that resolves once the wallet is usable.
 *
 * Resolves immediately when it already is, shows the prompt when it is not, and
 * rejects with a recognisable error when there is no wallet at all or the
 * person dismisses it. Callers should treat a rejection as "they changed their
 * mind" rather than as a failure worth shouting about.
 */
export function useUnlockGate() {
  const [pending, setPending] = useState(null)

  const ensure = useCallback(() => {
    if (isUnlocked()) return Promise.resolve(true)
    if (!hasWallet()) return Promise.reject(new Error('NO_WALLET'))
    return new Promise((resolve, reject) => setPending({ resolve, reject }))
  }, [])

  const modal = pending
    ? (
      <Modal
        onDone={() => { pending.resolve(true); setPending(null) }}
        onCancel={() => { pending.reject(new Error('CANCELLED')); setPending(null) }}
      />
    )
    : null

  return { ensure, modal }
}

/** True when an error from `ensure` just means the person backed out. */
export const isDismissal = (e) =>
  e?.message === 'CANCELLED' || e?.message === 'NO_WALLET'
