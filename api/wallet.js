// api/wallet.js
//
// The only server the in-app wallet needs.
//
// It does three kinds of work, none of which involve a visitor's private key:
//
//   1. Sponsorship. A brand new key cannot pay its own way onto the chain, so
//      this endpoint pays for the one transaction that creates its account and
//      for the token accounts that hold its balances. Both are authorised by
//      the visitor's own signature or by nothing at all, never by handing the
//      sponsor anything it could spend.
//
//   2. Relay. The node sends no CORS headers, so a browser cannot talk to it.
//      `submit` takes bytes that are already signed and forwards them. It
//      cannot alter them: any edit invalidates the signature.
//
//   3. Reads. `prepare` and `balances` save the browser from having to know the
//      node's wire format.
//
// Everything lives in one function because Vercel's Hobby plan caps a project
// at twelve of them, and this is one feature.
//
// A note on what the sponsor can and cannot do. A Thru transaction carries
// exactly one signature, the fee payer's. So the sponsor cannot move a
// visitor's tokens even though it created the accounts: any such transfer would
// need the visitor as fee payer, and only the visitor can sign that. The
// sponsor's exposure here is fees and state, which is why create and open are
// rate limited.
//
// Environment variables:
//   THRU_SPONSOR_PUBKEY   the paying account
//   THRU_SPONSOR_PRIVKEY  its private key, hex
//   THRU_RPC_URL          optional endpoint override

import dns from 'node:dns'
import { createThruClient, Pubkey, proofs, deriveProgramAddress, TransactionBuilder } from '@thru/sdk'
import { createGrpcTransport } from '@connectrpc/connect-node'
import { createHash } from 'node:crypto'

export const config = { runtime: 'nodejs' }

dns.setDefaultResultOrder('ipv4first')

const RPC_URL = process.env.THRU_RPC_URL || 'https://rpc.alphanet.thru.org'
const TOKEN_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq'
const EOA_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const ADDRESS_RE = /^ta[A-Za-z0-9_-]{44}$/

/* State proof types: UNSPECIFIED 0, CREATING 1, UPDATING 2, EXISTING 3. */
const PROOF_CREATING = 1

/* A token account is 73 bytes: mint[32] owner[32] amount(u64) is_frozen. */
const TOKEN_ACCOUNT_SIZE = 73

/* ---------- rate limiting ----------
   These two actions spend the sponsor's state allowance, so they are capped per
   IP. Serverless instances are not shared, so this is a speed bump rather than
   a wall, which is the right size of defence for a testnet faucet-shaped thing.

   A burst allowance rather than a flat cooldown, because opening a wallet's
   first few token accounts is one action from the visitor's side and several
   from the server's. */
const WINDOW = 60_000
const BURST = 5
const recent = new Map()   // ip -> timestamps

function overBudget(key) {
  const now = Date.now()
  for (const [k, times] of recent) {
    const kept = times.filter((t) => now - t < WINDOW)
    if (kept.length) recent.set(k, kept); else recent.delete(k)
  }
  const mine = recent.get(key) ?? []
  if (mine.length < BURST) return 0
  return WINDOW - (now - mine[0])
}

function charge(key) {
  recent.set(key, [...(recent.get(key) ?? []), Date.now()])
}

function refund(key) {
  const mine = recent.get(key)
  if (mine?.length) recent.set(key, mine.slice(0, -1))
}

/* ---------- bytes ---------- */

const toBytes = (a) => Pubkey.from(a).toBytes()

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

function hexToBytes(hex) {
  const clean = String(hex).replace(/^0x/, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

const sha256 = (bytes) => new Uint8Array(createHash('sha256').update(Buffer.from(bytes)).digest())

/** Thru sorts accounts ascending by raw public key bytes, and every index in an
 *  instruction refers to that sorted order. Sorting the strings does NOT match,
 *  because base64url orders differently from the bytes it encodes. */
const sortAccounts = (list) =>
  [...list].sort((x, y) => Buffer.compare(Buffer.from(toBytes(x)), Buffer.from(toBytes(y))))

/** Fixed by owner and mint, so a wallet can find its balances unaided. Matches
 *  the CLI's derive-token-account with its default all-zero seed. */
function deriveTokenAccount(mint, owner) {
  const seed = sha256(concat(toBytes(owner), toBytes(mint), new Uint8Array(32)))
  return deriveProgramAddress({ programAddress: TOKEN_PROGRAM, seed }).address
}

/* ---------- plumbing ---------- */

function json(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json')
  res.send(JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

let cached = null
function client() {
  if (!cached) cached = createThruClient({ transport: createGrpcTransport({ baseUrl: RPC_URL }) })
  return cached
}

async function getAccount(c, address) {
  try { return await c.accounts.get(address) } catch { return null }
}

/** Sponsor-paid transaction. The fee is 1 here because the sponsor has a
 *  balance to pay it from; wallet-paid transactions use 0 instead. */
async function sponsorSend(c, { program, readWrite = [], readOnly = [], data, stateUnits = 60_000 }) {
  const pub = process.env.THRU_SPONSOR_PUBKEY
  const priv = hexToBytes(process.env.THRU_SPONSOR_PRIVKEY)
  const [me, height] = await Promise.all([c.accounts.get(pub), c.blocks.getBlockHeight()])
  const { rawTransaction } = await new TransactionBuilder().buildAndSign({
    feePayer: { publicKey: pub, privateKey: priv },
    program,
    accounts: { readWriteAccounts: readWrite, readOnlyAccounts: readOnly },
    header: {
      fee: 1n,
      nonce: me?.meta?.nonce ?? 0n,
      startSlot: height.finalized,
      expiryAfter: 100,
      chainId: await c.chain.getChainId(),
      computeUnits: 300_000_000,
      stateUnits,
      memoryUnits: 60_000,
    },
    instructionData: data,
  })
  return c.transactions.send(rawTransaction)
}

/* ---------- actions ---------- */

/** Everything a browser needs to build a transaction, in one round trip. */
async function prepare(c, { address }) {
  const [account, height, chainId] = await Promise.all([
    getAccount(c, address),
    c.blocks.getBlockHeight(),
    c.chain.getChainId(),
  ])
  return {
    ok: true,
    exists: account !== null,
    nonce: (account?.meta?.nonce ?? 0n).toString(),
    startSlot: height.finalized.toString(),
    chainId,
    sponsor: process.env.THRU_SPONSOR_PUBKEY,
  }
}

/**
 * CREATE_ACCOUNT for the EOA program:
 *   [discriminant u32 = 0][proof_size u64][eoa_account_idx u16][signature 64][proof]
 *
 * The signature is the new key's own, over
 *   "tn_eoa_create_v1" || chain_id || fee_payer || eoa
 * signed raw. The sponsor cannot forge it and cannot reuse it: the message
 * names this chain and this fee payer, so it authorises exactly one creation.
 */
async function create(c, { address, signature }) {
  const existing = await getAccount(c, address)
  if (existing) return { ok: true, already: true, address }

  const sig = Buffer.from(signature, 'base64')
  if (sig.length !== 64) return { ok: false, error: 'That signature is not 64 bytes.' }

  const proof = await proofs.generateStateProof(c.ctx, { address, proofType: PROOF_CREATING })

  // Index 0 is the fee payer and 1 the program, so the single read-write
  // account, the one being created, sits at 2.
  const head = Buffer.alloc(4 + 8 + 2)
  head.writeUInt32LE(0, 0)
  head.writeBigUInt64LE(BigInt(proof.proof.length), 4)
  head.writeUInt16LE(2, 12)
  const data = concat(new Uint8Array(head), new Uint8Array(sig), proof.proof)

  const txn = await sponsorSend(c, {
    program: EOA_PROGRAM,
    readWrite: [address],
    data,
  })
  return { ok: true, already: false, address, signature: txn }
}

/**
 * INITIALIZE_ACCOUNT for the token program:
 *   [0x01][account u16][mint u16][owner u16][seed 32][proof]
 *
 * No signature from the owner is needed, or possible: ownership is a field the
 * token program writes, not a claim anybody proves. So the sponsor can open a
 * visitor's token accounts and still have no way to spend from them.
 */
async function open(c, { owner, mint }) {
  const address = deriveTokenAccount(mint, owner)

  const already = await getAccount(c, address)
  if (already) return { ok: true, already: true, account: address }

  const ownerAccount = await getAccount(c, owner)
  if (!ownerAccount) return { ok: false, error: 'Register your wallet on chain first.' }

  const mintAccount = await getAccount(c, mint)
  if (!mintAccount) return { ok: false, error: 'No mint at that address.' }

  const proof = await proofs.generateStateProof(c.ctx, { address, proofType: PROOF_CREATING })

  const readWrite = [address]
  const readOnly = sortAccounts([mint, owner])
  const at = (a) => (a === address ? 2 : 3 + readOnly.indexOf(a))

  const head = Buffer.alloc(1 + 2 + 2 + 2 + 32)
  head.writeUInt8(0x01, 0)
  head.writeUInt16LE(at(address), 1)
  head.writeUInt16LE(at(mint), 3)
  head.writeUInt16LE(at(owner), 5)
  // seed stays 32 zero bytes so the address matches derive-token-account

  const txn = await sponsorSend(c, {
    program: TOKEN_PROGRAM,
    readWrite,
    readOnly,
    data: concat(new Uint8Array(head), proof.proof),
  })
  return { ok: true, already: false, account: address, signature: txn }
}

/** One derived address and one balance per mint, so the wallet page is a single
 *  request rather than one per token. */
async function balances(c, { owner, mints }) {
  const out = await Promise.all(mints.map(async (mint) => {
    const account = deriveTokenAccount(mint, owner)
    const acc = await getAccount(c, account)
    if (!acc) return { mint, account, exists: false, amount: '0' }
    const raw = Buffer.from(acc?.data?.data ?? [])
    const amount = raw.length >= 72 ? raw.readBigUInt64LE(64).toString() : '0'
    return { mint, account, exists: true, amount }
  }))
  return { ok: true, balances: out }
}

/** Forwards bytes the browser already signed. Nothing here can change them:
 *  the signature covers the whole body, so a tampered transaction is simply
 *  rejected by the node. */
async function submit(c, { raw }) {
  const bytes = new Uint8Array(Buffer.from(raw, 'base64'))
  if (bytes.length < 100 || bytes.length > 100_000) {
    return { ok: false, error: 'That is not a transaction.' }
  }
  const signature = await c.transactions.send(bytes)
  return { ok: true, signature }
}

async function status(c, { signature }) {
  const txn = await c.transactions.get(signature)
  const text = JSON.stringify(txn, (k, v) => (typeof v === 'bigint' ? v.toString() : v))
  const vmError = Number(text.match(/"vmError":(-?\d+)/)?.[1] ?? NaN)
  if (!Number.isFinite(vmError)) return { ok: true, status: { settled: false } }
  const userError = Number(text.match(/"userErrorCode":(\d+)/)?.[1] ?? 0)
  return {
    ok: true,
    status: { settled: true, succeeded: vmError === 0, vmError, userError },
  }
}

/* ---------- entry ---------- */

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Use POST.' })

  if (!process.env.THRU_SPONSOR_PUBKEY || !process.env.THRU_SPONSOR_PRIVKEY) {
    return json(res, 503, { ok: false, error: 'The wallet service is not set up yet.' })
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}
  const action = String(body.action ?? '')

  const bad = (field) => json(res, 400, { ok: false, error: `${field} does not look like a Thru address.` })
  if (body.address !== undefined && !ADDRESS_RE.test(body.address)) return bad('address')
  if (body.owner !== undefined && !ADDRESS_RE.test(body.owner)) return bad('owner')
  if (body.mint !== undefined && !ADDRESS_RE.test(body.mint)) return bad('mint')
  if (body.mints !== undefined) {
    if (!Array.isArray(body.mints) || body.mints.length > 40) {
      return json(res, 400, { ok: false, error: 'Ask for at most 40 mints at a time.' })
    }
    if (!body.mints.every((m) => ADDRESS_RE.test(m))) return bad('mints')
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || 'unknown'
  const metered = action === 'create' || action === 'open'

  if (metered) {
    const wait = overBudget(ip)
    if (wait > 0) {
      return json(res, 429, { ok: false, error: `Slow down. Try again in ${Math.ceil(wait / 1000)} seconds.` })
    }
    charge(ip)
  }

  try {
    const c = client()
    switch (action) {
      case 'prepare':  return json(res, 200, await prepare(c, body))
      case 'create':   return json(res, 200, await create(c, body))
      case 'open':     return json(res, 200, await open(c, body))
      case 'balances': return json(res, 200, await balances(c, body))
      case 'submit':   return json(res, 200, await submit(c, body))
      case 'status':   return json(res, 200, await status(c, body))
      default:         return json(res, 400, { ok: false, error: `Unknown action "${action}".` })
    }
  } catch (err) {
    const detail = String(err?.message ?? err)
    console.error(`wallet ${action} failed:`, detail)
    // A failed create or open should not also cost the visitor their allowance.
    if (metered) refund(ip)
    return json(res, 502, { ok: false, error: 'That did not go through.', detail: detail.slice(0, 300) })
  }
}
