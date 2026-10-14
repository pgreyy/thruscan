// tools/betanet/extend-registry.mjs
//
// Appends thruswap's creator fee table to the pool registry (EXTEND, 0x08),
// signed and paid by the deploy authority. Run once, after thruswap is
// upgraded and after the app that reads the extended registry is live: an
// older app reads the appended bytes as extra pools.
//
//   node tools/betanet/extend-registry.mjs
//
// Idempotent: a registry that already has the table is reported and left.

import { AUTHORITY, record, save, log } from './config.mjs'
import { signer, getAccount, send, outcome } from './chain.mjs'
import { buildExtendInstruction, registryLayout } from '../../src/lib/swap.js'

const { THRUSWAP_PROGRAM: program, THRUSWAP_REGISTRY: registry } = record().addresses
const shape = async () => {
  const bytes = new Uint8Array((await getAccount(registry))?.data?.data ?? [])
  return { size: bytes.length, ...registryLayout(bytes.length, bytes) }
}

const before = await shape()
if (before.extAt !== null) {
  log(`registry ${registry} already extended (${before.size} bytes, ${before.slots} slots)`)
  process.exit(0)
}

const ix = buildExtendInstruction({ registry })
const signature = await send(signer(AUTHORITY), { program, ...ix, stateUnits: 8192 })
const r = await outcome(signature)
if (!r.ok) { log(`EXTEND failed: ${signature} ${JSON.stringify(r)}`); process.exit(1) }
save({ signatures: { 'extend THRUSWAP_REGISTRY': signature } })

const after = await shape()
log(`EXTEND ${signature}: ${before.size} -> ${after.size} bytes, ${after.slots} slots, table ${after.extAt !== null ? 'present' : 'MISSING'}`)
process.exit(after.extAt !== null && after.slots === before.slots ? 0 : 1)
