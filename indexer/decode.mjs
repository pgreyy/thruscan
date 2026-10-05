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
/* How interesting each kind is, most first. Used to name a bundle after its
   most recognisable part rather than its first one, since the plumbing tends
   to come first: a token account is opened before the thing it is opened for.
   Anything not listed sorts last. */
const RANK = [
  'launch', 'graduate', 'migrate', 'buy', 'sell', 'swap', 'claim', 'pad',
  'pool', 'liquidity', 'nft', 'name', 'wall', 'mint', 'burn', 'transfer',
  'faucet', 'token', 'account', 'bundle', 'other', 'oracle', 'noop',
]
const rank = (k) => { const i = RANK.indexOf(k); return i < 0 ? RANK.length : i }

/**
 * The calls inside a multicall bundle.
 *
 *   [count u16] then count x [program_idx u16][data_size u64][data]
 *
 * `program_idx` points into the transaction's own account list, which starts
 * with the fee payer, then the program being called, then the read-write
 * accounts and then the read-only ones. Every inner instruction resolves its
 * indices against that same shared list, which is what makes one bundle one
 * transaction rather than several.
 *
 * Malformed input returns what it managed to read rather than throwing: this
 * runs over whatever is on chain, and one odd transaction must not stop a feed.
 */
export function innerCalls(data, accounts) {
  const out = []
  if (!data || data.length < 2) return out
  const dv = new DataView(data.buffer, data.byteOffset, data.length)
  let off = 0
  const count = dv.getUint16(off, true); off += 2
  for (let i = 0; i < count && off + 10 <= data.length; i++) {
    const idx = dv.getUint16(off, true); off += 2
    const size = Number(dv.getBigUint64(off, true)); off += 8
    if (size < 0 || off + size > data.length) break
    out.push({ program: accounts[idx] ?? null, data: data.subarray(off, off + size) })
    off += size
  }
  return out
}

/* How much of each transaction rides along with its row.
 *
 * The fee is the node's own, on every transaction. The instruction's first 32
 * bytes carry the opcode and, for a transfer, the amount and both account
 * indices, which is all a feed needs to say who paid whom. The accounts are
 * what those indices point into. Proofs and long payloads stay on the chain. */
export const KEEP_DATA_BYTES = 32
export const KEEP_ACCOUNTS = 16

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
    [A.ORACLE_PROGRAM]: 'Oracle',
    [A.AMM_PROGRAM]: 'AMM',
    [A.CLOB_PROGRAM]: 'Order book',
    [A.THRUPAD_PROGRAM]: 'ThruPad',
    [A.THRUSWAP_PROGRAM]: 'Swap',
    [A.PALS_PROGRAM]: 'Pixel Pals',
    [A.WALL_PROGRAM]: 'Wall',
  }

  const PAD = {
    0: ['pad', 'Opened ThruPad'],
    1: ['launch', 'Launched a token'],
    2: ['buy', 'Bought on ThruPad'],
    3: ['sell', 'Sold on ThruPad'],
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

  /* What one call to one program is, read from its first byte.
   *
   * Separated out because a multicall bundle's inner calls are ordinary calls
   * to ordinary programs, and reading them with a second, similar-looking
   * copy of this is how the two drift apart. `flags` is only ever set on the
   * transaction itself, so it is passed rather than looked up. */
  function labelFor(program, data, flags) {
    const op = data?.length ? data[0] : null
    let kind = 'other'
    let label = `${named[program] ?? 'Program'} call`

    switch (program) {
      case A.THRUPAD_PROGRAM: {
        const hit = PAD[op]
        if (hit) [kind, label] = hit
        else label = 'ThruPad'
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
      case A.ORACLE_PROGRAM: {
        kind = 'oracle'
        label = 'Price update'
        break
      }
      case A.NOOP_PROGRAM: {
        /* Two different things wear this program.
         *
         * A wallet's very first transaction is a call to NOOP carrying a proof
         * that its address is empty and the flag that asks the runtime to
         * create the fee payer. That is how anybody gets onto the chain at
         * all, and it is worth showing.
         *
         * Every other NOOP is the node talking to itself, and there is one
         * per slot, so a feed that shows them shows nothing else. */
        if (flags === 1) { kind = 'account'; label = 'Account created' }
        else { kind = 'noop'; label = 'Chain keepalive' }
        break
      }
      default:
        break
    }
    return { kind, label, op }
  }

  return function decode(txn) {
    const program = addr(txn.program)
    const feePayer = addr(txn.feePayer)
    if (!program || !feePayer) return null

    const rw = (txn.readWriteAccounts ?? []).map(addr).filter(Boolean)
    const ro = (txn.readOnlyAccounts ?? []).map(addr).filter(Boolean)
    const data = txn.instructionData ?? new Uint8Array(0)
    const flags = Number(txn.flags ?? 0)

    let { kind, label, op } = labelFor(program, data, flags)

    /* A bundle is not an action, it is a container for several. Almost every
       write the site makes is one now, so a feed that stops at "bundled
       transaction" describes nothing that happened. Read what is inside and
       report the part somebody would recognise. */
    if (program === A.MULTICALL_PROGRAM) {
      const read = innerCalls(data, [feePayer, program, ...rw, ...ro])
        .map((c) => labelFor(c.program, c.data, 0))
      /* The bundle is named after the most interesting thing in it. A buy
         wrapped with a token-account creation and a deposit is a buy; saying
         "opened a token account" would be true and useless. */
      const best = [...read].sort((a, b) => rank(a.kind) - rank(b.kind))[0]
      /* Whatever is inside wins, even when it is infrastructure: a bundle of
         oracle updates is an oracle update, and calling it a bundled
         transaction only hides that from the filter that would drop it. */
      if (best) {
        kind = best.kind
        label = best.label
      }
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
      /* null when the node did not say, never a guess. */
      fee: txn.fee == null ? null : String(txn.fee),
      data: Buffer.from(data.subarray(0, KEEP_DATA_BYTES)).toString('base64'),
      rw: rw.slice(0, KEEP_ACCOUNTS),
      ro: ro.slice(0, KEEP_ACCOUNTS),
      participants: [
        { address: feePayer, writable: 1 },
        ...rw.map((a) => ({ address: a, writable: 1 })),
        ...ro.map((a) => ({ address: a, writable: 0 })),
      ],
    }
  }
}
