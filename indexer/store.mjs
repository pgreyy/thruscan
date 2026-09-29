// indexer/store.mjs
//
// Where the rows go. SQLite by default, because it is a file and needs nothing
// running; Postgres when DATABASE_URL is set, because that is what a hosted
// indexer will use.
//
// Node 22 ships SQLite in the standard library, so the default path installs
// nothing at all. That matters: the fewer moving parts this has, the more
// likely it is still running in six months.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SCHEMA = readFileSync(join(here, 'schema.sql'), 'utf8')

export async function openStore({ url = process.env.DATABASE_URL, file = process.env.INDEX_DB || join(here, 'index.db') } = {}) {
  if (url) return openPostgres(url)
  return openSqlite(file)
}

/* ------------------------------------------------------------------ sqlite */

async function openSqlite(file) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)

  const insertActivity = db.prepare(
    `INSERT OR IGNORE INTO activity
       ( signature, slot, block_offset, fee_payer, program, op, kind, label, ok, user_error, vm_error, block_time_ns )
     VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? )`,
  )
  const insertParticipant = db.prepare(
    'INSERT OR IGNORE INTO participant ( signature, address, writable ) VALUES ( ?, ?, ? )',
  )
  const setCursor = db.prepare(
    'INSERT INTO cursor ( id, slot ) VALUES ( 1, ? ) ON CONFLICT ( id ) DO UPDATE SET slot = excluded.slot',
  )
  const getCursor = db.prepare('SELECT slot FROM cursor WHERE id = 1')
  const countRows = db.prepare('SELECT COUNT(*) AS n FROM activity')

  return {
    kind: 'sqlite',
    where: file,
    cursor: () => getCursor.get()?.slot ?? null,
    count: () => Number(countRows.get()?.n ?? 0),
    write(rows, slot) {
      db.exec('BEGIN')
      try {
        for (const r of rows) {
          insertActivity.run(
            r.signature, r.slot, r.blockOffset, r.feePayer, r.program,
            r.op, r.kind, r.label, r.ok, r.userError, r.vmError, r.blockTimeNs ?? null,
          )
          for (const p of r.participants) insertParticipant.run(r.signature, p.address, p.writable)
        }
        setCursor.run(slot)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    recent(limit = 50) {
      return db.prepare('SELECT * FROM activity ORDER BY slot DESC, block_offset DESC LIMIT ?').all(limit)
    },
    forAddress(address, limit = 50) {
      return db.prepare(
        `SELECT a.* FROM activity a
           JOIN participant p ON p.signature = a.signature
          WHERE p.address = ?
          ORDER BY a.slot DESC, a.block_offset DESC
          LIMIT ?`,
      ).all(address, limit)
    },
    close: () => db.close(),
  }
}

/* ---------------------------------------------------------------- postgres */

async function openPostgres(url) {
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: url })
  // The schema is written for SQLite; two spellings differ in Postgres.
  await pool.query(SCHEMA.replaceAll('INTEGER PRIMARY KEY CHECK', 'INTEGER PRIMARY KEY CHECK'))

  return {
    kind: 'postgres',
    where: url.replace(/:[^:@/]*@/, ':***@'),
    async cursor() {
      const r = await pool.query('SELECT slot FROM cursor WHERE id = 1')
      return r.rows[0]?.slot ?? null
    },
    async count() {
      const r = await pool.query('SELECT COUNT(*)::int AS n FROM activity')
      return r.rows[0].n
    },
    async write(rows, slot) {
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        for (const r of rows) {
          await c.query(
            `INSERT INTO activity
               ( signature, slot, block_offset, fee_payer, program, op, kind, label, ok, user_error, vm_error, block_time_ns )
             VALUES ( $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12 )
             ON CONFLICT ( signature ) DO NOTHING`,
            [r.signature, r.slot, r.blockOffset, r.feePayer, r.program, r.op, r.kind, r.label, r.ok, r.userError, r.vmError, r.blockTimeNs ?? null],
          )
          for (const p of r.participants) {
            await c.query(
              'INSERT INTO participant ( signature, address, writable ) VALUES ( $1,$2,$3 ) ON CONFLICT DO NOTHING',
              [r.signature, p.address, p.writable],
            )
          }
        }
        await c.query(
          'INSERT INTO cursor ( id, slot ) VALUES ( 1, $1 ) ON CONFLICT ( id ) DO UPDATE SET slot = excluded.slot',
          [slot],
        )
        await c.query('COMMIT')
      } catch (e) {
        await c.query('ROLLBACK')
        throw e
      } finally {
        c.release()
      }
    },
    async recent(limit = 50) {
      const r = await pool.query('SELECT * FROM activity ORDER BY slot DESC, block_offset DESC LIMIT $1', [limit])
      return r.rows
    },
    async forAddress(address, limit = 50) {
      const r = await pool.query(
        `SELECT a.* FROM activity a
           JOIN participant p ON p.signature = a.signature
          WHERE p.address = $1
          ORDER BY a.slot DESC, a.block_offset DESC
          LIMIT $2`,
        [address, limit],
      )
      return r.rows
    },
    close: () => pool.end(),
  }
}
