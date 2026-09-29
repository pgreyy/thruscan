// indexer/decode.mjs
//
// One transaction in, one row out.
//
// This is the same reading src/lib/activity.js does in the browser, moved to
// where it belongs. The browser version was decoding every transaction on
// every page load because there was nowhere to keep the answer. Now there is,
// so each transaction is read once, ever, and the site reads rows.
//
// Pure on purpose: no network, no database, no clock. That is what makes it
// testable against a recorded block without a chain in front of it.

import { Pubkey, Signature } from '@thru/sdk'

/* The SDK hands back pubkeys as { bytes: Uint8Array }, or occasionally as the
   bare bytes. Both spellings turn into the same string. */
export function addr(p) {
  if (!p) return null
  try {
    return Pubkey.from(p?.bytes ?? p).toThruFmt()
  } catch {
    return null
  }
}

/* A signature is 64 bytes where an address is 32, so it needs its own
   formatter. Running it through the address one does not throw a useful error,
   it just returns nothing, which silently drops every row. Asking for that
   mistake once was enough. */
export function sigStr(s) {
  if (!s) return null
  try {
    if (typeof s.toThruFmt === 'function') return s.toThruFmt()
    return Signature.from(s?.bytes ?? s).toThruFmt()
  } catch {
    return null
  }
}

const u32 = (b, at) =>
  b && b.length >= at + 4 ? new DataView(b.buffer, b.byteOffset, b.length).getUint32(at, true) : null

/* A name registration carries the name inline. Worth pulling out, because
   "Registered greyy.id" is a row somebody wants to see and "Name service" is
   not. */
function registeredName(b) {
  if (!b || b.length < 6) return null
  const len = b[4]
  if (!len || len > 32 || b.length < 5 + len) return null
  let out = ''
  for (let i = 0; i < len; i++) {
    const c = b[5 + i]
    if (c < 32 || c > 126) return null
    out += String.fromCharCode(c)
  }
  return out
}

/**
 * Build the decoder for one network's address set.
 *
 * The addresses differ per network, because a program's address comes from
 * whoever deployed it, so the decoder is made rather than imported. Passing
 * the wrong set is the one way to get this quietly wrong, which is why it is
 * an argument instead of a global.
 */
export function makeDecoder(addresses) {
  const A = addresses
  const named = {
    [A.TOKEN_PROGRAM]: 'Token',
    [A.EOA_PROGRAM]: 'Account',
    [A.MULTICALL_PROGRAM]: 'Multicall',
    [A.NAME_SERVICE_PROGRAM]: 'Name service',
    [A.NATIVE_FAUCET_PROGRAM]: 'Faucet',
    [A.WTHRU_PROGRAM]: 'WTHRU',
    [A.NFT_PROGRAM]: 'NFT',
    [A.AMM_PROGRAM]: 'AMM',
    [A.CLOB_PROGRAM]: 'Order book',
    [A.THRUPAD_PROGRAM]: 'Launchpad',
    [A.THRUSWAP_PROGRAM]: 'Swap',
    [A.PALS_PROGRAM]: 'Pixel Pals',
    [A.WALL_PROGRAM]: 'Wall',
  }

  const PAD = {
    1: ['launch', 'Launched a token'],
    2: ['buy', 'Bought on the launchpad'],
    3: ['sell', 'Sold on the launchpad'],
    4: ['claim', 'Claimed creator fees'],
    5: ['graduate', 'Graduated a launch'],
    6: ['migrate', 'Migrated to the AMM'],
  }

  const AMM = {
    0: ['pool', 'Created a pool'],
    1: ['liquidity', 'Added liquidity'],
    2: ['liquidity', 'Removed liquidity'],
    3: ['swap', 'Swapped'],
  }

  const SWAP = {
    1: ['pool', 'Created a pool'],
    2: ['liquidity', 'Added liquidity'],
    3: ['liquidity', 'Removed liquidity'],
    4: ['swap', 'Swapped'],
  }

  return function decode(txn) {
    const program = addr(txn.program)
    const feePayer = addr(txn.feePayer)
    if (!program || !feePayer) return null

    const rw = (txn.readWriteAccounts ?? []).map(addr).filter(Boolean)
    const ro = (txn.readOnlyAccounts ?? []).map(addr).filter(Boolean)
    const data = txn.instructionData ?? new Uint8Array(0)
    const op = data.length ? data[0] : null

    let kind = 'other'
    let label = `${named[program] ?? 'Program'} call`

    switch (program) {
      case A.THRUPAD_PROGRAM: {
        const hit = PAD[op]
        if (hit) [kind, label] = hit
        else label = 'Launchpad'
        break
      }
      case A.AMM_PROGRAM: {
        const hit = AMM[op]
        if (hit) [kind, label] = hit
        break
      }
      case A.THRUSWAP_PROGRAM: {
        const hit = SWAP[op]
        if (hit) [kind, label] = hit
        break
      }
      case A.TOKEN_PROGRAM: {
        if (op === 0) { kind = 'token'; label = 'Created a token' }
        else if (op === 1) { kind = 'account'; label = 'Opened a token account' }
        else if (op === 2) { kind = 'transfer'; label = 'Token transfer' }
        else if (op === 3) { kind = 'mint'; label = 'Minted tokens' }
        else if (op === 4) { kind = 'burn'; label = 'Burned tokens' }
        else { kind = 'token' }
        break
      }
      case A.EOA_PROGRAM: {
        const eop = u32(data, 0)
        if (eop === 0) { kind = 'account'; label = 'Account created' }
        else if (eop === 1) { kind = 'transfer'; label = 'THRU transfer' }
        else { kind = 'account' }
        break
      }
      case A.NATIVE_FAUCET_PROGRAM: {
        kind = 'faucet'
        label = 'Claimed THRU from the faucet'
        break
      }
      case A.NAME_SERVICE_PROGRAM: {
        kind = 'name'
        const nop = u32(data, 0)
        if (nop === 1) {
          const n = registeredName(data)
          label = n ? `Registered ${n}` : 'Registered a name'
        } else {
          label = { 2: 'Set a name record', 3: 'Removed a name record', 4: 'Released a name' }[nop] ?? 'Name service'
        }
        break
      }
      case A.PALS_PROGRAM: {
        kind = 'nft'
        label = { 1: 'Minted a Pal', 2: 'Bought a Pal', 3: 'Listed a Pal' }[op] ?? 'Pixel Pals'
        break
      }
      case A.WALL_PROGRAM: {
        kind = 'wall'
        label = 'Posted to the wall'
        break
      }
      case A.MULTICALL_PROGRAM: {
        // A bundle's real content is its inner calls, which we cannot read
        // without unpacking them. Recorded as a bundle and left for later.
        kind = 'bundle'
        label = 'Bundled transaction'
        break
      }
      default:
        break
    }

    const x = txn.executionResult ?? {}
    const userError = Number(x.userErrorCode ?? 0)
    const vmError = Number(x.vmError ?? 0)

    return {
      signature: sigStr(txn.signature),
      slot: Number(txn.slot ?? 0),
      blockOffset: Number(txn.blockOffset ?? 0),
      feePayer,
      program,
      op,
      kind,
      label,
      ok: userError === 0 && vmError === 0 ? 1 : 0,
      userError,
      vmError,
      participants: [
        { address: feePayer, writable: 1 },
        ...rw.map((a) => ({ address: a, writable: 1 })),
        ...ro.map((a) => ({ address: a, writable: 0 })),
      ],
    }
  }
}
