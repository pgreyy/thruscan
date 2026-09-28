// src/components/FaucetDrop.jsx
//
// The faucet as a top bar control rather than a page.
//
// Running dry is something that happens in the middle of doing something else:
// mid-swap, mid-launch, halfway through a mint. Sending someone to /faucet to
// fix it throws away whatever they had on screen, and they have to find their
// way back. So the tap lives beside the bell and the theme button, and opens
// two claim buttons in place.
//
// It is deliberately only the two buttons. Everything else the faucet page
// says (what each currency is for, the daily limits, giving funds back, the
// CLI recipe) stays on the page, which is still there and still linked.

import { useCallback, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useDismiss } from '../lib/dismiss.js'
import { useWallet } from '../pages/Wallet.jsx'
import { claimTusd, claimNativeThru } from '../lib/wallet.js'

const fmtUsd = (units) => (Number(units) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })

export function FaucetDrop() {
  const wallet = useWallet()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(null)
  const [note, setNote] = useState(null)
  const [error, setError] = useState(null)
  const box = useRef(null)

  useDismiss(box, open, useCallback(() => { setOpen(false); setNote(null); setError(null) }, []))

  const ready = wallet.unlocked && wallet.registered

  const claim = async (which) => {
    setBusy(which); setError(null); setNote(null)
    try {
      if (which === 'tusd') {
        const j = await claimTusd()
        setNote(`${fmtUsd(j.amount)} tUSD on the way.`)
      } else {
        await claimNativeThru()
        setNote('10,000 THRU on the way. That is what pays your fees.')
      }
      await new Promise((r) => setTimeout(r, 2500))
      await wallet.refresh()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="faucet-drop" ref={box}>
      <button
        className="faucet-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label="Faucet"
        aria-expanded={open}
        title="Faucet"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 21a5 5 0 0 0 5-5c0-3.5-5-10-5-10S7 12.5 7 16a5 5 0 0 0 5 5z" />
        </svg>
      </button>

      {open && (
        <div className="faucet-menu" role="dialog" aria-label="Faucet">
          {ready ? (
            <>
              <button className="faucet-claim" onClick={() => claim('tusd')} disabled={busy !== null}>
                <span>Claim 500 tUSD</span>
                <span className="fine">{busy === 'tusd' ? 'Sending' : 'to trade with'}</span>
              </button>
              <button className="faucet-claim" onClick={() => claim('thru')} disabled={busy !== null}>
                <span>Claim 10,000 THRU</span>
                <span className="fine">{busy === 'thru' ? 'Claiming' : 'to pay fees with'}</span>
              </button>
            </>
          ) : (
            <p className="faucet-none">
              {wallet.registered === false && wallet.unlocked
                ? <>Your wallet needs an account on chain first. <Link to="/wallet" onClick={() => setOpen(false)}>Open the wallet page</Link>.</>
                : <>Unlock your wallet to claim. <Link to="/wallet" onClick={() => setOpen(false)}>Wallet</Link>.</>}
            </p>
          )}

          {note && <p className="faucet-note">{note}</p>}
          {error && <p className="faucet-note bad">{error}</p>}

          <Link className="faucet-more" to="/faucet" onClick={() => setOpen(false)}>
            Limits, giving it back, and the CLI recipe
          </Link>
        </div>
      )}
    </div>
  )
}

export default FaucetDrop
