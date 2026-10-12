// tools/betanet/deploy-programs.mjs
//
// Step 3: upload ThruScan's programs from programs/bin to betanet, each on its
// own fresh seed, with betanet-authority as fee payer and program authority.
//
//   node tools/betanet/deploy-programs.mjs            # every program in config
//   node tools/betanet/deploy-programs.mjs THRUSWAP_PROGRAM
//
// Idempotent: a program whose account already exists on chain is recorded and
// skipped, never re-created (creating on a used seed fails and leaves the old
// code live). A missing binary is reported and skipped; build it first with
// programs/build.sh in WSL.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROGRAMS, ROOT, AUTHORITY, thru, save, log } from './config.mjs'

const only = process.argv.slice(2)
const keys = Object.keys(PROGRAMS).filter((k) => !only.length || only.includes(k))
let failed = 0

for (const key of keys) {
  const { seed, bin } = PROGRAMS[key]
  const file = join(ROOT, 'programs', 'bin', `${bin}.bin`)
  const derived = thru(['program', 'derive-manager-accounts', seed]).derive_manager_accounts
  const address = derived.program_account

  const existing = thru(['getaccountinfo', address], { allowFail: true })
  if (existing) {
    log(`${key.padEnd(17)} ${address} already on chain (seed ${seed}), recorded`)
    save({ addresses: { [key]: address } })
    continue
  }
  if (!existsSync(file)) {
    log(`${key.padEnd(17)} SKIPPED: no programs/bin/${bin}.bin yet (build it in WSL with programs/build.sh ${bin})`)
    failed++
    continue
  }

  try {
    const r = thru(['program', 'create', seed, file, '--fee-payer', AUTHORITY, '--authority', AUTHORITY])
    const c = r.program_create ?? r.create ?? r
    // program create reports the accounts it made, not a signature.
    log(`${key.padEnd(17)} ${address} created (seed ${seed}, meta account ${c.meta_account})`)
    save({ addresses: { [key]: address }, signatures: { [`deploy ${key}`]: `created; meta account ${c.meta_account}` } })
  } catch (e) {
    log(`${key.padEnd(17)} FAILED: ${e.message}`)
    failed++
  }
}

process.exit(failed ? 1 : 0)
