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
//   /api/activity                      the newest activity, everyone's
//   /api/activity?kind=buy             one kind: buy, sell, launch, swap, mint…
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

export const config = { runtime: 'nodejs', maxDuration: 15 }

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50

/* Kinds the indexer writes. Anything else in the query string is refused
   rather than passed through, because this value reaches a query. */
const KINDS = new Set([
  'launch', 'buy', 'sell', 'claim', 'graduate', 'migrate',
  'pool', 'liquidity', 'swap',
  'token', 'account', 'transfer', 'mint', 'burn',
  'faucet', 'name', 'nft', 'wall', 'bundle', 'noop', 'oracle', 'other',
])

/* What the chain does by itself. The node writes a do-nothing transaction per
   empty slot and the oracle posts prices continuously, and on a quiet chain
   those are very nearly all of the traffic. Left in, the feed is a list of the
   chain being alive rather than of anybody doing anything, so both are
   excluded unless asked for by name. */
const HIDDEN_KINDS = ['noop', 'oracle']

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
    /* Nanoseconds, as a string, because the number is larger than JavaScript
       counts exactly. The browser divides it down to milliseconds. */
    time: row.block_time_ns == null ? null : String(row.block_time_ns),
  }
}

let pool = null

async function queryPostgres({ kind, address, cursor, limit }) {
  const { default: pg } = await import('pg')
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })

  const where = []
  const params = []
  const p = (v) => { params.push(v); return `$${params.length}` }

  if (kind) where.push(`a.kind = ${p(kind)}`)
  else where.push(`a.kind <> ALL(${p(HIDDEN_KINDS)})`)
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

async function querySqlite({ kind, address, cursor, limit }) {
  const file = process.env.INDEX_DB || join(process.cwd(), 'indexer', 'index.db')
  if (!existsSync(file)) return null

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const where = []
    const params = []

    if (kind) { where.push('a.kind = ?'); params.push(kind) }
    else { where.push(`a.kind NOT IN (${HIDDEN_KINDS.map(() => '?').join(',')})`); params.push(...HIDDEN_KINDS) }
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
const MAX_TIME_READS = 30

async function queryChain({ kind, address, cursor, limit }) {
  const { client, url } = await resolveClient()
  const decode = makeDecoder(await addressesFor(url))

  const { PageRequest } = await import('@thru/sdk')
  const out = []
  let pageToken

  for (let page = 0; page < MAX_PAGES && out.length < limit; page++) {
    const req = new PageRequest({ pageSize: 200, pageToken })
    let listed
    try {
      listed = await withTimeout(
        address
          ? client.transactions.listForAccount(address, { page: req })
          : client.transactions.list({ page: req }),
        CALL_MS,
      )
    } catch {
      break
    }

    for (const txn of listed.transactions ?? []) {
      const row = decode(txn)
      if (!row?.signature) continue
      if (kind ? row.kind !== kind : HIDDEN_KINDS.includes(row.kind)) continue
      /* "Show older" means strictly before a row, and the chain hands back
         everything newest first, so the cursor is a filter rather than a seek.
         Less efficient than the database path and invisible at this size. */
      if (cursor && !(row.slot < cursor.slot || (row.slot === cursor.slot && row.blockOffset < cursor.offset))) continue
      out.push(row)
      if (out.length >= limit) break
    }

    pageToken = listed.page?.nextPageToken
    if (!pageToken) break
  }

  /* One block read per distinct slot, in parallel, for the newest few. A feed
     that can only say "slot 2751" is a feed nobody reads twice. */
  const slots = [...new Set(out.map((r) => r.slot))].slice(0, MAX_TIME_READS)
  const times = new Map()
  await Promise.all(slots.map(async (slot) => {
    try {
      const b = await withTimeout(client.blocks.get({ slot }), 4000)
      if (b?.blockTimeNs != null) times.set(slot, String(b.blockTimeNs))
    } catch { /* it keeps its slot number */ }
  }))

  /* Shaped like a database row, because the caller reshapes them all the same
     way afterwards and one of these paths should not know about the other. */
  return out.map((r) => ({
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
  }))
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

    const addressRaw = q.get('address')
    if (addressRaw && !ADDRESS.test(addressRaw)) {
      res.statusCode = 400
      return res.end(JSON.stringify({ ok: false, error: 'That is not a Thru address.' }))
    }

    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.get('limit')) || DEFAULT_LIMIT))
    const args = { kind: kindRaw || null, address: addressRaw || null, cursor: parseCursor(q.get('before')), limit }

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
    res.setHeader(
      'cache-control',
      source === 'chain'
        ? 'public, s-maxage=15, stale-while-revalidate=60'
        : 'public, s-maxage=5, stale-while-revalidate=30',
    )

    const items = rows.map(shape)
    res.statusCode = 200
    return res.end(JSON.stringify({
      ok: true,
      items,
      next: items.length === limit ? cursorOf(rows[rows.length - 1]) : null,
      /* Which path answered. The browser does not change what it draws, but
         it is the first thing to look at when the feed is slow or short. */
      source,
    }))
  } catch (e) {
    res.statusCode = 500
    return res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e), items: [] }))
  }
}
