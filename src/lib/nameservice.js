// src/lib/nameservice.js
//
// Decoder for Thru name service account data.
//
// The @thru/thru-sdk has no nameservice module, so ThruScan fetches the raw
// account via ctx.accounts.get() and decodes the base64 `data` field here.
//
// Layout below was recovered from the thru CLI binary (thru-linux-x64 0.3.1),
// which ships unstripped: thru_core::commands::name_service::
// parse_domain_account_data and parse_root_registrar_account_data.
// All integers are little endian. Structs are packed, no alignment padding.
//
// ---------------------------------------------------------------------------
// Root registrar account (kind = 1), fixed 109 bytes
//
//   off  size  field
//   0x00    1  kind = 1
//   0x01   32  authority pubkey
//   0x21   64  root name buffer (zero padded)
//   0x61    4  name_len (u32, 1..=64)
//   0x65    8  total_subdomains (u64)
//   ----      109 bytes total
//
// ---------------------------------------------------------------------------
// Domain account (kind = 2), 145 + 296 * record_count bytes
//
//   off  size  field
//   0x00    1  kind = 2
//   0x01   32  pubkey A  (parent registrar or parent domain)
//   0x21   32  pubkey B  (owner)
//   0x41   64  domain name buffer (zero padded)
//   0x81    4  name_len (u32, 1..=64)
//   0x85    8  registration_time (u64)
//   0x8d    4  record_count (u32)
//   ----      145 byte header
//
// then record_count records, each exactly 296 bytes:
//
//   off  size  field
//   0x00    4  key_len (u32, 1..=32)
//   0x04   32  key buffer (zero padded)
//   0x24    4  value_len (u32, 0..=256)
//   0x28  256  value buffer (zero padded)
//   ----      296 bytes total
//
// The CLI enforces: data.length === 145 + 296 * record_count exactly, so a
// mismatch means either a truncated response or a layout change upstream.
//
// VERIFIED 2026-07-31 against a live pg.greyy domain account (dataSize 1033,
// 3 records). Every field below matched `thru nameservice resolve --json`
// exactly, including the parent-then-owner ordering.

import { Pubkey } from '@thru/thru-sdk'

export const NS_KIND_ROOT_REGISTRAR = 1
export const NS_KIND_DOMAIN = 2

const REGISTRAR_SIZE = 0x6d // 109
const DOMAIN_HEADER_SIZE = 0x91 // 145
const RECORD_SIZE = 0x128 // 296

const NAME_FIELD_SIZE = 64
const RECORD_KEY_FIELD_SIZE = 32
const RECORD_VALUE_FIELD_SIZE = 256

const PARENT_OFFSET = 0x01
const OWNER_OFFSET = 0x21

export class NameServiceDecodeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NameServiceDecodeError'
  }
}

/** Decode a base64 string (standard alphabet, as returned by the RPC) to bytes. */
export function base64ToBytes(b64) {
  if (b64 instanceof Uint8Array) return b64
  if (!b64) throw new NameServiceDecodeError('account has no data to parse')
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function readPubkey(bytes, offset) {
  const raw = bytes.slice(offset, offset + 32)
  return Pubkey.from(raw).toThruFmt()
}

function readName(bytes, bufOffset, lenOffset) {
  const len = view(bytes).getUint32(lenOffset, true)
  if (len < 1 || len > NAME_FIELD_SIZE) {
    throw new NameServiceDecodeError(`domain name length ${len} out of range 1..64`)
  }
  return new TextDecoder().decode(bytes.slice(bufOffset, bufOffset + len))
}

/**
 * Best-effort rendering of a record value, mirroring the CLI's behaviour.
 * Values are opaque bytes on chain. thru.pubkey holds 32 raw bytes; most
 * other keys in practice hold UTF-8 text.
 */
export function renderRecordValue(key, valueBytes) {
  if (valueBytes.length === 0) return { kind: 'empty', display: '' }

  if (key === 'thru.pubkey' && valueBytes.length === 32) {
    return { kind: 'pubkey', display: Pubkey.from(valueBytes).toThruFmt() }
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(valueBytes)
    // eslint-disable-next-line no-control-regex
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
      return { kind: 'text', display: text }
    }
  } catch {
    // fall through to hex
  }

  const hex = Array.from(valueBytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return { kind: 'hex', display: `0x${hex}` }
}

function decodeRecord(bytes, base, index) {
  const dv = view(bytes)

  const keyLen = dv.getUint32(base + 0x00, true)
  if (keyLen < 1 || keyLen > RECORD_KEY_FIELD_SIZE) {
    throw new NameServiceDecodeError(`invalid key length ${keyLen} in record ${index}`)
  }
  const key = new TextDecoder().decode(bytes.slice(base + 0x04, base + 0x04 + keyLen))

  const valueLen = dv.getUint32(base + 0x24, true)
  if (valueLen > RECORD_VALUE_FIELD_SIZE) {
    throw new NameServiceDecodeError(`invalid value length ${valueLen} in record ${index}`)
  }
  const valueBytes = bytes.slice(base + 0x28, base + 0x28 + valueLen)

  return { key, valueBytes, ...renderRecordValue(key, valueBytes) }
}

/** Decode a domain account (kind 2). */
export function decodeDomainAccount(input) {
  const bytes = base64ToBytes(input)

  if (bytes.length < DOMAIN_HEADER_SIZE) {
    throw new NameServiceDecodeError('account data too small to be a domain account')
  }
  if (bytes[0] !== NS_KIND_DOMAIN) {
    throw new NameServiceDecodeError(
      `expected domain account (kind=${NS_KIND_DOMAIN}), got kind=${bytes[0]}`
    )
  }

  const dv = view(bytes)
  const recordCount = dv.getUint32(0x8d, true)
  const expected = DOMAIN_HEADER_SIZE + recordCount * RECORD_SIZE
  if (bytes.length !== expected) {
    throw new NameServiceDecodeError(
      `unexpected domain account size: expected ${expected}, got ${bytes.length}`
    )
  }

  const records = []
  for (let i = 0; i < recordCount; i++) {
    records.push(decodeRecord(bytes, DOMAIN_HEADER_SIZE + i * RECORD_SIZE, i))
  }

  return {
    kind: NS_KIND_DOMAIN,
    kindLabel: 'domain',
    domainName: readName(bytes, 0x41, 0x81),
    parent: readPubkey(bytes, PARENT_OFFSET),
    owner: readPubkey(bytes, OWNER_OFFSET),
    // Nanoseconds since the Unix epoch. Confirmed: 1785534866106789144
    // decodes to 2026-07-31. Use registrationDate() for a JS Date.
    registrationTime: dv.getBigUint64(0x85, true),
    recordCount,
    records,
  }
}

/** Decode a root registrar account (kind 1). */
export function decodeRootRegistrar(input) {
  const bytes = base64ToBytes(input)

  if (bytes.length < REGISTRAR_SIZE) {
    throw new NameServiceDecodeError('account data too small to be a root registrar account')
  }
  if (bytes[0] !== NS_KIND_ROOT_REGISTRAR) {
    throw new NameServiceDecodeError(
      `expected root registrar account (kind=${NS_KIND_ROOT_REGISTRAR}), got kind=${bytes[0]}`
    )
  }

  const dv = view(bytes)
  return {
    kind: NS_KIND_ROOT_REGISTRAR,
    kindLabel: 'root-registrar',
    rootName: readName(bytes, 0x21, 0x61),
    authority: readPubkey(bytes, 0x01),
    totalSubdomains: dv.getBigUint64(0x65, true),
  }
}

/**
 * Decode either kind. Use this when the user pastes an address and ThruScan
 * does not yet know whether it is a registrar or a domain.
 */
export function decodeNameServiceAccount(input) {
  const bytes = base64ToBytes(input)
  switch (bytes[0]) {
    case NS_KIND_ROOT_REGISTRAR:
      return decodeRootRegistrar(bytes)
    case NS_KIND_DOMAIN:
      return decodeDomainAccount(bytes)
    default:
      throw new NameServiceDecodeError('account is not a recognized name service account')
  }
}

/**
 * registrationTime is nanoseconds since the Unix epoch, which overflows the
 * safe integer range. Divide down to milliseconds before building a Date.
 */
export function registrationDate(domain) {
  if (domain?.registrationTime == null) return null
  return new Date(Number(domain.registrationTime / 1000000n))
}

/** Convenience: pull one record value by key, like `resolve --key <KEY>`. */
export function getRecord(domain, key) {
  return domain.records.find((r) => r.key === key) ?? null
}
