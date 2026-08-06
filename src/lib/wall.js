// src/lib/wall.js
//
// Decoder for the ThruWall account, written alongside the program in
// thruwall.c rather than reverse-engineered, so the two must be kept in step.
// If you change a field size in the C, change it here in the same commit.
//
// ---------------------------------------------------------------------------
// Header, 41 bytes
//
//   off  size  field
//   0x00    1  version (currently 1)
//   0x01    4  next_idx (u32) — slot the next message goes into
//   0x05    4  total_posted (u32) — every message ever, including overwritten
//   0x09   32  sponsor pubkey — whoever ran INIT; posts from this key are sponsored
//
// Then 128 slots of 260 bytes each:
//
//   off  size  field
//   0x00    1  name_len
//   0x01   24  name
//   0x19    1  handle_len
//   0x1a   16  handle
//   0x2a    1  msg_len
//   0x2b  176  message
//   0xdb    8  posted_at (u64, nanoseconds since the Unix epoch)
//   0xe3   32  poster pubkey — the transaction's fee payer, proven not typed
//   0x103   1  verified (1 when the poster is not the sponsor)
//
// Total account size is 41 + slots * 260. The slot count is chosen when INIT
// runs rather than fixed here, because the chain caps how large an account can
// be and that limit is not documented. The decoder works it out from the
// account's own length.

import { Pubkey } from '@thru/thru-sdk'

export const WALL_VERSION = 1
export const HEADER_SIZE = 41
export const SLOT_SIZE = 260

/** Capacity is whatever INIT allocated, so read it off the account's size. */
export function wallCapacity(byteLength) {
  if (byteLength < HEADER_SIZE + SLOT_SIZE) return 0
  return Math.floor((byteLength - HEADER_SIZE) / SLOT_SIZE)
}

// Character limits the form enforces. The on-chain fields are larger in bytes
// because one emoji can take four bytes in UTF-8, so a message that fits the
// character limit always fits the byte field.
export const NAME_CHARS = 24
export const HANDLE_CHARS = 15
export const MESSAGE_CHARS = 140

const NAME_BYTES = 24
const HANDLE_BYTES = 16
const MESSAGE_BYTES = 176

export class WallDecodeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WallDecodeError'
  }
}

function base64ToBytes(b64) {
  if (b64 instanceof Uint8Array) return b64
  if (!b64) throw new WallDecodeError('wall account has no data')
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const decoder = new TextDecoder()

function readText(bytes, offset, len, max) {
  if (len > max) throw new WallDecodeError(`field length ${len} exceeds ${max}`)
  return decoder.decode(bytes.slice(offset, offset + len))
}

function readPubkey(bytes, offset) {
  return Pubkey.from(bytes.slice(offset, offset + 32)).toThruFmt()
}

/**
 * Decode the whole wall.
 *
 * Returns { version, nextIndex, totalPosted, sponsor, entries }, where entries
 * are newest first. Empty slots are skipped, so a wall with three messages
 * returns three entries rather than 128 mostly-blank ones.
 */
export function decodeWall(input) {
  const bytes = base64ToBytes(input)

  if (bytes.length < HEADER_SIZE) {
    throw new WallDecodeError('account is too small to be a wall')
  }
  if (bytes[0] !== WALL_VERSION) {
    throw new WallDecodeError(`unknown wall version ${bytes[0]}`)
  }
  const slots = wallCapacity(bytes.length)
  if (slots === 0) {
    throw new WallDecodeError(`wall account is too small at ${bytes.length} bytes`)
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sponsor = readPubkey(bytes, 0x09)

  const entries = []
  for (let i = 0; i < slots; i++) {
    const base = HEADER_SIZE + i * SLOT_SIZE

    const msgLen = bytes[base + 0x2a]
    // An empty message means the slot has never been written. The program
    // rejects empty posts, so this is a reliable "unused" marker.
    if (msgLen === 0) continue

    const postedAtNs = dv.getBigUint64(base + 0xdb, true)

    entries.push({
      slot: i,
      name: readText(bytes, base + 0x01, bytes[base + 0x00], NAME_BYTES),
      handle: readText(bytes, base + 0x1a, bytes[base + 0x19], HANDLE_BYTES),
      message: readText(bytes, base + 0x2b, msgLen, MESSAGE_BYTES),
      // Nanoseconds overflow a JS number, so divide down before making a Date.
      postedAt: new Date(Number(postedAtNs / 1000000n)),
      postedAtNs,
      poster: readPubkey(bytes, base + 0xe3),
      verified: bytes[base + 0x103] === 1,
    })
  }

  // Sort by time rather than by slot. The ring wraps, so slot order stops
  // matching post order as soon as the wall fills up once.
  entries.sort((a, b) => (a.postedAtNs < b.postedAtNs ? 1 : a.postedAtNs > b.postedAtNs ? -1 : 0))

  return {
    version: bytes[0],
    nextIndex: dv.getUint32(0x01, true),
    totalPosted: dv.getUint32(0x05, true),
    capacity: slots,
    sponsor,
    entries,
  }
}

/**
 * Build the POST instruction data the program expects:
 *   [0x01][name_len][name][handle_len][handle][msg_len][message]
 *
 * Shared by the browser lane (the server calls this before signing) and the
 * CLI lane (the browser calls it to show the user a command to paste), which
 * is exactly why it lives here rather than inside the API route.
 */
export function buildPostInstruction({ name = '', handle = '', message = '' }) {
  const enc = new TextEncoder()

  const nameBytes = enc.encode(name.trim())
  const handleBytes = enc.encode(handle.trim().replace(/^@/, ''))
  const msgBytes = enc.encode(message.trim())

  if (msgBytes.length === 0) throw new WallDecodeError('message is empty')
  if (nameBytes.length > NAME_BYTES) throw new WallDecodeError('name is too long')
  if (handleBytes.length > HANDLE_BYTES) throw new WallDecodeError('handle is too long')
  if (msgBytes.length > MESSAGE_BYTES) throw new WallDecodeError('message is too long')

  const out = new Uint8Array(1 + 1 + nameBytes.length + 1 + handleBytes.length + 1 + msgBytes.length)
  let o = 0
  out[o++] = 0x01
  out[o++] = nameBytes.length
  out.set(nameBytes, o); o += nameBytes.length
  out[o++] = handleBytes.length
  out.set(handleBytes, o); o += handleBytes.length
  out[o++] = msgBytes.length
  out.set(msgBytes, o)
  return out
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
