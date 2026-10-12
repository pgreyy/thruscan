// extension/src/popup/Onboard.jsx
//
// Setting up (6a-6c): a password, then twelve words held down to read, then a
// quick check that they were written down. Or an existing wallet: twelve words
// or a private key. And the unlock screen (6d).
// Runs in a full tab, because the toolbar popup closes the moment you click
// away to write something down.

import { useEffect, useMemo, useState } from 'react'
import { bg, go, Copy, Header, Mark, Notice, PasswordField, WordInputs, useAction, inTab, openInTab } from './ui.jsx'

export function Welcome() {
  const start = (path) => (inTab() ? go(path) : openInTab(path))
  return (
    <div className="screen welcome">
      <div className="welcome-top">
        <Mark size={64} />
        <h1>ThruScan Wallet</h1>
        <p className="muted">A self-custody wallet for Thru&rsquo;s test network. Your key stays encrypted on this device.</p>
      </div>
      <div className="stack">
        <button className="btn" onClick={() => start('/create')}>Create a new wallet</button>
        <button className="btn ghost" onClick={() => start('/import')}>I already have a recovery phrase</button>
        <p className="welcome-foot">TEST NETWORK · NOT AUDITED</p>
      </div>
    </div>
  )
}

/** 0 empty, 1 weak, 2 fair, 3 strong: length and variety, nothing cleverer. */
function strength(pw) {
  if (!pw) return 0
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length
  if (pw.length < 8) return 1
  if (pw.length >= 14 || (pw.length >= 10 && kinds >= 3)) return 3
  return kinds >= 2 ? 2 : 1
}
const STRENGTH = ['', 'Weak', 'Fair', 'Strong']

function Progress({ at }) {
  return (
    <div className="progress3" role="img" aria-label={`Step ${at} of 3`}>
      {[1, 2, 3].map((n) => <i key={n} className={n <= at ? 'on' : ''} />)}
    </div>
  )
}

function PasswordStep({ onDone, busy, error, cta }) {
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const problem = a.length > 0 && a.length < 8 ? 'At least 8 characters.' : b && a !== b ? 'The two passwords differ.' : null
  const ready = a.length >= 8 && a === b
  const s = strength(a)
  return (
    <div className="stack">
      <div className="stack tight">
        <h2 className="lead-title">Set a password</h2>
        <p className="muted">It unlocks the wallet on this device only. ThruScan can&rsquo;t reset it.</p>
      </div>
      <label className="field">
        <span>Password</span>
        <PasswordField value={a} onChange={setA} autoFocus placeholder="At least 8 characters" />
      </label>
      {a && (
        <div className={`strength s${s}`} aria-live="polite">
          <span className="strength-bar" aria-hidden="true"><i /><i /><i /></span>
          <b>{STRENGTH[s]}</b>
        </div>
      )}
      <label className="field">
        <span>Confirm password</span>
        <PasswordField value={b} onChange={setB} placeholder="Repeat it" onEnter={() => ready && onDone(a)} />
      </label>
      <Notice>{problem || error}</Notice>
      <button className="btn" disabled={!ready || busy} onClick={() => onDone(a)}>{busy ? 'Working…' : cta}</button>
    </div>
  )
}

/** Twelve words, masked until held down. Letting go hides them again. */
function HeldWords({ words, onSeen }) {
  const [held, setHeld] = useState(false)
  const show = () => { setHeld(true); onSeen?.() }
  const hide = () => setHeld(false)
  return (
    <>
      <div className="words" aria-live="polite">
        {words.map((w, i) => <span key={i}><i>{i + 1}</i>{held ? w : '•••••'}</span>)}
      </div>
      <button
        type="button" className={`hold${held ? ' on' : ''}`}
        onPointerDown={show} onPointerUp={hide} onPointerLeave={hide} onPointerCancel={hide}
        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); show() } }}
        onKeyUp={hide} onBlur={hide}
      >
        {held ? 'Release to hide' : 'Hold to reveal'}
      </button>
    </>
  )
}

export function Create({ onReady }) {
  const [step, setStep] = useState('password')
  const [password, setPassword] = useState(null)
  const [phrase, setPhrase] = useState(null)
  const [seen, setSeen] = useState(false)
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
  const at = step === 'password' ? 1 : step === 'words' ? 2 : 3
  const back = step === 'password' ? '/' : () => setStep(step === 'check' ? 'words' : 'password')

  return (
    <div className="screen">
      <Header title="New wallet" back={back} />
      <div className="body">
        <Progress at={at} />

        {step === 'password' && (
          <PasswordStep cta="Continue" onDone={(pw) => { setPassword(pw); setStep('words') }} />
        )}

        {step === 'words' && (
          <div className="stack">
            <div className="stack tight">
              <h2 className="lead-title">Your recovery phrase</h2>
              <p className="muted">Write these 12 words down in order. Anyone with them controls this wallet.</p>
            </div>
            <HeldWords words={words} onSeen={() => setSeen(true)} />
            {/* Paper is safer, and plenty of people keep a phrase in a password
                manager instead. Retyping twelve words into one is where they get
                mistyped, so the copy is offered once the words have been seen. */}
            {seen && phrase && <div className="inline"><Copy value={phrase} label="Copy the 12 words" /></div>}
            <label className="check">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} disabled={!seen} />
              <span>I wrote it down. ThruScan can&rsquo;t recover it for me.</span>
            </label>
            <button className="btn" disabled={!saved} onClick={() => setStep('check')}>Continue</button>
          </div>
        )}

        {step === 'check' && (
          <div className="stack">
            <div className="stack tight">
              <h2 className="lead-title">Check your words</h2>
              <p className="muted">Type these words from your written copy. Space or Enter moves to the next one.</p>
            </div>
            <WordInputs slots={checks} values={answers} onChange={setAnswers} />
            <Notice>{error}</Notice>
            <button className="btn" disabled={!checked || busy}
              onClick={() => run(async () => { await bg('create', { phrase, password }); onReady() })}>
              {busy ? 'Creating…' : 'Create wallet'}
            </button>
          </div>
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
      <Header title="Restore wallet" back={step === 'secret' ? '/' : () => setStep('secret')} />
      <div className="body">
        <Progress at={step === 'secret' ? 1 : 2} />
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
            <p className="fine">Works with words or keys from ThruScan&rsquo;s web wallet or any Thru wallet that follows Thru&rsquo;s standard path.</p>
            <Notice>{problem}</Notice>
            <button className="btn" disabled={!secret.trim()} onClick={check}>Continue</button>
          </div>
        )}
        {step === 'password' && (
          <PasswordStep busy={busy} error={error} cta="Restore wallet"
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
        <Mark size={64} />
        <h1>Wallet ready</h1>
        <p className="muted">Pin ThruScan Wallet to your toolbar (the puzzle icon, then the pin) and open it from there any time.</p>
      </div>
      <div className="stack">
        <button className="btn" onClick={() => (inTab() ? window.close() : go('/'))}>{inTab() ? 'Close this tab' : 'Open wallet'}</button>
      </div>
    </div>
  )
}

export function Unlock({ onUnlocked, reason, name }) {
  const [password, setPassword] = useState('')
  const { busy, error, run } = useAction()
  const submit = () => run(async () => { await bg('unlock', { password }); onUnlocked() })
  return (
    <div className="screen welcome">
      <div className="welcome-top">
        <Mark size={64} />
        <h1>Welcome back</h1>
        {name && <p className="mono muted">{name}</p>}
        {reason && <p className="muted">{reason}</p>}
      </div>
      <div className="stack">
        <label className="field">
          <span>Password</span>
          <PasswordField value={password} onChange={setPassword} autoFocus onEnter={submit} />
        </label>
        <Notice>{error}</Notice>
        <button className="btn" disabled={!password || busy} onClick={submit}>{busy ? 'Unlocking…' : 'Unlock'}</button>
        <button className="link" onClick={() => go('/forgot')}>Forgot it? Restore with recovery phrase</button>
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
        <p>The password cannot be recovered: it only exists in your head. To get back in, remove the wallet from this browser and restore it with your 12 words or private key, choosing a new password.</p>
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
