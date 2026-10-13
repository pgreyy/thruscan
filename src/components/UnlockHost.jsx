// src/components/UnlockHost.jsx
//
// The one unlock prompt for the whole site, mounted once in the shell. It
// opens only when something needs a signature and the browser wallet is
// locked (ensureUnlocked() in lib/wallet.js); see Unlock.jsx.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { unlock, storedWallet, setUnlockPrompt } from '../lib/wallet.js'
import { autoLockWords } from '../lib/walletSession.js'
import { notifyWalletChanged } from '../pages/Wallet.jsx'

const short = (a) => (a ? `${a.slice(0, 5)}…${a.slice(-4)}` : '')

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
      <div className="modal-card unlock-card" role="dialog" aria-modal="true" aria-labelledby="unlock-title">
        <h2 id="unlock-title" className="h3" style={{ fontWeight: 700 }}>Unlock your wallet</h2>
        <p className="sub mono" style={{ marginTop: 4 }}>{short(storedWallet()?.address)}</p>

        <label className="label" htmlFor="unlock-password" style={{ marginTop: 16 }}>Password</label>
        <input
          id="unlock-password"
          ref={inputRef}
          className="field"
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && password) go() }}
          autoComplete="current-password"
          aria-invalid={error ? 'true' : undefined}
          style={{ height: 44 }}
        />
        {error && <p className="helper bad" role="alert">{error}</p>}

        <button className="btn full" onClick={go} disabled={busy || !password} style={{ marginTop: 14, height: 44 }}>
          {busy ? 'Unlocking' : 'Unlock and continue'}
        </button>
        <button className="btn tertiary full" onClick={onCancel} style={{ marginTop: 6 }}>Cancel</button>

        <p className="fine" style={{ marginTop: 12, lineHeight: 1.5 }}>
          It stays unlocked {autoLockWords()} (Auto-lock, in the wallet menu). For larger
          amounts, the <Link to="/get-wallet" onClick={onCancel}>ThruScan Wallet extension</Link> is the safer choice.
        </p>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The one unlock prompt. Mount it once; ensureUnlocked() opens it.
 */
export function UnlockHost() {
  const [pending, setPending] = useState(null)
  useEffect(() => setUnlockPrompt(() => new Promise((resolve, reject) => setPending({ resolve, reject }))), [])
  if (!pending) return null
  return (
    <Modal
      onDone={() => { pending.resolve(true); setPending(null) }}
      onCancel={() => { pending.reject(new Error('CANCELLED')); setPending(null) }}
    />
  )
}
