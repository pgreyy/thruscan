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
import { customMints } from './customTokens.js'

export async function knownMints() {
  const mints = new Set([TUSD_MINT, WTHRU_MINT, ...customMints()])
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
 * Names this address owns right now.
 *
 * Three sources, because no single one is enough:
 *
 *   the site's index   every name ThruScan registered, with its current owner,
 *                      built from the sponsor's history on the server. This is
 *                      the one that works for a wallet that has never sent a
 *                      transaction, which is most of them.
 *
 *   this address's own history, which catches a name registered elsewhere,
 *
 *   `extra`, the names this browser remembers claiming.
 *
 * The index is authoritative about ownership already, but every candidate is
 * still read from the name service and checked, so a name transferred a minute
 * ago is not listed against its old owner.
 */
export async function ownedNames(address, extra = []) {
  if (!address) return []

  /* The index is built by walking the sponsor's history a few pages per call,
     so a cold deployment answers "nothing yet, still looking". Asking once more
     a moment later is the difference between a name appearing and a page that
     says a wallet holds none. */
  const askIndex = () => fetch(`/api/rpc?action=names&owner=${encodeURIComponent(address)}`)
    .then((r) => r.json())
    .then((j) => (j.ok ? { names: (j.names ?? []).map((n) => n.name), complete: Boolean(j.complete) } : { names: [], complete: true }))
    .catch(() => ({ names: [], complete: true }))

  const indexed = (async () => {
    let r = await askIndex()
    for (let i = 0; i < 3 && !r.complete && r.names.length === 0; i++) {
      await new Promise((res) => setTimeout(res, 2000))
      r = await askIndex()
    }
    return r.names
  })()

  /* The history read is the slow one, and on a quiet node it can simply not
     come back. It is the least important of the three sources, so it gets a
     deadline rather than the power to hold up the other two. */
  const historic = Promise.race([
    namesFromHistory(address).catch(() => []),
    new Promise((res) => setTimeout(() => res([]), 6000)),
  ])

  const candidates = [...new Set([...(await indexed), ...(await historic), ...extra])]
  const rows = await Promise.all(candidates.map((n) => readName(n).catch(() => null)))
  return rows.filter((r) => r?.domain && r.domain.owner === address)
}
