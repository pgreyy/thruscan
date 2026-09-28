// extension/src/popup/Approve.jsx
//
// The window a website's request opens: connect, sign a transaction, or sign
// a message. Nothing happens until the user presses Approve; closing the
// window is a no.

import { useEffect, useState } from 'react'
import { bg, Notice, PasswordField, useAction, short } from './ui.jsx'

const PROGRAM_NAMES = {
  taEOAD2uLK1SLzPgtabFLUAx22yDlBs9DE9nZFTOESIGRr: 'Thru accounts (THRU transfer)',
  taTOKENKRgcl3vO0yVhftATDbXuhgWcfaaxv9xpEEdMdUE: 'Thru token program',
  taNAMEqRNEDeMWp0cDYmMVdZyTZiF5NyGDR9zTwH42rWQG: 'Thru name service',
  taFCTxR0y2eabGGaEdtTwC9pHz7ZY4CYD7FOiBFUJeAW16: 'Thru faucet',
  taCXE0eEQbUHU90dyZ__Bz1yfQabjyaD4xaSHKUw3Q1M4N: 'ThruSwap',
  tastnRlQL8RGYeByXK2QAzaqdnfvI6pVn0e89JSl6Hiu8I: 'ThruPad',
  'tagNpTX6NLyLv1099dM7HQySw9j_dSH8GBoijY4fGCFVwH': 'ThruScan wall',
  taMULTIrOL8WpIFr16C1ECsO60qAsuwmwJephZHDOTvSeP: 'Thru multicall',
  taWTHRUBelpONhTRjYc7n4OovodUsUtZKTIuREWAi9G9lm: 'Wrapped THRU (WTHRU)',
  taNFTjOaeDBSPHNf0LVRWAkF4raUFQgrz0EQIgJd60ENb5: 'Thru NFT program',
  taXgi_tvqshzois9iLBY5msTGlQvW_GydSKRODoPgPVInH: 'Pixel Pals',
}

/** What we can say for sure about the instruction, from its bytes alone. */
function explain(program, dataHex) {
  const b = Uint8Array.from((dataHex.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)))
  const dv = new DataView(b.buffer)
  if (program === 'taEOAD2uLK1SLzPgtabFLUAx22yDlBs9DE9nZFTOESIGRr' && b.length >= 12 && dv.getUint32(0, true) === 1) {
    return `Sends ${dv.getBigUint64(4, true).toLocaleString()} THRU from this wallet`
  }
  // Wrapping: multicall of [EOA transfer to the WTHRU vault, WTHRU deposit].
  if (program === 'taMULTIrOL8WpIFr16C1ECsO60qAsuwmwJephZHDOTvSeP' && b.length >= 28 && dv.getUint16(0, true) === 2) {
    const size = Number(dv.getBigUint64(4, true))
    if (size === 16 && dv.getUint32(12, true) === 1) return `Wraps ${dv.getBigUint64(16, true).toLocaleString()} THRU into WTHRU`
  }
  if (program === 'taWTHRUBelpONhTRjYc7n4OovodUsUtZKTIuREWAi9G9lm' && b.length >= 24 && dv.getUint32(0, true) === 2) {
    return `Unwraps ${dv.getBigUint64(16, true).toLocaleString()} WTHRU base units back to THRU`
  }
  if (program === 'taNFTjOaeDBSPHNf0LVRWAkF4raUFQgrz0EQIgJd60ENb5' && b.length >= 4) {
    return ({ 1: 'Mints an NFT', 2: 'Sends an NFT from this wallet', 3: 'Burns an NFT' })[dv.getUint32(0, true)] ?? null
  }
  if (program === 'taXgi_tvqshzois9iLBY5msTGlQvW_GydSKRODoPgPVInH' && b.length >= 1) {
    return ({ 2: 'Mints a Pixel Pal (pays its price in WTHRU)', 3: 'Sends a Pixel Pal from this wallet', 6: 'Claims what a Pixel Pal holds' })[b[0]] ?? null
  }
  if (program === 'taTOKENKRgcl3vO0yVhftATDbXuhgWcfaaxv9xpEEdMdUE') {
    if (b[0] === 2 && b.length >= 13) return `Moves ${dv.getBigUint64(5, true).toLocaleString()} base units of a token`
    return ({ 0: 'Creates a token', 1: 'Opens a token account', 3: 'Mints tokens', 4: 'Burns tokens' })[b[0]] ?? null
  }
  return null
}

export function Approve({ id, state, onUnlocked }) {
  const [req, setReq] = useState(undefined)
  const [showData, setShowData] = useState(false)
  const [password, setPassword] = useState('')
  const act = useAction()

  useEffect(() => { bg('request', { id }).then(setReq).catch(() => setReq(null)) }, [id])
  // Chrome stops an idle background worker after 30 seconds, which would drop
  // the site's waiting request; a ping while this window is open prevents it.
  useEffect(() => {
    const t = setInterval(() => bg('ping').catch(() => {}), 10_000)
    return () => clearInterval(t)
  }, [])

  if (req === undefined) return <div className="screen"><p className="fine pad">Loading…</p></div>
  if (req === null) {
    return (
      <div className="screen welcome">
        <div className="welcome-top"><h1>Request expired</h1><p className="muted">The site's request is no longer waiting. Try again from the site.</p></div>
        <button className="btn" onClick={() => window.close()}>Close</button>
      </div>
    )
  }

  const locked = !state.unlocked
  const decide = (approve) => act.run(async () => {
    if (approve && locked) { await bg('unlock', { password }); onUnlocked() }
    await bg('decide', { id, approve })
    window.close()
  })

  const host = req.origin.replace(/^https?:\/\//, '')
  const p = req.params ?? {}
  const title = { connect: 'Connect', signTransaction: 'Sign transaction', signAndSendTransaction: 'Approve transaction', signMessage: 'Sign message' }[req.method] ?? req.method

  let message = null
  if (req.method === 'signMessage') {
    const bytes = Uint8Array.from(atob(p.messageB64), (c) => c.charCodeAt(0))
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    message = /^[\x20-\x7e\s -￿]*$/.test(text) && !text.includes('�') ? text : Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('')
  }

  const summary = p.program ? explain(p.program, p.dataHex ?? '') : null
  const accounts = [...(p.readWrite ?? []).map((a) => [a, 'can change']), ...(p.readOnly ?? []).map((a) => [a, 'read only'])]

  return (
    <div className="screen">
      <header className="bar">
        <span className="mark">T</span>
        <h1>{title}</h1>
      </header>
      <div className="body stack">
        <div className="origin">
          <span className="favicon">{host.slice(0, 1).toUpperCase()}</span>
          <div><b>{host}</b><span className="fine">{req.origin.startsWith('https://') ? 'Secure site' : 'Not a secure (https) site'}</span></div>
        </div>

        {req.method === 'connect' && (
          <div className="card">
            <p>This site wants to:</p>
            <ul className="ticks">
              <li>See your address <span className="mono fine">{short(state.account.address)}</span></li>
              <li>Ask you to approve transactions</li>
            </ul>
            <p className="fine">It cannot move anything without asking you here first.</p>
          </div>
        )}

        {p.program && (
          <div className="card kv">
            <div><span>Program</span><b>{PROGRAM_NAMES[p.program] ?? <span className="mono">{short(p.program, 8)}</span>}</b></div>
            {summary && <div><span>Does</span><b>{summary}</b></div>}
            <div><span>Fee</span><span>1 THRU at most</span></div>
            <div><span>Network</span><span>Thru alphanet</span></div>
          </div>
        )}
        {p.review && <p className="fine">The site describes it as: “{String(p.review).slice(0, 200)}”. Only the details above come from the transaction itself.</p>}
        {!PROGRAM_NAMES[p.program] && p.program && <p className="notice warn">A program ThruScan Wallet does not recognise. Only approve if you trust {host}.</p>}

        {p.program && (
          <details className="card" open={showData} onToggle={(e) => setShowData(e.target.open)}>
            <summary>Accounts and data</summary>
            <p className="fine">Program <span className="mono">{p.program}</span></p>
            {accounts.map(([a, what]) => (
              <p key={a} className="fine"><span className="mono">{short(a, 8)}</span> {a === state.account.address ? '(you) ' : ''}{what}</p>
            ))}
            <p className="mono small secret">{p.dataHex || '(no data)'}</p>
          </details>
        )}

        {message !== null && (
          <div className="card"><p className="fine">Message</p><p className="mono secret">{message}</p></div>
        )}

        {locked && (
          <label className="field">
            <span>Password to unlock</span>
            <PasswordField value={password} onChange={setPassword} autoFocus onEnter={() => password && decide(true)} />
          </label>
        )}
        <Notice>{act.error}</Notice>
      </div>
      <footer className="foot two">
        <button className="btn ghost" disabled={act.busy} onClick={() => decide(false)}>Cancel</button>
        <button className="btn" disabled={act.busy || (locked && !password)} onClick={() => decide(true)}>
          {req.method === 'connect' ? 'Connect' : req.method === 'signMessage' ? 'Sign' : 'Approve'}
        </button>
      </footer>
    </div>
  )
}
