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

export const SWAP_VERSION = 1
export const HEADER_SIZE = 37
export const POOL_SIZE = 179

export const TOKEN_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq'

export const OP_INIT = 0x00
export const OP_CREATE = 0x01
export const OP_ADD = 0x02
export const OP_REMOVE = 0x03
export const OP_SWAP = 0x04

export const BPS_DENOM = 10000n

export class SwapDecodeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SwapDecodeError'
  }
}

/** Capacity is whatever INIT allocated, so read it off the account's size. */
export function poolCapacity(byteLength) {
  if (byteLength < HEADER_SIZE + POOL_SIZE) return 0
  return Math.floor((byteLength - HEADER_SIZE) / POOL_SIZE)
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
  const slots = poolCapacity(bytes.length)
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
    })
  }

  return {
    version: bytes[0],
    poolCount: dv.getUint32(0x01, true),
    sponsor: readPubkey(bytes, 0x05),
    capacity: slots,
    pools,
  }
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
export function quoteSwap({ reserveIn, reserveOut, amountIn, feeBps = 30 }) {
  const rIn = BigInt(reserveIn)
  const rOut = BigInt(reserveOut)
  const aIn = BigInt(amountIn)
  const fee = BigInt(feeBps)

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

  return { amountOut, priceImpactBps: impact, reason: null }
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

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
