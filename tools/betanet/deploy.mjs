// tools/betanet/deploy.mjs
//
// The whole betanet deploy, in order, as one command:
//
//   GRAD_THRESHOLD=<WTHRU base units> POOL_WTHRU=<WTHRU base units> POOL_TEST=<whole BNTEST> \
//     node tools/betanet/deploy.mjs
//
// Before the first run:
//   - the two keys exist in THRUSCAN_SECRETS and in the deploy CLI config
//     (see config.mjs);
//   - every binary is built: in WSL, THRU_C_SDK_DIR=~/thru/sdks/c/thru-sdk
//     programs/build.sh (needs gcc-riscv64-unknown-elf and
//     picolibc-riscv64-unknown-elf).
//
// Every step is idempotent, so a failed run is fixed and re-run from the top.
// Pixel Pals is deliberately not part of this.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { HERE, ROOT } from './config.mjs'

const STEPS = [
  ['check both networks', join(ROOT, 'tools', 'check-networks.mjs'), { mayFail: true }],
  ['fund the authority and the sponsor', join(HERE, 'fund.mjs')],
  ['deploy the programs', join(HERE, 'deploy-programs.mjs')],
  ['initialise registries and boards', join(HERE, 'init-accounts.mjs')],
  ['initialise the launchpad registry', join(HERE, 'init-accounts.mjs'), { args: ['THRUPAD_REGISTRY'] }],
  ['create the .id name root', join(HERE, 'name-root.mjs')],
  ['test token and WTHRU pool', join(HERE, 'pool.mjs')],
  ['write the addresses into the tables', join(HERE, 'write-addresses.mjs')],
]

for (const [name, file, opts = {}] of STEPS) {
  console.log(`\n== ${name}`)
  const r = spawnSync(process.execPath, [file, ...(opts.args ?? [])], { stdio: 'inherit', cwd: ROOT })
  if (r.status !== 0 && !opts.mayFail) {
    console.log(`\nStopped at "${name}". Fix it and run this again; finished steps are skipped.`)
    process.exit(r.status ?? 1)
  }
}
console.log('\nDone. Run node tools/check-networks.mjs to confirm every betanet address is on chain.')
