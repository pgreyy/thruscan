// api/register-name.js
//
// Claims a username on chain, sponsored so nobody needs a wallet to have a
// name.
//
// The program is the authority on uniqueness — it scans every slot before
// writing, so two people claiming the same name in the same second cannot both
// win. What happens here is only the cheap early rejection.
//
// Environment variables:
//   THRU_SPONSOR_PUBKEY   sponsor account public key
//   THRU_SPONSOR_PRIVKEY  its private key, hex
//   THRU_ID_PROGRAM       the deployed thruid program account
//   THRU_ID_REGISTRY      the registry account created by INIT
//   THRU_RPC_URL          optional endpoint override

import dns from 'node:dns'
import { createThruClient } from '@thru/sdk'
import { createGrpcTransport } from '@connectrpc/connect-node'

export const config = { runtime: 'nodejs' }

dns.setDefaultResultOrder('ipv4first')

const RPC_URL = process.env.THRU_RPC_URL || 'https://rpc.alphanet.thru.org'
const NAME_MIN = 3
const NAME_MAX = 24

// Names are claimed once and renamed rarely, so this can be strict without
// getting in anyone's way.
const RATE_WINDOW_MS = 15_000
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

/** REGISTER: [0x01][id 8][name_len][name] */
function buildRegister(playerId, name) {
  const nameBytes = new TextEncoder().encode(name)
  const out = new Uint8Array(1 + 8 + 1 + nameBytes.length)
  out[0] = 0x01
  out.set(hexToBytes(playerId), 1)
  out[9] = nameBytes.length
  out.set(nameBytes, 10)
  return out
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Use POST.' })

  const { THRU_SPONSOR_PUBKEY, THRU_SPONSOR_PRIVKEY, THRU_ID_PROGRAM, THRU_ID_REGISTRY } = process.env
  if (!THRU_SPONSOR_PUBKEY || !THRU_SPONSOR_PRIVKEY || !THRU_ID_PROGRAM || !THRU_ID_REGISTRY) {
    return json(res, 503, { ok: false, error: 'Names are not set up yet.' })
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'

  const wait = tooSoon(ip)
  if (wait > 0) return json(res, 429, { ok: false, error: `Try again in ${wait} seconds.` })

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}

  const playerId = (body.playerId ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{16}$/.test(playerId) || playerId === '0000000000000000') {
    return json(res, 400, { ok: false, error: 'Bad player id.' })
  }

  const name = (body.name ?? '').trim()
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return json(res, 400, { ok: false, error: `Names are ${NAME_MIN} to ${NAME_MAX} characters.` })
  }
  if (!/^[a-z0-9_]+$/.test(name)) {
    return json(res, 400, { ok: false, error: 'Lowercase letters, numbers and underscores only.' })
  }

  try {
    const client = createThruClient({ transport: createGrpcTransport({ baseUrl: RPC_URL }) })

    const sponsor = await client.accounts.get(THRU_SPONSOR_PUBKEY)
    const nonce = sponsor?.meta?.nonce ?? 0n

    const signed = await client.transactions.buildAndSign({
      feePayer: {
        publicKey: THRU_SPONSOR_PUBKEY,
        privateKey: hexToBytes(THRU_SPONSOR_PRIVKEY),
      },
      program: THRU_ID_PROGRAM,
      accounts: { readWrite: [THRU_ID_REGISTRY] },
      header: { nonce, computeUnits: 300_000_000, stateUnits: 60_000, memoryUnits: 60_000 },
      instructionData: buildRegister(playerId, name),
    })

    const signature = await client.transactions.send(signed.rawTransaction)
    return json(res, 200, { ok: true, signature })
  } catch (err) {
    const detail = String(err?.message ?? err)
    console.error('name registration failed:', detail)

    // Program error 14 is the interesting one: somebody already holds it. That
    // deserves a plain answer rather than a generic failure.
    const taken = /user_error=0xe\b/i.test(detail) || detail.includes('0xe)')
    const full = /user_error=0xf\b/i.test(detail) || detail.includes('0xf)')

    return json(res, taken || full ? 409 : 502, {
      ok: false,
      taken,
      error: taken
        ? 'That name is already taken.'
        : full
          ? 'The registry is full for this season.'
          : 'Could not register that name.',
      detail: taken || full ? undefined : detail.slice(0, 300),
    })
  }
}
