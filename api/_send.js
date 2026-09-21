// api/_send.js
//
// Sending a transaction from one key so that it actually lands.
//
// A Thru transaction names its fee payer's next nonce. Two transactions built
// from the same key at the same moment carry the same nonce, the network keeps
// one and fails the other with error -511. The node can also answer "busy" to
// a send that it goes on to execute. Both were seen on alphanet.
//
// So a send is not done until the chain shows it:
//   1. one send at a time per server instance (a queue),
//   2. after sending, wait for the key's nonce to move on,
//   3. then look the signature up. Landed: done. Missing, or failed with -511
//      because another send took that nonce: build again with the next one.
//
// The underscore keeps Vercel from serving this file as an endpoint.

import { Signature } from '@thru/sdk'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let queue = Promise.resolve()

/** The landed transaction, or null if the chain has no record of it. */
async function lookup(c, signature, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await c.transactions.get(signature) } catch { /* not indexed yet, or not there */ }
    await sleep(500)
  }
  return null
}

// What the chain reports when a second transaction reuses a nonce: it lands in
// the same block and fails with this code, instead of being dropped.
const NONCE_TAKEN = -511

/**
 * build(nonce) must return { rawTransaction, signature } for that nonce.
 * nonceOf() returns the key's current nonce as a bigint.
 * Resolves with the landed signature, or throws after a few attempts.
 */
export function sendLanded(c, { build, nonceOf, attempts = 3 }) {
  const run = queue.then(async () => {
    let lastError = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      const nonce = await nonceOf()
      const { rawTransaction, signature: sigBytes } = await build(nonce)
      const signature = Signature.from(sigBytes).toThruFmt()

      try { await c.transactions.send(rawTransaction) } catch (e) { lastError = e /* may still land */ }

      // Wait for the nonce to move past ours, for up to about 10 seconds.
      let moved = false
      for (let i = 0; i < 20 && !moved; i++) {
        await sleep(500)
        try { moved = (await nonceOf()) > nonce } catch { /* keep waiting */ }
      }

      const landed = await lookup(c, signature, moved ? 4 : 2)
      if (landed && landed.executionResult?.vmError !== NONCE_TAKEN) return signature
      // Missing, or beaten to the nonce. Build again with the nonce as it is now.
    }
    throw lastError ?? new Error('The network did not take the transaction. Try again in a moment.')
  })
  queue = run.catch(() => {})
  return run
}
