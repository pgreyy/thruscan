// tools/check-networks.mjs
//
// Reads every network in src/lib/networks.js and says whether it still looks
// like the chain the table describes. Run it before a deploy, and first thing
// when the site starts saying "account not found":
//
//   node tools/check-networks.mjs
//
// For each network it prints the finalized height, the chain id and the node's
// commit, then checks three things a reset or a mix-up would break:
//
//   1. The chain id matches the table. Two names for one chain, or a network
//      that changed under us, shows up here first.
//   2. The height has not gone backwards since the last run. A genesis reset
//      starts again from zero, so a lower height than last time is a reset,
//      caught on the first run after it. The last heights are kept outside the
//      repo, in ~/.thruscan/network-heights.json.
//   3. Every ThruScan address the table lists for the network exists on it.
//      A reset wipes them all; an alphanet address copied into betanet's table
//      was never there.
//
// It uses native gRPC through the same SDK the API uses, never gRPC-Web: the
// node speaks gRPC, and the browser-only transport is what the site's proxy
// exists to avoid. Exit code 1 if anything is wrong, so a script can stop on it.

import dns from 'node:dns'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createThruClient } from '@thru/sdk'
import { createGrpcTransport } from '@connectrpc/connect-node'
import { NETWORKS } from '../src/lib/networks.js'

dns.setDefaultResultOrder('ipv4first')

const STATE_DIR = join(homedir(), '.thruscan')
const STATE_FILE = join(STATE_DIR, 'network-heights.json')
const TIMEOUT_MS = 10_000

/* Thru's own programs: the same on every network and not ours to check. */
const SYSTEM_KEYS = new Set([
  'TOKEN_PROGRAM', 'EOA_PROGRAM', 'MULTICALL_PROGRAM', 'NAME_SERVICE_PROGRAM', 'NATIVE_FAUCET_PROGRAM',
  'NATIVE_FAUCET_ACCOUNT', 'WTHRU_PROGRAM', 'WTHRU_VAULT', 'WTHRU_MINT', 'NFT_PROGRAM', 'NOOP_PROGRAM',
  'ORACLE_PROGRAM', 'AMM_PROGRAM', 'CLOB_PROGRAM',
])

const withTimeout = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timed out')), TIMEOUT_MS))])

function readHeights() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}

async function check(net, lastHeights) {
  const grpc = net.rpc.find((r) => r.protocol === 'grpc')
  const out = { id: net.id, label: net.label, url: grpc?.url, problems: [], height: null }
  if (!grpc) { out.problems.push('no native gRPC endpoint in the table'); return out }
  const client = createThruClient({ transport: createGrpcTransport({ baseUrl: grpc.url }) })

  try {
    const [height, chainId, version] = await Promise.all([
      withTimeout(client.blocks.getBlockHeight()),
      withTimeout(client.chain.getChainId()),
      withTimeout(client.version.get()),
    ])
    out.height = BigInt(height.finalized ?? height.finalizedHeight ?? height)
    out.chainId = chainId
    const components = version?.components ?? version
    out.commit = components?.['thru-node-commit'] ?? components?.thruNodeCommit ?? JSON.stringify(components).slice(0, 80)
  } catch (e) {
    out.problems.push(`unreachable: ${e.message}`)
    return out
  }

  if (net.chainId != null && out.chainId !== net.chainId) {
    out.problems.push(`chain id is ${out.chainId}, the table says ${net.chainId}`)
  }
  const last = lastHeights[net.id]
  if (last && out.height < BigInt(last.height)) {
    out.problems.push(`RESET: height ${out.height} is below the ${last.height} seen at ${last.at}`)
  }

  const ours = Object.entries(net.addresses).filter(([k, a]) => a && !SYSTEM_KEYS.has(k))
  const missing = []
  for (const [key, address] of ours) {
    const found = await withTimeout(client.accounts.get(address)).catch(() => null)
    if (!found) missing.push(key)
  }
  out.ours = ours.length
  if (missing.length) out.problems.push(`${missing.length} of ${ours.length} ThruScan addresses missing: ${missing.join(', ')}`)
  return out
}

const lastHeights = readHeights()
const nets = Object.values(NETWORKS).filter((n) => n.test)
const results = await Promise.all(nets.map((n) => check(n, lastHeights)))

const heights = { ...lastHeights }
let bad = false
for (const r of results) {
  console.log(`${r.label.padEnd(18)} ${r.url ?? ''}`)
  if (r.height !== null) {
    console.log(`  height ${r.height}  chain id ${r.chainId}  node ${r.commit}  ThruScan addresses ${r.ours}`)
    if (!r.problems.some((p) => p.startsWith('RESET'))) heights[r.id] = { height: r.height.toString(), at: new Date().toISOString() }
  }
  for (const p of r.problems) { console.log(`  PROBLEM  ${p}`); bad = true }
  if (!r.problems.length) console.log('  ok')
}

const ids = results.filter((r) => r.chainId != null).map((r) => `${r.id}:${r.chainId}:${r.commit}`)
const sameChain = results.filter((r) => r.chainId != null).length > 1
  && new Set(results.filter((r) => r.chainId != null).map((r) => r.chainId)).size === 1
if (sameChain) { console.log(`PROBLEM  every network reports the same chain id (${ids.join(', ')}); check whether they are one chain again`); bad = true }

try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(heights, null, 2)) } catch { /* read-only home: still report */ }
process.exit(bad ? 1 : 0)
