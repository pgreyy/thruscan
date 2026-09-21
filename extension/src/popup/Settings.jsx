// extension/src/popup/Settings.jsx
//
// Connected sites, backing up the wallet, auto-lock, network, and removal.

import { useState } from 'react'
import { bg, go, Header, Notice, Copy, PasswordField, useAction } from './ui.jsx'

export function Settings({ state, onLock, reload }) {
  const [minutes, setMinutes] = useState(String(state.settings.autoLockMinutes))
  const [rpc, setRpc] = useState(state.settings.rpc)
  const [saved, setSaved] = useState(null)

  const save = async (patch) => {
    await bg('setSettings', { settings: patch })
    setSaved('Saved.')
    setTimeout(() => setSaved(null), 1400)
    reload()
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

        <section className="card">
          <h2>Network</h2>
          <label className="field">
            <span>RPC address</span>
            <div className="with-btn">
              <input value={rpc} className="mono small" onChange={(e) => setRpc(e.target.value)} />
              <button className="btn ghost small" disabled={!/^https?:\/\//.test(rpc)} onClick={() => save({ rpc: rpc.replace(/\/$/, '') })}>Save</button>
            </div>
          </label>
          <button className="link" onClick={() => { setRpc('https://rpc.alphanet.thru.org'); save({ rpc: 'https://rpc.alphanet.thru.org' }) }}>Reset to Thru alphanet</button>
        </section>
        <Notice kind="good">{saved}</Notice>

        <section className="card">
          <h2>Remove wallet</h2>
          <p className="fine">Deletes the wallet from this browser. Only your 12 words or private key can bring it back.</p>
          <button className="btn danger ghost" onClick={() => go('/remove')}>Remove from this browser</button>
        </section>

        <p className="fine center">ThruScan Wallet {chrome.runtime.getManifest().version}</p>
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
