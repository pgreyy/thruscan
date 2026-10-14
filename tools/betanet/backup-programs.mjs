// tools/betanet/backup-programs.mjs
//
// Saves the program images live on betanet right now, so an upgrade can be
// rolled back by upgrading again with the saved file. Read-only.
//
//   node tools/betanet/backup-programs.mjs                  # thruswap and thrupad2
//   node tools/betanet/backup-programs.mjs THRUSWAP_PROGRAM
//
// Files go to THRUSCAN_SECRETS/backups (outside the repo), named
// <bin>.onchain.<timestamp>.bin. A program account's data is the image the
// upload wrote, byte for byte; that was checked against the committed
// binaries before the graduation-pool upgrade.

import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { PROGRAMS, SECRETS, record, log } from './config.mjs'
import { getAccount } from './chain.mjs'

const only = process.argv.slice(2)
const keys = ['THRUSWAP_PROGRAM', 'THRUPAD_PROGRAM'].filter((k) => !only.length || only.includes(k))
const dir = join(SECRETS, 'backups')
mkdirSync(dir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
let failed = 0

for (const key of keys) {
  const address = record().addresses[key]
  const acc = await getAccount(address)
  const data = Buffer.from(acc?.data?.data ?? [])
  if (!data.length) { log(`${key}: nothing read from ${address}`); failed++; continue }
  const file = join(dir, `${PROGRAMS[key].bin}.onchain.${stamp}.bin`)
  writeFileSync(file, data)
  const size = statSync(file).size
  log(`${key}: ${file} ${size} bytes sha256 ${createHash('sha256').update(data).digest('hex').slice(0, 16)}`)
  if (size !== data.length) failed++
}
process.exit(failed ? 1 : 0)
