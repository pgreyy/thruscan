// extension/src/popup/Settings.jsx
//
// Connected sites, backing up the wallet, auto-lock, network, and removal.

import { useState } from 'react'
import { bg, go, Header, Notice, Copy, PasswordField, useAction, short } from './ui.jsx'
import { PROGRAMS } from '../lib/chain.js'
import { NETWORKS, networkFor } from '../lib/networks.js'

export function Settings({ state, onLock, reload }) {
  const [minutes, setMinutes] = useState(String(state.settings.autoLockMinutes))
  const [rpc, setRpc] = useState(state.settings.rpc)
  const [saved, setSaved] = useState(null)
  const active = networkFor(state.settings)

  const [problem, setProblem] = useState(null)

  const save = async (patch) => {
    setProblem(null)
    await bg('setSettings', { settings: patch })
    setSaved('Saved.')
    setTimeout(() => setSaved(null), 1400)
    reload()
  }

  /**
   * Save a node of the user's own, after asking Chrome for permission to talk
   * to it.
   *
   * An extension reaches a host it has permission for, or a host that allows
   * it by its own CORS headers. Thru's nodes do the second, which is why this
   * box has worked at all; a node that does not would simply fail, and the
   * failure would look like the node being down. So the permission is declared
   * as optional and asked for here, on the click, which is the only moment it
   * can be asked for: nobody should grant a wallet every site on the web on
   * the day they install it for a box most people will never open.
   *
   * A refusal is not fatal and is not treated as one. The node may well allow
   * it anyway, so the address is saved either way and the wallet says what it
   * does not know.
   */
  const saveCustom = async () => {
    setProblem(null)
    let origin
    try { origin = new URL(rpc).origin + '/*' } catch { setProblem('That is not a web address.'); return }
    let granted
    try {
      granted = await chrome.permissions.request({ origins: [origin] })
    } catch { /* asked in the wrong context; carry on and let the node decide */ }
    await save({ network: 'custom', rpc: rpc.replace(/\/$/, '') })
    if (!granted) {
      setProblem('Saved. Chrome was not given access to that address, so it will only work if the node allows it. If the wallet cannot reach it, come back and allow access.')
    }
  }

  return (
    <div className="screen">
      <Header title="Settings" back="/" />
      <div className="body stack">
        <section className="card">
          <h2>Connected sites</h2>
          <button className="btn ghost" onClick={() => go('/sites')}>Manage connected sites</button>
        </section>

        <section className="card">
          <h2>Back up</h2>
          <div className="stack tight">
            {state.account.kind === 'phrase' && <button className="btn ghost" onClick={() => go('/reveal/phrase')}>Show 12 words</button>}
            <button className="btn ghost" onClick={() => go('/reveal/key')}>Show private key</button>
          </div>
        </section>

        <section className="card">
          <h2>Security</h2>
          <label className="field">
            <span>Lock after this many idle minutes</span>
            <div className="with-btn">
              <input value={minutes} inputMode="numeric" onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ''))} />
              <button className="btn ghost small" disabled={!minutes || Number(minutes) < 1}
                onClick={() => save({ autoLockMinutes: Math.min(1440, Number(minutes)) })}>Save</button>
            </div>
          </label>
          <button className="btn ghost" onClick={onLock}>Lock now</button>
        </section>

        {/* Network.
         *
         * This was a text box holding an RPC address and nothing else, which
         * made switching chains an act of faith: the node changed and the
         * program addresses did not, so the wallet kept working and every
         * balance it showed was read from the wrong place. Picking a network by
         * name moves both together. The box is still here underneath for a node
         * of your own, and it is labelled as what it is. */}
        <section className="card">
          <h2>Network</h2>
          <div className="stack tight">
            {Object.values(NETWORKS).map((n) => (
              <button
                key={n.id}
                className={n.id === active.id ? 'btn' : 'btn ghost'}
                onClick={() => { setRpc(n.rpc); save({ network: n.id, rpc: n.rpc }) }}
              >
                {n.label}{n.test ? ' (test)' : ''}
              </button>
            ))}
          </div>
          <p className="fine" style={{ marginTop: 10 }}>
            {active.test
              ? 'A test network. Nothing here is worth anything, and nothing here is a rehearsal for a key you would use on mainnet.'
              : 'Thru has not opened mainnet yet, so nothing will load while this is selected. It is here so the wallet is ready the day they do.'}
          </p>
          <details style={{ marginTop: 10 }}>
            <summary className="fine">Use my own node</summary>
            <label className="field" style={{ marginTop: 8 }}>
              <span>RPC address</span>
              <div className="with-btn">
                <input value={rpc} className="mono small" onChange={(e) => setRpc(e.target.value)} />
                <button className="btn ghost small" disabled={!/^https?:\/\//.test(rpc)}
                  onClick={saveCustom}>Save</button>
              </div>
            </label>
            <p className="fine">
              Chrome will ask whether the wallet may talk to that address. A node of your own is assumed to be
              serving the same chain as {NETWORKS.alphanet.label.toLowerCase()}, because the wallet has no way to
              ask it which programs it carries.
            </p>
          </details>
        </section>
        <Notice>{problem}</Notice>
        <Notice kind="good">{saved}</Notice>

        <section className="card">
          <h2>Remove wallet</h2>
          <p className="fine">Deletes the wallet from this browser. Only your 12 words or private key can bring it back.</p>
          <button className="btn danger ghost" onClick={() => go('/remove')}>Remove from this browser</button>
        </section>

        {/* The network moved its programs once and every wallet running an
            older build broke in a way that looked like a network fault. The
            token program's address is the cheapest thing to show that says
            which generation this build belongs to. */}
        <p className="fine center">
          ThruScan Wallet {chrome.runtime.getManifest().version}
          <br />
          <span className="mono" style={{ fontSize: '10px' }}>token program {short(PROGRAMS.TOKEN)}</span>
        </p>
      </div>
    </div>
  )
}

export function Reveal({ what }) {
  const [password, setPassword] = useState('')
  const [secret, setSecret] = useState(null)
  const { busy, error, run } = useAction()
  const submit = () => run(async () => setSecret(await bg('reveal', { password })))
  const value = secret ? (what === 'phrase' ? secret.phrase : secret.privateKey) : null

  return (
    <div className="screen">
      <Header title={what === 'phrase' ? '12 words' : 'Private key'} back="/settings" />
      <div className="body stack">
        <p className="notice bad">Anyone who sees this can take everything in the wallet. Never type it into a website or share it with anyone, including ThruScan.</p>
        {!value && (
          <>
            <PasswordField value={password} onChange={setPassword} autoFocus onEnter={submit} placeholder="Your password" />
            <Notice>{error}</Notice>
            <button className="btn" disabled={!password || busy} onClick={submit}>Show</button>
          </>
        )}
        {value && what === 'phrase' && (
          <div className="words">{value.split(' ').map((w, i) => <span key={i}><i>{i + 1}</i>{w}</span>)}</div>
        )}
        {value && what === 'key' && <p className="mono secret">{value}</p>}
        {value && <Copy value={value} className="btn ghost" />}
      </div>
    </div>
  )
}

export function Remove({ onGone }) {
  const [password, setPassword] = useState('')
  const { busy, error, run } = useAction()
  return (
    <div className="screen">
      <Header title="Remove wallet" back="/settings" />
      <div className="body stack">
        <p>Type your password to remove this wallet from the browser. Make sure you have your 12 words or private key first.</p>
        <PasswordField value={password} onChange={setPassword} autoFocus />
        <Notice>{error}</Notice>
        <button className="btn danger" disabled={!password || busy} onClick={() => run(async () => { await bg('forget', { password }); onGone() })}>Remove</button>
      </div>
    </div>
  )
}
