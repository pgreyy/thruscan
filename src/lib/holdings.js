// src/lib/holdings.js
//
// What a wallet holds, found from the chain rather than from this browser.
//
//   knownMints()        every mint ThruScan knows about: the two quote assets,
//                       every pool's pair and LP token, every launch's token
//   ownedNames(address) every .id name this address registered and still owns

import { getAccount } from './rpcClient.js'
import { decodeSwapRegistry } from './swap.js'
import { decodePadRegistry } from './pad.js'
import { decodeDomain } from './names.js'
import { checkName } from './wallet.js'
import { namesFromHistory } from './activity.js'
import { TUSD_MINT, WTHRU_MINT, THRUSWAP_REGISTRY, THRUPAD_REGISTRY } from './addresses.js'

export async function knownMints() {
  const mints = new Set([TUSD_MINT, WTHRU_MINT])
  const [swap, pad] = await Promise.all([
    THRUSWAP_REGISTRY ? getAccount(THRUSWAP_REGISTRY).catch(() => null) : null,
    THRUPAD_REGISTRY ? getAccount(THRUPAD_REGISTRY).catch(() => null) : null,
  ])
  try {
    for (const p of decodeSwapRegistry(swap?.data?.base64).pools) {
      mints.add(p.mintA); mints.add(p.mintB); mints.add(p.lpMint)
    }
  } catch { /* no pools readable; the quote assets are still checked */ }
  try {
    for (const l of decodePadRegistry(pad?.data?.base64).launches) mints.add(l.mint)
  } catch { /* same */ }
  return [...mints].filter(Boolean)
}

function bytesOf(b64) {
  if (!b64) return null
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Read one name. Returns { name, account, domain } or null if free. */
export async function readName(name) {
  const r = await checkName(name)
  if (!r.ok || !r.taken) return null
  return { name, account: r.account, domain: decodeDomain(bytesOf(r.data)) }
}

/**
 * Names this address owns right now. `extra` adds names to check that the
 * history may not reach, such as ones this browser remembers.
 */
export async function ownedNames(address, extra = []) {
  if (!address) return []
  let fromChain = []
  try { fromChain = await namesFromHistory(address) } catch { /* fall back to extra */ }
  const candidates = [...new Set([...fromChain, ...extra])]
  const rows = await Promise.all(candidates.map((n) => readName(n).catch(() => null)))
  return rows.filter((r) => r?.domain && r.domain.owner === address)
}
