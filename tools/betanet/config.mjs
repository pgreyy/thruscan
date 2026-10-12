// tools/betanet/config.mjs
//
// Everything the betanet deploy scripts share: the node, the two CLI key
// names, where the secrets live, the seeds, the sizes, and the record of what
// has been deployed.
//
// Keys never come near the repo. The scripts sign through the thru CLI, which
// holds the keys in its own config (~/.thru), under these names:
//
//   betanet-authority   deploys and initialises ThruScan's programs
//   betanet-sponsor     the site's sponsor (THRU_SPONSOR_* in Vercel), and the
//                       authority of the .id name root, because api/wallet.js
//                       registers names by signing as the root's authority
//
// A copy of each key, with its public address, is kept outside the repo in
// THRUSCAN_SECRETS (default C:\Users\<you>\thruscan-secrets). Only the public
// address is ever read from there by these scripts.
//
// What has been deployed is recorded in deployed.json beside this file. Those
// are public addresses, the same ones written into src/lib/networks.js.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..', '..')
export const RPC = process.env.THRU_RPC_URL || 'https://rpc.betanet.thru.org'
export const SECRETS = process.env.THRUSCAN_SECRETS || join(homedir(), 'thruscan-secrets')

export const AUTHORITY = 'betanet-authority'
export const SPONSOR = 'betanet-sponsor'

/** Public address of a CLI key, from the secrets folder. Never the private half. */
export function publicKeyOf(name) {
  return JSON.parse(readFileSync(join(SECRETS, `${name}.json`), 'utf8')).publicKey
}

/* Seeds are permanent: a program is bound to its seed, and creating on a seed
   that already holds one fails. Bump the suffix for a fresh deploy. */
export const PROGRAMS = {
  THRUSWAP_PROGRAM: { seed: 'thruscan-bn-swap-1', bin: 'thruswap' },
  THRUPAD_PROGRAM: { seed: 'thruscan-bn-pad-1', bin: 'thrupad2' },
  WALL_PROGRAM: { seed: 'thruscan-bn-wall-1', bin: 'thruwall2' },
  WORDLE_PROGRAM: { seed: 'thruscan-bn-wordle-1', bin: 'thruwordle' },
  G2048_PROGRAM: { seed: 'thruscan-bn-2048-1', bin: 'thru2048' },
  ID_PROGRAM: { seed: 'thruscan-bn-id-1', bin: 'thruid' },
}

/* Slot counts, the same as the alphanet deployment. */
export const SIZES = {
  THRUSWAP_REGISTRY: 256,
  THRUPAD_REGISTRY: 256,
  WALL_ACCOUNT: 512,
  WORDLE_BOARD: 512,
  G2048_BOARD: 512,
  ID_REGISTRY: 1024,
}

export const NAME_ROOT_NAME = 'id'

/* State units per transaction never exceed the chain's per-block budget. */
export const MAX_STATE_UNITS = 8192

const RECORD = join(HERE, 'deployed.json')

export function record() {
  return existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')) : { network: 'betanet', addresses: {}, signatures: {} }
}

export function save(update) {
  const r = record()
  Object.assign(r.addresses, update.addresses ?? {})
  Object.assign(r.signatures, update.signatures ?? {})
  writeFileSync(RECORD, JSON.stringify(r, null, 2) + '\n')
  return r
}

/* The CLI the deploy signs with. Its config must carry Thru v0.4 system
   program addresses: a config written by CLI 0.3.x keeps the old taAAAA...
   placeholders for the uploader and manager programs, and program create then
   fails with -766 INVALID_PROGRAM_ACCOUNT. So the deploy uses its own config,
   in THRUSCAN_SECRETS/cli-home, holding only the two betanet keys.

   On Windows that CLI runs in WSL (installed with npm under ~/thru-cli),
   because the Windows build cannot be pointed at a second config. Elsewhere it
   runs directly with HOME set to cli-home. */
const CLI_HOME = join(SECRETS, 'cli-home')
const WIN_PATH = /^[A-Za-z]:[\\/]/
const toWsl = (p) => p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/')
const quote = (a) => `'${String(a).replace(/'/g, "'\\''")}'`

/** Run the thru CLI against betanet, JSON out. Throws with the CLI's own message. */
export function thru(args, { allowFail = false } = {}) {
  const full = ['--quiet', '--json', '--url', RPC, ...args]
  try {
    let out
    if (process.platform === 'win32') {
      const bin = process.env.THRU_WSL_BIN || '~/thru-cli/node_modules/.bin/thru'
      const cmd = `HOME=${quote(toWsl(CLI_HOME))} ${bin} ${full.map((a) => quote(WIN_PATH.test(a) ? toWsl(a) : a)).join(' ')}`
      out = execFileSync('wsl.exe', ['-e', 'bash', '-lc', cmd], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] })
    } else {
      out = execFileSync(process.env.THRU_BIN || 'thru', full, { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, HOME: CLI_HOME } })
    }
    return JSON.parse(out.slice(out.indexOf('{')))
  } catch (e) {
    if (allowFail) return null
    const msg = String(e.stdout || e.stderr || e.message).trim()
    throw new Error(`thru ${args.slice(0, 2).join(' ')} failed: ${msg.slice(0, 600)}`)
  }
}

export const log = (...a) => console.log(...a)
