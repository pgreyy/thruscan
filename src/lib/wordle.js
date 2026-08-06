// src/lib/wordle.js
//
// Game rules, the word list, and the decoder for the on-chain scoreboard.
// Written alongside thruwordle.c — if a field size changes in the C, it
// changes here in the same commit.
//
// ---------------------------------------------------------------------------
// Board header, 45 bytes
//
//   0x00   1  version
//   0x01   4  next_idx (u32)
//   0x05   4  players (u32)
//   0x09   4  games (u32)
//   0x0d  32  sponsor pubkey
//
// Then slots of 67 bytes each:
//
//   0x00   8  player id (all zero means unused)
//   0x08   1  name_len
//   0x09  24  name
//   0x21   4  played (u32)
//   0x25   4  won (u32)
//   0x29   4  points (u32)
//   0x2d   4  streak (u32)
//   0x31   4  best_streak (u32)
//   0x35   8  last_played (u64, nanoseconds)
//   0x3d   5  last_answer
//   0x42   1  last_guesses

import { Pubkey } from '@thru/thru-sdk'

export const WORD_LEN = 5
export const MAX_GUESSES = 6
export const NAME_CHARS = 24
export const HEADER_SIZE = 45
export const SLOT_SIZE = 67
export const BOARD_VERSION = 1

/**
 * Answers. Deliberately common words — a casual game that hands you obscure
 * vocabulary stops being fun by the third round. Guesses are not checked
 * against a dictionary, so no one gets stuck because a real word was rejected.
 */
export const WORDS = [
  'about', 'above', 'actor', 'acute', 'admit', 'adopt', 'after', 'again', 'agent', 'agree',
  'ahead', 'alarm', 'album', 'alert', 'alike', 'alive', 'alone', 'along', 'alter', 'among',
  'anger', 'angle', 'angry', 'ankle', 'apart', 'apple', 'apply', 'arena', 'argue', 'arise',
  'armor', 'aroma', 'array', 'arrow', 'aside', 'asset', 'audio', 'audit', 'avoid', 'awake',
  'award', 'aware', 'badly', 'baker', 'basic', 'basin', 'beach', 'beard', 'beast', 'begin',
  'being', 'below', 'bench', 'birth', 'black', 'blade', 'blame', 'blank', 'blast', 'blaze',
  'blend', 'blind', 'block', 'blood', 'bloom', 'board', 'boost', 'booth', 'bound', 'brain',
  'brand', 'brave', 'bread', 'break', 'breed', 'brick', 'bride', 'brief', 'bring', 'broad',
  'broke', 'brown', 'brush', 'build', 'built', 'burst', 'cabin', 'cable', 'candy', 'canoe',
  'cargo', 'carry', 'carve', 'catch', 'cause', 'chain', 'chair', 'chalk', 'charm', 'chart',
  'chase', 'cheap', 'check', 'cheer', 'chess', 'chest', 'chief', 'child', 'chill', 'china',
  'chose', 'civil', 'claim', 'clash', 'class', 'clean', 'clear', 'clerk', 'click', 'cliff',
  'climb', 'clock', 'close', 'cloth', 'cloud', 'coach', 'coast', 'color', 'coral', 'couch',
  'could', 'count', 'court', 'cover', 'crack', 'craft', 'crash', 'crazy', 'cream', 'creek',
  'crime', 'crisp', 'cross', 'crowd', 'crown', 'crude', 'cruel', 'crush', 'curve', 'cycle',
  'daily', 'dance', 'dated', 'dealt', 'death', 'debut', 'delay', 'dense', 'depth', 'devil',
  'diary', 'digit', 'dirty', 'dozen', 'draft', 'drain', 'drama', 'drank', 'dream', 'dress',
  'dried', 'drift', 'drink', 'drive', 'drove', 'dying', 'eager', 'eagle', 'early', 'earth',
  'eight', 'elbow', 'elder', 'elect', 'empty', 'enemy', 'enjoy', 'enter', 'entry', 'equal',
  'error', 'essay', 'event', 'every', 'exact', 'exist', 'extra', 'faith', 'false', 'fault',
  'favor', 'feast', 'fence', 'fever', 'field', 'fiber', 'fifth', 'fifty', 'fight', 'final',
  'first', 'flame', 'flash', 'fleet', 'flesh', 'float', 'flood', 'floor', 'flour', 'fluid',
  'focus', 'force', 'forge', 'forth', 'forty', 'forum', 'found', 'frame', 'fraud', 'fresh',
  'front', 'frost', 'fruit', 'fully', 'funny', 'ghost', 'giant', 'given', 'glass', 'globe',
  'glory', 'glove', 'grace', 'grade', 'grain', 'grand', 'grant', 'grape', 'graph', 'grasp',
  'grass', 'grave', 'great', 'greed', 'green', 'greet', 'grief', 'grill', 'gross', 'group',
  'grown', 'guard', 'guess', 'guest', 'guide', 'guilt', 'habit', 'happy', 'harsh', 'haste',
  'heart', 'heavy', 'hedge', 'hello', 'hobby', 'honey', 'honor', 'horse', 'hotel', 'house',
  'human', 'humor', 'hurry', 'ideal', 'image', 'imply', 'index', 'inner', 'input', 'irony',
  'issue', 'ivory', 'jelly', 'joint', 'judge', 'juice', 'knife', 'knock', 'known', 'label',
  'labor', 'large', 'laser', 'later', 'laugh', 'layer', 'learn', 'lease', 'least', 'leave',
  'legal', 'lemon', 'level', 'light', 'limit', 'linen', 'liver', 'lobby', 'local', 'logic',
  'loose', 'lower', 'loyal', 'lucky', 'lunar', 'lunch', 'magic', 'major', 'maker', 'maple',
  'march', 'match', 'maybe', 'mayor', 'meant', 'medal', 'media', 'mercy', 'merge', 'merit',
  'metal', 'meter', 'might', 'minor', 'mixed', 'model', 'money', 'month', 'moral', 'motor',
  'mount', 'mouse', 'mouth', 'movie', 'music', 'naive', 'naked', 'nerve', 'never', 'newly',
  'night', 'noble', 'noise', 'north', 'novel', 'nurse', 'occur', 'ocean', 'offer', 'often',
  'olive', 'onion', 'onset', 'opera', 'orbit', 'order', 'organ', 'other', 'ought', 'outer',
  'owner', 'ozone', 'paint', 'panel', 'panic', 'paper', 'party', 'pasta', 'patch', 'pause',
  'peace', 'peach', 'pearl', 'pedal', 'phase', 'phone', 'photo', 'piano', 'piece', 'pilot',
  'pitch', 'pixel', 'pizza', 'place', 'plain', 'plane', 'plant', 'plate', 'point', 'polar',
  'porch', 'pound', 'power', 'press', 'price', 'pride', 'prime', 'print', 'prior', 'prize',
  'probe', 'proof', 'proud', 'prove', 'pulse', 'punch', 'pupil', 'purse', 'queen', 'query',
  'quest', 'queue', 'quick', 'quiet', 'quite', 'quota', 'radar', 'radio', 'raise', 'rally',
  'ranch', 'range', 'rapid', 'ratio', 'reach', 'react', 'ready', 'realm', 'rebel', 'refer',
  'relax', 'relay', 'reply', 'rider', 'ridge', 'rifle', 'right', 'rigid', 'rival', 'river',
  'roast', 'robot', 'rocky', 'roman', 'rough', 'round', 'route', 'royal', 'rugby', 'rural',
  'salad', 'sauce', 'scale', 'scene', 'scope', 'score', 'scout', 'seize', 'sense', 'serve',
  'seven', 'shade', 'shaft', 'shake', 'shall', 'shape', 'share', 'shark', 'sharp', 'sheep',
  'sheet', 'shelf', 'shell', 'shift', 'shine', 'shirt', 'shock', 'shoot', 'shore', 'short',
  'shown', 'sight', 'silly', 'since', 'skill', 'slate', 'sleep', 'slice', 'slide', 'slope',
  'small', 'smart', 'smile', 'smoke', 'snake', 'solar', 'solid', 'solve', 'sorry', 'sound',
  'south', 'space', 'spare', 'spark', 'speak', 'speed', 'spell', 'spend', 'spent', 'spice',
  'spike', 'split', 'spoke', 'sport', 'squad', 'stack', 'staff', 'stage', 'stain', 'stake',
  'stand', 'stare', 'start', 'state', 'steam', 'steel', 'steep', 'steer', 'stick', 'still',
  'stock', 'stone', 'stood', 'store', 'storm', 'story', 'stove', 'strap', 'straw', 'strip',
  'study', 'stuff', 'style', 'sugar', 'suite', 'sunny', 'super', 'sweet', 'swift', 'swing',
  'sword', 'table', 'taken', 'taste', 'teach', 'tenth', 'thank', 'theft', 'their', 'theme',
  'there', 'these', 'thick', 'thing', 'think', 'third', 'those', 'three', 'threw', 'throw',
  'tiger', 'tight', 'timer', 'title', 'toast', 'today', 'token', 'tooth', 'topic', 'total',
  'touch', 'tough', 'towel', 'tower', 'trace', 'track', 'trade', 'trail', 'train', 'treat',
  'trend', 'trial', 'tribe', 'trick', 'troop', 'truck', 'truly', 'trust', 'truth', 'twice',
  'twist', 'ultra', 'uncle', 'under', 'union', 'unite', 'unity', 'until', 'upper', 'upset',
  'urban', 'usage', 'usual', 'valid', 'value', 'vapor', 'vault', 'venue', 'video', 'vinyl',
  'viral', 'virus', 'visit', 'vital', 'vivid', 'vocal', 'voice', 'wagon', 'waste', 'watch',
  'water', 'weigh', 'weird', 'whale', 'wheat', 'wheel', 'where', 'which', 'while', 'white',
  'whole', 'whose', 'width', 'winds', 'woman', 'world', 'worry', 'worse', 'worst', 'worth',
  'would', 'wound', 'wrist', 'write', 'wrong', 'yield', 'young', 'youth', 'zebra',
]

export function randomWord() {
  return WORDS[Math.floor(Math.random() * WORDS.length)]
}

/**
 * Score a guess the way Wordle does, which is fiddlier than it looks because
 * of repeated letters. Exact matches are claimed first, then each remaining
 * letter can only be marked "present" if an unclaimed copy of it is left in
 * the answer. Without the two passes, guessing SPEED against ERASE marks both
 * E's yellow when only one belongs.
 */
export function scoreGuess(guess, answer) {
  const result = new Array(WORD_LEN).fill('absent')
  const remaining = {}

  for (let i = 0; i < WORD_LEN; i++) {
    if (guess[i] === answer[i]) result[i] = 'correct'
    else remaining[answer[i]] = (remaining[answer[i]] ?? 0) + 1
  }

  for (let i = 0; i < WORD_LEN; i++) {
    if (result[i] === 'correct') continue
    if (remaining[guess[i]] > 0) {
      result[i] = 'present'
      remaining[guess[i]] -= 1
    }
  }

  return result
}

/** Best state seen for each letter, for colouring the on-screen keyboard. */
export function keyboardState(guesses, answer) {
  const rank = { absent: 0, present: 1, correct: 2 }
  const state = {}

  for (const guess of guesses) {
    const marks = scoreGuess(guess, answer)
    for (let i = 0; i < WORD_LEN; i++) {
      const letter = guess[i]
      if (!state[letter] || rank[marks[i]] > rank[state[letter]]) state[letter] = marks[i]
    }
  }

  return state
}

/** Points must match the program's own arithmetic, or the UI lies about scores. */
export function pointsFor(solved, guessCount) {
  return solved ? (MAX_GUESSES + 1 - guessCount) * 10 : 0
}

/* ---------- player identity ---------- */

const ID_KEY = 'thruscan_player_id'

/**
 * An 8-byte id kept in this browser. Not an identity in any serious sense —
 * clearing site data starts you over — but it means a first game needs no
 * account, no wallet and no sign-up.
 */
export function getPlayerId() {
  let hex = localStorage.getItem(ID_KEY)
  if (hex && /^[0-9a-f]{16}$/.test(hex)) return hex

  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  localStorage.setItem(ID_KEY, hex)
  return hex
}

/* ---------- decoding ---------- */

export class BoardDecodeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BoardDecodeError'
  }
}

function base64ToBytes(b64) {
  if (!b64) throw new BoardDecodeError('scoreboard has no data')
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

export function decodeBoard(input) {
  const bytes = base64ToBytes(input)

  if (bytes.length < HEADER_SIZE) throw new BoardDecodeError('scoreboard too small')
  if (bytes[0] !== BOARD_VERSION) throw new BoardDecodeError(`unknown board version ${bytes[0]}`)

  const slots = boardCapacity(bytes.length)
  if (slots === 0) throw new BoardDecodeError('scoreboard has no slots')

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const players = []

  for (let i = 0; i < slots; i++) {
    const base = HEADER_SIZE + i * SLOT_SIZE

    const id = Array.from(bytes.slice(base, base + 8), (b) => b.toString(16).padStart(2, '0')).join('')
    if (id === '0000000000000000') continue // never used

    const nameLen = Math.min(bytes[base + 0x08], NAME_CHARS)
    const lastNs = dv.getBigUint64(base + 0x35, true)

    players.push({
      id,
      name: decoder.decode(bytes.slice(base + 0x09, base + 0x09 + nameLen)),
      played: dv.getUint32(base + 0x21, true),
      won: dv.getUint32(base + 0x25, true),
      points: dv.getUint32(base + 0x29, true),
      streak: dv.getUint32(base + 0x2d, true),
      bestStreak: dv.getUint32(base + 0x31, true),
      lastPlayed: new Date(Number(lastNs / 1000000n)),
      lastPlayedNs: lastNs,
      lastAnswer: decoder.decode(bytes.slice(base + 0x3d, base + 0x42)),
      lastGuesses: bytes[base + 0x42],
    })
  }

  return {
    version: bytes[0],
    players: dv.getUint32(0x05, true),
    games: dv.getUint32(0x09, true),
    sponsor: Pubkey.from(bytes.slice(0x0d, 0x2d)).toThruFmt(),
    capacity: slots,
    entries: players,
  }
}

/** Ranked by points, then by wins, then by whoever got there first. */
export function rankByPoints(entries) {
  return [...entries].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points
    if (b.won !== a.won) return b.won - a.won
    return a.lastPlayedNs < b.lastPlayedNs ? -1 : 1
  })
}

/** Ranked by best streak, with the current streak breaking ties. */
export function rankByStreak(entries) {
  return [...entries].sort((a, b) => {
    if (b.bestStreak !== a.bestStreak) return b.bestStreak - a.bestStreak
    if (b.streak !== a.streak) return b.streak - a.streak
    return b.points - a.points
  })
}

/* ---------- instruction building ---------- */

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * SUBMIT: [0x01][id 8][name_len][name][answer 5][guess_count][guesses n*5][solved]
 * Shared with the server so both sides encode identically.
 */
export function buildSubmitInstruction({ playerId, name, answer, guesses, solved }) {
  const enc = new TextEncoder()
  const nameBytes = enc.encode((name ?? '').trim().slice(0, NAME_CHARS))
  const idBytes = hexToBytes(playerId)

  const out = new Uint8Array(1 + 8 + 1 + nameBytes.length + WORD_LEN + 1 + guesses.length * WORD_LEN + 1)
  let o = 0
  out[o++] = 0x01
  out.set(idBytes, o); o += 8
  out[o++] = nameBytes.length
  out.set(nameBytes, o); o += nameBytes.length
  out.set(enc.encode(answer), o); o += WORD_LEN
  out[o++] = guesses.length
  for (const g of guesses) { out.set(enc.encode(g), o); o += WORD_LEN }
  out[o] = solved ? 1 : 0
  return out
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
