// src/lib/pad.js
//
// Decoder and instruction builder for thrupad, the launchpad. Written alongside
// the program in thrupad.c, so the two must be kept in step. If you change a
// field size in the C, change it here in the same commit.
//
// ---------------------------------------------------------------------------
// Registry header, 77 bytes
//
//   off  size  field
//   0x00    1  version (currently 1)
//   0x01    4  launch_count (u32)
//   0x05   32  sponsor pubkey
//   0x25   32  quote_mint — what every launch is priced in
//   0x45    8  grad_threshold (u64) — quote raised before the curve freezes
//
// Then launch records of 253 bytes each (v2; v1 records were 221, before the
// quote mint moved out of the header and onto each launch):
//
//   off  size  field
//   0x00    1  state (0 empty, 1 live, 2 graduated)
//   0x01    2  fee_bps (u16) — the creator's cut, capped at 1000
//   0x03    1  name_len
//   0x04   32  name
//   0x24    1  symbol_len
//   0x25    8  symbol
//   0x2d   32  creator
//   0x4d   32  mint
//   0x6d   32  token_vault  — the curve's own tokens
//   0x8d   32  quote_vault  — what buyers have paid in
//   0xad    8  vq (u64) — virtual quote reserve
//   0xb5    8  vt (u64) — virtual token reserve
//   0xbd    8  creator_fees (u64) — accrued, sitting in the quote vault
//   0xc5    8  tokens_sold (u64)
//   0xcd    8  trade_count (u64)
//   0xd5    8  start_slot (u64) — when the anti-snipe window opened
//
// The reserves are VIRTUAL. A pure constant product seeded with real tokens and
// no quote opens at a price of zero, so the curve is seeded with an imaginary
// quote balance instead. That is what gives a launch an opening price and what
// leaves tokens on the curve at graduation to seed a pool with.

import { Pubkey } from '@thru/sdk'

// v2 moved the quote mint out of the header and onto each launch, which grew a
// launch record from 221 bytes to 253. The two are not interchangeable, so the
// version byte is checked rather than assumed.
export const PAD_VERSION = 2
export const HEADER_SIZE = 77
export const LAUNCH_SIZE = 253

export const TOKEN_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq'

export const OP_INIT = 0x00
export const OP_LAUNCH = 0x01
export const OP_BUY = 0x02
export const OP_SELL = 0x03
export const OP_CLAIM = 0x04
export const OP_GRADUATE = 0x05

export const STATE_EMPTY = 0
export const STATE_LIVE = 1
export const STATE_GRADUATED = 2

export const NAME_MAX = 32
export const SYMBOL_MAX = 8
export const CREATOR_BPS_MAX = 1000  // 10%, the same ceiling Pons uses

// The anti-snipe tax opens here and decays to nothing across this many slots.
// It is paid to NOBODY: it stays in the vault backing the curve. Paying it to
// the creator would give every creator a reason to snipe their own launch.
export const SNIPE_BPS_START = 9000n
export const SNIPE_SLOTS = 25n

export const BPS_DENOM = 10000n

export class PadDecodeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PadDecodeError'
  }
}

export function launchCapacity(byteLength) {
  if (byteLength < HEADER_SIZE + LAUNCH_SIZE) return 0
  return Math.floor((byteLength - HEADER_SIZE) / LAUNCH_SIZE)
}

function base64ToBytes(b64) {
  if (b64 instanceof Uint8Array) return b64
  if (!b64) throw new PadDecodeError('registry account has no data')
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const decoder = new TextDecoder()

function readText(bytes, offset, len, max) {
  if (len > max) throw new PadDecodeError(`field length ${len} exceeds ${max}`)
  return decoder.decode(bytes.slice(offset, offset + len))
}

function readPubkey(bytes, offset) {
  return Pubkey.from(bytes.slice(offset, offset + 32)).toThruFmt()
}

/**
 * Decode the launch registry.
 *
 * Returns { version, launchCount, sponsor, quoteMint, gradThreshold, capacity,
 * launches }, carrying only slots in use. Newest first, since a launchpad is
 * read as a feed.
 */
export function decodePadRegistry(input) {
  const bytes = base64ToBytes(input)

  if (bytes.length < HEADER_SIZE) {
    throw new PadDecodeError('account is too small to be a launch registry')
  }
  if (bytes[0] !== PAD_VERSION) {
    throw new PadDecodeError(`unknown registry version ${bytes[0]}`)
  }
  const slots = launchCapacity(bytes.length)
  if (slots === 0) {
    throw new PadDecodeError(`registry is too small at ${bytes.length} bytes`)
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const launches = []

  for (let i = 0; i < slots; i++) {
    const base = HEADER_SIZE + i * LAUNCH_SIZE
    const state = bytes[base]
    if (state === STATE_EMPTY) continue

    launches.push({
      id: i,
      state,
      graduated: state === STATE_GRADUATED,
      feeBps: dv.getUint16(base + 0x01, true),
      name: readText(bytes, base + 0x04, bytes[base + 0x03], NAME_MAX),
      symbol: readText(bytes, base + 0x25, bytes[base + 0x24], SYMBOL_MAX),
      creator: readPubkey(bytes, base + 0x2d),
      mint: readPubkey(bytes, base + 0x4d),
      tokenVault: readPubkey(bytes, base + 0x6d),
      quoteVault: readPubkey(bytes, base + 0x8d),
      // v2: each launch names its own quote asset, so one pad can price some
      // curves in tUSD and others in WTHRU. It sits immediately after the quote
      // vault in the C struct, which pushes every number below it along by 32
      // bytes. Getting this wrong decodes a pubkey as a reserve and prices the
      // curve off nonsense, so the offsets are spelled out rather than derived.
      quoteMint: readPubkey(bytes, base + 0xad),
      vq: dv.getBigUint64(base + 0xcd, true),
      vt: dv.getBigUint64(base + 0xd5, true),
      creatorFees: dv.getBigUint64(base + 0xdd, true),
      tokensSold: dv.getBigUint64(base + 0xe5, true),
      tradeCount: dv.getBigUint64(base + 0xed, true),
      startSlot: dv.getBigUint64(base + 0xf5, true),
    })
  }

  launches.sort((a, b) => b.id - a.id)

  return {
    version: bytes[0],
    launchCount: dv.getUint32(0x01, true),
    sponsor: readPubkey(bytes, 0x05),
    quoteMint: readPubkey(bytes, 0x25),
    gradThreshold: dv.getBigUint64(0x45, true),
    capacity: slots,
    launches,
  }
}

// ---------------------------------------------------------------- pricing

/** The tax a buy pays right now, in basis points. Zero once the window closes. */
export function snipeBps(startSlot, currentSlot) {
  const start = BigInt(startSlot)
  const now = BigInt(currentSlot)
  if (now <= start) return SNIPE_BPS_START
  const elapsed = now - start
  if (elapsed >= SNIPE_SLOTS) return 0n
  return SNIPE_BPS_START - (SNIPE_BPS_START * elapsed) / SNIPE_SLOTS
}

/**
 * What a buy returns, computed exactly as the program does so the number shown
 * before signing is the number that lands.
 */
export function quoteBuy({ vq, vt, amountIn, feeBps, startSlot, currentSlot }) {
  const q = BigInt(vq)
  const t = BigInt(vt)
  const aIn = BigInt(amountIn)
  if (aIn <= 0n) return { tokensOut: 0n, creatorFee: 0n, snipeTax: 0n, reason: 'zero input' }

  const creatorFee = (aIn * BigInt(feeBps)) / BPS_DENOM
  const tax = currentSlot == null ? 0n : (aIn * snipeBps(startSlot, currentSlot)) / BPS_DENOM
  if (creatorFee + tax >= aIn) {
    return { tokensOut: 0n, creatorFee, snipeTax: tax, reason: 'fees exceed the amount' }
  }

  const net = aIn - creatorFee - tax
  const newVq = q + net
  const newVt = (q * t) / newVq
  if (newVt >= t) return { tokensOut: 0n, creatorFee, snipeTax: tax, reason: 'amount too small' }

  return { tokensOut: t - newVt, creatorFee, snipeTax: tax, reason: null }
}

/** What a sell returns, net of the creator's cut. No snipe tax on selling. */
export function quoteSell({ vq, vt, amountIn, feeBps }) {
  const q = BigInt(vq)
  const t = BigInt(vt)
  const aIn = BigInt(amountIn)
  if (aIn <= 0n) return { quoteOut: 0n, creatorFee: 0n, reason: 'zero input' }

  const newVt = t + aIn
  const newVq = (q * t) / newVt
  if (newVq >= q) return { quoteOut: 0n, creatorFee: 0n, reason: 'amount too small' }

  const gross = q - newVq
  const creatorFee = (gross * BigInt(feeBps)) / BPS_DENOM
  if (creatorFee >= gross) return { quoteOut: 0n, creatorFee, reason: 'amount too small' }

  return { quoteOut: gross - creatorFee, creatorFee, reason: null }
}

/**
 * Current price along the curve, in quote base units per token base unit.
 * With both sides at the same decimals this is directly the price of one token
 * in one quote unit, which is the usual case since tUSD and launches are both
 * six decimals.
 */
export function launchPrice(launch) {
  const q = Number(launch.vq)
  const t = Number(launch.vt)
  if (!t) return 0
  return q / t
}

/** How far along the curve a launch is, 0 to 1, against the graduation bar. */
export function graduationProgress(raised, threshold) {
  const r = Number(raised)
  const t = Number(threshold)
  if (!t) return 0
  return Math.min(1, r / t)
}

// ------------------------------------------------------- account ordering

// Thru sorts accounts ascending by raw pubkey bytes and instruction indices
// refer to that order. A string sort does NOT match, because the base64
// alphabet orders differently from the bytes it encodes.
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
    bytes: (b) => { out.set(b, o); o += b.length },
    done: () => {
      if (o !== size) throw new PadDecodeError(`wrote ${o} bytes, expected ${size}`)
      return out
    },
  }
}

function tradeInstruction(op, { registry, launchId, tokenVault, quoteVault, userToken, userQuote, amountIn, minOut = 1n }) {
  const readWrite = sortAccounts([registry, tokenVault, quoteVault, userToken, userQuote])
  const readOnly = [TOKEN_PROGRAM]
  const at = (a) => 2 + readWrite.indexOf(a)

  const w = writer(31)
  w.u8(op)
  w.u16(2 + readWrite.length)
  w.u16(at(registry))
  w.u16(launchId)
  w.u16(at(tokenVault))
  w.u16(at(quoteVault))
  w.u16(at(userToken))
  w.u16(at(userQuote))
  w.u64(amountIn)
  w.u64(minOut)
  return { data: w.done(), readWrite, readOnly }
}

export function buildBuyInstruction(args) { return tradeInstruction(OP_BUY, args) }
export function buildSellInstruction(args) { return tradeInstruction(OP_SELL, args) }

/**
 * LAUNCH. The mint's authority must already be the program, which is what makes
 * the supply fixed: there is no second instruction that mints.
 */
export function buildLaunchInstruction({
  registry, launchId, mint, tokenVault, quoteVault, quoteMint,
  feeBps, supply, virtQuote, name, symbol,
}) {
  const enc = new TextEncoder()
  const nameBytes = enc.encode(name.trim())
  const symBytes = enc.encode(symbol.trim().toUpperCase())

  if (nameBytes.length === 0 || nameBytes.length > NAME_MAX) throw new PadDecodeError('name must be 1 to 32 bytes')
  if (symBytes.length === 0 || symBytes.length > SYMBOL_MAX) throw new PadDecodeError('symbol must be 1 to 8 bytes')
  if (feeBps > CREATOR_BPS_MAX) throw new PadDecodeError('creator fee is capped at 10%')

  // The mint's supply changes and the token vault receives, so both are written.
  // The quote vault is only validated, so it stays read-only.
  const readWrite = sortAccounts([registry, mint, tokenVault])
  // The quote mint is read so the program can check the quote vault really
  // holds it. Passing no quote mint means "use the registry default", which the
  // program reads as index 0.
  const readOnly = sortAccounts(
    quoteMint ? [quoteVault, quoteMint, TOKEN_PROGRAM] : [quoteVault, TOKEN_PROGRAM],
  )
  const at = (a) => 2 + readWrite.indexOf(a)
  const atRo = (a) => 2 + readWrite.length + readOnly.indexOf(a)

  // 35 = the packed struct launch_args in thrupad2.c:
  //   u8 op + 8 u16 (token prog, registry, launch id, mint, token vault,
  //   quote vault, quote mint, fee bps) + u64 supply + u64 virt quote
  //   + u8 name_len + u8 symbol_len.
  // v1 was 33 and this was allocated as 32, which is a bug that never fired
  // because every launch so far was built by the deploy script rather than
  // here. It would have fired the first time someone used the Create card.
  const w = writer(35 + nameBytes.length + symBytes.length)
  w.u8(OP_LAUNCH)
  w.u16(atRo(TOKEN_PROGRAM))
  w.u16(at(registry))
  w.u16(launchId)
  w.u16(at(mint))
  w.u16(at(tokenVault))
  w.u16(atRo(quoteVault))
  w.u16(quoteMint ? atRo(quoteMint) : 0)
  w.u16(feeBps)
  w.u64(supply)
  w.u64(virtQuote)
  w.u8(nameBytes.length)
  w.u8(symBytes.length)
  w.bytes(nameBytes)
  w.bytes(symBytes)
  return { data: w.done(), readWrite, readOnly }
}

/**
 * CLAIM. Anyone may call it; the program checks the destination really is owned
 * by the recorded creator, so a third party paying the fee is a convenience
 * rather than a hole.
 */
export function buildClaimInstruction({ registry, launchId, quoteVault, dest }) {
  const readWrite = sortAccounts([registry, quoteVault, dest])
  const readOnly = [TOKEN_PROGRAM]
  const at = (a) => 2 + readWrite.indexOf(a)

  const w = writer(11)
  w.u8(OP_CLAIM)
  w.u16(2 + readWrite.length)
  w.u16(at(registry))
  w.u16(launchId)
  w.u16(at(quoteVault))
  w.u16(at(dest))
  return { data: w.done(), readWrite, readOnly }
}

/** GRADUATE. Freezes the curve once enough real quote has been raised. */
export function buildGraduateInstruction({ registry, launchId, quoteVault }) {
  const readWrite = sortAccounts([registry, quoteVault])
  const at = (a) => 2 + readWrite.indexOf(a)

  const w = writer(7)
  w.u8(OP_GRADUATE)
  w.u16(at(registry))
  w.u16(launchId)
  w.u16(at(quoteVault))
  return { data: w.done(), readWrite, readOnly: [] }
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
