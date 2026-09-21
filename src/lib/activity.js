// src/lib/activity.js
//
// Transaction history for one or more accounts, read from the chain through
// /api/rpc, and a short human label for each transaction.
//
// Labels come from the program and the first bytes of the instruction, using
// the same opcodes the builders in swap.js, pad.js, names.js and wallet.js
// write. Anything unrecognised is shown as a plain program call.

import {
  THRUSWAP_PROGRAM, THRUPAD_PROGRAM, WALL_PROGRAM, TOKEN_PROGRAM,
  NAME_SERVICE_PROGRAM, NATIVE_FAUCET_PROGRAM, TUSD_MINT, WTHRU_MINT,
} from './addresses.js'
import { ROOT_REGISTRAR, ROOT_SUFFIX } from './names.js'

const EOA_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

export async function fetchHistory(addresses, pages = null) {
  const list = [...new Set(addresses.filter(Boolean))].slice(0, 6)
  if (list.length === 0) return { items: [], next: null }
  const q = new URLSearchParams({ action: 'history', addresses: list.join(',') })
  if (pages) q.set('pages', JSON.stringify(pages))
  const res = await fetch(`/api/rpc?${q}`)
  let body
  try { body = await res.json() } catch { throw new Error(`History did not load (${res.status}).`) }
  if (!res.ok || body.ok === false) throw new Error(body.error || `History did not load (${res.status}).`)
  return { items: body.items ?? [], next: body.next ?? null }
}

function bytesOf(b64) {
  if (!b64) return new Uint8Array()
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const u32 = (b, at) => (b.length >= at + 4 ? new DataView(b.buffer, b.byteOffset).getUint32(at, true) : null)

/** The name inside a REGISTER_SUBDOMAIN instruction: 64 bytes at 12, length at 76. */
function registeredName(b) {
  if (b.length < 84) return null
  const len = Number(new DataView(b.buffer, b.byteOffset).getBigUint64(76, true))
  if (!len || len > 64) return null
  return new TextDecoder().decode(b.slice(12, 12 + len))
}

/**
 * { label, tone } for one history item. `me` is the viewer's address, used to
 * tell sent from received and a sponsored faucet mint from a self-signed one.
 */
export function describe(item, me) {
  const b = bytesOf(item.data)
  const op = b[0]
  const byMe = me && item.feePayer === me

  switch (item.program) {
    case THRUSWAP_PROGRAM:
      return { label: ({ 1: 'Created a pool', 2: 'Added liquidity', 3: 'Removed liquidity', 4: 'Swap' })[op] ?? 'Swap program' }
    case THRUPAD_PROGRAM:
      return { label: ({ 1: 'Launched a token', 2: 'Bought on launchpad', 3: 'Sold on launchpad', 4: 'Claimed creator fees', 5: 'Graduated a launch' })[op] ?? 'Launchpad' }
    case WALL_PROGRAM:
      return { label: 'Wall message' }
    case NAME_SERVICE_PROGRAM: {
      const nop = u32(b, 0)
      if (nop === 1) {
        const n = registeredName(b)
        // The name service is shared; only names under our root end in .id.
        const ours = item.rw?.includes(ROOT_REGISTRAR)
        return { label: n ? `Registered ${ours ? `${n}.${ROOT_SUFFIX}` : `"${n}"`}` : 'Registered a name' }
      }
      return { label: ({ 2: 'Set a name record', 3: 'Removed a name record', 4: 'Released a name' })[nop] ?? 'Name service' }
    }
    case TOKEN_PROGRAM: {
      if (op === 2) return { label: !me ? 'Token transfer' : byMe ? 'Sent tokens' : 'Received tokens' }
      if (op === 3) {
        const mint = item.rw.find((a) => a === TUSD_MINT || a === WTHRU_MINT)
        return { label: !byMe && mint === TUSD_MINT ? 'tUSD from faucet' : 'Minted tokens' }
      }
      return { label: ({ 0: 'Created a token', 1: 'Opened a token account', 4: 'Burned tokens' })[op] ?? 'Token program' }
    }
    case NATIVE_FAUCET_PROGRAM:
      return { label: 'THRU from faucet' }
    case EOA_PROGRAM: {
      const eop = u32(b, 0)
      if (eop === 0) return { label: 'Account created' }
      if (eop === 1) return { label: !me ? 'THRU transfer' : byMe ? 'Sent THRU' : 'Received THRU' }
      return { label: 'Account program' }
    }
    default:
      return { label: 'Program call' }
  }
}

export function timeAgo(ms) {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ms).toLocaleDateString()
}

/**
 * Names this address registered, found in its own history. Registration puts
 * the owner in the transaction, so the chain can answer "which names" without
 * an owner index. The caller still checks each domain's current owner, since a
 * name may have been released or moved since.
 */
export async function namesFromHistory(address, maxPages = 6) {
  const found = new Map()
  let pages = null
  for (let i = 0; i < maxPages; i++) {
    const { items, next } = await fetchHistory([address], pages)
    for (const it of items) {
      if (it.program !== NAME_SERVICE_PROGRAM || it.ok === false) continue
      const b = bytesOf(it.data)
      if (u32(b, 0) !== 1 || !it.rw.includes(ROOT_REGISTRAR)) continue
      const name = registeredName(b)
      const account = it.rw.find((a) => a !== ROOT_REGISTRAR)
      if (name && account && !found.has(name)) found.set(name, account)
    }
    if (!next || !next[address]) break
    pages = next
  }
  return [...found.keys()]
}

/** A readable name for the programs ThruScan knows, or null. */
export function programName(address) {
  return ({
    [THRUSWAP_PROGRAM]: 'ThruSwap',
    [THRUPAD_PROGRAM]: 'ThruPad launchpad',
    [WALL_PROGRAM]: 'ThruWall',
    [TOKEN_PROGRAM]: 'Token program',
    [NAME_SERVICE_PROGRAM]: 'Name service',
    [NATIVE_FAUCET_PROGRAM]: 'Thru faucet',
    [EOA_PROGRAM]: 'Account program',
  })[address] ?? null
}

/**
 * The transaction that wrote a wall message. The wall stores the sender and
 * the block time but not the signature, so this walks the wall account's own
 * history back to that time and picks the sender's transaction at it.
 */
export async function findWallTransaction(wallAccount, poster, postedAtMs, maxPages = 10) {
  let pages = null
  for (let i = 0; i < maxPages; i++) {
    const { items, next } = await fetchHistory([wallAccount], pages)
    const hit = items.find((t) => t.feePayer === poster && t.time && Math.abs(t.time - postedAtMs) < 2000)
    if (hit) return hit.signature
    const oldest = items[items.length - 1]
    if (!next || !next[wallAccount] || (oldest?.time && oldest.time < postedAtMs - 60_000)) break
    pages = next
  }
  return null
}

/* ---------- amounts ---------- */

/** Token transfers, mints and burns for these transactions, from the chain. */
export async function fetchEvents(signatures) {
  const list = [...new Set(signatures.filter(Boolean))]
  if (list.length === 0) return { events: {}, accounts: {} }
  const out = { events: {}, accounts: {} }
  // A handful per request keeps each one well inside the server's time limit.
  for (let i = 0; i < list.length; i += 15) {
    const q = new URLSearchParams({ action: 'events', signatures: list.slice(i, i + 15).join(',') })
    const body = await fetch(`/api/rpc?${q}`).then((r) => r.json()).catch(() => null)
    if (!body?.ok) continue
    Object.assign(out.events, body.events)
    Object.assign(out.accounts, body.accounts)
  }
  return out
}

/**
 * What one transaction did to `me`'s balances: [{ label, delta }], where delta
 * is a signed number already scaled by decimals. THRU moves are read from the
 * instruction, token moves from the token program's records.
 */
export function movements(item, extra, me) {
  if (!me) return []
  const out = new Map()   // label -> number
  const add = (label, v) => out.set(label, (out.get(label) ?? 0) + v)
  const b = bytesOf(item.data)
  const dv = b.length ? new DataView(b.buffer, b.byteOffset) : null

  if (item.program === EOA_PROGRAM && u32(b, 0) === 1 && b.length >= 16) {
    const amount = Number(dv.getBigUint64(4, true))
    // [u32 1][u64 amount][u16 from][u16 to]; from is the fee payer.
    if (item.feePayer === me) add('THRU', -amount)
    else if (item.rw.includes(me)) add('THRU', amount)
  }
  if (item.program === NATIVE_FAUCET_PROGRAM && item.feePayer === me && b.length >= 16) {
    add('THRU', Number(dv.getBigUint64(8, true)))
  }

  const events = extra?.events?.[item.signature] ?? []
  const acc = extra?.accounts ?? {}
  const mineAcc = (a) => acc[a]?.kind === 'token' && acc[a].owner === me
  const scale = (tokenAccount, mint, amount) => {
    const m = mint ?? acc[tokenAccount]?.mint
    const info = acc[m]
    const decimals = info?.kind === 'mint' ? info.decimals : 6
    const label = info?.kind === 'mint' && info.ticker ? info.ticker : (m ? `${m.slice(0, 4)}…` : 'tokens')
    return [label, Number(amount) / 10 ** decimals]
  }
  for (const e of events) {
    if (e.op === 'transfer') {
      if (mineAcc(e.from) && !mineAcc(e.to)) { const [l, v] = scale(e.from, null, e.amount); add(l, -v) }
      if (mineAcc(e.to) && !mineAcc(e.from)) { const [l, v] = scale(e.to, null, e.amount); add(l, v) }
    } else if (e.op === 'mint' && mineAcc(e.to)) {
      const [l, v] = scale(e.to, e.mint, e.amount); add(l, v)
    } else if (e.op === 'burn' && mineAcc(e.from)) {
      const [l, v] = scale(e.from, e.mint, e.amount); add(l, -v)
    }
  }
  return [...out].filter(([, v]) => v !== 0).map(([label, delta]) => ({ label, delta }))
}

export function formatDelta({ label, delta }) {
  const abs = Math.abs(delta)
  const n = abs >= 1e6 ? abs.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : abs.toLocaleString(undefined, { maximumFractionDigits: abs < 1 ? 6 : 4 })
  return `${delta < 0 ? '−' : '+'}${n} ${label}`
}
