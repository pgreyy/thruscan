// src/lib/txflow.js
//
// The transaction flow every signing moment shares: idle → reviewing →
// awaitingSignature → submitted → landed | failed | rejected. useTxFlow keeps
// the state; components/TxDialog.jsx draws it.

import { useCallback, useRef, useState } from 'react'
import { toast } from './toasts.js'
import { network } from './networks.js'

/** A wallet's "no": the extension's 4001, or the message wallet.js gives it. */
export const isRejection = (e) =>
  e?.code === 4001 || e?.cause?.code === 4001 || /cancelled it in your wallet/i.test(String(e?.message ?? ''))

export const NETWORK_ROW = { k: 'Network', v: `Thru ${network.label.toLowerCase()}${network.test ? ' (test)' : ''}` }

/**
 * `useTxFlow` keeps the state; `<TxDialog flow={flow} … />` draws it.
 *
 *   const flow = useTxFlow()
 *   flow.open()                      // shows the review
 *   flow.start(run)                  // from the dialog's sign button
 */
export function useTxFlow() {
  const [phase, setPhase] = useState(null)   // null | review | pending | landed | failed | rejected
  const [step, setStep] = useState(null)     // accounts | sign | sent
  const [signature, setSignature] = useState(null)
  const [error, setError] = useState(null)
  const [startedAt, setStartedAt] = useState(null)
  const closedRef = useRef(false)

  const open = useCallback(() => {
    closedRef.current = false
    setPhase('review'); setStep(null); setSignature(null); setError(null)
  }, [])
  const close = useCallback(() => { closedRef.current = true; setPhase(null) }, [])

  const start = useCallback(async (run, words = {}) => {
    closedRef.current = false
    setPhase('pending'); setStep('sign'); setSignature(null); setError(null); setStartedAt(Date.now())
    const progress = (s, sig) => {
      setStep(s)
      if (sig) setSignature(sig)
      if (s === 'sent' && sig) setStartedAt(Date.now())
    }
    try {
      const r = await run(progress)
      if (r?.signature) setSignature(r.signature)
      if (r && r.ok === false) {
        setError(r.error ?? null); setPhase('failed')
        if (closedRef.current) toast({ kind: 'failed', title: words.failed ?? 'Transaction failed', sub: `${r.error ?? ''} Nothing was spent but the fee.`, signature: r.signature })
        return r
      }
      setPhase('landed')
      if (closedRef.current) toast({ kind: 'confirmed', title: words.landed ?? 'Transaction confirmed', sub: words.landedSub, signature: r?.signature })
      return r
    } catch (e) {
      if (isRejection(e)) {
        setPhase('rejected')
        if (closedRef.current) toast({ kind: 'rejected', title: 'Rejected in wallet', sub: 'Nothing was sent. You can try again.' })
      } else {
        setError(String(e?.message ?? e)); setPhase('failed')
        if (closedRef.current) toast({ kind: 'failed', title: words.failed ?? 'Transaction failed', sub: String(e?.message ?? e) })
      }
      return null
    }
  }, [])

  return { phase, step, signature, error, startedAt, open, close, start, setPhase }
}

