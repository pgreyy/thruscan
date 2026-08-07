// api/play.js
//
// One endpoint for everything that writes to a game program: claiming a name,
// recording a finished word game, starting a 2048 board, and each 2048 move.
//
// These were three separate functions until a deploy hit Vercel's twelve
// function limit. They were always near-identical anyway — same signing, same
// sponsor, same error handling — so folding them together removes duplication
// as well as two functions.
//
// Every call carries an action:
//
//   { action: 'register',  playerId, name }
//   { action: 'wordle',    playerId, name, answer, guesses[], solved }
//   { action: '2048-new',  playerId, name }
//   { action: '2048-move', playerId, dir }
//
// Environment variables:
//   THRU_SPONSOR_PUBKEY   sponsor account public key
//   THRU_SPONSOR_PRIVKEY  its private key, hex
//   THRU_ID_PROGRAM       THRU_ID_REGISTRY
//   THRU_WORDLE_PROGRAM   THRU_WORDLE_BOARD
//   THRU_2048_PROGRAM     THRU_2048_BOARD
//   THRU_RPC_URL          optional endpoint override

import dns from 'node:dns'
// @thru/sdk, not the older @thru/thru-sdk: the 0.2.x line signs with a scheme
// the 0.3.x node rejects, which surfaces as "invalid transaction signature".
import { createThruClient } from '@thru/sdk'
import { createGrpcTransport } from '@connectrpc/connect-node'

export const config = { runtime: 'nodejs' }

dns.setDefaultResultOrder('ipv4first')

const RPC_URL = process.env.THRU_RPC_URL || 'https://rpc.alphanet.thru.org'

const NAME_MIN = 3
const NAME_MAX = 24
const WORD_LEN = 5
const MAX_GUESSES = 6

/* ---------- rate limiting ----------
   Per action, because the natural pace of each is wildly different: 2048 moves
   arrive in bursts while someone plays, a finished word game takes minutes,
   and a name is claimed once. */
const WINDOWS = {
  register: 15_000,
  wordle: 10_000,
  '2048-new': 3_000,
  '2048-move': 400,
}

const recent = new Map()

function tooSoon(key, windowMs) {
  const now = Date.now()
  for (const [k, at] of recent) if (now - at > 120_000) recent.delete(k)
  const last = recent.get(key)
  if (last && now - last < windowMs) return Math.ceil((windowMs - (now - last)) / 1000)
  recent.set(key, now)
  return 0
}

/* ---------- helpers ---------- */

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).send(JSON.stringify(body))
}

function hexToBytes(hex) {
  const clean = hex.trim().replace(/^0x/, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

const enc = new TextEncoder()
const isWord = (s) => typeof s === 'string' && /^[a-z]{5}$/.test(s)

/* ---------- instruction builders ----------
   Each mirrors the layout its program parses. Getting a length prefix wrong
   here is the difference between a recorded game and a revert, so they stay
   close together where they can be compared. */

/** thruid REGISTER: [0x01][id 8][name_len][name] */
function buildRegister(playerId, name) {
  const nameBytes = enc.encode(name)
  const out = new Uint8Array(1 + 8 + 1 + nameBytes.length)
  out[0] = 0x01
  out.set(hexToBytes(playerId), 1)
  out[9] = nameBytes.length
  out.set(nameBytes, 10)
  return out
}

/** thruwordle SUBMIT: [0x01][id 8][name_len][name][answer 5][count][guesses][solved] */
function buildWordle({ playerId, name, answer, guesses, solved }) {
  const nameBytes = enc.encode(name)
  const out = new Uint8Array(1 + 8 + 1 + nameBytes.length + WORD_LEN + 1 + guesses.length * WORD_LEN + 1)
  let o = 0
  out[o++] = 0x01
  out.set(hexToBytes(playerId), o); o += 8
  out[o++] = nameBytes.length
  out.set(nameBytes, o); o += nameBytes.length
  out.set(enc.encode(answer), o); o += WORD_LEN
  out[o++] = guesses.length
  for (const g of guesses) { out.set(enc.encode(g), o); o += WORD_LEN }
  out[o] = solved ? 1 : 0
  return out
}

/** thru2048 NEW: [0x01][id 8][name_len][name] */
function build2048New(playerId, name) {
  const nameBytes = enc.encode(name)
  const out = new Uint8Array(1 + 8 + 1 + nameBytes.length)
  out[0] = 0x01
  out.set(hexToBytes(playerId), 1)
  out[9] = nameBytes.length
  out.set(nameBytes, 10)
  return out
}

/** thru2048 MOVE: [0x02][id 8][dir] — ten bytes. */
function build2048Move(playerId, dir) {
  const out = new Uint8Array(10)
  out[0] = 0x02
  out.set(hexToBytes(playerId), 1)
  out[9] = dir
  return out
}

/* ---------- request validation ---------- */

/**
 * Works out which program to call and what to send it, or returns an error a
 * person can act on. Returning early here saves a transaction that the program
 * would only revert anyway.
 */
function plan(body) {
  const playerId = (body.playerId ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{16}$/.test(playerId) || playerId === '0000000000000000') {
    return { error: 'Bad player id.' }
  }

  const name = (body.name ?? '').trim().slice(0, NAME_MAX)

  switch (body.action) {
    case 'register': {
      if (name.length < NAME_MIN) return { error: `Names are at least ${NAME_MIN} characters.` }
      if (!/^[a-z0-9_]+$/.test(name)) return { error: 'Lowercase letters, numbers and underscores only.' }
      return {
        program: process.env.THRU_ID_PROGRAM,
        account: process.env.THRU_ID_REGISTRY,
        data: buildRegister(playerId, name),
      }
    }

    case 'wordle': {
      const answer = (body.answer ?? '').trim().toLowerCase()
      if (!isWord(answer)) return { error: 'Bad answer.' }

      const guesses = Array.isArray(body.guesses)
        ? body.guesses.map((g) => String(g).trim().toLowerCase())
        : []
      if (guesses.length === 0 || guesses.length > MAX_GUESSES) return { error: 'Bad guess count.' }
      if (!guesses.every(isWord)) return { error: 'Bad guess.' }

      const solved = Boolean(body.solved)

      // The same consistency rules the program enforces, checked early so the
      // message names the problem instead of arriving as a revert code.
      if (solved && guesses[guesses.length - 1] !== answer) return { error: 'That game does not add up.' }
      if (!solved && guesses.includes(answer)) return { error: 'That game does not add up.' }
      if (!solved && guesses.length !== MAX_GUESSES) return { error: 'That game does not add up.' }

      return {
        program: process.env.THRU_WORDLE_PROGRAM,
        account: process.env.THRU_WORDLE_BOARD,
        data: buildWordle({ playerId, name, answer, guesses, solved }),
      }
    }

    case '2048-new':
      return {
        program: process.env.THRU_2048_PROGRAM,
        account: process.env.THRU_2048_BOARD,
        data: build2048New(playerId, name),
      }

    case '2048-move': {
      const dir = Number(body.dir)
      if (!(dir >= 0 && dir <= 3)) return { error: 'Bad direction.' }
      return {
        program: process.env.THRU_2048_PROGRAM,
        account: process.env.THRU_2048_BOARD,
        data: build2048Move(playerId, dir),
      }
    }

    default:
      return { error: 'Unknown action.' }
  }
}

/* ---------- handler ---------- */

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Use POST.' })

  const { THRU_SPONSOR_PUBKEY, THRU_SPONSOR_PRIVKEY } = process.env
  if (!THRU_SPONSOR_PUBKEY || !THRU_SPONSOR_PRIVKEY) {
    return json(res, 503, { ok: false, error: 'Not set up yet.' })
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}
  const action = body.action

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'

  const wait = tooSoon(`${ip}:${action}`, WINDOWS[action] ?? 5_000)
  if (wait > 0) return json(res, 429, { ok: false, error: `Try again in ${wait} second${wait === 1 ? '' : 's'}.` })

  const target = plan(body)
  if (target.error) return json(res, 400, { ok: false, error: target.error })
  if (!target.program || !target.account) {
    return json(res, 503, { ok: false, error: 'That part is not set up yet.' })
  }

  const started = Date.now()

  try {
    const client = createThruClient({ transport: createGrpcTransport({ baseUrl: RPC_URL }) })

    const sponsor = await client.accounts.get(THRU_SPONSOR_PUBKEY)
    const nonce = sponsor?.meta?.nonce ?? 0n

    const signed = await client.transactions.buildAndSign({
      feePayer: {
        publicKey: THRU_SPONSOR_PUBKEY,
        privateKey: hexToBytes(THRU_SPONSOR_PRIVKEY),
      },
      program: target.program,
      accounts: { readWrite: [target.account] },
      // State and memory units default too low for a write, the same way they
      // did for account creation. Ask explicitly.
      header: { nonce, computeUnits: 300_000_000, stateUnits: 60_000, memoryUnits: 60_000 },
      instructionData: target.data,
    })

    const signature = await client.transactions.send(signed.rawTransaction)
    return json(res, 200, { ok: true, signature, ms: Date.now() - started })
  } catch (err) {
    const detail = String(err?.message ?? err)
    console.error(`play(${action}) failed:`, detail)

    const code = (n) => new RegExp(`user_error=0x${n}\\b`, 'i').test(detail) || detail.includes(`0x${n})`)

    // A 2048 swipe that shifts nothing reverts with 15. That is ordinary play,
    // not a failure, so it comes back as a success the client can ignore.
    if (action === '2048-move' && code('f')) {
      return json(res, 200, { ok: true, noChange: true, ms: Date.now() - started })
    }

    if (action === 'register' && code('e')) {
      return json(res, 409, { ok: false, taken: true, error: 'That name is already taken.' })
    }
    if (action === 'register' && code('f')) {
      return json(res, 409, { ok: false, error: 'The registry is full for this season.' })
    }

    return json(res, 502, {
      ok: false,
      error: 'That did not go through.',
      detail: detail.slice(0, 300),
      ms: Date.now() - started,
    })
  }
}
