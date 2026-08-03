// api/post-message.js
//
// The sponsored lane. A visitor types a message in the browser, this function
// validates it, signs with a server-held key, and submits it. The visitor
// needs no wallet, no tokens and no install.
//
// This is the only place a post can be refused. Once a message is on chain it
// cannot be removed, so everything that should never reach the wall has to be
// caught here.
//
// Environment variables (set in Vercel, never in the repo):
//   THRU_SPONSOR_PUBKEY   the sponsor account's public key (ta...)
//   THRU_SPONSOR_PRIVKEY  its private key, hex, from `thru keys get <name>`
//   THRU_WALL_PROGRAM     the deployed thruwall program account
//   THRU_WALL_ACCOUNT     the wall data account created by INIT
//   THRU_RPC_URL          optional endpoint override
//
// Requires: npm i @connectrpc/connect-node

import dns from 'node:dns'
import { createThruClient } from '@thru/thru-sdk'
import { createGrpcTransport } from '@connectrpc/connect-node'

export const config = { runtime: 'nodejs' }

// Same NAT64 problem as api/rpc.js: the RPC host publishes an AAAA record that
// Node prefers and then cannot reach.
dns.setDefaultResultOrder('ipv4first')

const RPC_URL = process.env.THRU_RPC_URL || 'https://rpc.alphanet.thru.org'

const NAME_BYTES = 24
const HANDLE_BYTES = 16
const MESSAGE_BYTES = 176
const NAME_CHARS = 24
const HANDLE_CHARS = 15
const MESSAGE_CHARS = 140

// One post per this many milliseconds per IP. Held in module scope, so it only
// covers a single warm lambda — enough to stop a stuck submit button, not a
// determined flood. Move to a shared store if the wall gets popular.
const RATE_WINDOW_MS = 30_000
const recentPosts = new Map()

function tooSoon(ip) {
  const now = Date.now()
  for (const [key, at] of recentPosts) {
    if (now - at > RATE_WINDOW_MS) recentPosts.delete(key)
  }
  const last = recentPosts.get(ip)
  if (last && now - last < RATE_WINDOW_MS) return Math.ceil((RATE_WINDOW_MS - (now - last)) / 1000)
  recentPosts.set(ip, now)
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

function buildPostInstruction(name, handle, message) {
  const enc = new TextEncoder()
  const nameBytes = enc.encode(name)
  const handleBytes = enc.encode(handle)
  const msgBytes = enc.encode(message)

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

/**
 * Reject anything that should never reach the chain. Deliberately plain: no
 * word filtering here, because that belongs in a list you can edit without a
 * deploy, and because a bad filter is worse than none.
 */
function validate({ name, handle, message }) {
  const enc = new TextEncoder()

  const cleanName = (name ?? '').trim()
  const cleanHandle = (handle ?? '').trim().replace(/^@/, '')
  const cleanMessage = (message ?? '').trim()

  if (cleanMessage.length === 0) return { error: 'Write something first.' }
  if ([...cleanMessage].length > MESSAGE_CHARS) return { error: `Messages are limited to ${MESSAGE_CHARS} characters.` }
  if ([...cleanName].length > NAME_CHARS) return { error: `Names are limited to ${NAME_CHARS} characters.` }
  if ([...cleanHandle].length > HANDLE_CHARS) return { error: `Handles are limited to ${HANDLE_CHARS} characters.` }
  if (cleanHandle && !/^[A-Za-z0-9_]+$/.test(cleanHandle)) return { error: 'Handles can only contain letters, numbers and underscores.' }

  // Character limits do not bound byte length, since one emoji can take four
  // bytes. The program rejects oversized fields, so catch it here with a
  // message a person can act on.
  if (enc.encode(cleanName).length > NAME_BYTES) return { error: 'That name uses too many special characters.' }
  if (enc.encode(cleanHandle).length > HANDLE_BYTES) return { error: 'That handle is too long.' }
  if (enc.encode(cleanMessage).length > MESSAGE_BYTES) return { error: 'That message uses too many emoji. Try shortening it.' }

  return { name: cleanName, handle: cleanHandle, message: cleanMessage }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Use POST.' })

  const { THRU_SPONSOR_PUBKEY, THRU_SPONSOR_PRIVKEY, THRU_WALL_PROGRAM, THRU_WALL_ACCOUNT } = process.env

  if (!THRU_SPONSOR_PUBKEY || !THRU_SPONSOR_PRIVKEY || !THRU_WALL_PROGRAM || !THRU_WALL_ACCOUNT) {
    return json(res, 503, { ok: false, error: 'The wall is not set up yet. Check back shortly.' })
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'

  const wait = tooSoon(ip)
  if (wait > 0) {
    return json(res, 429, { ok: false, error: `One post at a time. Try again in ${wait} seconds.` })
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}
  const checked = validate(body)
  if (checked.error) return json(res, 400, { ok: false, error: checked.error })

  try {
    const client = createThruClient({ transport: createGrpcTransport({ baseUrl: RPC_URL }) })

    // The transaction nonce has to match the fee payer account's current
    // nonce, so read it rather than assuming.
    const sponsorAccount = await client.accounts.get(THRU_SPONSOR_PUBKEY)
    const nonce = sponsorAccount?.meta?.nonce ?? 0n

    const instructionData = buildPostInstruction(checked.name, checked.handle, checked.message)

    const signed = await client.transactions.buildAndSign({
      feePayer: {
        publicKey: THRU_SPONSOR_PUBKEY,
        privateKey: hexToBytes(THRU_SPONSOR_PRIVKEY),
      },
      program: THRU_WALL_PROGRAM,
      accounts: { readWrite: [THRU_WALL_ACCOUNT] },
      header: { nonce, computeUnits: 300_000_000 },
      instructionData,
    })

    const signature = await client.transactions.send(signed.transaction ?? signed)

    return json(res, 200, { ok: true, signature })
  } catch (err) {
    // Never leak the key or internals to the browser; log for yourself.
    console.error('wall post failed:', err)
    return json(res, 502, { ok: false, error: 'Could not post to the chain. Try again in a moment.' })
  }
}
