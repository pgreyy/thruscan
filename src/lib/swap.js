// src/lib/swap.js
//
// Decoder and instruction builder for thruswap, the AMM. Written alongside the
// program in thruswap.c rather than reverse-engineered, so the two must be kept
// in step. If you change a field size in the C, change it here in the same
// commit.
//
// ---------------------------------------------------------------------------
// Registry header, 37 bytes
//
//   off  size  field
//   0x00    1  version (currently 1)
//   0x01    4  pool_count (u32)
//   0x05   32  sponsor pubkey — whoever ran INIT
//
// Then pool records of 179 bytes each:
//
//   off  size  field
//   0x00    1  in_use
//   0x01    2  fee_bps (u16)
//   0x03   32  mint_a
//   0x23   32  mint_b
//   0x43   32  vault_a      — token account owned by the program
//   0x63   32  vault_b
//   0x83   32  lp_mint      — its authority is the program
//   0xa3    8  lp_supply (u64)
//   0xab    8  swap_count (u64)
//
// Reserves are deliberately NOT in the record. They are read live from the
// vault token accounts, so the curve can never price against a balance that is
// not there. Fetch the vaults alongside the registry and pass them in.
//
// ---------------------------------------------------------------------------
// ACCOUNT ORDER MATTERS
//
// Thru sorts a transaction's accounts ascending by raw public key bytes, and
// every index inside an instruction refers to that sorted order rather than the
// order the caller listed them. Building these payloads by hand is therefore a
// good way to send tokens somewhere unintended. The builders below sort the
// accounts and derive the indices from the result, and they return the sorted
// lists so the caller submits exactly what was encoded.

import { Pubkey } from '@thru/sdk'
import { buildMulticall } from './multicall.js'
import { wrapSteps, WTHRU_MINT_ADDRESS } from './wthru.js'

export const SWAP_VERSION = 1
export const HEADER_SIZE = 37
export const POOL_SIZE = 179

export const TOKEN_PROGRAM = 'taTOKENKRgcl3vO0yVhftATDbXuhgWcfaaxv9xpEEdMdUE'

export const OP_INIT = 0x00
export const OP_CREATE = 0x01
export const OP_ADD = 0x02
export const OP_REMOVE = 0x03
export const OP_SWAP = 0x04
export const OP_CREATE_SEEDED = 0x05
export const OP_SET_CREATOR_FEE = 0x06
export const OP_CLAIM_CREATOR_FEES = 0x07
export const OP_EXTEND = 0x08
export const OP_OPT_IN_CREATOR_FEE = 0x09

/* The creator fee table appended after the pool records (thruswap.c,
   registry_layout): an 8-byte magic, then one 53-byte entry per slot. */
export const EXT_MAGIC = 0x3145454652435354n   // "TSCRFEE1"
export const EXT_HEADER_SIZE = 8
export const EXT_SIZE = 53
/** LP fee plus creator fee, together, never more than this. */
export const TOTAL_FEE_BPS_MAX = 100

export const BPS_DENOM = 10000n

export class SwapDecodeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SwapDecodeError'
  }
}

/** Capacity is whatever INIT allocated, so read it off the account's size.
 *  Without `bytes` this is the plain shape only; pass the bytes to recognise a
 *  registry with the creator fee table appended. */
export function poolCapacity(byteLength, bytes = null) {
  return registryLayout(byteLength, bytes).slots
}

/** The registry's shape, exactly as thruswap.c's registry_layout reads it: try
 *  the extended shape and believe it only if the magic sits where it says;
 *  otherwise every byte after the header is pool records. */
export function registryLayout(byteLength, bytes = null) {
  if (byteLength < HEADER_SIZE + POOL_SIZE) return { slots: 0, extAt: null }
  const body = byteLength - HEADER_SIZE
  if (bytes && body > EXT_HEADER_SIZE && (body - EXT_HEADER_SIZE) % (POOL_SIZE + EXT_SIZE) === 0) {
    const s = (body - EXT_HEADER_SIZE) / (POOL_SIZE + EXT_SIZE)
    const m = HEADER_SIZE + s * POOL_SIZE
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (s > 0 && dv.getBigUint64(m, true) === EXT_MAGIC) return { slots: s, extAt: m + EXT_HEADER_SIZE }
  }
  return { slots: Math.floor(body / POOL_SIZE), extAt: null }
}

function base64ToBytes(b64) {
  if (b64 instanceof Uint8Array) return b64
  if (!b64) throw new SwapDecodeError('registry account has no data')
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function readPubkey(bytes, offset) {
  return Pubkey.from(bytes.slice(offset, offset + 32)).toThruFmt()
}

/**
 * Decode the pool registry.
 *
 * Returns { version, poolCount, sponsor, capacity, pools }, where pools carries
 * only the slots actually in use rather than every empty one.
 */
export function decodeSwapRegistry(input) {
  const bytes = base64ToBytes(input)

  if (bytes.length < HEADER_SIZE) {
    throw new SwapDecodeError('account is too small to be a pool registry')
  }
  if (bytes[0] !== SWAP_VERSION) {
    throw new SwapDecodeError(`unknown registry version ${bytes[0]}`)
  }
  const { slots, extAt } = registryLayout(bytes.length, bytes)
  if (slots === 0) {
    throw new SwapDecodeError(`registry is too small at ${bytes.length} bytes`)
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const pools = []

  for (let i = 0; i < slots; i++) {
    const base = HEADER_SIZE + i * POOL_SIZE
    if (bytes[base] !== 1) continue // never created

    pools.push({
      id: i,
      feeBps: dv.getUint16(base + 0x01, true),
      mintA: readPubkey(bytes, base + 0x03),
      mintB: readPubkey(bytes, base + 0x23),
      vaultA: readPubkey(bytes, base + 0x43),
      vaultB: readPubkey(bytes, base + 0x63),
      lpMint: readPubkey(bytes, base + 0x83),
      lpSupply: dv.getBigUint64(base + 0xa3, true),
      swapCount: dv.getBigUint64(base + 0xab, true),
      ...creatorFeeAt(bytes, dv, extAt, i),
    })
  }

  return {
    version: bytes[0],
    poolCount: dv.getUint32(0x01, true),
    sponsor: readPubkey(bytes, 0x05),
    capacity: slots,
    extended: extAt !== null,
    pools,
  }
}

/* A pool's creator fee entry: has_creator u8, creator 32, creator_bps u16,
   max_bps u16, accrued_a u64, accrued_b u64. No table, or no creator, reads as
   no creator fee and nothing owed. */
function creatorFeeAt(bytes, dv, extAt, i) {
  const none = { creator: null, creatorBps: 0, maxCreatorBps: 0, owedA: 0n, owedB: 0n }
  if (extAt === null) return none
  const e = extAt + i * EXT_SIZE
  const owed = { owedA: dv.getBigUint64(e + 37, true), owedB: dv.getBigUint64(e + 45, true) }
  if (bytes[e] !== 1) return { ...none, ...owed }
  return {
    creator: readPubkey(bytes, e + 1),
    creatorBps: dv.getUint16(e + 33, true),
    maxCreatorBps: dv.getUint16(e + 35, true),
    ...owed,
  }
}

/** A pool's liquidity: what its vaults hold less what its creator is owed.
 *  Owed fees sit in the vaults but are not the pool's to trade, exactly as the
 *  program reads it. `balances` maps vault address to amount. */
export function poolReserves(pool, balances) {
  const minus = (held, owed) => (held > owed ? held - owed : 0n)
  return {
    a: minus(balances?.[pool.vaultA] ?? 0n, pool.owedA ?? 0n),
    b: minus(balances?.[pool.vaultB] ?? 0n, pool.owedB ?? 0n),
  }
}

/** Every fee a swap through `pool` pays, in basis points. */
export function totalFeeBps(pool) {
  return (pool?.feeBps ?? 0) + (pool?.creatorBps ?? 0)
}

// ---------------------------------------------------------------- pricing

/**
 * The same constant product the program computes, in the same order, so a
 * quote shown in the browser matches what the chain will actually do.
 *
 * BigInt throughout because the intermediate product exceeds 2^53 long before
 * the reserves get interesting, and a silently rounded quote is worse than no
 * quote at all.
 */
/**
 * What the pool actually withholds from a swap of `amountIn`.
 *
 * thruswap swaps `in_less_fee = floor(amountIn * (10000 - feeBps) / 10000)` and
 * leaves the rest in the pool, so the fee is the remainder, which rounds UP
 * against a floor of the rate times the amount. At 30 basis points a swap of
 * 100 base units withholds 1, where 100 * 30 / 10000 floors to 0. Showing the
 * floor said "0 WTHRU" for a swap that did pay a fee.
 */
export function poolFee(amountIn, feeBps) {
  const aIn = BigInt(amountIn)
  return aIn - (aIn * (BPS_DENOM - BigInt(feeBps))) / BPS_DENOM
}

export function quoteSwap({ reserveIn, reserveOut, amountIn, feeBps = 30, creatorBps = 0 }) {
  const rIn = BigInt(reserveIn)
  const rOut = BigInt(reserveOut)
  const aIn = BigInt(amountIn)
  const fee = BigInt(feeBps) + BigInt(creatorBps)

  if (rIn <= 0n || rOut <= 0n) return { amountOut: 0n, priceImpactBps: 0n, reason: 'empty pool' }
  if (aIn <= 0n) return { amountOut: 0n, priceImpactBps: 0n, reason: 'zero input' }

  const inLessFee = (aIn * (BPS_DENOM - fee)) / BPS_DENOM
  if (inLessFee <= 0n) return { amountOut: 0n, priceImpactBps: 0n, reason: 'amount too small' }

  const amountOut = (rOut * inLessFee) / (rIn + inLessFee)
  if (amountOut <= 0n) return { amountOut: 0n, priceImpactBps: 0n, reason: 'amount too small' }
  if (amountOut >= rOut) return { amountOut: 0n, priceImpactBps: 0n, reason: 'not enough liquidity' }

  // How far the execution price sits from the pool's price before the trade.
  const idealOut = (aIn * rOut) / rIn
  const impact = idealOut > 0n ? ((idealOut - amountOut) * BPS_DENOM) / idealOut : 0n

  // The creator's part of the fee, rounded down as the program rounds it.
  const creatorFee = (aIn * BigInt(creatorBps)) / BPS_DENOM
  return { amountOut, priceImpactBps: impact, creatorFee, reason: null }
}

/** Price of one whole unit of A in terms of B, as a JS number for display. */
export function poolPrice(reserveA, reserveB, decimalsA = 6, decimalsB = 6) {
  const a = Number(reserveA)
  const b = Number(reserveB)
  if (!a || !b) return 0
  return (b / 10 ** decimalsB) / (a / 10 ** decimalsA)
}

// ------------------------------------------------------- account ordering

/**
 * A Thru address is "ta" plus base64url of the key and a checksum byte. Sorting
 * has to happen on those raw bytes, not on the string: the base64 alphabet does
 * not order the same way the bytes do, so a string sort silently produces the
 * wrong indices and the program then reads the wrong accounts.
 */
export function addressBytes(addr) {
  const body = addr.slice(2).replace(/-/g, '+').replace(/_/g, '/')
  const padded = body + '='.repeat((4 - (body.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function sortAccounts(list) {
  return [...list].sort((x, y) => {
    const a = addressBytes(x)
    const b = addressBytes(y)
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] - b[i]
    }
    return a.length - b.length
  })
}

// ------------------------------------------------------------- instructions

function writer(size) {
  const out = new Uint8Array(size)
  const dv = new DataView(out.buffer)
  let o = 0
  return {
    u8: (v) => { out[o++] = v },
    u16: (v) => { dv.setUint16(o, v, true); o += 2 },
    u64: (v) => { dv.setBigUint64(o, BigInt(v), true); o += 8 },
    done: () => {
      if (o !== size) throw new SwapDecodeError(`wrote ${o} bytes, expected ${size}`)
      return out
    },
  }
}

/**
 * SWAP. `vaultIn` and `vaultOut` decide the direction; the pool itself is
 * symmetric and accepts its two vaults in either order.
 *
 * Returns { data, readWrite, readOnly } with the accounts already in the order
 * the indices were computed against. Submit them exactly as returned.
 */
export function buildSwapInstruction({
  registry, poolId, vaultIn, vaultOut, userIn, userOut, amountIn, minOut = 1n,
}) {
  const readWrite = sortAccounts([registry, vaultIn, vaultOut, userIn, userOut])
  const readOnly = [TOKEN_PROGRAM]
  const at = (a) => 2 + readWrite.indexOf(a)
  const tokenProgIdx = 2 + readWrite.length

  const w = writer(35)
  w.u8(OP_SWAP)
  w.u16(tokenProgIdx)
  w.u16(at(registry))
  w.u16(poolId)
  w.u16(at(vaultIn))
  w.u16(at(vaultOut))
  w.u16(at(userIn))
  w.u16(at(userOut))
  w.u16(0)          // lp_mint, unused by SWAP
  w.u16(0)          // user_lp, unused by SWAP
  w.u64(amountIn)
  w.u64(minOut)
  return { data: w.done(), readWrite, readOnly }
}

/**
 * SWAP, with the wrapping folded in.
 *
 * Pools hold tokens, so selling THRU means wrapping it into WTHRU first. That
 * was a signature of its own, and a wallet that approved the wrap and then
 * changed its mind at the swap was left holding WTHRU it never wanted. Both go
 * in one transaction now.
 *
 * Only this direction folds. Buying THRU ends in an unwrap, and the amount to
 * unwrap is whatever the swap actually returns, which is not known until it
 * runs; WITHDRAW takes an exact figure and treats 0 as "nothing" rather than
 * "everything", checked on chain. So that direction stays two steps.
 *
 * `payer` is needed because the wrap moves native THRU out of the fee payer,
 * and inside a bundle the payer is index 0 of a shared list.
 */
export function buildSwapPayingInThru({
  payer, program, registry, poolId, vaultIn, vaultOut, userIn, userOut, amountIn, minOut = 1n, wrap,
}) {
  const w = wrapSteps({ dest: userIn, amount: wrap })
  const swapAccounts = [registry, vaultIn, vaultOut, userIn, userOut]

  return buildMulticall({
    payer,
    readWrite: [...swapAccounts, ...w.readWrite],
    readOnly: [...w.readOnly, TOKEN_PROGRAM, WTHRU_MINT_ADDRESS],
    steps: [
      ...w.steps,
      {
        program,
        build: (at) => {
          const x = writer(35)
          x.u8(OP_SWAP)
          x.u16(at(TOKEN_PROGRAM))
          x.u16(at(registry))
          x.u16(poolId)
          x.u16(at(vaultIn))
          x.u16(at(vaultOut))
          x.u16(at(userIn))
          x.u16(at(userOut))
          x.u16(0)          // lp_mint, unused by SWAP
          x.u16(0)          // user_lp, unused by SWAP
          x.u64(amountIn)
          x.u64(minOut)
          return x.done()
        },
      },
    ],
  })
}

/** ADD LIQUIDITY. Both sides go in, LP tokens come back. */
export function buildAddLiquidityInstruction({
  registry, poolId, vaultA, vaultB, userA, userB, lpMint, userLp, amountA, amountB,
}) {
  const readWrite = sortAccounts([registry, vaultA, vaultB, userA, userB, lpMint, userLp])
  const readOnly = [TOKEN_PROGRAM]
  const at = (a) => 2 + readWrite.indexOf(a)

  const w = writer(35)
  w.u8(OP_ADD)
  w.u16(2 + readWrite.length)
  w.u16(at(registry))
  w.u16(poolId)
  w.u16(at(vaultA))
  w.u16(at(vaultB))
  w.u16(at(userA))
  w.u16(at(userB))
  w.u16(at(lpMint))
  w.u16(at(userLp))
  w.u64(amountA)
  w.u64(amountB)
  return { data: w.done(), readWrite, readOnly }
}

/** REMOVE LIQUIDITY. LP tokens are burned, both sides come back pro rata. */
export function buildRemoveLiquidityInstruction({
  registry, poolId, vaultA, vaultB, userA, userB, lpMint, userLp, lpAmount,
}) {
  const readWrite = sortAccounts([registry, vaultA, vaultB, userA, userB, lpMint, userLp])
  const readOnly = [TOKEN_PROGRAM]
  const at = (a) => 2 + readWrite.indexOf(a)

  const w = writer(35)
  w.u8(OP_REMOVE)
  w.u16(2 + readWrite.length)
  w.u16(at(registry))
  w.u16(poolId)
  w.u16(at(vaultA))
  w.u16(at(vaultB))
  w.u16(at(userA))
  w.u16(at(userB))
  w.u16(at(lpMint))
  w.u16(at(userLp))
  w.u64(lpAmount)
  w.u64(0)
  return { data: w.done(), readWrite, readOnly }
}

/** SET_CREATOR_FEE: the creator, as fee payer, sets the fee to 0..cap. */
export function buildSetCreatorFeeInstruction({ registry, poolId, creatorBps }) {
  const w = writer(7)
  w.u8(OP_SET_CREATOR_FEE)
  w.u16(2)          // the registry, the only read-write account
  w.u16(poolId)
  w.u16(creatorBps)
  return { data: w.done(), readWrite: [registry], readOnly: [] }
}

/** CLAIM_CREATOR_FEES: everything owed on both sides, to the creator's own
 *  token accounts `destA` (pool mint A) and `destB` (mint B). */
export function buildClaimCreatorFeesInstruction({ registry, poolId, vaultA, vaultB, destA, destB }) {
  const readWrite = sortAccounts([registry, vaultA, vaultB, destA, destB])
  const readOnly = [TOKEN_PROGRAM]
  const at = (a) => 2 + readWrite.indexOf(a)
  const w = writer(15)
  w.u8(OP_CLAIM_CREATOR_FEES)
  w.u16(2 + readWrite.length)
  w.u16(at(registry))
  w.u16(poolId)
  w.u16(at(vaultA))
  w.u16(at(vaultB))
  w.u16(at(destA))
  w.u16(at(destB))
  return { data: w.done(), readWrite, readOnly }
}

/** OPT_IN_CREATOR_FEE: a launch's creator gives the pool it graduated into a
 *  creator fee, once. thrupad's registry is read to prove who they are. */
export function buildOptInCreatorFeeInstruction({ registry, poolId, padRegistry, launchId, creatorBps }) {
  const readWrite = [registry]
  const readOnly = [padRegistry]
  const w = writer(11)
  w.u8(OP_OPT_IN_CREATOR_FEE)
  w.u16(2)
  w.u16(poolId)
  w.u16(3)
  w.u16(launchId)
  w.u16(creatorBps)
  return { data: w.done(), readWrite, readOnly }
}

/** EXTEND: append the creator fee table. Anyone; once. */
export function buildExtendInstruction({ registry }) {
  const w = writer(3)
  w.u8(OP_EXTEND)
  w.u16(2)
  return { data: w.done(), readWrite: [registry], readOnly: [] }
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
