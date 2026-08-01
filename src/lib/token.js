// src/lib/token.js
//
// Decoder for Thru token program accounts (mints and token accounts).
//
// Layouts below come from the ABI definition embedded in the thru CLI binary
// (thru-linux-x64 0.3.2), under TokenProgramAccount. That union discriminates
// its variants BY SIZE, not by a leading kind byte, which is why there is no
// discriminator field here the way there is in nameservice.js:
//
//     token_account   expected-size: 73
//     mint_account    expected-size: 115
//
// All structs are packed with no alignment padding. Integers little endian.
//
// ---------------------------------------------------------------------------
// MintAccount, exactly 115 bytes
//
//   off  size  field
//   0x00    1  decimals (u8)
//   0x01    8  supply (u64, base units)
//   0x09   32  creator pubkey
//   0x29   32  mint_authority pubkey
//   0x49   32  freeze_authority pubkey
//   0x69    1  has_freeze_authority (u8) — freeze_authority is meaningless if 0
//   0x6a    1  ticker length (u8, max 8)
//   0x6b    8  ticker bytes (zero padded)
//   ----      115 bytes total
//
// ---------------------------------------------------------------------------
// TokenAccount, exactly 73 bytes
//
//   off  size  field
//   0x00   32  mint pubkey
//   0x20   32  owner pubkey
//   0x40    8  amount (u64, base units)
//   0x48    1  is_frozen (u8)
//   ----      73 bytes total

import { Pubkey } from '@thru/thru-sdk'

export const MINT_ACCOUNT_SIZE = 115
export const TOKEN_ACCOUNT_SIZE = 73

/**
 * Size alone is NOT enough to identify these accounts. A managed program's
 * meta account is also exactly 73 bytes, so decoding purely by length would
 * render a deployed program as a token balance.
 *
 * Every Thru system program has an address of the form ta + A-padding + a
 * short tag. The token program ends in Kqq; the program manager ends in QE.
 * Matching the shape rather than a hardcoded 46-character literal avoids
 * transcription mistakes in an address that is almost entirely repeated As.
 */
export function isTokenProgram(owner) {
  return typeof owner === 'string' && /^taA+Kqq$/.test(owner)
}

export class TokenDecodeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TokenDecodeError'
  }
}

function base64ToBytes(b64) {
  if (b64 instanceof Uint8Array) return b64
  if (!b64) throw new TokenDecodeError('account has no data to parse')
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function readPubkey(bytes, offset) {
  return Pubkey.from(bytes.slice(offset, offset + 32)).toThruFmt()
}

/**
 * Render a base-unit amount using the mint's decimals.
 * Supply is a u64, so it arrives as a BigInt and must not be coerced to Number
 * before scaling — a large supply would lose precision.
 */
export function formatAmount(baseUnits, decimals) {
  const raw = BigInt(baseUnits)
  if (!decimals) return raw.toLocaleString()

  const scale = 10n ** BigInt(decimals)
  const whole = raw / scale
  const frac = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${whole.toLocaleString()}.${frac}` : whole.toLocaleString()
}

/** Decode a mint account (115 bytes). */
export function decodeMintAccount(input) {
  const bytes = base64ToBytes(input)
  if (bytes.length !== MINT_ACCOUNT_SIZE) {
    throw new TokenDecodeError(`not a mint account: expected ${MINT_ACCOUNT_SIZE} bytes, got ${bytes.length}`)
  }

  const dv = view(bytes)
  const decimals = bytes[0]
  const supply = dv.getBigUint64(0x01, true)
  const hasFreeze = bytes[0x69] !== 0

  const tickerLen = bytes[0x6a]
  if (tickerLen > 8) throw new TokenDecodeError(`invalid ticker length ${tickerLen}`)
  const ticker = new TextDecoder().decode(bytes.slice(0x6b, 0x6b + tickerLen))

  return {
    kindLabel: 'mint',
    ticker,
    decimals,
    supply,
    supplyDisplay: formatAmount(supply, decimals),
    creator: readPubkey(bytes, 0x09),
    mintAuthority: readPubkey(bytes, 0x29),
    // Only meaningful when hasFreezeAuthority is true. The field still holds
    // bytes when unset, so surfacing it unconditionally would be misleading.
    hasFreezeAuthority: hasFreeze,
    freezeAuthority: hasFreeze ? readPubkey(bytes, 0x49) : null,
  }
}

/** Decode a token account (73 bytes). */
export function decodeTokenAccount(input) {
  const bytes = base64ToBytes(input)
  if (bytes.length !== TOKEN_ACCOUNT_SIZE) {
    throw new TokenDecodeError(`not a token account: expected ${TOKEN_ACCOUNT_SIZE} bytes, got ${bytes.length}`)
  }

  const dv = view(bytes)
  return {
    kindLabel: 'token-account',
    mint: readPubkey(bytes, 0x00),
    owner: readPubkey(bytes, 0x20),
    amount: dv.getBigUint64(0x40, true),
    isFrozen: bytes[0x48] !== 0,
  }
}

/**
 * Decode whichever token program account this is.
 * Requires the account's owner program, and returns null rather than throwing
 * when the account does not belong to the token program or the size matches
 * neither variant.
 */
export function decodeTokenProgramAccount(input, owner) {
  // Owner is required. Callers that cannot supply it get nothing back, since
  // a size-only match produces false positives on program meta accounts.
  if (!isTokenProgram(owner)) return null

  let bytes
  try {
    bytes = base64ToBytes(input)
  } catch {
    return null
  }

  if (bytes.length === MINT_ACCOUNT_SIZE) return decodeMintAccount(bytes)
  if (bytes.length === TOKEN_ACCOUNT_SIZE) return decodeTokenAccount(bytes)
  return null
}
