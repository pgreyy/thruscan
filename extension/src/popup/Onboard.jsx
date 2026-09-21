// extension/src/popup/Onboard.jsx
//
// Setting up: a new wallet (password, twelve words, a quick check that they
// were written down) or an existing one (twelve words or a private key).
// Runs in a full tab, because the toolbar popup closes the moment you click
// away to write something down.

import { useEffect, useMemo, useState } from 'react'
import { bg, go, Header, Notice, PasswordField, useAction, inTab, openInTab } from './ui.jsx'

export function Welcome() {
  const start = (path) => (inTab() ? go(path) : openInTab(path))
  return (
    <div className="screen welcome">
      <div className="welcome-top">
        <span className="mark big">T</span>
        <h1>ThruScan Wallet</h1>
        <p className="muted">A wallet for Thru. Your keys stay in this browser, encrypted with your password. Nobody else holds them.</p>
      </div>
      <div className="stack">
        <button className="btn" onClick={() => start('/create')}>Create a new wallet</button>
        <button className="btn ghost" onClick={() => start('/import')}>I already have a wallet</button>
      </div>
    </div>
  )
}

function PasswordStep({ onDone, busy, error, cta }) {
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const problem = a.length > 0 && a.length < 8 ? 'At least 8 characters.' : b && a !== b ? 'The two passwords differ.' : null
  const ready = a.length >= 8 && a === b
  return (
    <div className="stack">
      <label className="field">
        <span>Password</span>
        <PasswordField value={a} onChange={setA} autoFocus placeholder="At least 8 characters" />
      </label>
      <label className="field">
        <span>Same password again</span>
        <PasswordField value={b} onChange={setB} placeholder="Repeat it" onEnter={() => ready && onDone(a)} />
      </label>
      <p className="fine">This password unlocks the wallet in this browser only. It cannot recover the wallet anywhere else: your 12 words or private key do that.</p>
      <Notice>{problem || error}</Notice>
      <button className="btn" disabled={!ready || busy} onClick={() => onDone(a)}>{busy ? 'Working…' : cta}</button>
    </div>
  )
}

export function Create({ onReady }) {
  const [step, setStep] = useState('words')
  const [phrase, setPhrase] = useState(null)
  const [shown, setShown] = useState(false)
  const [saved, setSaved] = useState(false)
  const [answers, setAnswers] = useState({})
  const { busy, error, run } = useAction()

  useEffect(() => { bg('newPhrase').then(setPhrase) }, [])
  const words = phrase ? phrase.split(' ') : []

  // Three random positions to check, fixed for this phrase.
  const checks = useMemo(() => {
    if (!words.length) return []
    const pick = new Set()
    while (pick.size < 3) pick.add(crypto.getRandomValues(new Uint32Array(1))[0] % 12)
    return [...pick].sort((x, y) => x - y)
  }, [phrase])  // eslint-disable-line react-hooks/exhaustive-deps

  const checked = checks.every((i) => (answers[i] ?? '').trim().toLowerCase() === words[i])

  return (
    <div className="screen">
      <Header title="New wallet" back={step === 'words' ? '/' : () => setStep(step === 'check' ? 'words' : 'check')} />
      <div className="body">
        <ol className="steps">
          <li className={step === 'words' ? 'on' : 'done'}>Words</li>
          <li className={step === 'check' ? 'on' : step === 'password' ? 'done' : ''}>Check</li>
          <li className={step === 'password' ? 'on' : ''}>Password</li>
        </ol>

        {step === 'words' && (
          <div className="stack">
            <p>These 12 words are your wallet. Write them down in order and keep them somewhere safe and offline.</p>
            <div className={`words ${shown ? '' : 'blurred'}`} onClick={() => setShown(true)}>
              {words.map((w, i) => <span key={i}><i>{i + 1}</i>{w}</span>)}
              {!shown && <div className="words-cover">Click to show. Make sure nobody can see your screen.</div>}
            </div>
            <p className="fine">Anyone with these words controls the wallet. ThruScan never asks for them and cannot recover them.</p>
            <label className="check">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} disabled={!shown} />
              <span>I have written down all 12 words</span>
            </label>
            <button className="btn" disabled={!saved} onClick={() => setStep('check')}>Continue</button>
          </div>
        )}

        {step === 'check' && (
          <div className="stack">
            <p>Type these words from your written copy.</p>
            {checks.map((i) => (
              <label className="field" key={i}>
                <span>Word {i + 1}</span>
                <input value={answers[i] ?? ''} autoComplete="off" spellCheck={false}
                  onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })} />
              </label>
            ))}
            <button className="btn" disabled={!checked} onClick={() => setStep('password')}>Continue</button>
          </div>
        )}

        {step === 'password' && (
          <PasswordStep busy={busy} error={error} cta="Create wallet"
            onDone={(password) => run(async () => { await bg('create', { phrase, password }); onReady() })} />
        )}
      </div>
    </div>
  )
}

export function Import({ onReady }) {
  const [mode, setMode] = useState('phrase')
  const [secret, setSecret] = useState('')
  const [step, setStep] = useState('secret')
  const [problem, setProblem] = useState(null)
  const { busy, error, run } = useAction()

  const check = async () => {
    if (mode === 'phrase') {
      const p = await bg('phraseProblem', { phrase: secret })
      if (p) return setProblem(p)
    } else {
      const clean = secret.trim().replace(/^0x/, '')
      if (!/^[0-9a-fA-F]{64}$/.test(clean)) return setProblem('A private key is 64 hex characters (0-9, a-f).')
    }
    setProblem(null)
    setStep('password')
  }

  return (
    <div className="screen">
      <Header title="Import wallet" back={step === 'secret' ? '/' : () => setStep('secret')} />
      <div className="body">
        {step === 'secret' && (
          <div className="stack">
            <div className="seg">
              <button className={mode === 'phrase' ? 'on' : ''} onClick={() => { setMode('phrase'); setSecret(''); setProblem(null) }}>12 words</button>
              <button className={mode === 'key' ? 'on' : ''} onClick={() => { setMode('key'); setSecret(''); setProblem(null) }}>Private key</button>
            </div>
            <label className="field">
              <span>{mode === 'phrase' ? 'Your 12 words, separated by spaces' : 'Your private key (64 hex characters)'}</span>
              <textarea rows={mode === 'phrase' ? 4 : 3} value={secret} autoFocus autoComplete="off" spellCheck={false}
                className="mono" onChange={(e) => setSecret(e.target.value)} />
            </label>
            <p className="fine">Works with words or keys from ThruScan's web wallet or any Thru wallet that follows Thru's standard path.</p>
            <Notice>{problem}</Notice>
            <button className="btn" disabled={!secret.trim()} onClick={check}>Continue</button>
          </div>
        )}
        {step === 'password' && (
          <PasswordStep busy={busy} error={error} cta="Import wallet"
            onDone={(password) => run(async () => {
              if (mode === 'phrase') await bg('create', { phrase: secret, password })
              else await bg('importKey', { privateKey: secret.trim(), password })
              onReady()
            })} />
        )}
      </div>
    </div>
  )
}

export function Ready() {
  return (
    <div className="screen welcome">
      <div className="welcome-top">
        <span className="mark big">✓</span>
        <h1>Wallet ready</h1>
        <p className="muted">Pin ThruScan Wallet to your toolbar (the puzzle icon, then the pin) and open it from there any time.</p>
      </div>
      <div className="stack">
        <button className="btn" onClick={() => (inTab() ? window.close() : go('/'))}>{inTab() ? 'Close this tab' : 'Open wallet'}</button>
      </div>
    </div>
  )
}

export function Unlock({ onUnlocked, reason }) {
  const [password, setPassword] = useState('')
  const { busy, error, run } = useAction()
  const submit = () => run(async () => { await bg('unlock', { password }); onUnlocked() })
  return (
    <div className="screen welcome">
      <div className="welcome-top">
        <span className="mark big">T</span>
        <h1>Welcome back</h1>
        {reason && <p className="muted">{reason}</p>}
      </div>
      <div className="stack">
        <PasswordField value={password} onChange={setPassword} autoFocus onEnter={submit} />
        <Notice>{error}</Notice>
        <button className="btn" disabled={!password || busy} onClick={submit}>{busy ? 'Unlocking…' : 'Unlock'}</button>
        <button className="link" onClick={() => go('/forgot')}>Forgot password?</button>
      </div>
    </div>
  )
}

export function Forgot({ onGone }) {
  const [sure, setSure] = useState(false)
  const { busy, error, run } = useAction()
  return (
    <div className="screen">
      <Header title="Forgot password" back="/" />
      <div className="body stack">
        <p>The password cannot be recovered: it only exists in your head. To get back in, remove the wallet from this browser and import it again with your 12 words or private key, choosing a new password.</p>
        <p className="notice bad">Without your 12 words or private key, removing the wallet loses it for good.</p>
        <label className="check">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
          <span>I have my 12 words or private key</span>
        </label>
        <Notice>{error}</Notice>
        <button className="btn danger" disabled={!sure || busy} onClick={() => run(async () => { await bg('reset'); onGone() })}>Remove and start over</button>
      </div>
    </div>
  )
}
