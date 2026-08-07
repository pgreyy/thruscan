// api/move-2048.js
//
// One transaction per swipe, sponsored so the player needs no wallet.
//
// This is deliberately the busiest endpoint on the site: a finished game runs
// a few hundred moves, and each one is a transaction. That is the point — it
// is what a real application's load on the chain would look like.
//
// Environment variables:
//   THRU_SPONSOR_PUBKEY   sponsor account public key
//   THRU_SPONSOR_PRIVKEY  its private key, hex
//   THRU_2048_PROGRAM     the deployed thru2048 program account
//   THRU_2048_BOARD       the board account created by INIT
//   THRU_RPC_URL          optional endpoint override

import dns from 'node:dns'
// @thru/sdk, not @thru/thru-sdk: the 0.2.x line signs with a scheme the 0.3.x
// node rejects, which shows up as "invalid transaction signature".
import { createThruClient } from '@thru/sdk'
import { createGrpcTransport } from '@connectrpc/connect-node'

export const config = { runtime: 'nodejs' }

dns.setDefaultResultOrder('ipv4first')

const RPC_URL = process.env.THRU_RPC_URL || 'https://rpc.alphanet.thru.org'
const NAME_CHARS = 24

// Deliberately loose. Swipes come in bursts while someone plays, so a limit
// tight enough to stop a script would also interrupt a real game. The cheap
// defence is that a move nobody makes still costs the sponsor nothing.
const RATE_WINDOW_MS = 400
const recent = new Map()

function tooSoon(ip) {
  const now = Date.now()
  for (const [key, at] of recent) if (now - at > 60_000) recent.delete(key)
  const last = recent.get(ip)
  if (last && now - last < RATE_WINDOW_MS) return true
  recent.set(ip, now)
  return false
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

/** NEW: [0x01][id 8][name_len][name] */
function buildNew(playerId, name) {
  const nameBytes = new TextEncoder().encode(name)
  const out = new Uint8Array(1 + 8 + 1 + nameBytes.length)
  out[0] = 0x01
  out.set(hexToBytes(playerId), 1)
  out[9] = nameBytes.length
  out.set(nameBytes, 10)
  return out
}

/** MOVE: [0x02][id 8][dir] — ten bytes, about as small as a transaction gets. */
function buildMove(playerId, dir) {
  const out = new Uint8Array(10)
  out[0] = 0x02
  out.set(hexToBytes(playerId), 1)
  out[9] = dir
  return out
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Use POST.' })

  const { THRU_SPONSOR_PUBKEY, THRU_SPONSOR_PRIVKEY, THRU_2048_PROGRAM, THRU_2048_BOARD } = process.env
  if (!THRU_SPONSOR_PUBKEY || !THRU_SPONSOR_PRIVKEY || !THRU_2048_PROGRAM || !THRU_2048_BOARD) {
    return json(res, 503, { ok: false, error: 'The game is not set up yet.' })
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'

  if (tooSoon(ip)) return json(res, 429, { ok: false, error: 'Too fast.' })

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}

  const playerId = (body.playerId ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{16}$/.test(playerId) || playerId === '0000000000000000') {
    return json(res, 400, { ok: false, error: 'Bad player id.' })
  }

  const action = body.action === 'new' ? 'new' : 'move'
  const dir = Number(body.dir)
  if (action === 'move' && !(dir >= 0 && dir <= 3)) {
    return json(res, 400, { ok: false, error: 'Bad direction.' })
  }

  const name = (body.name ?? '').trim().slice(0, NAME_CHARS)
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
      program: THRU_2048_PROGRAM,
      accounts: { readWrite: [THRU_2048_BOARD] },
      header: { nonce, computeUnits: 300_000_000, stateUnits: 60_000, memoryUnits: 60_000 },
      instructionData: action === 'new' ? buildNew(playerId, name) : buildMove(playerId, dir),
    })

    const signature = await client.transactions.send(signed.rawTransaction)

    // Round-trip time is the number worth watching here, so hand it back and
    // let the page show it rather than burying it in logs.
    return json(res, 200, { ok: true, signature, ms: Date.now() - started })
  } catch (err) {
    const detail = String(err?.message ?? err)
    console.error('2048 move failed:', detail)

    // A swipe that shifts nothing reverts with error 15. That is a normal part
    // of playing, not a failure worth alarming anyone about.
    const noChange = /user_error=0xf\b/i.test(detail) || detail.includes('0xf)')

    return json(res, noChange ? 200 : 502, {
      ok: noChange,
      noChange,
      error: noChange ? undefined : 'That move did not go through.',
      detail: noChange ? undefined : detail.slice(0, 300),
      ms: Date.now() - started,
    })
  }
}
