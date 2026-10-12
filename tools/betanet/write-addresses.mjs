// tools/betanet/write-addresses.mjs
//
// Step 10: copy every address in deployed.json into the three places that
// name betanet's ThruScan accounts:
//
//   src/lib/networks.js         OURS_BETANET
//   indexer/addresses.mjs       OURS.betanet
//   extension/src/lib/networks.js   betanet.NAMES_ROOT and betanet.ours
//
//   node tools/betanet/write-addresses.mjs
//
// Only keys that already exist in each table are written, and only from what
// the deploy recorded, so nothing from alphanet can find its way in.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, record, log } from './config.mjs'

const A = record().addresses
const ADDR = /^ta[A-Za-z0-9_-]{44}$/
for (const [k, v] of Object.entries(A)) if (!ADDR.test(v)) throw new Error(`deployed.json: ${k} is not an address: ${v}`)

function rewriteBlock(file, startMarker, endMarker, apply) {
  const path = join(ROOT, file)
  const s = readFileSync(path, 'utf8')
  const i = s.indexOf(startMarker)
  const j = s.indexOf(endMarker, i)
  if (i < 0 || j < 0) throw new Error(`${file}: could not find the betanet table`)
  const block = s.slice(i, j)
  const next = apply(block)
  writeFileSync(path, s.slice(0, i) + next + s.slice(j))
  return next !== block
}

const setKeys = (block, map) => {
  let out = block
  for (const [key, value] of Object.entries(map)) {
    if (!value) continue
    out = out.replace(new RegExp(`(\\n\\s*${key}: )'[^']*'`), `$1'${value}'`)
  }
  return out
}

/* The site. */
const site = rewriteBlock('src/lib/networks.js', 'const OURS_BETANET = {', '\n}\n', (b) => setKeys(b, A))

/* The indexer only recognises programs and the pad registry. */
const idx = rewriteBlock('indexer/addresses.mjs', '  betanet: {', '\n  },\n', (b) => {
  const keys = ['THRUPAD_PROGRAM', 'THRUPAD_REGISTRY', 'THRUSWAP_PROGRAM', 'WALL_PROGRAM', 'WORDLE_PROGRAM', 'G2048_PROGRAM', 'ID_PROGRAM']
  const lines = keys.filter((k) => A[k]).map((k) => `    ${k}: '${A[k]}',`)
  return `  betanet: {\n${lines.join('\n')}`
})

/* The extension. */
const ext = rewriteBlock('extension/src/lib/networks.js', '  betanet: {', '\n  },\n', (b) => {
  let out = b.replace(/(\n\s*NAMES_ROOT: )'[^']*'/, `$1'${A.NAME_ROOT ?? ''}'`)
  out = out.replace(/ours: \{[^}]*\}/, `ours: { THRUSWAP: '${A.THRUSWAP_PROGRAM ?? ''}', THRUPAD: '${A.THRUPAD_PROGRAM ?? ''}', WALL: '${A.WALL_PROGRAM ?? ''}' }`)
  return out
})

log(`src/lib/networks.js ${site ? 'updated' : 'unchanged'}; indexer/addresses.mjs ${idx ? 'updated' : 'unchanged'}; extension networks ${ext ? 'updated' : 'unchanged'}`)
for (const [k, v] of Object.entries(A)) log(`  ${k.padEnd(18)} ${v}`)
