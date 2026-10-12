// tools/betanet/pool.mjs
//
// Step 9: a test token and a WTHRU pool on ThruSwap, so Swap has something to
// trade.
//
//   node tools/betanet/pool.mjs                                  # test token only
//   POOL_WTHRU=<WTHRU base units> POOL_TEST=<whole BNTEST> node tools/betanet/pool.mjs
//
// The test token is BNTEST ("BetaNet test"), 6 decimals, minted by the deploy
// authority, which keeps the mint authority: it is a test asset and says so.
//
// The pool is WTHRU against BNTEST. Its vaults are token accounts owned by the
// thruswap program and its LP mint's authority is thruswap, which is what
// CREATE requires. The authority wraps native THRU into WTHRU (one WTHRU base
// unit per native THRU unit), then CREATE records the pool and ADD seeds both
// sides. Nothing is seeded until POOL_WTHRU is given, because how many WTHRU
// base units "one WTHRU" means is a decision, not a default.
//
// Idempotent: anything already on chain is reused.

import { AUTHORITY, record, save, log } from './config.mjs'
import { signer, seed32, getAccount, landed, send, outcome, sortAccounts, creationProof } from './chain.mjs'
import { deriveMint, deriveTokenAccountAt, createMintStep, openAccountStep } from '../../src/lib/tokenix.js'
import { buildWrap } from '../../src/lib/wthru.js'
import { buildAddLiquidityInstruction, decodeSwapRegistry, OP_CREATE } from '../../src/lib/swap.js'

const TOKEN_PROGRAM = 'taTOKENKRgcl3vO0yVhftATDbXuhgWcfaaxv9xpEEdMdUE'
const WTHRU_MINT = 'taaoXQw03WlYWdo1jhfFi2Nqfqsf4RqYySn_89mchjCiLb'
const TEST = { ticker: 'BNTEST', decimals: 6, supply: 10_000n }
const FEE_BPS = 30

const me = signer(AUTHORITY)
const payer = me.publicKey
const deployed = record().addresses

/** One instruction, its indices computed against the sorted account lists. */
async function single(label, step, readWrite, readOnly, stateUnits = 1024) {
  const rw = sortAccounts(readWrite.filter((a) => a !== payer))
  const ro = sortAccounts(readOnly.filter((a) => a !== payer && !rw.includes(a) && a !== step.program))
  const at = (a) => {
    if (a === payer) return 0
    if (a === step.program) return 1
    const i = rw.indexOf(a); if (i >= 0) return 2 + i
    const j = ro.indexOf(a); if (j >= 0) return 2 + rw.length + j
    throw new Error(`${label}: ${a} is not in the account list`)
  }
  const signature = await send(me, { program: step.program, readWrite: rw, readOnly: ro, data: step.build(at), stateUnits })
  const r = await outcome(signature)
  if (!r.ok) throw new Error(`${label} failed: ${signature} ${JSON.stringify(r)}`)
  save({ signatures: { [label]: signature } })
  log(`${label}: ${signature}`)
  return signature
}

async function ensureMint(label, mint, { creator, mintAuthority, ticker, seed, decimals }) {
  if (await getAccount(mint)) return log(`${label}: ${mint} exists`)
  const proof = await creationProof(mint)
  await single(label, createMintStep({ mint, creator, mintAuthority, ticker, seed, proof, decimals }), [mint], [])
  if (!(await landed(mint))) throw new Error(`${label}: ${mint} did not land`)
}

async function ensureAccount(label, mint, owner, seed = new Uint8Array(32)) {
  const account = await deriveTokenAccountAt(mint, owner, seed)
  if (await getAccount(account)) { log(`${label}: ${account} exists`); return account }
  const proof = await creationProof(account)
  await single(label, openAccountStep({ account, mint, owner, seed, proof }), [account], [mint, owner])
  if (!(await landed(account))) throw new Error(`${label}: ${account} did not land`)
  return account
}

const amountOf = async (account) => {
  const a = await getAccount(account)
  const b = Buffer.from(a?.data?.data ?? [])
  return b.length >= 72 ? b.readBigUInt64LE(64) : 0n
}

/* ---------- the test token ---------- */

const testSeed = seed32('thruscan-bn-testtoken-1')
const testMint = await deriveMint(payer, testSeed)
await ensureMint('BNTEST mint', testMint, { creator: payer, mintAuthority: payer, ticker: TEST.ticker, seed: testSeed, decimals: TEST.decimals })
const myTest = await ensureAccount('BNTEST account (authority)', testMint, payer)
const wantTest = TEST.supply * 10n ** BigInt(TEST.decimals)
const haveTest = await amountOf(myTest)
if (haveTest < wantTest) {
  await single('BNTEST mint_to authority', {
    program: TOKEN_PROGRAM,
    build: (at) => {
      const d = Buffer.alloc(15)
      d.writeUInt8(0x03, 0); d.writeUInt16LE(at(testMint), 1); d.writeUInt16LE(at(myTest), 3); d.writeUInt16LE(at(payer), 5)
      d.writeBigUInt64LE(wantTest - haveTest, 7)
      return new Uint8Array(d)
    },
  }, [testMint, myTest], [])
}
save({ addresses: { TEST_MINT: testMint } })
log(`BNTEST ${testMint}: authority holds ${await amountOf(myTest)} base units`)

/* ---------- the pool ---------- */

const poolWthru = process.env.POOL_WTHRU
const poolTest = process.env.POOL_TEST
if (!/^\d+$/.test(poolWthru ?? '') || !/^\d+$/.test(poolTest ?? '')) {
  log('Pool not created: set POOL_WTHRU (WTHRU base units) and POOL_TEST (whole BNTEST) to seed it.')
  process.exit(0)
}

const swap = deployed.THRUSWAP_PROGRAM
const registry = deployed.THRUSWAP_REGISTRY
if (!swap || !registry) throw new Error('thruswap and its registry must be deployed first')

const readRegistry = async () => decodeSwapRegistry(Buffer.from((await getAccount(registry)).data.data).toString('base64'))
let reg = await readRegistry()
let pool = reg.pools.find((p) => [p.mintA, p.mintB].includes(WTHRU_MINT) && [p.mintA, p.mintB].includes(testMint))

const vaultWthru = await ensureAccount('pool vault WTHRU', WTHRU_MINT, swap, seed32('thruscan-bn-pool0-wthru'))
const vaultTest = await ensureAccount('pool vault BNTEST', testMint, swap, seed32('thruscan-bn-pool0-bntest'))
const lpSeed = seed32('thruscan-bn-pool0-lp')
const lpMint = await deriveMint(payer, lpSeed)
await ensureMint('pool LP mint', lpMint, { creator: payer, mintAuthority: swap, ticker: 'BNLP', seed: lpSeed, decimals: 6 })

if (!pool) {
  const poolId = reg.poolCount
  await single('pool CREATE', {
    program: swap,
    build: (at) => {
      const d = Buffer.alloc(17)
      let o = 0
      d.writeUInt8(OP_CREATE, o); o += 1
      d.writeUInt16LE(at(registry), o); o += 2
      d.writeUInt16LE(poolId, o); o += 2
      d.writeUInt16LE(at(WTHRU_MINT), o); o += 2
      d.writeUInt16LE(at(testMint), o); o += 2
      d.writeUInt16LE(at(vaultWthru), o); o += 2
      d.writeUInt16LE(at(vaultTest), o); o += 2
      d.writeUInt16LE(at(lpMint), o); o += 2
      d.writeUInt16LE(FEE_BPS, o)
      return new Uint8Array(d)
    },
  }, [registry], [WTHRU_MINT, testMint, vaultWthru, vaultTest, lpMint])
  reg = await readRegistry()
  pool = reg.pools.find((p) => p.id === poolId) ?? reg.pools.at(-1)
}
log(`pool ${pool.id}: ${JSON.stringify(pool, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 300)}`)

const myWthru = await ensureAccount('WTHRU account (authority)', WTHRU_MINT, payer)
const myLp = await ensureAccount('LP account (authority)', lpMint, payer)

const wantWthru = BigInt(poolWthru)
const wantTestIn = BigInt(poolTest) * 10n ** BigInt(TEST.decimals)
if ((await amountOf(vaultWthru)) === 0n) {
  const short = wantWthru - (await amountOf(myWthru))
  if (short > 0n) {
    const w = buildWrap({ payer, dest: myWthru, amount: short })
    const sig = await send(me, { ...w, stateUnits: 1024 })
    const r = await outcome(sig)
    if (!r.ok) throw new Error(`wrap failed: ${sig} ${JSON.stringify(r)}`)
    save({ signatures: { 'wrap THRU to WTHRU (authority)': sig } })
    log(`wrapped ${short} THRU into WTHRU: ${sig}`)
  }
  const isA = pool.mintA === WTHRU_MINT
  const add = buildAddLiquidityInstruction({
    registry, poolId: pool.id,
    vaultA: pool.vaultA, vaultB: pool.vaultB,
    userA: isA ? myWthru : myTest, userB: isA ? myTest : myWthru,
    lpMint, userLp: myLp,
    amountA: isA ? wantWthru : wantTestIn, amountB: isA ? wantTestIn : wantWthru,
  })
  const sig = await send(me, { program: swap, ...add, stateUnits: 1024 })
  const r = await outcome(sig)
  if (!r.ok) throw new Error(`add liquidity failed: ${sig} ${JSON.stringify(r)}`)
  save({ signatures: { 'pool seed ADD': sig } })
  log(`seeded pool ${pool.id} with ${wantWthru} WTHRU base units and ${poolTest} BNTEST: ${sig}`)
}
log(`vaults: WTHRU ${await amountOf(vaultWthru)}, BNTEST ${await amountOf(vaultTest)}`)
