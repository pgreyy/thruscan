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

const TUSD_MINT = process.env.THRU_TUSD_MINT || 'tabAx2SejGxnH7qDY02xofs0rrhBV2Cdoxg0yeG0hv7Z0R'

/* 500 tUSD a day, and never more than 10,000 held at once.
   The daily figure is enough to trade with and to seed a small pool; the cap is
   what stops one account accumulating enough to move every price on the
   network. Both are checked, and the cap is checked against the account's
   actual balance rather than a running total, so it self-heals: spend some and
   you can claim again, which is the behaviour people expect and the one a
   serverless function can honour without a database. */
const FAUCET_AMOUNT = BigInt(process.env.THRU_FAUCET_AMOUNT || '500000000')
const FAUCET_CAP = BigInt(process.env.THRU_FAUCET_CAP || '10000000000')

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

/* tUSD claims are capped per account for much longer than per IP, because the
   point is to stop one person draining the supply rather than to stop a
   double-click. Only recorded once the mint actually lands, so a failure does
   not lock someone out for a day. */
const CLAIM_WINDOW = 24 * 60 * 60 * 1000
const claims = new Map()

function claimedTooRecently(who) {
  const now = Date.now()
  for (const [k, at] of claims) if (now - at > CLAIM_WINDOW * 2) claims.delete(k)
  const last = claims.get(who)
  return last && now - last < CLAIM_WINDOW ? CLAIM_WINDOW - (now - last) : 0
}

function human(ms) {
  const mins = Math.ceil(ms / 60000)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`
  const hrs = Math.ceil(mins / 60)
  return `${hrs} hour${hrs === 1 ? '' : 's'}`
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
function deriveTokenAccount(mint, owner, seed = new Uint8Array(32)) {
  const digest = sha256(concat(toBytes(owner), toBytes(mint), seed))
  return deriveProgramAddress({ programAddress: TOKEN_PROGRAM, seed: digest }).address
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
    // The wallet's native balance decides whether it can pay a fee at all. A
    // freshly created account holds nothing, and any fee above its balance
    // fails the whole transaction rather than being taken from elsewhere.
    balance: (account?.meta?.balance ?? 0n).toString(),
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

/**
 * The tUSD faucet, which used to be its own function.
 *
 * It lives here because Vercel's Hobby plan allows twelve serverless functions
 * and a faucet is not worth one of them when it is three lines of difference
 * from what this file already does.
 *
 * Two ways in. A wallet passes its owner address and the account is derived and
 * opened if needed, so claiming is one button. Someone using the CLI passes the
 * token account directly, because their account was made elsewhere and we
 * should not assume the default seed.
 *
 * MINT_TO, opcode 0x03: [0x03][mint u16][dest u16][authority u16][amount u64].
 * The sponsor holds the mint authority and is also the fee payer, so the
 * authority index is 0.
 */
async function faucet(c, { owner, account }) {
  let dest = account

  if (!dest) {
    if (!owner) return { ok: false, error: 'Pass a wallet address or a token account.' }
    dest = deriveTokenAccount(TUSD_MINT, owner)
    if (!(await getAccount(c, dest))) {
      const made = await open(c, { owner, mint: TUSD_MINT })
      if (!made.ok) return made
      // The account lands a slot or two later. Minting into an account that is
      // not there yet fails with a number nobody can interpret, so wait.
      for (let i = 0; i < 8 && !(await getAccount(c, dest)); i++) {
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
  }

  const held = await getAccount(c, dest)
  if (!held) {
    return { ok: false, error: 'No account at that address. Open your tUSD account first.' }
  }
  if ((held?.meta?.dataSize ?? 0) !== TOKEN_ACCOUNT_SIZE) {
    return {
      ok: false,
      error: 'That is an account, but not a token account. Paste the address that '
        + 'thru token initialize-account printed, not your wallet address.',
    }
  }

  const raw = Buffer.from(held?.data?.data ?? [])
  if (raw.length >= 32 && !raw.subarray(0, 32).equals(Buffer.from(toBytes(TUSD_MINT)))) {
    return { ok: false, error: 'That token account is for a different token. It has to be a tUSD account.' }
  }

  // The cap is on what the account holds, not on what it has ever been given.
  const balance = raw.length >= 72 ? raw.readBigUInt64LE(64) : 0n
  if (balance >= FAUCET_CAP) {
    return {
      ok: false,
      error: `That account already holds ${Number(balance) / 1e6} tUSD, and the faucet caps you at `
        + `${Number(FAUCET_CAP) / 1e6}. Spend some and come back.`,
    }
  }

  const readWrite = sortAccounts([TUSD_MINT, dest])
  const at = (a) => 2 + readWrite.indexOf(a)
  const data = Buffer.alloc(15)
  data.writeUInt8(0x03, 0)
  data.writeUInt16LE(at(TUSD_MINT), 1)
  data.writeUInt16LE(at(dest), 3)
  data.writeUInt16LE(0, 5)
  const amount = balance + FAUCET_AMOUNT > FAUCET_CAP ? FAUCET_CAP - balance : FAUCET_AMOUNT
  data.writeBigUInt64LE(amount, 7)

  const signature = await sponsorSend(c, {
    program: TOKEN_PROGRAM,
    readWrite,
    data: new Uint8Array(data),
    stateUnits: 20_000,
  })
  return { ok: true, signature, amount: amount.toString(), account: dest, held: balance.toString() }
}

/* ---------- launching ----------
   A launch needs three accounts before the curve can exist: a mint whose
   authority is thrupad, a vault for the token and a vault for the quote asset,
   both owned by thrupad. All three need creation state proofs, which a browser
   cannot produce, so the sponsor makes them.

   It does not make the launch itself. That one is signed by the creator, whose
   address the program records and pays fees to, and only they can sign it.

   INITIALIZE_MINT, recovered from a live transaction:
     [0x00][mint u16][decimals u8][creator 32][mint_auth 32][freeze_auth 32]
     [has_freeze u8][ticker_len u8][ticker 8][seed 32][proof]

   The mint's address is deriveProgramAddress(TOKEN_PROGRAM,
   sha256(creator || seed)), confirmed against the CLI. */

function deriveMint(creator, seed) {
  return deriveProgramAddress({
    programAddress: TOKEN_PROGRAM,
    seed: sha256(concat(toBytes(creator), seed)),
  }).address
}

function randomSeed() {
  return new Uint8Array(createHash('sha256').update(
    Buffer.from(`${Date.now()}:${Math.random()}:${Math.random()}`),
  ).digest())
}

async function openTokenAccountFor({ c, mint, owner, seed }) {
  const account = deriveTokenAccount(mint, owner, seed)
  if (await getAccount(c, account)) return { account, already: true }

  const proof = await proofs.generateStateProof(c.ctx, { address: account, proofType: PROOF_CREATING })
  const readWrite = [account]
  const readOnly = sortAccounts([mint, owner])
  const at = (a) => (a === account ? 2 : 3 + readOnly.indexOf(a))

  const head = Buffer.alloc(1 + 2 + 2 + 2 + 32)
  head.writeUInt8(0x01, 0)
  head.writeUInt16LE(at(account), 1)
  head.writeUInt16LE(at(mint), 3)
  head.writeUInt16LE(at(owner), 5)
  Buffer.from(seed).copy(head, 7)

  const signature = await sponsorSend(c, {
    program: TOKEN_PROGRAM,
    readWrite,
    readOnly,
    data: concat(new Uint8Array(head), proof.proof),
  })
  return { account, already: false, signature }
}

/**
 * Everything a launch needs, made in one call so the Create form is a button.
 *
 * The mint's creator field is the sponsor, because the token program refuses a
 * mint whose creator is not the fee payer. That field is metadata and nothing
 * reads it. The one that matters is the LAUNCH record's creator, which thrupad
 * takes from the launch transaction's fee payer, so it is the visitor who signs
 * that and the visitor the fees accrue to. The sponsor cannot sign it for them
 * and would not want to.
 *
 * The mint authority is thrupad, and there is no second instruction anywhere
 * that mints, which is what makes the supply fixed by construction rather than
 * by promise.
 */
async function padAccounts(c, { owner, symbol, quoteMint, padProgram }) {
  const ticker = String(symbol ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{2,8}$/.test(ticker)) {
    return { ok: false, error: 'A ticker is 2 to 8 letters or digits.' }
  }
  if (!(await getAccount(c, owner))) {
    return { ok: false, error: 'Register your wallet on chain first.' }
  }
  const pad = padProgram || process.env.THRU_PAD_PROGRAM
  if (!ADDRESS_RE.test(pad ?? '')) return { ok: false, error: 'No launchpad program configured.' }

  const sponsor = process.env.THRU_SPONSOR_PUBKEY
  const mintSeed = randomSeed()
  const mint = deriveMint(sponsor, mintSeed)
  if (await getAccount(c, mint)) return { ok: false, error: 'Seed collision. Try again.' }

  const proof = await proofs.generateStateProof(c.ctx, { address: mint, proofType: PROOF_CREATING })

  const head = Buffer.alloc(1 + 2 + 1 + 32 + 32 + 32 + 1 + 1 + 8 + 32)
  let o = 0
  head.writeUInt8(0x00, o); o += 1
  head.writeUInt16LE(2, o); o += 2          // the mint, the only read-write account
  head.writeUInt8(6, o); o += 1             // decimals
  Buffer.from(toBytes(sponsor)).copy(head, o); o += 32    // creator: has to be the payer
  Buffer.from(toBytes(pad)).copy(head, o); o += 32        // mint authority: thrupad
  o += 32                                   // freeze authority: none
  head.writeUInt8(0, o); o += 1             // has_freeze
  head.writeUInt8(ticker.length, o); o += 1
  head.write(ticker, o, 8, 'ascii'); o += 8
  Buffer.from(mintSeed).copy(head, o)

  const mintSig = await sponsorSend(c, {
    program: TOKEN_PROGRAM,
    readWrite: [mint],
    data: concat(new Uint8Array(head), proof.proof),
  })

  // The vaults refer to the mint, so it has to exist before they are made.
  for (let i = 0; i < 10 && !(await getAccount(c, mint)); i++) {
    await new Promise((r) => setTimeout(r, 1500))
  }
  if (!(await getAccount(c, mint))) {
    return { ok: false, error: 'The mint did not land. Try again in a moment.', mint, signature: mintSig }
  }

  const tokenVault = await openTokenAccountFor({ c, mint, owner: pad, seed: randomSeed() })
  const quoteVault = await openTokenAccountFor({ c, mint: quoteMint || TUSD_MINT, owner: pad, seed: randomSeed() })

  return {
    ok: true,
    mint,
    tokenVault: tokenVault.account,
    quoteVault: quoteVault.account,
    signature: mintSig,
  }
}

/* ---------- names ----------
   ThruNames runs on Thru's own name service, under a root we own. Registering
   under a root needs that root's authority, and a transaction carries one
   signature, so ThruScan has to sign. What stops that making ThruScan the owner
   of everybody's name is that the instruction takes the owner as an account
   index rather than implying the fee payer, so the visitor's wallet goes in the
   owner field while ThruScan merely pays.

   The ABI was recovered from live transactions; src/lib/names.js has it written
   out. The trap worth repeating here: the name field is 64 bytes, and a 32-byte
   guess reverts with no user error code at all. */

const NAME_SERVICE_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUF'
const ROOT_REGISTRAR = process.env.THRU_NAME_ROOT || 'taGEX4QNK_WjsknEK4kl0_ppCJUimoanrmFuU27t1gS3pw'
const NAME_FIELD = 64
const KEY_FIELD = 32
const VALUE_FIELD = 256
const NAME_RE = /^(?!-)(?!.*--)[a-z0-9-]{3,32}(?<!-)$/

function domainAccount(name, parent = ROOT_REGISTRAR) {
  const seed = sha256(concat(toBytes(parent), Buffer.from(name, 'utf8')))
  return deriveProgramAddress({ programAddress: NAME_SERVICE_PROGRAM, seed }).address
}

/** Is this name free, and where would it live? */
async function nameCheck(c, { name }) {
  if (!NAME_RE.test(String(name ?? ''))) {
    return { ok: false, error: 'Lowercase letters, numbers and hyphens, 3 to 32 characters.' }
  }
  const account = domainAccount(name)
  const held = await getAccount(c, account)
  return {
    ok: true,
    name,
    account,
    taken: held !== null,
    data: held ? Buffer.from(held?.data?.data ?? []).toString('base64') : null,
  }
}

/** Register `name`, owned by `owner`, paid for and authorised by the sponsor. */
async function nameRegister(c, { name, owner }) {
  if (!NAME_RE.test(String(name ?? ''))) {
    return { ok: false, error: 'Lowercase letters, numbers and hyphens, 3 to 32 characters.' }
  }
  if (!(await getAccount(c, owner))) {
    return { ok: false, error: 'Register your wallet on chain before claiming a name.' }
  }

  const account = domainAccount(name)
  if (await getAccount(c, account)) return { ok: false, error: 'That name is taken.' }

  const proof = await proofs.generateStateProof(c.ctx, { address: account, proofType: PROOF_CREATING })

  const readWrite = sortAccounts([account, ROOT_REGISTRAR])
  const readOnly = [owner]
  const at = (a) => {
    const i = readWrite.indexOf(a)
    return i >= 0 ? 2 + i : 2 + readWrite.length + readOnly.indexOf(a)
  }

  const head = Buffer.alloc(84)
  head.writeUInt32LE(1, 0)                 // REGISTER_SUBDOMAIN
  head.writeUInt16LE(at(account), 4)
  head.writeUInt16LE(at(ROOT_REGISTRAR), 6)
  head.writeUInt16LE(at(owner), 8)         // the visitor owns it
  head.writeUInt16LE(0, 10)                // authority: the sponsor, which holds the root
  head.write(name, 12, NAME_FIELD, 'utf8')
  head.writeBigUInt64LE(BigInt(Buffer.byteLength(name)), 76)

  const signature = await sponsorSend(c, {
    program: NAME_SERVICE_PROGRAM,
    readWrite,
    readOnly,
    data: concat(new Uint8Array(head), proof.proof),
  })
  return { ok: true, name, account, owner, signature }
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
  if (body.quoteMint !== undefined && !ADDRESS_RE.test(body.quoteMint)) return bad('quoteMint')
  if (body.padProgram !== undefined && !ADDRESS_RE.test(body.padProgram)) return bad('padProgram')
  if (body.account !== undefined && !ADDRESS_RE.test(body.account)) return bad('account')
  if (body.mints !== undefined) {
    if (!Array.isArray(body.mints) || body.mints.length > 40) {
      return json(res, 400, { ok: false, error: 'Ask for at most 40 mints at a time.' })
    }
    if (!body.mints.every((m) => ADDRESS_RE.test(m))) return bad('mints')
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || 'unknown'
  const metered = action === 'create' || action === 'open' || action === 'faucet'
    || action === 'name-register' || action === 'pad-accounts'

  if (metered) {
    const wait = overBudget(ip)
    if (wait > 0) {
      return json(res, 429, { ok: false, error: `Slow down. Try again in ${Math.ceil(wait / 1000)} seconds.` })
    }
    charge(ip)
  }

  // tUSD is capped per account as well as per IP. An IP limit alone is beaten
  // by a phone on mobile data, and an account limit alone by making new
  // accounts, so neither is sufficient and both are cheap.
  if (action === 'faucet') {
    const who = body.account || body.owner
    const wait = claimedTooRecently(who)
    if (wait > 0) {
      refund(ip)
      return json(res, 429, {
        ok: false,
        error: `That account already claimed. It can claim again in ${human(wait)}.`,
      })
    }
  }

  try {
    const c = client()
    switch (action) {
      case 'prepare':  return json(res, 200, await prepare(c, body))
      case 'create':   return json(res, 200, await create(c, body))
      case 'open':     return json(res, 200, await open(c, body))
      case 'faucet': {
        const out = await faucet(c, body)
        if (out.ok) claims.set(body.account || body.owner, Date.now())
        return json(res, 200, out)
      }
      case 'balances': return json(res, 200, await balances(c, body))
      case 'pad-accounts':  return json(res, 200, await padAccounts(c, body))
      case 'name-check':    return json(res, 200, await nameCheck(c, body))
      case 'name-register': return json(res, 200, await nameRegister(c, body))
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
