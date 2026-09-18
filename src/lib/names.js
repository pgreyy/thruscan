// src/lib/names.js
//
// ThruNames: human names for Thru accounts, on Thru's own name service.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT OUR OWN PROGRAM
//
// Thru ships a name service as a built-in program, with roots, subdomains,
// owners and arbitrary key/value records on a domain. Writing a second one
// would mean names that only mean something inside ThruScan. Building on theirs
// means `alice.id` is a fact about the chain that any other explorer, wallet or
// program can read, and it keeps working if ThruScan does not.
//
// We do not own `.thru`. Its root authority is Unto Labs', and both
// registrar initialisation and direct registration under it are refused, which
// is correct: it is theirs. So we claimed a root of our own, and the suffix is
// `.id`. Shorter, and ours to run.
//
// ---------------------------------------------------------------------------
// HOW REGISTRATION CAN BE FREE AND STILL YOURS
//
// A Thru transaction carries exactly one signature, the fee payer's. Registering
// under a root needs that root's authority, which is ThruScan. So ThruScan has
// to be the fee payer, and a naive design would leave every name owned by
// ThruScan.
//
// The instruction takes an owner as an ACCOUNT INDEX rather than implying the
// fee payer, so the owner can be any account named in the transaction. The
// sponsor signs as the root's authority, pays, and writes the visitor's wallet
// into the owner field. Verified on chain: grace.id is owned by a browser
// wallet that never signed anything.
//
// ---------------------------------------------------------------------------
// THE ABI, RECOVERED FROM LIVE TRANSACTIONS
//
// None of this is documented. Every layout below was read out of transactions
// the CLI produced, then confirmed by building the same instruction by hand and
// watching it land. The one that cost the most time: the name field is 64 bytes,
// not 32, and a 32-byte guess reverts with no user error code at all.
//
//   INIT_ROOT         [u32 0][u16 registrar][u16 pad][64 name][u64 len][proof]
//   REGISTER_SUBDOMAIN[u32 1][u16 domain][u16 parent][u16 owner][u16 authority]
//                     [64 name][u64 len][proof]
//   APPEND_RECORD     [u32 2][u16 domain][u16 authority][u32 key_len][32 key]
//                     [u32 value_len][256 value]
//
// Domain accounts are at a fixed address, so a name can be looked up without an
// index:
//
//   domain = deriveProgramAddress(NAME_SERVICE, sha256(parent || nameBytes))
//
// Note the raw name bytes there, NOT the padded 64. Confirmed against the CLI's
// derive-domain-account on names it had already created.

import { Pubkey, deriveProgramAddress } from '@thru/sdk'

export const NAME_SERVICE_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUF'

/** Our root. Every name registered through ThruScan is a child of this. */
export const ROOT_REGISTRAR = 'taGEX4QNK_WjsknEK4kl0_ppCJUimoanrmFuU27t1gS3pw'
export const ROOT_SUFFIX = 'id'

export const OP_INIT_ROOT = 0
export const OP_REGISTER = 1
export const OP_APPEND_RECORD = 2

export const NAME_FIELD = 64
export const KEY_FIELD = 32
export const VALUE_FIELD = 256

/** version + parent + owner + name + name_len + registered_at */
export const DOMAIN_HEADER = 1 + 32 + 32 + NAME_FIELD + 8 + 8   // 145
export const RECORD_SIZE = 4 + KEY_FIELD + 4 + VALUE_FIELD      // 296

/* ---------- names ---------- */

/**
 * What counts as a name.
 *
 * Lowercase letters, digits and hyphens, not starting or ending with one. The
 * restriction is the point: without it, `alice` and `Alice` and `alicе` with a
 * Cyrillic e are three names that look identical to a reader, and a name that
 * can be impersonated is worse than no name.
 */
export function nameProblem(name) {
  const n = String(name ?? '')
  if (n.length < 3) return 'Names are at least 3 characters.'
  if (n.length > 32) return 'Names are at most 32 characters.'
  if (n !== n.toLowerCase()) return 'Names are lowercase.'
  if (!/^[a-z0-9-]+$/.test(n)) return 'Letters, numbers and hyphens only.'
  if (n.startsWith('-') || n.endsWith('-')) return 'Names cannot start or end with a hyphen.'
  if (n.includes('--')) return 'No double hyphens.'
  return null
}

export const withSuffix = (name) => `${name}.${ROOT_SUFFIX}`

const enc = new TextEncoder()
const dec = new TextDecoder()

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

/** Where a name lives, without asking anybody. */
export async function domainAccount(name, parent = ROOT_REGISTRAR) {
  const digest = await sha256(concat(Pubkey.from(parent).toBytes(), enc.encode(name)))
  return deriveProgramAddress({ programAddress: NAME_SERVICE_PROGRAM, seed: digest }).address
}

/* ---------- reading ---------- */

function readString(bytes, at, len) {
  return dec.decode(bytes.subarray(at, at + Number(len))).replace(/\0+$/, '')
}

/**
 * Decode a domain account.
 *
 *   [0]        version
 *   [1..32]    parent registrar
 *   [33..64]   owner
 *   [65..128]  name, null padded to 64
 *   [129..136] name length
 *   [137..144] registered at
 *   then zero or more 296-byte records
 *
 * There is no record count in the header, because there does not need to be
 * one: the account is exactly 145 + 296n bytes long.
 */
export function decodeDomain(bytes) {
  if (!bytes || bytes.length < DOMAIN_HEADER) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const nameLen = dv.getBigUint64(129, true)
  const domain = {
    version: bytes[0],
    parent: Pubkey.from(bytes.slice(1, 33)).toThruFmt(),
    owner: Pubkey.from(bytes.slice(33, 65)).toThruFmt(),
    name: readString(bytes, 65, nameLen),
    registeredAt: dv.getBigUint64(137, true),
    records: [],
  }

  const count = Math.floor((bytes.length - DOMAIN_HEADER) / RECORD_SIZE)
  for (let i = 0; i < count; i++) {
    const at = DOMAIN_HEADER + i * RECORD_SIZE
    const keyLen = dv.getUint32(at, true)
    const valueLen = dv.getUint32(at + 4 + KEY_FIELD, true)
    domain.records.push({
      key: readString(bytes, at + 4, keyLen),
      value: readString(bytes, at + 4 + KEY_FIELD + 4, valueLen),
    })
  }
  return domain
}

/** The record a wallet cares about. Everything else is extra. */
export const ADDRESS_KEY = 'addr'

export function addressOf(domain) {
  return domain?.records?.find((r) => r.key === ADDRESS_KEY)?.value ?? domain?.owner ?? null
}

/* ---------- writing ---------- */

function nameField(name) {
  const out = new Uint8Array(NAME_FIELD)
  const raw = enc.encode(name)
  if (raw.length > NAME_FIELD) throw new Error('Name too long.')
  out.set(raw)
  return out
}

/**
 * REGISTER_SUBDOMAIN.
 *
 * `indexOf` maps an address to its index in the transaction, which the caller
 * knows because it decides the account lists. Index 0 is the fee payer, which
 * is also the root's authority, so `authority` is 0 and the owner is whoever
 * the caller names.
 */
export function buildRegisterInstruction({ name, domain, parent, owner, indexOf, proof }) {
  const head = new Uint8Array(84)
  const dv = new DataView(head.buffer)
  dv.setUint32(0, OP_REGISTER, true)
  dv.setUint16(4, indexOf(domain), true)
  dv.setUint16(6, indexOf(parent), true)
  dv.setUint16(8, owner ? indexOf(owner) : 0, true)
  dv.setUint16(10, 0, true)              // authority: the fee payer
  head.set(nameField(name), 12)
  dv.setBigUint64(76, BigInt(enc.encode(name).length), true)
  return concat(head, proof)
}

/** APPEND_RECORD. No proof: the domain account already exists. */
export function buildRecordInstruction({ domain, key, value, indexOf }) {
  // op + domain/authority + key_len + key + value_len + value
  const out = new Uint8Array(4 + 4 + 4 + KEY_FIELD + 4 + VALUE_FIELD)
  const dv = new DataView(out.buffer)
  const keyBytes = enc.encode(key)
  const valueBytes = enc.encode(value)
  if (keyBytes.length > KEY_FIELD) throw new Error('Record key is too long.')
  if (valueBytes.length > VALUE_FIELD) throw new Error('Record value is too long.')

  dv.setUint32(0, OP_APPEND_RECORD, true)
  dv.setUint16(4, indexOf(domain), true)
  dv.setUint16(6, 0, true)               // authority: the fee payer
  dv.setUint32(8, keyBytes.length, true)
  out.set(keyBytes, 12)
  dv.setUint32(12 + KEY_FIELD, valueBytes.length, true)
  out.set(valueBytes, 12 + KEY_FIELD + 4)
  return out
}
