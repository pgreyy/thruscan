// tools/pack-extension.mjs
//
// Zip the built extension into public/downloads, which is the copy the site
// actually serves from /get-wallet.
//
// There used to be a second zip at the repo root. Nothing served it, so it sat
// there looking like the artifact while visitors downloaded the other one, and
// a rebuild that updated only the root copy left everyone downloading a wallet
// that called programs at addresses the network had moved. One file now, made
// by one command:
//
//   npm run pack:extension
//
// The version the page shows is read from the manifest rather than typed, for
// the same reason.

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, readFileSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = resolve(root, 'extension/dist')
const out = resolve(root, 'public/downloads/thruscan-wallet.zip')

if (!statSync(dist, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('extension/dist is missing. Run: npm run build:extension')
  process.exit(1)
}

mkdirSync(dirname(out), { recursive: true })
rmSync(out, { force: true })
execFileSync('zip', ['-qr', out, '.'], { cwd: dist })

const version = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8')).version
const kb = Math.round(statSync(out).size / 1024)
console.log(`packed ThruScan Wallet ${version} into public/downloads/thruscan-wallet.zip (${kb} KB)`)
