// api/faucet.js
//
// Hands out tUSD, the quote currency every pool and every launch is priced in.
//
// Without this the DEX and the launchpad work for exactly one person: the
// holder of the mint authority. A faucet is what turns them from a private
// demo into something a stranger can use.
//
// It only mints. It does not create the destination account, because creating
// an account needs a state proof and that is a round trip the CLI already does
// well. The page shows the one command to run first. Doing less here means the
// part that matters cannot fail for a reason nobody can debug from a browser.
//
//   POST { account: 'ta...' }   a tUSD TOKEN ACCOUNT, not a wallet address
//
// Environment variables:
//   THRU_SPONSOR_PUBKEY   holds the tUSD mint authority
//   THRU_SPONSOR_PRIVKEY  its private key, hex
//   THRU_TUSD_MINT        optional override; defaults to the live mint
//   THRU_FAUCET_AMOUNT    optional override, in base units
//   THRU_RPC_URL          optional endpoint override

import dns from 'node:dns'
// @thru/sdk, not the older @thru/thru-sdk: the 0.2.x line signs with a scheme
// the 0.3.x node rejects, which surfaces as "invalid transaction signature".
import { createThruClient } from '@thru/sdk'
import { createGrpcTransport } from '@connectrpc/connect-node'

export const config = { runtime: 'nodejs' }

dns.setDefaultResultOrder('ipv4first')

const RPC_URL = process.env.THRU_RPC_URL || 'https://rpc.alphanet.thru.org'
const TUSD_MINT = process.env.THRU_TUSD_MINT || 'tabAx2SejGxnH7qDY02xofs0rrhBV2Cdoxg0yeG0hv7Z0R'
const TOKEN_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq'

// 1,000 tUSD at six decimals. Enough to trade with and seed a small pool,
// not so much that one person can move every price on the network.
const AMOUNT = BigInt(process.env.THRU_FAUCET_AMOUNT || '1000000000')

// A token account is 73 bytes: mint[32] owner[32] amount(u64) is_frozen.
const TOKEN_ACCOUNT_SIZE = 73

/* ---------- rate limiting ----------
   Per address as well as per IP. An IP limit alone is trivially beaten by a
   phone on mobile data, and an address limit alone is beaten by generating
   fresh accounts, so both are cheap and neither is sufficient on its own. */
const IP_WINDOW = 60_000
const ACCOUNT_WINDOW = 6 * 60 * 60 * 1000

const recentIp = new Map()
const recentAccount = new Map()

function tooSoon(store, key, windowMs) {
  const now = Date.now()
  for (const [k, at] of store) if (now - at > windowMs * 2) store.delete(k)
  const last = store.get(key)
  if (last && now - last < windowMs) return windowMs - (now - last)
  return 0
}

function human(ms) {
  const mins = Math.ceil(ms / 60000)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`
  const hrs = Math.ceil(mins / 60)
  return `${hrs} hour${hrs === 1 ? '' : 's'}`
}

function json(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json')
  res.send(JSON.stringify(body))
}

function hexToBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/* Thru sorts a transaction's accounts ascending by raw public key bytes, and
   the indices inside an instruction refer to that sorted order rather than the
   order they are listed. Sorting on the string would NOT match, because the
   base64 alphabet orders differently from the bytes it encodes. */
function addressBytes(addr) {
  const body = addr.slice(2).replace(/-/g, '+').replace(/_/g, '/')
  const padded = body + '='.repeat((4 - (body.length % 4)) % 4)
  return Buffer.from(padded, 'base64')
}

function sortAccounts(list) {
  return [...list].sort((x, y) => Buffer.compare(addressBytes(x), addressBytes(y)))
}

/* MINT_TO, opcode 0x03:
     [0x03][mint u16][dest u16][authority u16][amount u64]
   Recovered from live transactions; see programs/thru_token.h. */
function buildMintTo({ mintIdx, destIdx, authorityIdx, amount }) {
  const out = new Uint8Array(15)
  const dv = new DataView(out.buffer)
  out[0] = 0x03
  dv.setUint16(1, mintIdx, true)
  dv.setUint16(3, destIdx, true)
  dv.setUint16(5, authorityIdx, true)
  dv.setBigUint64(7, amount, true)
  return out
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Use POST.' })

  const { THRU_SPONSOR_PUBKEY, THRU_SPONSOR_PRIVKEY } = process.env
  if (!THRU_SPONSOR_PUBKEY || !THRU_SPONSOR_PRIVKEY) {
    return json(res, 503, { ok: false, error: 'The faucet is not set up yet.' })
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}
  const account = String(body.account ?? '').trim()

  if (!/^ta[A-Za-z0-9_-]{44}$/.test(account)) {
    return json(res, 400, {
      ok: false,
      error: 'That does not look like a Thru address. It should start with ta and be 46 characters.',
    })
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'

  let wait = tooSoon(recentIp, ip, IP_WINDOW)
  if (wait > 0) return json(res, 429, { ok: false, error: `Slow down. Try again in ${human(wait)}.` })

  wait = tooSoon(recentAccount, account, ACCOUNT_WINDOW)
  if (wait > 0) {
    return json(res, 429, {
      ok: false,
      error: `That account already claimed. It can claim again in ${human(wait)}.`,
    })
  }

  const started = Date.now()

  try {
    const client = createThruClient({ transport: createGrpcTransport({ baseUrl: RPC_URL }) })

    // Check the destination before minting. A wallet address rather than a
    // token account is the mistake everyone makes first, and the token program
    // would reject it with a number nobody can interpret. Say it in words.
    let dest
    try {
      dest = await client.accounts.get(account)
    } catch {
      return json(res, 404, {
        ok: false,
        error: 'No account at that address. Create your tUSD token account first, then paste it here.',
      })
    }

    const size = dest?.meta?.dataSize ?? 0
    if (size !== TOKEN_ACCOUNT_SIZE) {
      return json(res, 400, {
        ok: false,
        error:
          'That is an account, but not a token account. Paste the address that ' +
          'thru token initialize-account printed, not your wallet address.',
      })
    }

    const raw = dest?.data?.data
    if (raw && raw.length >= 32) {
      const mintOfAccount = Buffer.from(raw.slice(0, 32))
      const expected = addressBytes(TUSD_MINT).subarray(0, 32)
      if (!mintOfAccount.equals(expected)) {
        return json(res, 400, {
          ok: false,
          error: 'That token account is for a different token. It has to be a tUSD account.',
        })
      }
    }

    // Index 0 is the fee payer, 1 the program, then the read-write accounts in
    // sorted order. The sponsor is both fee payer and mint authority, so the
    // authority index is 0.
    const readWrite = sortAccounts([TUSD_MINT, account])
    const data = buildMintTo({
      mintIdx: 2 + readWrite.indexOf(TUSD_MINT),
      destIdx: 2 + readWrite.indexOf(account),
      authorityIdx: 0,
      amount: AMOUNT,
    })

    const sponsor = await client.accounts.get(THRU_SPONSOR_PUBKEY)
    const nonce = sponsor?.meta?.nonce ?? 0n

    const signed = await client.transactions.buildAndSign({
      feePayer: {
        publicKey: THRU_SPONSOR_PUBKEY,
        privateKey: hexToBytes(THRU_SPONSOR_PRIVKEY),
      },
      program: TOKEN_PROGRAM,
      accounts: { readWrite },
      header: { nonce, computeUnits: 300_000_000, stateUnits: 20_000, memoryUnits: 20_000 },
      instructionData: data,
    })

    const signature = await client.transactions.send(signed.rawTransaction)

    // Only record the claim once it actually landed, so a failed attempt does
    // not lock someone out for six hours.
    recentIp.set(ip, Date.now())
    recentAccount.set(account, Date.now())

    return json(res, 200, {
      ok: true,
      signature,
      amount: AMOUNT.toString(),
      account,
      ms: Date.now() - started,
    })
  } catch (err) {
    const detail = String(err?.message ?? err)
    console.error('faucet failed:', detail)
    return json(res, 502, {
      ok: false,
      error: 'That did not go through.',
      detail: detail.slice(0, 300),
      ms: Date.now() - started,
    })
  }
}
