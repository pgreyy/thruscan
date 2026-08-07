// src/lib/identity.js
//
// Reads the username registry written by thruid.c and turns it into two things
// every game needs: what my name is, and what to call everyone else on a
// leaderboard.
//
// Games store only the eight byte player id. Names are joined on here, so a
// name claimed once is the same name everywhere, including in games that do
// not exist yet.
//
// ---------------------------------------------------------------------------
// Header, 41 bytes
//   0x00  1  version
//   0x01  4  next_idx (u32)
//   0x05  4  count (u32)
//   0x09 32  sponsor pubkey
//
// Slot, 41 bytes
//   0x00  8  player id (all zero means unused)
//   0x08  1  name_len
//   0x09 24  name
//   0x21  8  claimed_at (u64, ns)

import { Pubkey } from '@thru/sdk'

export const NAME_MIN = 3
export const NAME_MAX = 24
export const HEADER_SIZE = 41
export const SLOT_SIZE = 41
export const REGISTRY_VERSION = 1

/**
 * The same rule the program enforces. Checking here too means someone learns
 * their name is invalid while typing it, rather than from a failed
 * transaction several seconds later.
 */
export function nameProblem(name) {
  const value = (name ?? '').trim()
  if (value.length < NAME_MIN) return `At least ${NAME_MIN} characters.`
  if (value.length > NAME_MAX) return `At most ${NAME_MAX} characters.`
  if (!/^[a-z0-9_]+$/.test(value)) return 'Lowercase letters, numbers and underscores only.'
  return null
}

export class RegistryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RegistryError'
  }
}

function base64ToBytes(b64) {
  if (!b64) throw new RegistryError('registry has no data')
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const decoder = new TextDecoder()

export function decodeRegistry(input) {
  const bytes = base64ToBytes(input)

  if (bytes.length < HEADER_SIZE) throw new RegistryError('registry too small')
  if (bytes[0] !== REGISTRY_VERSION) throw new RegistryError(`unknown version ${bytes[0]}`)

  const slots = Math.floor((bytes.length - HEADER_SIZE) / SLOT_SIZE)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // Two shapes, because both are wanted constantly: id to name for leaderboard
  // rows, and name to id for telling someone a name is already gone.
  const byId = new Map()
  const byName = new Map()

  for (let i = 0; i < slots; i++) {
    const base = HEADER_SIZE + i * SLOT_SIZE
    const id = Array.from(bytes.slice(base, base + 8), (b) => b.toString(16).padStart(2, '0')).join('')
    if (id === '0000000000000000') continue

    const len = Math.min(bytes[base + 0x08], NAME_MAX)
    const name = decoder.decode(bytes.slice(base + 0x09, base + 0x09 + len))
    if (!name) continue

    byId.set(id, name)
    byName.set(name, id)
  }

  return {
    version: bytes[0],
    count: dv.getUint32(0x05, true),
    capacity: slots,
    sponsor: Pubkey.from(bytes.slice(0x09, 0x29)).toThruFmt(),
    byId,
    byName,
  }
}

/** What to show for a player: their registered name, or whatever the game stored. */
export function displayName(registry, id, fallback) {
  return registry?.byId.get(id) || fallback || 'Anonymous'
}

/** True when the name belongs to someone else. Free names and your own both pass. */
export function nameTaken(registry, name, myId) {
  const holder = registry?.byName.get((name ?? '').trim())
  return Boolean(holder) && holder !== myId
}
