// src/components/TxDialog.jsx
//
// The transaction review dialog (design system 2i), and the flow behind it.
//
// One shape for every signing moment on the site: swap, liquidity, buy and
// sell, launch. It walks idle → reviewing → awaitingSignature → submitted →
// landed | failed | rejected. The review shows what you pay and what you get
// (marked as an estimate), the rows that matter, and a collapsible
// "Technical details" for the program; pending replaces it with three steps and
// the signature; the outcome says what happened in plain words. Every change of
// state is announced politely to screen readers.
//
// The caller owns the work. It passes `run`, an async function that receives
// `progress(step, signature?)` and resolves to { signature, ok, error? }.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { Icon, Spinner } from './Icon.jsx'
import { CopyId } from './CopyId.jsx'

// The flow's state and helpers live in lib/txflow.js; this file draws it.

const short = (a) => (a && a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a ?? '')

function Elapsed({ from }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  if (!from) return null
  return <span className="txd-elapsed mono">{Math.max(0, Math.round((now - from) / 1000))}s</span>
}

function StepRow({ state, children, extra }) {
  return (
    <div className={`txd-step ${state}`}>
      <span className="txd-step-mark" aria-hidden="true">
        {state === 'done' ? <Icon name="success" size={12} stroke={3} /> : state === 'active' ? <Spinner size={16} /> : null}
      </span>
      <span className="txd-step-label">{children}</span>
      {extra}
    </div>
  )
}

/**
 * props:
 *   flow          from useTxFlow
 *   title         'Review swap'
 *   pay, receive  { label, value } — receive is an estimate unless `exact`
 *   rows          [{ k, v, term }]
 *   technical     { program, extra } shown under "Technical details"
 *   note          the line above the button
 *   signLabel     'Sign in wallet'
 *   run           async (progress) => ({ signature, ok, error })
 *   words         { pendingTitle, landed, landedSub, failed, accounts, closeNote }
 *   landedLinks   [{ to, label, strong }]
 *   onDone        after a landed transaction, when the dialog closes
 */
export function TxDialog({
  flow, title, pay, receive, rows = [], technical, note, signLabel = 'Sign in wallet',
  run, words = {}, landedLinks = [], body, needsAccounts = false, onDone,
}) {
  const { phase, step, signature, error, startedAt } = flow
  const closeBtn = useRef(null)

  useEffect(() => {
    if (!phase) return undefined
    const key = (e) => { if (e.key === 'Escape') flow.close() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [phase, flow])

  useEffect(() => { if (phase) closeBtn.current?.focus() }, [phase])

  if (!phase) return null

  const close = () => { const landed = phase === 'landed'; flow.close(); if (landed) onDone?.() }

  const heading = phase === 'review' ? title
    : phase === 'pending' ? (step === 'sent' ? (words.pendingTitle ?? 'Submitted') : 'Waiting for wallet')
      : phase === 'landed' ? (words.landed ?? 'Confirmed')
        : phase === 'rejected' ? 'Rejected in wallet'
          : (words.failed ?? 'Failed')

  const order = [...(needsAccounts ? ['accounts'] : []), 'sign', 'sent']
  const at = order.indexOf(step)
  const st = (name) => {
    const i = order.indexOf(name)
    return i < at ? 'done' : i === at ? 'active' : 'todo'
  }

  return createPortal(
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && phase !== 'pending') close() }}>
      <div className={`modal-card txd${phase === 'failed' ? ' failed' : ''}`} role="dialog" aria-modal="true" aria-labelledby="txd-title">
        <div className="txd-head">
          <h2 id="txd-title" className="txd-title">
            {phase === 'landed' && <Icon name="success" size={18} stroke={2.2} className="txd-ok" />}
            {(phase === 'failed') && <Icon name="failed" size={18} stroke={2.2} className="txd-bad" />}
            {phase === 'rejected' && <Icon name="failed" size={18} stroke={2} className="txd-dim" />}
            {heading}
          </h2>
          <button ref={closeBtn} className="txd-x" onClick={close} aria-label="Close"><Icon name="failed" size={20} /></button>
        </div>

        <div className="txd-body">
          <p className="sr-only" role="status" aria-live="polite">
            {phase === 'pending' ? heading : phase === 'landed' ? (words.landed ?? 'Confirmed') : phase === 'failed' ? (words.failed ?? 'Failed') : phase === 'rejected' ? 'Rejected in wallet' : ''}
          </p>

          {phase === 'review' && (
            <>
              {body}
              {pay && <div className="txd-amt"><span>{pay.label ?? 'You pay'}</span><b className="mono">{pay.value}</b></div>}
              {receive && <div className="txd-amt"><span>{receive.label ?? 'You receive (estimate)'}</span><b className="mono">{receive.exact ? '' : '≈ '}{receive.value}</b></div>}
              {(rows.length > 0 || technical) && (
                <div className="txd-rows">
                  {rows.map((r) => (
                    <div key={r.k} className="txd-row"><span>{r.k}</span><span className={r.plain ? '' : 'mono'}>{r.v}</span></div>
                  ))}
                  {technical && (
                    <details className="txd-tech">
                      <summary className="txd-row">
                        <span className="txd-tech-k">Technical details<Icon name="expand" size={14} stroke={1.8} /></span>
                        <span className="mono dim">program {short(technical.program)}</span>
                      </summary>
                      <div className="txd-tech-body">
                        <div className="txd-row"><span>Program</span><CopyId value={technical.program} /></div>
                        {(technical.extra ?? []).map((r) => (
                          <div key={r.k} className="txd-row"><span>{r.k}</span><span className="mono">{r.v}</span></div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
              {note && <p className="txd-note">{note}</p>}
              <button className="btn lg full" onClick={() => flow.start(run, words)}>{signLabel}</button>
            </>
          )}

          {phase === 'pending' && (
            <>
              <div className="txd-steps">
                {needsAccounts && <StepRow state={st('accounts')}>{words.accounts ?? 'Opening your token accounts'}</StepRow>}
                <StepRow state={st('sign')}>Signed in wallet</StepRow>
                <StepRow state={step === 'sent' ? 'done' : 'todo'}>Sent to the network</StepRow>
                <StepRow state={step === 'sent' ? 'active' : 'todo'} extra={step === 'sent' && <Elapsed from={startedAt} />}>Waiting for it to land</StepRow>
              </div>
              {signature && (
                <div className="txd-sig"><span>Signature</span><CopyId value={signature} to={`/tx/${signature}`} /></div>
              )}
              <p className="txd-note">{words.closeNote ?? 'You can close this; the result will appear as a notification and in Activity.'}</p>
              <button className="btn secondary lg full" onClick={close}>Close</button>
            </>
          )}

          {phase === 'landed' && (
            <>
              {words.landedSub && <p className="txd-text">{words.landedSub}</p>}
              <div className="txd-links">
                {landedLinks.map((l) => (
                  <Link key={l.label} to={l.to} className={l.strong ? 'txd-link strong' : 'txd-link'} onClick={close}>{l.label}</Link>
                ))}
                {signature && <Link to={`/tx/${signature}`} className="txd-link" onClick={close}>View transaction</Link>}
              </div>
              <button className="btn secondary lg full" onClick={close}>Done</button>
            </>
          )}

          {phase === 'failed' && (
            <>
              <p className="txd-text">{error}{error && !/[.!]$/.test(error) ? '.' : ''} Nothing was spent but the fee.</p>
              {signature && <div className="txd-links"><Link to={`/tx/${signature}`} className="txd-link" onClick={close}>View transaction</Link></div>}
              <button className="btn secondary lg full" onClick={close}>Close</button>
            </>
          )}

          {phase === 'rejected' && (
            <>
              <p className="txd-text">{words.rejected ?? 'Nothing was sent. You can try again.'}</p>
              <button className="btn lg full" onClick={() => flow.setPhase('review')}>Try again</button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default TxDialog
