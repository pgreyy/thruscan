// extension/src/popup/Accounts.jsx
//
// Several accounts in one wallet: more accounts from the same 12 words (as in
// MetaMask), a new set of 12 words, or an imported phrase or private key.
// All of them sit in the same encrypted vault behind the same password.

import { useEffect, useMemo, useState } from 'react'
import { bg, go, Header, Notice, useAction, short } from './ui.jsx'

export function Accounts({ onChanged }) {
  const [data, setData] = useState(null)
  const [editing, setEditing] = useState(null)
  const [name, setName] = useState('')
  const act = useAction()
  const load = () => bg('accounts').then(setData)
  useEffect(() => { load() }, [])

  const pick = (id) => act.run(async () => { await bg('switchAccount', { id }); onChanged(); go('/') })
  const add = () => act.run(async () => { await bg('addAccount'); onChanged(); go('/') })
  const rename = () => act.run(async () => { await bg('renameAccount', { id: editing, name }); setEditing(null); load(); onChanged() })

  return (
    <div className="screen">
      <Header title="Accounts" back="/" />
      <div className="body">
        <Notice>{act.error}</Notice>
        <div className="list">
          {data?.list.map((a, i) => (
            editing === a.id ? (
              <div key={a.id} className="row acct-row">
                <input style={{ flex: 1, minWidth: 0 }} value={name} autoFocus maxLength={24} onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setEditing(null) }} />
                <button className="btn small" onClick={rename} disabled={act.busy || !name.trim()}>Save</button>
              </div>
            ) : (
              <div key={a.id} className={`row acct-row ${a.id === data.active ? 'on' : ''}`}>
                <button className="row acct-row" style={{ padding: 0, flex: 1, minWidth: 0 }} onClick={() => pick(a.id)} disabled={act.busy}>
                  <span className="acct-dot">{i + 1}</span>
                  <span className="row-main">
                    <b>{a.name}</b>
                    <span className="fine mono">{short(a.address, 6)}{a.kind === 'key' ? ' · imported key' : ''}</span>
                  </span>
                  {a.id === data.active && <span className="tick">✓</span>}
                </button>
                <button className="link small" onClick={() => { setEditing(a.id); setName(a.name) }}>Rename</button>
              </div>
            )
          ))}
        </div>

        <div className="acct-actions">
          {data?.seeds > 0 && <button className="btn" onClick={add} disabled={act.busy}>{act.busy ? 'Adding…' : 'Add account'}</button>}
          <button className="btn ghost" onClick={() => go('/accounts/new')}>New account with new 12 words</button>
          <button className="btn ghost" onClick={() => go('/accounts/import')}>Import 12 words or a private key</button>
        </div>
        {data?.seeds > 0 && <p className="fine" style={{ marginTop: 10 }}>Add account makes the next account from the 12 words you already have, so the same backup covers it.</p>}
      </div>
    </div>
  )
}

/** A brand new phrase, shown once, then kept in the vault. */
export function NewPhraseAccount({ onChanged }) {
  const [phrase, setPhrase] = useState(null)
  const [shown, setShown] = useState(false)
  const [saved, setSaved] = useState(false)
  const act = useAction()
  useEffect(() => { bg('newPhrase').then(setPhrase) }, [])
  const words = useMemo(() => (phrase ? phrase.split(' ') : []), [phrase])

  const create = () => act.run(async () => { await bg('addPhraseAccount', { phrase }); onChanged(); go('/') })

  return (
    <div className="screen">
      <Header title="New 12 words" back="/accounts" />
      <div className="body stack">
        <p>These 12 words back up this new account only. Write them down in order and keep them offline.</p>
        <div className={`words ${shown ? '' : 'blurred'}`} onClick={() => setShown(true)}>
          {words.map((w, i) => <span key={i}><i>{i + 1}</i>{w}</span>)}
          {!shown && <div className="words-cover">Click to show. Make sure nobody can see your screen.</div>}
        </div>
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} disabled={!shown} />
          <span>I have written down all 12 words</span>
        </label>
        <Notice>{act.error}</Notice>
        <button className="btn" disabled={!saved || act.busy} onClick={create}>{act.busy ? 'Creating…' : 'Create account'}</button>
      </div>
    </div>
  )
}

/** 12 words or a 64-character private key from another wallet. */
export function ImportAccount({ onChanged }) {
  const [text, setText] = useState('')
  const act = useAction()
  const clean = text.trim()
  const isKey = /^(0x)?[0-9a-fA-F]{64}$/.test(clean)

  const run = () => act.run(async () => {
    if (isKey) await bg('addKeyAccount', { privateKey: clean })
    else await bg('addPhraseAccount', { phrase: clean })
    onChanged(); go('/')
  })

  return (
    <div className="screen">
      <Header title="Import account" back="/accounts" />
      <div className="body stack">
        <label className="field">
          <span>12 words, or a private key</span>
          <textarea rows={4} value={text} spellCheck={false} autoComplete="off" onChange={(e) => setText(e.target.value)} />
        </label>
        <p className="fine">It is encrypted with your wallet password and never leaves this browser.</p>
        <Notice>{act.error}</Notice>
        <button className="btn" disabled={!clean || act.busy} onClick={run}>{act.busy ? 'Importing…' : isKey ? 'Import key' : 'Import 12 words'}</button>
      </div>
    </div>
  )
}
