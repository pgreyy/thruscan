// src/lib/feed.js
//
// Reading activity from the indexer.
//
// The difference from src/lib/activity.js is where the work happens. That one
// asks the chain for an account's transactions and decodes each of them in the
// browser, every time a page loads. This asks for rows that were decoded once,
// when they happened, and never again.
//
// The endpoint answers from the indexer when there is one and from the chain
// when there is not, so this does not need to know or care which. An empty
// list here means the chain is quiet, never that something is unconfigured.

import {
  describe, programName, movements, formatDelta, fetchEvents, EOA_PROGRAM,
} from './activity.js'
import {
  THRUSWAP_PROGRAM, THRUPAD_PROGRAM, WALL_PROGRAM, TOKEN_PROGRAM,
  NAME_SERVICE_PROGRAM, NATIVE_FAUCET_PROGRAM, MULTICALL_PROGRAM, NFT_PROGRAM,
} from './addresses.js'
import { ROOT_SUFFIX } from './names.js'

const KIND_GROUPS = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'launch', label: 'Launches', kinds: ['launch'] },
  { id: 'trade', label: 'Trades', kinds: ['buy', 'sell', 'swap'] },
  { id: 'nft', label: 'NFTs', kinds: ['nft'] },
  { id: 'token', label: 'Tokens', kinds: ['token', 'mint', 'transfer', 'burn'] },
  { id: 'name', label: 'ThruNames', kinds: ['name'] },
]

export { KIND_GROUPS }

/**
 * One page of activity.
 *
 * `kind` takes a single kind, because that is what the endpoint filters on. A
 * group covering several kinds is filtered here instead, which is honest about
 * the cost: it fetches a page and keeps part of it. Worth it for now, and the
 * right fix later is for the endpoint to take a list.
 */
export async function fetchFeed({ group = 'all', address = null, before = null, limit = 50 } = {}) {
  const g = KIND_GROUPS.find((x) => x.id === group) ?? KIND_GROUPS[0]
  const single = g.kinds && g.kinds.length === 1 ? g.kinds[0] : null

  const q = new URLSearchParams()
  if (single) q.set('kind', single)
  if (address) q.set('address', address)
  if (before) q.set('before', before)
  q.set('limit', String(limit))

  let r
  try {
    r = await fetch(`/api/activity?${q}`)
  } catch (e) {
    return { items: [], next: null, problem: 'offline', detail: String(e?.message ?? e) }
  }

  let body
  try {
    body = await r.json()
  } catch {
    return { items: [], next: null, problem: 'unreadable', detail: `The server answered ${r.status}.` }
  }

  if (!body.ok) {
    return {
      items: [],
      next: null,
      problem: 'error',
      detail: body.detail ?? body.error ?? 'Something went wrong.',
    }
  }

  /* A group covering several kinds is narrowed here. `all` keeps everything. */
  const items = g.kinds && g.kinds.length > 1
    ? body.items.filter((i) => g.kinds.includes(i.kind))
    : body.items

  return { items, next: body.next, problem: null, source: body.source }
}

/* The dot beside each row. Kept to three states rather than one colour per
   kind: a wall of colour reads as decoration, and the only distinction that
   changes what somebody does is whether it worked. */
export function toneOf(item) {
  if (!item.ok) return 'bad'
  if (item.kind === 'launch' || item.kind === 'graduate' || item.kind === 'migrate') return 'mark'
  return 'plain'
}

export const shortId = (s) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : '')


/* ------------------------------------------------------------------ a row, read
 *
 * What the activity table shows beyond what the row says outright: the plain
 * description, who the other party is, what moved and what it cost. All of it
 * comes from the row itself (the node's own fee, the instruction's first
 * bytes, the accounts it names) or from the chain's token events for the same
 * transaction. Nothing here estimates; where the data is not there, each
 * function says so by returning null or an empty list.
 */

/** A feed row in the shape describe() and movements() read. */
export const asItem = (row) => ({ ...row, feePayer: row.who, rw: row.rw ?? [], ro: row.ro ?? [] })

/** describe() knows the programs by their own opcodes, but a bundle is just
 *  "a program call" to it, and almost every write the site makes is a bundle.
 *  For those the decoder has already read what is inside, so its label wins. */
export function detailOf(row) {
  /* describe() reads the opcode from the instruction. A row indexed before the
     instruction was kept has none, and its own label is the better answer. */
  if (!row.data && row.label) return row.label
  const d = describe(asItem(row), null).label
  return d === 'Program call' && row.label ? row.label : d
}

const bytesOf = (b64) => {
  if (!b64) return new Uint8Array()
  const bin = atob(b64)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** The wallet a THRU transfer pays, read from the instruction:
 *  [u32 1][u64 amount][u16 from][u16 to], the indices pointing into
 *  [fee payer, program, ...read-write, ...read-only]. */
export function recipientOf(row) {
  if (row.program !== EOA_PROGRAM) return null
  const b = bytesOf(row.data)
  if (b.length < 16) return null
  const dv = new DataView(b.buffer, b.byteOffset)
  if (dv.getUint32(0, true) !== 1) return null
  return [row.who, row.program, ...(row.rw ?? []), ...(row.ro ?? [])][dv.getUint16(14, true)] ?? null
}

/* A bundle calls Multicall, which is true and tells nobody anything. The
   decoder's kind names what was inside, which is the program a reader means. */
const BY_KIND = {
  pad: THRUPAD_PROGRAM, launch: THRUPAD_PROGRAM, buy: THRUPAD_PROGRAM, sell: THRUPAD_PROGRAM,
  claim: THRUPAD_PROGRAM, graduate: THRUPAD_PROGRAM, migrate: THRUPAD_PROGRAM,
  swap: THRUSWAP_PROGRAM, pool: THRUSWAP_PROGRAM, liquidity: THRUSWAP_PROGRAM,
  name: NAME_SERVICE_PROGRAM, wall: WALL_PROGRAM, faucet: NATIVE_FAUCET_PROGRAM,
  token: TOKEN_PROGRAM, transfer: TOKEN_PROGRAM, mint: TOKEN_PROGRAM, burn: TOKEN_PROGRAM, account: TOKEN_PROGRAM,
  nft: NFT_PROGRAM,
}

const owned = (extra, a, who) => extra?.accounts?.[a]?.kind === 'token' && extra.accounts[a].owner === who

/**
 * Where the transaction went: { address, label, wallet }.
 * A wallet when it is a transfer to one, otherwise the program called.
 */
export function targetOf(row, extra) {
  const to = recipientOf(row)
  if (to) return { address: to, label: shortId(to), wallet: true }

  if (row.kind === 'transfer' && row.program !== EOA_PROGRAM) {
    const sent = (extra?.events?.[row.signature] ?? []).find((e) => e.op === 'transfer' && owned(extra, e.from, row.who))
    const owner = sent && extra.accounts?.[sent.to]?.owner
    if (owner) return { address: owner, label: shortId(owner), wallet: true }
  }

  let program = row.program
  let label = programName(program)
  if (!label && program === MULTICALL_PROGRAM && BY_KIND[row.kind]) {
    program = BY_KIND[row.kind]
    label = programName(program)
  }
  if (!label && program === MULTICALL_PROGRAM) label = 'Multicall'
  return { address: program, label: label ?? shortId(program), wallet: false, mono: !label }
}

const TOKEN_MOVING = new Set(['buy', 'sell', 'swap', 'liquidity', 'pool', 'transfer', 'mint', 'burn', 'claim', 'graduate', 'migrate', 'faucet', 'bundle', 'nft', 'token'])

/** Whether this row's amounts need the chain's token events. A THRU transfer
 *  and a native faucet draw are in the instruction itself. */
export function wantsEvents(row) {
  return !!row.ok && TOKEN_MOVING.has(row.kind) && row.program !== EOA_PROGRAM && row.program !== NATIVE_FAUCET_PROGRAM
}

/** What the transaction did to the sender's balances: [{ label, delta, text }].
 *  A failed transaction moved nothing, whatever its instruction asked for. */
export function amountsOf(row, extra) {
  if (!row.ok) return []
  return movements(asItem(row), extra, row.who).map((m) => ({ ...m, text: formatDelta(m) }))
}

/** The one figure for a narrow row: what the wallet received if it received
 *  anything, otherwise the first thing it sent. */
export const primaryAmount = (list) => list.find((a) => a.delta > 0) ?? list[0] ?? null

/** The node's fee as the /tx page words it, or null when it was not recorded. */
export function feeOf(row) {
  if (row.fee == null || row.fee === '') return null
  const n = Number(row.fee)
  return Number.isFinite(n) ? `${n.toLocaleString('en-US')} THRU` : null
}

/* ---- what is fetched once and kept ---- */

const eventStore = { events: {}, accounts: {} }
const eventsInflight = new Map()   // signature -> the request that will settle it
const eventsSettled = new Set()    // asked about, and the answer (or the failure) is in

/** Token events for these signatures, fetched once each per page load: a landed
 *  transaction's events never change. Two callers asking about the same
 *  signature share one request, and a failed request settles its signatures
 *  too, so a row says "no amount" rather than waiting for ever. */
export async function loadEvents(signatures) {
  const fresh = [...new Set(signatures)].filter((s) => s && !eventsInflight.has(s) && !eventsSettled.has(s))
  if (fresh.length) {
    const request = fetchEvents(fresh)
      .then((got) => { Object.assign(eventStore.events, got.events); Object.assign(eventStore.accounts, got.accounts) })
      .catch(() => {})
      .finally(() => fresh.forEach((s) => { eventsSettled.add(s); eventsInflight.delete(s) }))
    fresh.forEach((s) => eventsInflight.set(s, request))
  }
  await Promise.all([...new Set(signatures.map((s) => eventsInflight.get(s)).filter(Boolean))])
  return eventStore
}
/** Whether the question has been answered for this signature, either way. */
export const eventsReady = (sig) => eventsSettled.has(sig)

let nameCache = { at: 0, map: new Map() }

/** Registered names by owner, "alice.id". One request, refreshed each minute;
 *  an unreachable list is an empty one, and addresses show as addresses. */
export async function loadNames() {
  if (Date.now() - nameCache.at < 60_000) return nameCache.map
  try {
    const body = await (await fetch('/api/rpc?action=names')).json()
    if (body?.ok) {
      const map = new Map()
      for (const r of body.names ?? []) if (r.owner && r.name && !map.has(r.owner)) map.set(r.owner, `${r.name}.${ROOT_SUFFIX}`)
      nameCache = { at: Date.now(), map }
    }
  } catch { /* keep what we had */ }
  return nameCache.map
}
