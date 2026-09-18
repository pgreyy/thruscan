// src/pages/Wall.jsx
//
// Messages on chain, optionally addressed to someone.
//
// Three changes from the version this replaces, and they are all the same
// change really:
//
//   1. A message can name a recipient, so an address has an inbox. This is the
//      Etherscan "message via input data" idea, except the recipient is a field
//      the program parses rather than a string in the message body that the
//      reader has to trust.
//
//   2. Your wallet posts it, not ours. Every post is therefore signed by you
//      and marked as signed by the author, rather than sponsored and marked as
//      not. The old flow had ThruScan pay, which meant the proven address on
//      every browser post was ThruScan's.
//
//   3. There is no "who are you" box. There was one because the chain had no
//      idea who you were; now it does. Your wallet is the identity and your
//      .id name is the label, which is the whole point of having built both.
//
// What is proven and what is not, since this is where people get it wrong:
//
//   The sender is proven. It is the transaction's fee payer, read out of the
//   transaction by the program. You cannot pay a fee for a key you do not hold.
//
//   The recipient is not proven and cannot be. Writing to someone needs no
//   permission from them, exactly as sending them a transaction does not. So an
//   inbox is "messages addressed here", never "messages this person accepted",
//   and this page says that out loud rather than implying otherwise.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getAccount } from '../lib/rpcClient.js'
import { decodeWall, buildPostInstruction, MESSAGE_CHARS, NAME_CHARS, toHex } from '../lib/wall.js'
import { WALL_PROGRAM, WALL_ACCOUNT } from '../lib/addresses.js'
import { useWallet } from './Wallet.jsx'
import { signAndSend, waitForResult, hasWallet } from '../lib/wallet.js'
import { useUnlockGate, isDismissal } from '../components/Unlock.jsx'
import { Tabs } from '../components/Tabs.jsx'
import { domainAccount, decodeDomain, addressOf, withSuffix, ROOT_SUFFIX } from '../lib/names.js'

const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '')

/** The first .id name this browser claimed for an address, if any. */
function localName(address) {
  if (!address) return null
  try {
    const held = JSON.parse(localStorage.getItem(`thruscan.names.${address}`) || '[]')
    return held.length ? withSuffix(held[0]) : null
  } catch { return null }
}

function ago(date) {
  const s = Math.max(0, (Date.now() - date.getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/**
 * Turn what someone typed into an address.
 *
 * Accepts a raw Thru address or a name. A name is resolved through the name
 * service rather than through anything this browser remembers, so it works for
 * names you have never seen and cannot be spoofed by local storage.
 */
async function resolveRecipient(input) {
  const raw = input.trim()
  if (!raw) return { address: null }

  if (raw.startsWith('ta') && raw.length > 40 && !raw.includes('.')) {
    return { address: raw }
  }

  const label = raw.replace(/^@/, '').replace(new RegExp(`\\.${ROOT_SUFFIX}$`, 'i'), '').toLowerCase()
  if (!label) return { error: 'That is not an address or a name.' }

  try {
    const domain = await domainAccount(label)
    const account = await getAccount(domain)
    if (!account?.data?.base64) {
      return { error: `Nobody has claimed ${withSuffix(label)}.` }
    }
    const bytes = Uint8Array.from(atob(account.data.base64), (c) => c.charCodeAt(0))
    const decoded = decodeDomain(bytes)
    if (!decoded) return { error: `Could not read ${withSuffix(label)}.` }
    const address = addressOf(decoded) || decoded.owner
    return { address, label: withSuffix(label) }
  } catch (e) {
    return { error: `Could not look up ${withSuffix(label)}: ${String(e?.message ?? e)}` }
  }
}

/* ---------------------------------------------------------------- reading */

function useWall() {
  const [wall, setWall] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!WALL_ACCOUNT) { setLoading(false); return }
    setLoading(true); setError(null)
    try {
      const account = await getAccount(WALL_ACCOUNT)
      setWall(decodeWall(account.data?.base64))
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  return { wall, loading, error, reload: load }
}

function Message({ entry, you }) {
  const mine = you && entry.poster === you
  const toMe = you && entry.to === you

  return (
    <article className="wall-msg">
      <div className="wall-msg-head">
        <span className="wall-msg-who">
          {entry.name || short(entry.poster)}
          {entry.verified
            ? <span className="wall-badge ok" title="The sender paid for this transaction, so the address is proven">signed</span>
            : <span className="wall-badge" title="Posted through ThruScan's key, so the address is ThruScan's">sponsored</span>}
          {mine && <span className="wall-badge you">you</span>}
        </span>
        <span className="fine">{ago(entry.postedAt)}</span>
      </div>

      <p className="wall-msg-body">{entry.message}</p>

      <div className="wall-msg-foot fine">
        <Link className="mono" to={`/account/${entry.poster}`}>{short(entry.poster)}</Link>
        {entry.to && (
          <>
            <span aria-hidden="true">→</span>
            <Link className="mono" to={`/account/${entry.to}`}>
              {toMe ? 'you' : short(entry.to)}
            </Link>
          </>
        )}
        {!entry.to && <span>public</span>}
      </div>
    </article>
  )
}

function MessageList({ entries, you, empty }) {
  if (!entries.length) return <p className="fine" style={{ padding: '14px 2px', lineHeight: 1.65 }}>{empty}</p>
  return <div className="wall-list">{entries.map((e) => <Message key={`${e.slot}-${e.postedAtNs}`} entry={e} you={you} />)}</div>
}

/* ---------------------------------------------------------------- writing */

function Composer({ onPosted, fixedTo = null }) {
  const wallet = useWallet()
  const gate = useUnlockGate()

  const [message, setMessage] = useState('')
  const [toInput, setToInput] = useState('')
  const [resolved, setResolved] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  const name = localName(wallet.address)
  const used = [...message].length
  const over = used > MESSAGE_CHARS

  // Resolve as they type, but only after they stop, so a half-typed name does
  // not fire a lookup per keystroke.
  useEffect(() => {
    if (fixedTo || !toInput.trim()) { setResolved(null); return }
    let alive = true
    const id = setTimeout(async () => {
      const r = await resolveRecipient(toInput)
      if (alive) setResolved(r)
    }, 450)
    return () => { alive = false; clearTimeout(id) }
  }, [toInput, fixedTo])

  const to = fixedTo ?? resolved?.address ?? null

  const post = async () => {
    setError(null); setDone(null)
    try { await gate.ensure() } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return
    }

    setBusy(true)
    try {
      // The label is the .id name when there is one, so the wall shows a name
      // rather than a truncated address, and it is not a free text field
      // anybody can put anything in.
      const label = name ? name.slice(0, NAME_CHARS) : ''
      const data = buildPostInstruction({ name: label, handle: '', message, to })

      const signature = await signAndSend({
        program: WALL_PROGRAM,
        readWrite: [WALL_ACCOUNT],
        data,
        computeUnits: 2_000_000,
        stateUnits: 40_000,
        memoryUnits: 40_000,
      })

      const result = await waitForResult(signature)
      if (result?.settled && !result.succeeded) {
        throw new Error('The chain rejected it. If the wall is full this is not the reason: it wraps. Check the transaction for the program error code.')
      }

      setDone(signature)
      setMessage(''); setToInput(''); setResolved(null)
      setTimeout(onPosted, 1200)
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  if (!hasWallet()) {
    return (
      <section className="card">
        <h2 className="h2">Open a wallet to post</h2>
        <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
          Posts are signed by whoever sends them, which is what makes the address on a message
          worth anything. <Link to="/wallet">Open a wallet</Link>, which takes about fifteen
          seconds, and your messages are signed by you rather than by us.
        </p>
      </section>
    )
  }

  return (
    <section className="card">
      {gate.modal}

      <div className="card-head">
        <div>
          <h2 className="h2">{fixedTo ? 'Send a message' : 'Post'}</h2>
          <p className="sub">
            {name ? <>as <b>{name}</b></> : <>as <span className="mono">{short(wallet.address)}</span></>}
          </p>
        </div>
      </div>

      {!name && (
        <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
          You are posting as your address. <Link to="/names">Claim a .{ROOT_SUFFIX} name</Link> and
          it becomes your label here and everywhere else, without you typing it each time.
        </p>
      )}

      {!fixedTo && (
        <div className="form-row" style={{ marginTop: 14 }}>
          <label className="label">To, if anyone</label>
          <input
            className="field mono"
            value={toInput}
            onChange={(e) => setToInput(e.target.value)}
            placeholder={`An address, or a name like someone.${ROOT_SUFFIX}`}
          />
          {resolved?.error && <p className="fine" style={{ margin: '6px 0 0', color: 'var(--signal)' }}>{resolved.error}</p>}
          {resolved?.address && (
            <p className="fine" style={{ margin: '6px 0 0' }}>
              Goes to <span className="mono">{short(resolved.address)}</span>
              {resolved.label ? `, which is ${resolved.label}` : ''}.
            </p>
          )}
          {!toInput.trim() && (
            <p className="fine" style={{ margin: '6px 0 0' }}>
              Leave it empty and the message is public, which is what the wall has always been.
            </p>
          )}
        </div>
      )}

      <div className="form-row" style={{ marginTop: 14 }}>
        <label className="label">Message</label>
        <textarea
          className="field"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Say something"
          rows={3}
        />
        <p className="fine" style={{ margin: '6px 0 0', color: over ? 'var(--signal)' : undefined }}>
          {used} of {MESSAGE_CHARS} characters
        </p>
      </div>

      <button
        className="btn"
        style={{ width: '100%', marginTop: 14 }}
        onClick={post}
        disabled={busy || over || message.trim().length === 0}
      >
        {busy ? 'Signing' : to ? 'Send it' : 'Post it'}
      </button>

      {error && <p className="notice bad" style={{ marginTop: 12 }}>{error}</p>}
      {done && (
        <p className="notice" style={{ marginTop: 12 }}>
          Posted. <Link className="mono" to={`/tx/${done}`}>{short(done)}</Link>
        </p>
      )}

      <p className="fine" style={{ marginTop: 14, lineHeight: 1.65 }}>
        Anyone can address a message to any account, the same way anyone can send one a
        transaction, so arriving in someone's inbox is not a sign that they know you. Everything
        here is public and permanent for as long as alphanet lives: the wall holds a fixed number
        of messages and the oldest is overwritten when it fills.
      </p>
    </section>
  )
}

/* ---------------------------------------------------------------- the page */

function NotDeployed() {
  return (
    <div className="wrap wrap-top">
      <section className="card">
        <h2 className="h2">Not deployed yet</h2>
        <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
          The wall program that carries a recipient is written but is not on chain yet. Once it is
          deployed and its two addresses are in <code className="mono">src/lib/addresses.js</code>,
          this page reads it and messages work.
        </p>
      </section>
    </div>
  )
}

/** Messages addressed to one account. Rendered on an address's own page. */
export function AddressMessages({ address }) {
  const { wall, loading, reload } = useWall()
  const wallet = useWallet()

  if (!WALL_ACCOUNT) return null

  const inbox = wall?.entries?.filter((e) => e.to === address) ?? []
  const isYou = wallet.address === address

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="h2">Messages</h2>
          <p className="sub">{inbox.length} addressed to this account</p>
        </div>
        <button className="btn ghost" onClick={reload} disabled={loading}>{loading ? 'Reading' : 'Refresh'}</button>
      </div>

      <MessageList
        entries={inbox}
        you={wallet.address}
        empty="Nothing has been sent here."
      />

      {!isYou && hasWallet() && (
        <div style={{ marginTop: 14 }}>
          <Composer fixedTo={address} onPosted={reload} />
        </div>
      )}
    </section>
  )
}

export function WallPage() {
  const { wall, loading, error, reload } = useWall()
  const wallet = useWallet()
  const you = wallet.address

  const { inbox, sent, all } = useMemo(() => {
    const entries = wall?.entries ?? []
    return {
      all: entries,
      inbox: you ? entries.filter((e) => e.to === you) : [],
      sent: you ? entries.filter((e) => e.poster === you) : [],
    }
  }, [wall, you])

  if (!WALL_ACCOUNT || !WALL_PROGRAM) return <NotDeployed />

  const header = (
    <>
      {error && <p className="notice bad">Could not read the wall. It may be mid-reset.</p>}
      <Composer onPosted={reload} />
    </>
  )

  const stats = wall && (
    <div className="stat-strip" style={{ marginBottom: 16 }}>
      <div className="stat-cell"><span className="k">Messages ever</span><span className="v">{wall.totalPosted.toLocaleString()}</span></div>
      <div className="stat-cell"><span className="k">Signed by sender</span><span className="v">{wall.entries.filter((e) => e.verified).length}</span></div>
      <div className="stat-cell"><span className="k">Addressed</span><span className="v">{wall.entries.filter((e) => e.to).length}</span></div>
      <div className="stat-cell"><span className="k">Slots filled</span><span className="v">{wall.entries.length}/{wall.capacity}</span></div>
    </div>
  )

  const panel = (entries, empty) => (
    <div className="wrap wrap-top">
      {stats}
      {header}
      <section className="card">
        <div className="card-head">
          <div><h2 className="h2">Messages</h2></div>
          <button className="btn ghost" onClick={reload} disabled={loading}>{loading ? 'Reading' : 'Refresh'}</button>
        </div>
        <MessageList entries={entries} you={you} empty={empty} />
      </section>
    </div>
  )

  return (
    <Tabs
      tabs={[
        { key: 'all', label: 'Everything', el: panel(all, 'Nothing has been posted yet.'), badge: all.length || null },
        {
          key: 'inbox',
          label: 'To you',
          badge: inbox.length || null,
          el: panel(inbox, you
            ? 'Nothing has been addressed to you. Anyone can send here by putting your address or your name in the To field.'
            : 'Open a wallet and anything addressed to it shows up here.'),
        },
        { key: 'sent', label: 'Sent', el: panel(sent, 'You have not posted anything yet.'), badge: sent.length || null },
      ]}
    />
  )
}

export default WallPage
