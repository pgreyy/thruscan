// src/lib/game2048.js
//
// Mirrors thru2048.c: the same slide and merge rules, so the browser can show
// a move the instant you make it while the transaction settles behind it.
// Whatever the chain returns afterwards wins — this is a prediction, not the
// source of truth.
//
// ---------------------------------------------------------------------------
// Header, 45 bytes
//   0x00  1  version
//   0x01  4  next_idx (u32)
//   0x05  4  players (u32)
//   0x09  4  moves (u32) — every move by everyone, ever
//   0x0d 32  sponsor pubkey
//
// Player slot, 82 bytes
//   0x00  8  player id
//   0x08  1  name_len
//   0x09 24  name
//   0x21 16  board, one byte per cell, as EXPONENTS (0 empty, 1 is a 2)
//   0x31  4  score (u32)
//   0x35  4  best_score (u32)
//   0x39  4  moves this game (u32)
//   0x3d  4  games (u32)
//   0x41  8  rng state (u64)
//   0x49  8  last_played (u64, ns)
//   0x51  1  status (0 none, 1 playing, 2 over)

import { Pubkey } from '@thru/sdk'

export const GRID = 4
export const CELLS = 16
export const HEADER_SIZE = 45
export const SLOT_SIZE = 82
export const BOARD_VERSION = 1
export const NAME_CHARS = 24

export const DIRECTIONS = { left: 0, right: 1, up: 2, down: 3 }

export const STATUS_NONE = 0
export const STATUS_PLAYING = 1
export const STATUS_OVER = 2

/** Tiles are stored as exponents to fit a byte, so 3 means a tile showing 8. */
export const tileValue = (exp) => (exp ? 2 ** exp : 0)

/* ---------- rules ---------- */

function lineIndices(dir, line) {
  const out = []
  for (let i = 0; i < GRID; i++) {
    if (dir === 0) out.push(line * GRID + i)
    else if (dir === 1) out.push(line * GRID + (GRID - 1 - i))
    else if (dir === 2) out.push(i * GRID + line)
    else out.push((GRID - 1 - i) * GRID + line)
  }
  return out
}

function slideLine(cells) {
  const packed = cells.filter(Boolean)
  const result = []
  let gained = 0

  for (let i = 0; i < packed.length; i++) {
    // Each tile merges at most once per swipe, which is why the partner is
    // skipped rather than left available. Without it 2 2 4 becomes 8.
    if (i + 1 < packed.length && packed[i] === packed[i + 1] && packed[i] < 17) {
      const merged = packed[i] + 1
      result.push(merged)
      gained += 2 ** merged
      i++
    } else {
      result.push(packed[i])
    }
  }

  while (result.length < GRID) result.push(0)
  return { line: result, gained }
}

/**
 * Apply a swipe locally. Returns the slid board without a new tile, because
 * only the chain decides where that lands.
 */
export function applyMove(board, dir) {
  const next = [...board]
  let gained = 0
  let changed = false

  for (let line = 0; line < GRID; line++) {
    const idx = lineIndices(dir, line)
    const cells = idx.map((i) => next[i])
    const { line: slid, gained: g } = slideLine(cells)
    gained += g

    idx.forEach((boardIndex, i) => {
      if (next[boardIndex] !== slid[i]) changed = true
      next[boardIndex] = slid[i]
    })
  }

  return { board: next, gained, changed }
}

/** Over only when the board is full and no neighbours match. */
export function hasMoves(board) {
  if (board.some((cell) => cell === 0)) return true

  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const here = board[r * GRID + c]
      if (c + 1 < GRID && here === board[r * GRID + c + 1]) return true
      if (r + 1 < GRID && here === board[(r + 1) * GRID + c]) return true
    }
  }
  return false
}

/* ---------- randomness ----------
   A JavaScript twin of the xorshift64 in thru2048.c. Because the generator's
   state is stored in the account, the browser can work out exactly which cell
   the chain will fill and what it will contain — so a move can be shown in
   full immediately, with the transaction settling behind it. Get this wrong
   and the board visibly corrects itself a second later, which is worse than
   not predicting at all. */

const MASK64 = (1n << 64n) - 1n

export function nextRandom(state) {
  let x = BigInt(state) & MASK64
  x = (x ^ (x << 13n)) & MASK64
  x = x ^ (x >> 7n)
  x = (x ^ (x << 17n)) & MASK64
  return x
}

/**
 * Drop a tile exactly where the program would. Two draws, in the same order
 * as the C: the first picks the cell, the second decides 2 or 4.
 */
export function spawnTile(board, rngState) {
  const empty = []
  for (let i = 0; i < CELLS; i++) if (!board[i]) empty.push(i)
  if (empty.length === 0) return { board, rng: rngState }

  const pickRng = nextRandom(rngState)
  const cell = empty[Number(pickRng % BigInt(empty.length))]

  const valueRng = nextRandom(pickRng)
  const next = [...board]
  next[cell] = valueRng % 10n === 0n ? 2 : 1

  return { board: next, rng: valueRng }
}

/* ---------- decoding ---------- */

export class Board2048Error extends Error {
  constructor(message) {
    super(message)
    this.name = 'Board2048Error'
  }
}

function base64ToBytes(b64) {
  if (!b64) throw new Board2048Error('board has no data')
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function boardCapacity(byteLength) {
  if (byteLength < HEADER_SIZE + SLOT_SIZE) return 0
  return Math.floor((byteLength - HEADER_SIZE) / SLOT_SIZE)
}

const decoder = new TextDecoder()

export function decodeGameBoard(input) {
  const bytes = base64ToBytes(input)

  if (bytes.length < HEADER_SIZE) throw new Board2048Error('board too small')
  if (bytes[0] !== BOARD_VERSION) throw new Board2048Error(`unknown version ${bytes[0]}`)

  const slots = boardCapacity(bytes.length)
  if (slots === 0) throw new Board2048Error('board has no slots')

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries = []

  for (let i = 0; i < slots; i++) {
    const base = HEADER_SIZE + i * SLOT_SIZE
    const id = Array.from(bytes.slice(base, base + 8), (b) => b.toString(16).padStart(2, '0')).join('')
    if (id === '0000000000000000') continue

    const nameLen = Math.min(bytes[base + 0x08], NAME_CHARS)
    const lastNs = dv.getBigUint64(base + 0x49, true)

    entries.push({
      id,
      name: decoder.decode(bytes.slice(base + 0x09, base + 0x09 + nameLen)),
      board: Array.from(bytes.slice(base + 0x21, base + 0x31)),
      score: dv.getUint32(base + 0x31, true),
      bestScore: dv.getUint32(base + 0x35, true),
      moves: dv.getUint32(base + 0x39, true),
      games: dv.getUint32(base + 0x3d, true),
      rng: dv.getBigUint64(base + 0x41, true),
      lastPlayed: new Date(Number(lastNs / 1000000n)),
      lastPlayedNs: lastNs,
      status: bytes[base + 0x51],
    })
  }

  return {
    version: bytes[0],
    players: dv.getUint32(0x05, true),
    moves: dv.getUint32(0x09, true),
    sponsor: Pubkey.from(bytes.slice(0x0d, 0x2d)).toThruFmt(),
    capacity: slots,
    entries,
  }
}

export function findPlayer(decoded, playerId) {
  return decoded?.entries.find((e) => e.id === playerId) ?? null
}

/** Best score first, then highest single tile, then fewest moves to get there. */
export function rank2048(entries) {
  return [...entries].sort((a, b) => {
    if (b.bestScore !== a.bestScore) return b.bestScore - a.bestScore
    const topA = Math.max(...a.board, 0)
    const topB = Math.max(...b.board, 0)
    if (topB !== topA) return topB - topA
    return a.moves - b.moves
  })
}
