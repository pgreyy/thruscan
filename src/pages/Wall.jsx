// src/pages/Wall.jsx
//
// Messages on chain, optionally addressed to someone. Since Update 02 this is
// the Explorer's Wall tab (/explorer?tab=wall).
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { findWallTransaction } from '../lib/activity.js'
import { getAccount } from '../lib/rpcClient.js'
import { decodeWall, buildPostInstruction, MESSAGE_CHARS, NAME_CHARS } from '../lib/wall.js'
import { WALL_PROGRAM, WALL_ACCOUNT } from '../lib/addresses.js'
import { network } from '../lib/networks.js'
import { useWallet } from './Wallet.jsx'
import { signAndSend, waitForResult, hasWallet } from '../lib/wallet.js'
import { connectWallet } from '../lib/connect.js'
import { notifyTx } from '../lib/notify.js'
import { toast } from '../lib/toasts.js'
import { loadNames } from '../lib/feed.js'
import { relTime } from '../lib/when.js'
import { useUnlockGate, isDismissal } from '../components/Unlock.jsx'
import { Icon } from '../components/Icon.jsx'
import { domainAccount, decodeDomain, addressOf, withSuffix, ROOT_SUFFIX } from '../lib/names.js'

const short = (a) => (a ? `${a.slice(0, 5)}…${a.slice(-4)}` : '')

/** The first .id name this browser claimed for an address, if any. */
function localName(address) {
  if (!address) return null
  try {
    const held = JSON.parse(localStorage.getItem(`thruscan.names.${address}`) || '[]')
    return held.length ? withSuffix(held[0]) : null
  } catch { return null }
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

/* How a post that has landed is told apart from the same post in a read of the
   wall: same sender, same words, same recipient, and posted around now. The
   program stamps the block time, so the time is a window rather than a match. */
const SAME_POST_WINDOW_NS = 5n * 60n * 1_000_000_000n
const samePost = (pending, e) =>
  e.poster === pending.poster && e.message === pending.message && (e.to ?? null) === (pending.to ?? null)
  && (e.postedAtNs > pending.postedAtNs ? e.postedAtNs - pending.postedAtNs : pending.postedAtNs - e.postedAtNs) < SAME_POST_WINDOW_NS

function useWall() {
  const [wall, setWall] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  /* Posts whose transaction has landed but which no read of the wall has shown
     yet. The node's account read trails the transaction by a moment, and the
     endpoint in front of it caches for a few seconds more, so the read that
     follows a post was returning the wall as it was before it. */
  const [pending, setPending] = useState([])
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const read = useCallback(async (fresh) => {
    const account = await getAccount(WALL_ACCOUNT, { fresh })
    return decodeWall(account.data?.base64)
  }, [])

  /* Drop whatever the chain's copy now shows, and anything older than a few
     minutes that it still does not, rather than keep for ever a message that a
     reset removed. */
  const settle = useCallback((fromChain) => {
    setPending((list) => list.filter((p) => !fromChain.entries.some((e) => samePost(p, e))
      && Date.now() - p.addedAt < 5 * 60_000))
  }, [])

  const load = useCallback(async () => {
    if (!WALL_ACCOUNT) { setLoading(false); return }
    setLoading(true); setError(null)
    try {
      const fromChain = await read(false)
      if (!alive.current) return
      setWall(fromChain)
      settle(fromChain)
    } catch (e) {
      if (alive.current) setError(String(e?.message ?? e))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [read, settle])

  useEffect(() => { load() }, [load])

  /* A post has landed. Show it now, then read the wall fresh until the chain
     agrees, which is usually the second read. `entry` is what is known without
     asking the chain: who, what, to whom, and the signature. */
  const posted = useCallback((entry) => {
    const own = entry && entry.message
      ? { ...entry, slot: -1, postedAt: new Date(), postedAtNs: BigInt(Date.now()) * 1_000_000n, verified: true, addedAt: Date.now() }
      : null
    if (own) setPending((list) => [own, ...list])
    ;(async () => {
      for (let i = 0; i < 40 && alive.current; i++) {
        await new Promise((r) => setTimeout(r, i === 0 ? 700 : 1500))
        try {
          const fromChain = await read(true)
          if (!alive.current) return
          setWall(fromChain)
          if (!own || fromChain.entries.some((e) => samePost(own, e))) { settle(fromChain); return }
        } catch { /* the next read may work */ }
      }
    })()
  }, [read, settle])

  /* The wall as the page shows it: the chain's copy plus the posts that have
     landed but are not in it yet, newest first. They count toward the totals
     too, so the figures above the list agree with the list. */
  const shown = useMemo(() => {
    if (!wall) return wall
    const extra = pending.filter((p) => !wall.entries.some((e) => samePost(p, e)))
    if (!extra.length) return wall
    const entries = [...extra, ...wall.entries].sort((a, b) => (a.postedAtNs < b.postedAtNs ? 1 : a.postedAtNs > b.postedAtNs ? -1 : 0))
    return { ...wall, entries, totalPosted: wall.totalPosted + extra.length }
  }, [wall, pending])

  return { wall: shown, loading, error, reload: load, posted }
}

/** Finds the message's transaction only when asked, then opens it. */
function TxLink({ entry }) {
  const navigate = useNavigate()
  const [state, setState] = useState(null)   // null | finding | missing

  const open = async () => {
    setState('finding')
    try {
      const sig = await findWallTransaction(WALL_ACCOUNT, entry.poster, entry.postedAt.getTime())
      if (sig) navigate(`/tx/${sig}`)
      else setState('missing')
    } catch {
      setState('missing')
    }
  }

  return (
    <button type="button" className="linkish wall-tx mono" onClick={open} disabled={state === 'finding'}>
      {state === 'finding' ? 'finding…' : state === 'missing' ? 'transaction not found' : 'transaction'}
    </button>
  )
}

/* ---------------------------------------------------------------- reading */

const PAGE = 20
const DESK = '(min-width: 1024px)'

/** One message. Plain text only: never HTML, never an unfurled link. Long
 *  messages clamp to four lines with "Show more". */
function Message({ entry, you, names, onReply }) {
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  const body = useRef(null)
  const toMe = !!you && entry.to === you
  const who = (a) => (a === you ? 'you' : names.get(a) ?? short(a))

  useLayoutEffect(() => {
    const el = body.current
    if (el) setLong(el.scrollHeight > el.clientHeight + 1)
  }, [entry.message])

  return (
    <article className={`wall-msg${toMe ? ' to-me' : ''}`}>
      <div className="wall-msg-head">
        <span className="wall-msg-who mono">
          <Link to={`/account/${entry.poster}`}>{entry.name || who(entry.poster)}</Link>
          {entry.to && (
            <>
              <span aria-hidden="true"> → </span>
              <span className="sr-only"> to </span>
              <Link to={`/account/${entry.to}`}>{who(entry.to)}</Link>
            </>
          )}
          {toMe && <span className="wall-chip">TO YOU</span>}
        </span>
        <span className="wall-msg-time mono" title={entry.postedAt.toUTCString()}>{relTime(entry.postedAt.getTime())}</span>
      </div>

      <p ref={body} className={`wall-msg-body${open ? ' open' : ''}`}>{entry.message}</p>
      {(long || open) && (
        <button type="button" className="linkish wall-more" onClick={() => setOpen((o) => !o)}>{open ? 'Show less' : 'Show more'}</button>
      )}

      <div className="wall-msg-foot">
        {entry.poster !== you && <button type="button" className="btn tertiary sm" onClick={() => onReply(entry.poster)}>Reply</button>}
        {entry.signature
          ? <Link className="wall-tx mono" to={`/tx/${entry.signature}`}>{short(entry.signature)}</Link>
          : <TxLink entry={entry} />}
      </div>
    </article>
  )
}

/* ---------------------------------------------------------------- writing */

function Composer({ onPosted, to: presetTo, nonce = 0, onClose }) {
  const wallet = useWallet()
  const gate = useUnlockGate()

  const [message, setMessage] = useState('')
  const [toInput, setToInput] = useState(presetTo ?? '')
  const [resolved, setResolved] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  // A Reply or a "Write on Wall" link fills the To field.
  const [preset, setPreset] = useState(`${nonce}:${presetTo}`)
  if (`${nonce}:${presetTo}` !== preset) { setPreset(`${nonce}:${presetTo}`); setToInput(presetTo ?? ''); setResolved(null) }

  const name = localName(wallet.address)
  const used = [...message].length
  const over = used > MESSAGE_CHARS

  // Resolve as they type, but only after they stop, so a half-typed name does
  // not fire a lookup per keystroke.
  useEffect(() => {
    if (!toInput.trim()) return undefined
    let alive = true
    const id = setTimeout(async () => {
      const r = await resolveRecipient(toInput)
      if (alive) setResolved(r)
    }, 450)
    return () => { alive = false; clearTimeout(id) }
  }, [toInput])

  const to = toInput.trim() ? resolved?.address ?? null : null
  const unresolved = !!toInput.trim() && !to

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
        stateUnits: 2_048,
        memoryUnits: 40_000,
      })

      const result = await waitForResult(signature)
      if (result?.settled && !result.succeeded) {
        notifyTx({ address: wallet.address, type: 'wall', title: 'Wall post failed', body: 'Nothing was posted. Only the fee was spent.', sig: signature, ok: false })
        throw new Error('The chain rejected it. If the wall is full this is not the reason: it wraps. Check the transaction for the program error code.')
      }

      setDone(signature)
      setMessage(''); setToInput(''); setResolved(null)
      toast({ kind: 'confirmed', title: 'Message posted', sub: to ? `To ${resolved?.label ?? short(to)}` : 'On the public wall', signature })
      notifyTx({ address: wallet.address, type: 'wall', title: 'Message posted', body: message.trim().slice(0, 80), sig: signature })
      /* The post is on chain, so it goes on the page now, before any read of
         the wall can show it. If the result was never confirmed either way,
         nothing is shown early and the page just keeps reading until it
         appears. */
      onPosted(result?.settled && result.succeeded
        ? { signature, message: message.trim(), name: label, to, poster: wallet.address }
        : null)
      onClose?.()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="wall-compose">
      {gate.modal}
      <h2 className="wall-compose-title">Write on a Wall</h2>

      <div className="form-row">
        <label className="label" htmlFor="wall-to">To</label>
        <input
          id="wall-to"
          className="field mono"
          value={toInput}
          onChange={(e) => { setToInput(e.target.value); setResolved(null) }}
          placeholder={`An address or a name like someone.${ROOT_SUFFIX}`}
          autoComplete="off" spellCheck={false}
        />
        {toInput.trim() && resolved?.error && <p className="field-help bad"><Icon name="failed" size={12} stroke={2.4} />{resolved.error}</p>}
        {to && <p className="field-help">Goes to <span className="mono">{short(to)}</span>{resolved?.label ? `, which is ${resolved.label}` : ''}.</p>}
        {!toInput.trim() && <p className="field-help">Leave it empty to post on the public wall.</p>}
      </div>

      <div className="form-row">
        <label className="label" htmlFor="wall-msg">Message</label>
        <textarea
          id="wall-msg"
          className="field wall-textarea"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Say something"
        />
        <p className={`field-help wall-count mono${over ? ' bad' : ''}`}>{used} / {MESSAGE_CHARS}</p>
      </div>

      {!hasWallet() ? (
        <button type="button" className="btn lg full" onClick={connectWallet}><Icon name="wallet" size={18} />Connect wallet to post</button>
      ) : (
        <button
          type="button"
          className="btn lg full"
          onClick={post}
          disabled={busy || over || message.trim().length === 0 || unresolved}
        >
          {busy ? 'Waiting for wallet' : 'Post message'}
        </button>
      )}
      {!busy && hasWallet() && (message.trim().length === 0 || over || unresolved) && (
        <p className="why">{over ? `Keep it to ${MESSAGE_CHARS} characters.` : unresolved ? 'Check the To field.' : 'Write a message to post.'}</p>
      )}

      {error && <p className="notice bad">{error}</p>}
      {done && (
        <p className="notice">Posted. <Link className="mono" to={`/tx/${done}`}>{short(done)}</Link></p>
      )}

      <p className="fine wall-note">Messages are public and stay on chain. Your wallet signs and pays the network fee.</p>
    </section>
  )
}

/* ---------------------------------------------------------------- the tab */

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'to-you', label: 'To you' },
  { key: 'from-you', label: 'From you' },
]

/**
 * The Explorer's Wall tab (Update 02, 5f/5g): the composer on the left, the
 * messages on the right. On a phone the composer is a bottom sheet behind a
 * floating Write button. ?filter=to-you and ?to=<address> come from
 * notifications and from "Write on Wall" on an account page.
 */
export function WallTab() {
  const { wall, loading, error, posted } = useWall()
  const desktop = useSyncExternalStore(
    (fn) => { const m = window.matchMedia(DESK); m.addEventListener('change', fn); return () => m.removeEventListener('change', fn) },
    () => window.matchMedia(DESK).matches,
    () => true,
  )
  const wallet = useWallet()
  const you = wallet.address
  const [params, setParams] = useSearchParams()
  const filter = FILTERS.some((f) => f.key === params.get('filter')) ? params.get('filter') : 'all'
  const [replyTo, setReplyTo] = useState(() => ({ to: params.get('to') ?? '', n: 0 }))
  const [sheet, setSheet] = useState(() => !!params.get('to') && !window.matchMedia(DESK).matches)
  const [shown, setShown] = useState(PAGE)
  const [names, setNames] = useState(() => new Map())

  useEffect(() => {
    let alive = true
    loadNames().then((m) => { if (alive) setNames(m) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const pick = (key) => {
    const next = new URLSearchParams(params)
    if (key === 'all') next.delete('filter')
    else next.set('filter', key)
    setParams(next, { replace: true })
    setShown(PAGE)
  }

  const { all, inbox, sent } = useMemo(() => {
    const entries = wall?.entries ?? []
    return {
      all: entries,
      inbox: you ? entries.filter((e) => e.to === you) : [],
      sent: you ? entries.filter((e) => e.poster === you) : [],
    }
  }, [wall, you])

  if (!WALL_ACCOUNT || !WALL_PROGRAM) {
    return (
      <section className="empty">
        <span className="empty-title">The wall isn&rsquo;t running on this network yet</span>
        <p>Messages will appear here once the wall program is deployed on {network.label}.</p>
      </section>
    )
  }

  const list = filter === 'to-you' ? inbox : filter === 'from-you' ? sent : all
  const reply = (address) => {
    setReplyTo((r) => ({ to: address, n: r.n + 1 }))
    if (!desktop) setSheet(true)
    else document.getElementById('wall-msg')?.focus()
  }
  const empty = filter === 'to-you'
    ? (you ? 'Nothing addressed to you yet.' : 'Connect a wallet to see messages to you.')
    : filter === 'from-you'
      ? (you ? 'You have not posted anything yet.' : 'Connect a wallet to see what you posted.')
      : 'Nothing has been posted yet.'

  const composer = <Composer key="compose" to={replyTo.to} nonce={replyTo.n} onPosted={posted} onClose={() => setSheet(false)} />

  return (
    <div className="wall-grid">
      {desktop && <aside className="wall-side">{composer}</aside>}

      <section className="wall-main">
        <div className="chips wall-chips" role="group" aria-label="Filter messages">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" className="chip" aria-pressed={filter === f.key} onClick={() => pick(f.key)}>
              {f.label}{f.key === 'to-you' && you ? <span className="mono"> ({inbox.length})</span> : null}
            </button>
          ))}
        </div>

        {error && <p className="notice bad">Could not read the wall. It may be mid-reset.</p>}
        {loading && !wall && <p className="why">Reading the wall from {network.label}…</p>}

        {wall && (list.length === 0
          ? <p className="wall-empty">{empty}</p>
          : (
            <div className="wall-list">
              {list.slice(0, shown).map((e) => (
                <Message key={e.signature ?? `${e.slot}-${e.postedAtNs}`} entry={e} you={you} names={names} onReply={reply} />
              ))}
            </div>
          ))}
        {list.length > shown && (
          <button type="button" className="btn secondary wall-older" onClick={() => setShown((n) => n + PAGE)}>Show older</button>
        )}
        {wall && <p className="fine">The wall keeps the latest {wall.capacity} messages; older ones are overwritten, and a network reset clears it.</p>}
      </section>

      {!desktop && <button type="button" className="wall-fab" onClick={() => setSheet(true)}><Icon name="create" size={18} stroke={2} />Write</button>}
      {!desktop && sheet && createPortal(
        <div className="sheet-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setSheet(false) }}>
          <div className="sheet wall-sheet" role="dialog" aria-modal="true" aria-label="Write on a Wall">
            <span className="sheet-grab" aria-hidden="true" />
            <button type="button" className="txd-x wall-sheet-x" onClick={() => setSheet(false)} aria-label="Close"><Icon name="failed" size={20} /></button>
            {composer}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

export default WallTab
