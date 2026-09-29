// indexer/index.mjs
//
// Walk the chain once, so the site never has to.
//
// The loop is deliberately boring: ask where we got to, read the next window
// of slots, decode what is in them, write the rows and the new cursor in one
// transaction, repeat. Boring is the requirement. This is the piece that has
// to still be running unattended in six months.
//
// Two properties are worth stating because they are what make it safe to
// restart at any moment. The cursor moves in the same database transaction as
// the rows it covers, so a crash can duplicate work but can never skip it. And
// every insert ignores conflicts on the signature, so repeated work is free.
//
//   node indexer/index.mjs                     follow the chain forever
//   node indexer/index.mjs --from 18000        start from a slot
//   node indexer/index.mjs --once --to 18600   catch up and exit
//   node indexer/index.mjs --show 20           print the newest rows and exit
//
// THRU_RPC picks the network. Everything else is optional.

import { createThruClient, Filter, PageRequest } from '@thru/sdk'
import { createGrpcTransport } from '@connectrpc/connect-node'
import { makeDecoder } from './decode.mjs'
import { openStore } from './store.mjs'
import { addressesFor } from './addresses.mjs'

const RPC = process.env.THRU_RPC || 'https://rpc.betanet.thru.org'
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

/* How many slots to ask for before writing. Small enough that a restart loses
   almost nothing, large enough that we are not writing once per slot. */
const WINDOW = Number(value('--window', '25'))
/* How long to wait when we have caught up. Betanet produces a block about
   every five seconds; alphanet every 56 milliseconds. Polling faster than the
   chain moves just burns requests. */
const IDLE_MS = Number(value('--idle', '2000'))

const client = createThruClient({ transport: createGrpcTransport({ baseUrl: RPC }) })

async function main() {
  const store = await openStore()
  const addresses = await addressesFor(RPC)
  const decode = makeDecoder(addresses)

  if (flag('--show')) {
    const rows = await store.recent(Number(value('--show', '20')))
    for (const r of rows) {
      console.log(
        String(r.slot).padStart(9),
        r.ok ? ' ' : '!',
        r.kind.padEnd(10),
        r.label.padEnd(30),
        r.fee_payer.slice(0, 12) + '…',
      )
    }
    console.log(`\n${await store.count()} rows, cursor at ${await store.cursor()}, ${store.kind} at ${store.where}`)
    await store.close()
    return
  }

  const head = Number((await client.blocks.getBlockHeight()).finalized)
  const fromArg = value('--from')
  /* Where to begin. An explicit --from wins, then wherever we left off, then
     a short way back from the head, because indexing a whole chain from
     genesis is a different job with different pacing. */
  let next = fromArg !== null ? Number(fromArg) : ((await store.cursor()) ?? Math.max(0, head - 200)) + (fromArg === null && (await store.cursor()) !== null ? 1 : 0)
  const stopAt = value('--to') ? Number(value('--to')) : null

  console.log(`indexer: ${RPC}`)
  console.log(`store:   ${store.kind} at ${store.where}`)
  console.log(`head:    ${head}, starting at ${next}${stopAt ? `, stopping at ${stopAt}` : ''}`)

  let written = 0
  let idleSince = null

  for (;;) {
    const finalized = Number((await client.blocks.getBlockHeight()).finalized)
    const target = Math.min(finalized, stopAt ?? finalized, next + WINDOW - 1)

    if (target < next) {
      if (stopAt !== null || flag('--once')) break
      if (!idleSince) { idleSince = Date.now(); console.log(`caught up at ${next - 1}, ${written} rows written`) }
      await sleep(IDLE_MS)
      continue
    }
    idleSince = null

    const rows = []
    for (let slot = next; slot <= target; slot++) {
      const found = await transactionsInSlot(slot)
      if (!found.length) continue
      /* The time lives on the block, not the transaction, so it costs one
         extra read per slot that actually has something in it. Worth it: a
         feed that can only say "slot 18500" is a feed nobody reads twice. */
      const blockTimeNs = await blockTimeOf(slot)
      for (const txn of found) {
        const row = decode({ ...txn, slot: txn.slot ?? slot })
        if (row?.signature) rows.push({ ...row, blockTimeNs })
      }
    }

    await store.write(rows, target)
    written += rows.length
    if (rows.length) {
      console.log(`${next}..${target}  ${String(rows.length).padStart(4)} rows  (${written} total)`)
    }
    next = target + 1

    if (stopAt !== null && next > stopAt) break
  }

  console.log(`done: ${written} rows, ${await store.count()} in the database, cursor at ${await store.cursor()}`)
  await store.close()
}

/**
 * Every transaction in one slot.
 *
 * The slot has to go through the node's CEL filter, and it has to be written
 * as an unsigned literal: `transaction.slot == 18640u`. Passing `{ slot }` as
 * an option, which is what the shape of the API invites, is not an error. The
 * node ignores it and returns the most recent page of the whole chain, so the
 * indexer appears to work, writes the same fifty rows for every slot, and the
 * only symptom is a row count that makes no sense. It cost an hour to notice,
 * which is why this has a function to itself and this comment on top of it.
 */
async function transactionsInSlot(slot) {
  const out = []
  let pageToken
  for (;;) {
    let listed
    try {
      listed = await client.transactions.list({
        filter: new Filter({ expression: `transaction.slot == ${slot}u` }),
        page: new PageRequest({ pageSize: 500, pageToken }),
      })
    } catch (e) {
      /* An empty slot, or one the node no longer keeps, is ordinary. Anything
         else is worth hearing about, and will repeat rather than pass in
         silence. */
      if (!/not.?found/i.test(e.message ?? '')) console.warn(`slot ${slot}: ${e.message}`)
      return out
    }
    out.push(...(listed.transactions ?? []))
    pageToken = listed.page?.nextPageToken
    if (!pageToken) return out
  }
}

/** When a slot happened, in nanoseconds, or null if the node will not say. */
async function blockTimeOf(slot) {
  try {
    const b = await client.blocks.get({ slot })
    const t = b?.blockTimeNs
    return t === undefined || t === null ? null : String(t)
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
