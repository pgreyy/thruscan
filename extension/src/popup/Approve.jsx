// extension/src/popup/Approve.jsx
//
// The window a website's request opens (6i-6k): connect, sign a transaction,
// or sign a message. Nothing happens until the user presses Approve; closing
// the window is a no. When the wallet cannot read the program, Reject is the
// amber action and approving takes a deliberate second choice.

import { useEffect, useState } from 'react'
import { bg, Notice, PasswordField, useAction, short, Icon, Mark } from './ui.jsx'
import { networkFor } from '../lib/networks.js'

const PROGRAM_NAMES = {
  taEOAD2uLK1SLzPgtabFLUAx22yDlBs9DE9nZFTOESIGRr: 'Thru accounts (THRU transfer)',
  taTOKENKRgcl3vO0yVhftATDbXuhgWcfaaxv9xpEEdMdUE: 'Thru token program',
  taNAMEqRNEDeMWp0cDYmMVdZyTZiF5NyGDR9zTwH42rWQG: 'Thru name service',
  taFCTxR0y2eabGGaEdtTwC9pHz7ZY4CYD7FOiBFUJeAW16: 'Thru faucet',
  taMULTIrOL8WpIFr16C1ECsO60qAsuwmwJephZHDOTvSeP: 'Thru multicall',
  taWTHRUBelpONhTRjYc7n4OovodUsUtZKTIuREWAi9G9lm: 'Wrapped THRU (WTHRU)',
  taNFTjOaeDBSPHNf0LVRWAkF4raUFQgrz0EQIgJd60ENb5: 'Thru NFT program',
}

/* Thru's programs above are the same everywhere; ThruScan's are deployed per
   network, so their names come from the network the wallet is on. A blank
   address (not deployed there) names nothing. */
function programNames(net) {
  const names = { ...PROGRAM_NAMES }
  const add = (address, name) => { if (address) names[address] = name }
  add(net.ours?.THRUSWAP, 'ThruSwap')
  add(net.ours?.THRUPAD, 'ThruPad')
  add(net.ours?.WALL, 'ThruScan wall')
  add(net.pals?.program, 'Pixel Pals')
  return names
}

/** What we can say for sure about the instruction, from its bytes alone. */
function explain(program, dataHex, net) {
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
  if (net.pals?.program && program === net.pals.program && b.length >= 1) {
    return ({ 2: 'Mints a Pixel Pal (pays its price in WTHRU)', 3: 'Sends a Pixel Pal from this wallet', 6: 'Claims what a Pixel Pal holds' })[b[0]] ?? null
  }
  if (program === 'taTOKENKRgcl3vO0yVhftATDbXuhgWcfaaxv9xpEEdMdUE') {
    if (b[0] === 2 && b.length >= 13) return `Moves ${dv.getBigUint64(5, true).toLocaleString()} base units of a token`
    return ({ 0: 'Creates a token', 1: 'Opens a token account', 3: 'Mints tokens', 4: 'Burns tokens' })[b[0]] ?? null
  }
  return null
}

export function Approve({ id, state, onUnlocked }) {
  const net = networkFor(state.settings)
  const names = programNames(net)
  /* The account was made on one network and this request is on another. The
     key works on both, because a Thru address comes from the key rather than
     from the chain, which is exactly why this is worth saying out loud: there
     is nothing in the address itself to tell you that a wallet you have only
     ever used for test money is about to sign on a real chain. Accounts made
     before the wallet recorded this carry no network and get no warning,
     because a warning shown to everybody is a warning nobody reads. */
  const madeOn = state.account?.network
  const elsewhere = Boolean(madeOn && madeOn !== net.id)
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
        <div className="welcome-top"><Mark size={56} /><h1>Request expired</h1><p className="muted">The site's request is no longer waiting. Try again from the site.</p></div>
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

  const summary = p.program ? explain(p.program, p.dataHex ?? '', net) : null
  const accounts = [...(p.readWrite ?? []).map((a) => [a, 'can change']), ...(p.readOnly ?? []).map((a) => [a, 'read only'])]
  const unreadable = Boolean(p.program && !names[p.program])
  const pays = summary && /^(Sends|Moves|Mints a Pixel Pal)/.test(summary)
  const writable = (p.readWrite ?? []).length
  const dataBytes = Math.floor((p.dataHex ?? '').length / 2)
  const netLine = `Thru ${net.label.replace(/\s*\(.*\)$/, '').toLowerCase()}${net.test ? ' (test)' : ''}`
  const yes = req.method === 'connect' ? 'Connect' : req.method === 'signMessage' ? 'Sign' : unreadable ? 'Approve anyway' : 'Approve'

  return (
    <div className="screen">
      <div className="body stack">
        <div className="origin-big">
          <span className="favicon">{host.slice(0, 1).toUpperCase()}</span>
          <h1 className="lead-title">{req.method === 'connect' ? 'Connect to this site?' : title}</h1>
          <b>{host}</b>
          <span className="fine">{req.origin.startsWith('https://') ? 'Secure site' : 'Not a secure (https) site'}</span>
        </div>

        {req.method === 'connect' && (
          <>
            <div className="card perm">
              <div><Icon name="success" size={16} stroke={2} />See your address and balances</div>
              <div><Icon name="success" size={16} stroke={2} />Ask you to approve transactions</div>
              <div><Icon name="success" size={16} stroke={2} />It can&rsquo;t move tokens without you</div>
            </div>
            <div className="card kv">
              <div><span>Account</span><b>{state.account.name ?? short(state.account.address)}</b></div>
              <div><span>Network</span><span>{netLine}</span></div>
            </div>
          </>
        )}

        {unreadable && (
          <div className="unreadable" role="alert">
            <Icon name="warning" size={20} />
            <span><b>ThruScan Wallet can&rsquo;t read this.</b>Only approve if you trust this site and know what it does.</span>
          </div>
        )}

        {p.program && (
          <div className="card kv">
            {summary && <div><span>Does</span><b className={pays ? 'pay' : ''}>{summary}</b></div>}
            <div><span>Program</span><b>{names[p.program] ? `${names[p.program]} · ` : ''}<span className="mono">{short(p.program, 5)}</span></b></div>
            {unreadable && <div><span>Instruction data</span><span className="mono">{dataBytes} B</span></div>}
            {unreadable && <div><span>Writable accounts</span><span className="mono">{writable}{(p.readWrite ?? []).includes(state.account.address) ? ' incl. yours' : ''}</span></div>}
            <div><span>Fee paid by</span><span>this wallet · 1 THRU at most</span></div>
            <div><span>Network</span><span>{netLine}</span></div>
          </div>
        )}
        {elsewhere && (
          <p className="notice warn">
            This account was made on {(networkFor({ network: madeOn }).label)}, and you are about to sign on {net.label}.
            The same key works on both. Check this is the network you meant.
          </p>
        )}
        {p.review && <p className="fine">The site describes it as: &ldquo;{String(p.review).slice(0, 200)}&rdquo;. Only the details above come from the transaction itself.</p>}

        {p.program && (
          <details className="card" open={showData} onToggle={(e) => setShowData(e.target.open)}>
            <summary>Raw details · {accounts.length} accounts</summary>
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
            <PasswordField value={password} onChange={setPassword} autoFocus onEnter={() => password && !unreadable && decide(true)} />
          </label>
        )}
        <Notice>{act.error}</Notice>
      </div>
      <footer className="foot two">
        {/* One amber action. On a transaction the wallet cannot read, that is Reject. */}
        <button className={unreadable ? 'btn' : 'btn ghost'} disabled={act.busy} onClick={() => decide(false)}>Reject</button>
        <button className={unreadable ? 'btn ghost' : 'btn'} disabled={act.busy || (locked && !password)} onClick={() => decide(true)}>{yes}</button>
      </footer>
    </div>
  )
}
