// api/activity.js
//
// Serves what the indexer has already read, so the browser never waits on the
// chain for a list of what happened.
//
// This is the other half of indexer/. The indexer walks the chain and writes
// rows; this hands those rows to the site. Nothing here talks to a node, which
// is the entire point: /api/rpc is a round trip to a blockchain, and this is a
// query against a table.
//
// Routes (GET):
//   /api/activity                      the newest activity on the whole chain
//   /api/activity?kind=buy             one kind: buy, sell, launch, swap, mint…
//   /api/activity?kinds=buy,sell,swap  several kinds
//   /api/activity?scope=thruscan       only ThruScan's own programs and accounts
//   /api/activity?address=ta...        everything one wallet took part in
//   /api/activity?before=18500.168     the page after a row, for "show older"
//   /api/activity?limit=50             up to 200
//
// Where the rows come from, in order of preference:
//   DATABASE_URL set   -> Postgres, written by the indexer. Fast, complete,
//                         and what production should use.
//   an index.db file   -> the indexer's SQLite, where the indexer itself runs.
//   neither            -> the chain, read live and decoded per request.
//
// That last one matters more than it looks. The feed has to work the moment
// the site is deployed, with nothing set up, or it is not a feature, it is a
// note asking somebody to go and build one. The chain path is slower and shows
// less history, so the database is worth having; it is an improvement to
// something that already works rather than a prerequisite for it working
// at all.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveClient, withTimeout } from './rpc.js'
import { makeDecoder } from '../indexer/decode.mjs'
import { addressesFor } from '../indexer/addresses.mjs'
import { activeAddresses } from '../src/lib/networks.js'

export const config = { runtime: 'nodejs', maxDuration: 15 }

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50

/* Kinds the indexer writes. Anything else in the query string is refused
   rather than passed through, because this value reaches a query. */
const KINDS = new Set([
  'pad', 'launch', 'buy', 'sell', 'claim', 'graduate', 'migrate',
  'pool', 'liquidity', 'swap',
  'token', 'account', 'transfer', 'mint', 'burn',
  'faucet', 'name', 'nft', 'wall', 'game', 'wrap', 'bundle', 'noop', 'oracle', 'other',
])

/* What the chain does by itself. The node writes a do-nothing transaction per
   empty slot and the oracle posts prices continuously, and on a quiet chain
   those are very nearly all of the traffic. Left in, the feed is a list of the
   chain being alive rather than of anybody doing anything, so both are
   excluded unless asked for by name. */
const HIDDEN_KINDS = ['noop', 'oracle']

/* 2048 is retired: its moves and leaderboard names are left out of the feed
   (the programs stay on chain; their transactions still open by link). */
const RETIRED_PROGRAM_KEYS = ['G2048_PROGRAM', 'ID_PROGRAM']
const retiredPrograms = () => RETIRED_PROGRAM_KEYS.map((k) => activeAddresses()[k]).filter(Boolean)

/* What "ThruScan only" means for rows that already carry a kind: the
   launchpad, swap, the wall, .id names and the games. The chain path answers
   the same question more precisely, from ThruScan's own accounts. */
const THRUSCAN_KINDS = ['pad', 'launch', 'buy', 'sell', 'claim', 'graduate', 'migrate', 'pool', 'liquidity', 'swap', 'wall', 'name', 'game']

/** Does a row pass the kind filter? An explicit list wins; otherwise the
 *  chain's own keepalives and price posts are hidden. */
const kindOk = (kinds, k) => (kinds ? kinds.includes(k) : !HIDDEN_KINDS.includes(k))

/* A Thru address or signature, as the chain formats them. Used to reject
   anything shaped wrong before it gets near a query. */
const ADDRESS = /^t[as][A-Za-z0-9_-]{20,120}$/

/** "18500.168" -> { slot, offset }. Anything else is no cursor at all. */
function parseCursor(s) {
  if (typeof s !== 'string') return null
  const m = /^(\d{1,19})\.(\d{1,9})$/.exec(s)
  if (!m) return null
  return { slot: Number(m[1]), offset: Number(m[2]) }
}

const cursorOf = (row) => `${row.slot}.${row.block_offset}`

/* One row, named the way the browser wants it rather than the way the table
   stores it. The site should not have to know about column names. */
/* rw and ro are JSON text in the database and arrays on the chain path. */
function listOf(v) {
  if (Array.isArray(v)) return v
  if (typeof v !== 'string') return []
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : [] } catch { return [] }
}

function shape(row) {
  return {
    signature: row.signature,
    slot: Number(row.slot),
    offset: Number(row.block_offset),
    who: row.fee_payer,
    program: row.program,
    kind: row.kind,
    label: row.label,
    ok: !!Number(row.ok),
    error: Number(row.user_error) || Number(row.vm_error) || null,
    /* The node's fee, as the string it sent; null for a row indexed before
       fees were recorded. Never a default, because a fee of zero is a fact. */
    fee: row.fee ?? null,
    /* What a transfer's recipient and amount are read from. */
    data: row.data ?? null,
    rw: listOf(row.rw),
    ro: listOf(row.ro),
    /* Nanoseconds, as a string, because the number is larger than JavaScript
       counts exactly. The browser divides it down to milliseconds. */
    time: row.block_time_ns == null ? null : String(row.block_time_ns),
  }
}

let pool = null

async function queryPostgres({ kinds, scope, address, cursor, limit }) {
  const { default: pg } = await import('pg')
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })

  const where = []
  const params = []
  const p = (v) => { params.push(v); return `$${params.length}` }

  if (kinds) where.push(`a.kind = ANY(${p(kinds)})`)
  else where.push(`a.kind <> ALL(${p(HIDDEN_KINDS)})`)
  if (scope === 'thruscan') where.push(`a.kind = ANY(${p(THRUSCAN_KINDS)})`)
  if (retiredPrograms().length) where.push(`a.program <> ALL(${p(retiredPrograms())})`)
  if (cursor) where.push(`( a.slot, a.block_offset ) < ( ${p(cursor.slot)}, ${p(cursor.offset)} )`)

  const from = address
    ? `activity a JOIN participant pt ON pt.signature = a.signature AND pt.address = ${p(address)}`
    : 'activity a'

  const sql =
    `SELECT a.* FROM ${from}` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY a.slot DESC, a.block_offset DESC LIMIT ${p(limit)}`

  const r = await pool.query(sql, params)
  return r.rows
}

async function querySqlite({ kinds, scope, address, cursor, limit }) {
  const file = process.env.INDEX_DB || join(process.cwd(), 'indexer', 'index.db')
  if (!existsSync(file)) return null

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const where = []
    const params = []

    if (kinds) { where.push(`a.kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds) }
    else { where.push(`a.kind NOT IN (${HIDDEN_KINDS.map(() => '?').join(',')})`); params.push(...HIDDEN_KINDS) }
    if (scope === 'thruscan') { where.push(`a.kind IN (${THRUSCAN_KINDS.map(() => '?').join(',')})`); params.push(...THRUSCAN_KINDS) }
    const retired = retiredPrograms()
    if (retired.length) { where.push(`a.program NOT IN (${retired.map(() => '?').join(',')})`); params.push(...retired) }
    if (cursor) {
      /* SQLite compares row values the same way, but spelling it out keeps
         this readable next to the Postgres version. */
      where.push('( a.slot < ? OR ( a.slot = ? AND a.block_offset < ? ) )')
      params.push(cursor.slot, cursor.slot, cursor.offset)
    }

    let from = 'activity a'
    if (address) {
      from = 'activity a JOIN participant pt ON pt.signature = a.signature AND pt.address = ?'
      params.unshift(address)
    }

    const sql =
      `SELECT a.* FROM ${from}` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY a.slot DESC, a.block_offset DESC LIMIT ?'
    params.push(limit)

    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

/* ------------------------------------------------------------------- chain */

/* How many pages of chain history to walk before giving up on filling a page.
   A filter like "launches only" can look through a lot of transactions to find
   a few, and this endpoint has fifteen seconds. Better a short list quickly
   than a complete one that times out. */
const MAX_PAGES = 4
/* Block times cost a read each, so only the newest slots get one. The rest
   show their slot number, which is true, rather than a guessed time. */
const MAX_TIME_READS = 60

/* ThruScan's own accounts, whose transactions make up "ThruScan only" when
 * there is no indexer. Everything the site does touches one of these: the pad and swap
 * registries (launches, trades, pools, liquidity), the two programs (which also
 * lists their deployment), the name root (every ThruID), and the wall and the
 * game boards. Blank means not deployed on this network, and is skipped.
 *
 * The default feed is the whole chain (client.transactions.list), so other
 * projects' calls show too; this list is only for the ThruScan-only chip. */
const OWN_ACCOUNTS = [
  'THRUPAD_REGISTRY', 'THRUSWAP_REGISTRY', 'THRUPAD_PROGRAM', 'THRUSWAP_PROGRAM',
  'NAME_ROOT', 'WALL_ACCOUNT', 'WORDLE_BOARD', 'G2048_BOARD', 'ID_REGISTRY',
]

async function queryChain({ kinds, scope, address, cursor, limit }) {
  const { client, url } = await resolveClient()
  /* The decoder needs every program the site deploys to label it, and the
     site's own table is the one place that lists them all, overrides included.
     The indexer's table adds what it knows on top. */
  const A = { ...(await addressesFor(url)), ...activeAddresses() }
  const own = [...new Set(OWN_ACCOUNTS.map((k) => A[k]).filter(Boolean))]
  const decode = makeDecoder(A)
  const retired = new Set(RETIRED_PROGRAM_KEYS.map((k) => A[k]).filter(Boolean))
  const { PageRequest, Filter } = await import('@thru/sdk')

  /* How many listings gave up. The node now and then closes a stream with an
     internal error (NGHTTP2_INTERNAL_ERROR, about one call in fifty), and
     with nine listings in flight that would silently drop an account from the
     feed about one request in six. So each page is tried again, and a listing
     that still fails is counted so the answer can say it is short. */
  let failed = 0

  const listPage = async (fetchPage, pageToken) => {
    let last
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await withTimeout(fetchPage(new PageRequest({ pageSize: 200, pageToken })), CALL_MS)
      } catch (e) {
        last = e
        await new Promise((r) => setTimeout(r, 120 * (attempt + 1)))
      }
    }
    throw last
  }

  /* Where a walk stopped reading when it ran out of pages rather than out of
     chain: the cursor "Show older" carries on from, even when every row it
     read was filtered out. */
  let scannedTo = null

  /* Walk one listing, newest first, and keep what survives the filters. */
  const walk = async (fetchPage, pages) => {
    const rows = []
    let pageToken
    let last = null
    let exhausted = false
    for (let i = 0; i < pages && rows.length < limit; i++) {
      let listed
      try {
        listed = await listPage(fetchPage, pageToken)
      } catch {
        failed++
        exhausted = true
        break
      }
      for (const txn of listed.transactions ?? []) {
        const row = decode(txn)
        if (!row?.signature) continue
        last = row
        if (!kindOk(kinds, row.kind) || retired.has(row.program)) continue
        /* "Show older" means strictly before a row, and the chain hands back
           everything newest first, so the cursor is a filter rather than a
           seek. Less efficient than the database path, invisible at this
           size. */
        if (cursor && !(row.slot < cursor.slot || (row.slot === cursor.slot && row.blockOffset < cursor.offset))) continue
        rows.push(row)
      }
      pageToken = listed.page?.nextPageToken
      if (!pageToken) { exhausted = true; break }
    }
    if (!exhausted && rows.length < limit && last) rows.scannedTo = last
    return rows
  }

  let out
  if (address) {
    out = await walk((page) => client.transactions.listForAccount(address, { page }), MAX_PAGES)
  } else if (scope === 'thruscan' && own.length) {
    /* One listing per account of ours, newest first, in parallel, merged by
     * time. Each listing is already sorted, so keeping the first `limit` of
     * each is enough to know the first `limit` of all of them; a transaction
     * that touches two accounts (a launch touches the registry and the
     * program) turns up twice and is counted once. Paging is the same cursor
     * as everywhere else: strictly before a (slot, offset), applied inside
     * each walk, so "show older" asks every account for what is older than
     * the last row and merges again. */
    const lists = await Promise.all(own.map((a) => walk((page) => client.transactions.listForAccount(a, { page }), MAX_PAGES)))
    const seen = new Set()
    out = lists.flat()
      .filter((r) => (seen.has(r.signature) ? false : seen.add(r.signature)))
      .sort((a, b) => (b.slot - a.slot) || (b.blockOffset - a.blockOffset))
  } else {
    /* The whole chain, newest first. "Show older" seeks with the node's own
       filter rather than walking down from the top again, so any depth of
       history is reachable; the cursor check in walk() then drops the rest of
       the cursor's own slot. The slot must be an unsigned literal (see
       transactionsInSlot in indexer/index.mjs). */
    const filter = cursor ? new Filter({ expression: `transaction.slot <= ${cursor.slot}u` }) : undefined
    out = await walk((page) => client.transactions.list({ filter, page }), MAX_PAGES)
    scannedTo = out.scannedTo ?? null
  }
  out = out.slice(0, limit)

  /* One block read per distinct slot, in parallel, for the newest few. A feed
     that can only say "slot 2751" is a feed nobody reads twice. */
  const slots = [...new Set(out.map((r) => r.slot))].slice(0, MAX_TIME_READS)
  const times = new Map()
  await Promise.all(slots.map(async (slot) => {
    /* Twice, for the same reason the listings are retried: a stream the node
       closes under load is not a block that has no time. */
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const b = await withTimeout(client.blocks.get({ slot }), 4000)
        if (b?.blockTimeNs != null) times.set(slot, String(b.blockTimeNs))
        return
      } catch { /* try once more, then it keeps its slot number */ }
    }
  }))

  /* Shaped like a database row, because the caller reshapes them all the same
     way afterwards and one of these paths should not know about the other. */
  const shaped = out.map((r) => ({
    signature: r.signature,
    slot: r.slot,
    block_offset: r.blockOffset,
    fee_payer: r.feePayer,
    program: r.program,
    kind: r.kind,
    label: r.label,
    ok: r.ok,
    user_error: r.userError,
    vm_error: r.vmError,
    block_time_ns: times.get(r.slot) ?? null,
    fee: r.fee,
    data: r.data,
    rw: r.rw,
    ro: r.ro,
  }))
  /* Carried on the array so the handler can read it without changing what the
     two other paths return. */
  shaped.partial = failed > 0
  /* A short page that stopped for lack of pages, not lack of chain, still has
     older rows: page on from where the reading stopped. */
  if (shaped.length < limit && scannedTo) shaped.next = `${scannedTo.slot}.${scannedTo.blockOffset}`
  return shaped
}

const CALL_MS = 8000

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8')

  try {
    const url = new URL(req.url, 'http://localhost')
    const q = url.searchParams

    const kindRaw = q.get('kind')
    if (kindRaw && !KINDS.has(kindRaw)) {
      res.statusCode = 400
      return res.end(JSON.stringify({ ok: false, error: `Unknown kind "${kindRaw}".` }))
    }

    const kindsRaw = q.get('kinds')
    const kinds = kindsRaw ? kindsRaw.split(',').map((k) => k.trim()).filter(Boolean) : (kindRaw ? [kindRaw] : null)
    if (kinds && (kinds.length > 30 || kinds.some((k) => !KINDS.has(k)))) {
      res.statusCode = 400
      return res.end(JSON.stringify({ ok: false, error: 'Unknown kind in "kinds".' }))
    }
    const scopeRaw = q.get('scope')
    if (scopeRaw && scopeRaw !== 'thruscan') {
      res.statusCode = 400
      return res.end(JSON.stringify({ ok: false, error: `Unknown scope "${scopeRaw}".` }))
    }

    const addressRaw = q.get('address')
    if (addressRaw && !ADDRESS.test(addressRaw)) {
      res.statusCode = 400
      return res.end(JSON.stringify({ ok: false, error: 'That is not a Thru address.' }))
    }

    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.get('limit')) || DEFAULT_LIMIT))
    const args = { kinds, scope: scopeRaw || null, address: addressRaw || null, cursor: parseCursor(q.get('before')), limit }

    let source = 'postgres'
    let rows = null
    if (process.env.DATABASE_URL) {
      rows = await queryPostgres(args)
    } else {
      rows = await querySqlite(args)
      source = 'sqlite'
      if (rows === null) {
        /* No indexer anywhere. Read the chain instead: slower and shorter, but
           the page shows real activity rather than an apology. */
        rows = await queryChain(args)
        source = 'chain'
      }
    }

    /* Rows never change once written, so a shared cache costs nothing and
       takes repeat visitors off the database entirely. The chain path gets a
       longer one because it is the expensive one: every miss is a page of
       transactions plus a block read per slot. */
    const partial = rows.partial === true
    res.setHeader(
      'cache-control',
      partial
        ? 'public, s-maxage=2'     // short, so a hiccup is not what everyone sees for a minute
        : source === 'chain'
          /* The newest page is the live feed, refreshed every 10 s, so it is
             cached only briefly; older pages never change. */
          ? (args.cursor ? 'public, s-maxage=60, stale-while-revalidate=300' : 'public, s-maxage=3, stale-while-revalidate=10')
          : 'public, s-maxage=5, stale-while-revalidate=30',
    )

    const items = rows.map(shape)
    res.statusCode = 200
    return res.end(JSON.stringify({
      ok: true,
      items,
      next: items.length === limit ? cursorOf(rows[rows.length - 1]) : (rows.next ?? null),
      /* Which path answered. The browser does not change what it draws, but
         it is the first thing to look at when the feed is slow or short. */
      source,
      /* Present only when a listing failed even after retrying, so the page
         can say it may be missing rows instead of presenting a short list as
         the whole truth. */
      ...(partial ? { partial: true } : {}),
    }))
  } catch (e) {
    res.statusCode = 500
    return res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e), items: [] }))
  }
}
