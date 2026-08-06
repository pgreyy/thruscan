// api/submit-game.js
//
// Records a finished game on chain, paid for by the site so the player needs
// no wallet.
//
// The program does the real checking: it recomputes the outcome from the
// answer and guesses, so a claimed win has to come with the guess that proves
// it. What happens here is cheaper and earlier — reject anything obviously
// malformed before spending a transaction on it.
//
// Environment variables:
//   THRU_SPONSOR_PUBKEY    the sponsor account's public key
//   THRU_SPONSOR_PRIVKEY   its private key, hex
//   THRU_WORDLE_PROGRAM    the deployed thruwordle program account
//   THRU_WORDLE_BOARD      the scoreboard account created by INIT
//   THRU_RPC_URL           optional endpoint override

import dns from 'node:dns'
// @thru/sdk, not the older @thru/thru-sdk. The 0.2.x line signs transactions
// with a scheme the 0.3.x node rejects outright, which surfaces as "invalid
// transaction signature" no matter how correct the rest of the request is.
import { createThruClient } from '@thru/sdk'
import { createGrpcTransport } from '@connectrpc/connect-node'

export const config = { runtime: 'nodejs' }

dns.setDefaultResultOrder('ipv4first')

const RPC_URL = process.env.THRU_RPC_URL || 'https://rpc.alphanet.thru.org'

const WORD_LEN = 5
const MAX_GUESSES = 6
const NAME_CHARS = 24

// One game per this many seconds per IP. A finished game takes a person at
// least this long to play, so it costs nothing real while making a script
// that hammers the endpoint noticeably slower than just playing.
const RATE_WINDOW_MS = 10_000
const recent = new Map()

function tooSoon(ip) {
  const now = Date.now()
  for (const [key, at] of recent) if (now - at > RATE_WINDOW_MS) recent.delete(key)
  const last = recent.get(ip)
  if (last && now - last < RATE_WINDOW_MS) return Math.ceil((RATE_WINDOW_MS - (now - last)) / 1000)
  recent.set(ip, now)
  return 0
}

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

function buildSubmitInstruction({ playerId, name, answer, guesses, solved }) {
  const enc = new TextEncoder()
  const nameBytes = enc.encode(name)
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

const isWord = (s) => typeof s === 'string' && /^[a-z]{5}$/.test(s)

function validate(body) {
  const playerId = (body.playerId ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{16}$/.test(playerId)) return { error: 'Bad player id.' }
  if (playerId === '0000000000000000') return { error: 'Bad player id.' }

  const answer = (body.answer ?? '').trim().toLowerCase()
  if (!isWord(answer)) return { error: 'Bad answer.' }

  const guesses = Array.isArray(body.guesses) ? body.guesses.map((g) => String(g).trim().toLowerCase()) : []
  if (guesses.length === 0 || guesses.length > MAX_GUESSES) return { error: 'Bad guess count.' }
  if (!guesses.every(isWord)) return { error: 'Bad guess.' }

  const solved = Boolean(body.solved)

  // The same consistency rules the program enforces. Catching them here saves
  // a wasted transaction and gives a clearer message than a revert code.
  if (solved && guesses[guesses.length - 1] !== answer) return { error: 'That game does not add up.' }
  if (!solved && guesses.includes(answer)) return { error: 'That game does not add up.' }
  if (!solved && guesses.length !== MAX_GUESSES) return { error: 'That game does not add up.' }

  const name = (body.name ?? '').trim().slice(0, NAME_CHARS)

  return { playerId, answer, guesses, solved, name }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Use POST.' })

  const { THRU_SPONSOR_PUBKEY, THRU_SPONSOR_PRIVKEY, THRU_WORDLE_PROGRAM, THRU_WORDLE_BOARD } = process.env
  if (!THRU_SPONSOR_PUBKEY || !THRU_SPONSOR_PRIVKEY || !THRU_WORDLE_PROGRAM || !THRU_WORDLE_BOARD) {
    return json(res, 503, { ok: false, error: 'The game is not set up yet.' })
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'

  const wait = tooSoon(ip)
  if (wait > 0) return json(res, 429, { ok: false, error: `Slow down for ${wait} seconds.` })

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}
  const checked = validate(body)
  if (checked.error) return json(res, 400, { ok: false, error: checked.error })

  try {
    const client = createThruClient({ transport: createGrpcTransport({ baseUrl: RPC_URL }) })

    const sponsor = await client.accounts.get(THRU_SPONSOR_PUBKEY)
    const nonce = sponsor?.meta?.nonce ?? 0n

    const signed = await client.transactions.buildAndSign({
      feePayer: {
        publicKey: THRU_SPONSOR_PUBKEY,
        privateKey: hexToBytes(THRU_SPONSOR_PRIVKEY),
      },
      program: THRU_WORDLE_PROGRAM,
      accounts: { readWrite: [THRU_WORDLE_BOARD] },
      // State and memory units default low enough to fail on a write, the
      // same way INIT did. Ask explicitly rather than hoping.
      header: { nonce, computeUnits: 300_000_000, stateUnits: 60_000, memoryUnits: 60_000 },
      instructionData: buildSubmitInstruction(checked),
    })

    // rawTransaction is the wire-format Uint8Array. signed.transaction is a
    // TransactionLike wrapper, which send() does not accept — passing it is
    // what made every submission fail.
    const signature = await client.transactions.send(signed.rawTransaction)
    return json(res, 200, { ok: true, signature })
  } catch (err) {
    console.error('wordle submit failed:', err)
    // Surface the real reason. A generic message here means guessing at
    // whether it was the key, the nonce, the transport or the program.
    const detail = String(err?.message ?? err).slice(0, 300)
    return json(res, 502, { ok: false, error: detail })
  }
}
