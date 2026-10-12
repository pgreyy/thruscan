// extension/src/popup/Settings.jsx
//
// Settings (6m): accounts, connected sites, auto-lock, theme, the recovery
// phrase behind the password, the network, and removal.

import { useEffect, useState } from 'react'
import { bg, go, Header, Notice, Copy, PasswordField, useAction, short, Icon, TabBar } from './ui.jsx'
import { openSite } from './nav.js'
import { PROGRAMS } from '../lib/chain.js'
import { NETWORKS, DEFAULT_NETWORK, networkFor } from '../lib/networks.js'

export function Settings({ state, onLock, reload }) {
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

  const [sites, setSites] = useState(null)
  const [accounts, setAccounts] = useState(null)
  useEffect(() => {
    bg('sites').then((x) => setSites(Object.keys(x ?? {}).length)).catch(() => {})
    bg('accounts').then((x) => setAccounts(x?.list?.length ?? null)).catch(() => {})
  }, [])
  const theme = state.settings.theme ?? 'dark'

  return (
    <div className="screen">
      <Header title="Settings" />
      <div className="body stack">
        <div className="set-list">
          <button className="set-row" onClick={() => go('/accounts')}><span>Accounts</span><span className="fine">{accounts ?? ''}</span></button>
          <button className="set-row" onClick={() => go('/sites')}><span>Connected sites</span><span className="fine">{sites ?? ''}</span></button>
          <label className="set-row">
            <span>Auto-lock</span>
            <select aria-label="Auto-lock" value={String(state.settings.autoLockMinutes)} onChange={(e) => save({ autoLockMinutes: Number(e.target.value) })}>
              {[...new Set([5, 15, 30, 60, 240, Number(state.settings.autoLockMinutes)])].sort((x, y) => x - y).map((m) => (
                <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}</option>
              ))}
            </select>
          </label>
          <label className="set-row">
            <span>Theme</span>
            <select aria-label="Theme" value={theme} onChange={(e) => save({ theme: e.target.value })}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">System</option>
            </select>
          </label>
          {state.account.kind === 'phrase' && <button className="set-row" onClick={() => go('/reveal/phrase')}><span>Show recovery phrase</span><span className="fine">needs password</span></button>}
          <button className="set-row" onClick={() => go('/reveal/key')}><span>Show private key</span><span className="fine">needs password</span></button>
          <button className="set-row" onClick={onLock}><span>Lock now</span></button>
          <button className="set-row" onClick={() => openSite('/')}><span>Open ThruScan</span><Icon name="external" size={16} /></button>
        </div>

        {/* Network.
         *
         * Picking a network by name moves the node and the program addresses
         * together. The box underneath is for a node of your own, and it is
         * labelled as what it is. */}
        <section className="card">
          <h2>Network</h2>
          <div className="seg" role="group" aria-label="Network">
            {Object.values(NETWORKS).map((n) => (
              <button
                key={n.id}
                className={n.id === active.id ? 'on' : ''}
                onClick={() => { setRpc(n.rpc); save({ network: n.id, rpc: n.rpc }) }}
              >
                {n.label.replace(/\s*\(.*\)$/, '')}
              </button>
            ))}
          </div>
          <p className="fine">
            {active.test
              ? 'A test network. Nothing here is worth anything, and nothing here is a rehearsal for a key you would use on mainnet.'
              : 'Thru has not opened mainnet yet, so nothing will load while this is selected. It is here so the wallet is ready the day they do.'}
          </p>
          <details>
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
              serving the same chain as {NETWORKS[DEFAULT_NETWORK].label}, because the wallet has no way to
              ask it which programs it carries.
            </p>
          </details>
        </section>
        <Notice>{problem}</Notice>
        <Notice kind="good">{saved}</Notice>

        <div className="set-list">
          <button className="set-row bad" onClick={() => go('/remove')}><span>Remove wallet from this device</span></button>
        </div>

        {/* The network moved its programs once and every wallet running an
            older build broke in a way that looked like a network fault. The
            token program's address is the cheapest thing to show that says
            which generation this build belongs to. */}
        <p className="version" title={`token program ${PROGRAMS.TOKEN}`}>
          ThruScan Wallet v{chrome.runtime.getManifest().version} · {active.label.replace(/\s*\(.*\)$/, '').toLowerCase()} · token {short(PROGRAMS.TOKEN, 4)}
        </p>
      </div>
      <TabBar on="/settings" />
    </div>
  )
}

/** The phrase, masked until held down, even after the password. */
function HeldPhrase({ phrase }) {
  const [held, setHeld] = useState(false)
  const words = phrase.split(' ')
  const hide = () => setHeld(false)
  return (
    <>
      <div className="words">{words.map((w, i) => <span key={i}><i>{i + 1}</i>{held ? w : '•••••'}</span>)}</div>
      <button
        type="button" className={`hold${held ? ' on' : ''}`}
        onPointerDown={() => setHeld(true)} onPointerUp={hide} onPointerLeave={hide} onPointerCancel={hide}
        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setHeld(true) } }}
        onKeyUp={hide} onBlur={hide}
      >
        {held ? 'Release to hide' : 'Hold to reveal'}
      </button>
    </>
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
      <Header title={what === 'phrase' ? 'Recovery phrase' : 'Private key'} back="/settings" />
      <div className="body stack">
        <p className="notice bad">Anyone who sees this can take everything in the wallet. Never type it into a website or share it with anyone, including ThruScan.</p>
        {!value && (
          <>
            <PasswordField value={password} onChange={setPassword} autoFocus onEnter={submit} placeholder="Your password" />
            <Notice>{error}</Notice>
            <button className="btn" disabled={!password || busy} onClick={submit}>Show</button>
          </>
        )}
        {value && what === 'phrase' && <HeldPhrase phrase={value} />}
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
