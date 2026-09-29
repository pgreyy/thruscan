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
// Where the rows live:
//   DATABASE_URL set   -> Postgres. This is production.
//   not set            -> the indexer's SQLite file, which only exists where
//                         the indexer itself runs. On Vercel it does not, so
//                         the endpoint says so rather than pretending the
//                         chain is empty.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const config = { runtime: 'nodejs', maxDuration: 15 }

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50

/* Kinds the indexer writes. Anything else in the query string is refused
   rather than passed through, because this value reaches a query. */
const KINDS = new Set([
  'launch', 'buy', 'sell', 'claim', 'graduate', 'migrate',
  'pool', 'liquidity', 'swap',
  'token', 'account', 'transfer', 'mint', 'burn',
  'faucet', 'name', 'nft', 'wall', 'bundle', 'other',
])

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

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8')
  /* Rows never change once written, so a short shared cache costs nothing and
     takes the repeat visitors off the database entirely. */
  res.setHeader('cache-control', 'public, s-maxage=5, stale-while-revalidate=30')

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

    const rows = process.env.DATABASE_URL ? await queryPostgres(args) : await querySqlite(args)

    if (rows === null) {
      /* No database at all. Said plainly, because "no activity" and "there is
         nowhere for activity to be" look identical from the browser and only
         one of them is something to fix. */
      res.statusCode = 503
      return res.end(JSON.stringify({
        ok: false,
        error: 'no activity database',
        detail: 'Set DATABASE_URL to the Postgres the indexer writes to, or run the indexer locally so indexer/index.db exists.',
        items: [],
      }))
    }

    const items = rows.map(shape)
    res.statusCode = 200
    return res.end(JSON.stringify({
      ok: true,
      items,
      next: items.length === limit ? cursorOf(rows[rows.length - 1]) : null,
      source: process.env.DATABASE_URL ? 'postgres' : 'sqlite',
    }))
  } catch (e) {
    res.statusCode = 500
    return res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e), items: [] }))
  }
}
