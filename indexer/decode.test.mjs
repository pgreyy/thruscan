// indexer/decode.test.mjs
//
// The decoder, checked without a chain.
//
// Worth having for a reason specific to this project: betanet currently
// carries nothing but the node's own keepalive transactions, and alphanet is
// down, so running the indexer end to end proves the loop works and proves
// nothing at all about whether a launchpad buy is read as a buy. These build
// the transactions by hand instead.
//
//   node --test indexer/decode.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Pubkey, keys } from '@thru/sdk'
import { makeDecoder } from './decode.mjs'
import { SYSTEM } from './addresses.mjs'

const A = {
  ...SYSTEM,
  THRUPAD_PROGRAM: 'tastnRlQL8RGYeByXK2QAzaqdnfvI6pVn0e89JSl6Hiu8I',
  THRUSWAP_PROGRAM: 'taCXE0eEQbUHU90dyZ__Bz1yfQabjyaD4xaSHKUw3Q1M4N',
  PALS_PROGRAM: 'taXgi_tvqshzois9iLBY5msTGlQvW_GydSKRODoPgPVInH',
  WALL_PROGRAM: 'tagNpTX6NLyLv1099dM7HQySw9j_dSH8GBoijY4fGCFVwH',
}

const decode = makeDecoder(A)

const payer = (await keys.generateKeyPair()).address
const other = (await keys.generateKeyPair()).address

/* A transaction as the SDK hands one back: pubkeys wrapped, signature 64
   bytes, instruction data raw. */
function txn({ program, data, rw = [], ro = [], userError = 0, vmError = 0, slot = 100, blockOffset = 168, flags = 0 }) {
  const sig = new Uint8Array(64)
  sig.set(new TextEncoder().encode(`${program.slice(0, 6)}:${slot}:${blockOffset}`))
  return {
    program: Pubkey.from(program),
    feePayer: Pubkey.from(payer),
    readWriteAccounts: rw.map((a) => Pubkey.from(a)),
    readOnlyAccounts: ro.map((a) => Pubkey.from(a)),
    instructionData: data,
    flags,
    signature: sig,
    executionResult: { userErrorCode: userError, vmError },
    slot,
    blockOffset,
  }
}

const bytes = (...b) => new Uint8Array(b)
/* The EOA and name programs read their opcode as a little endian u32, not a
   byte, which is the sort of difference that produces a plausible wrong
   label rather than an error. */
const u32le = (n, ...rest) => new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255, ...rest])

test('launchpad operations each get their own kind', () => {
  const cases = [
    [1, 'launch', 'Launched a token'],
    [2, 'buy', 'Bought on the launchpad'],
    [3, 'sell', 'Sold on the launchpad'],
    [4, 'claim', 'Claimed creator fees'],
    [5, 'graduate', 'Graduated a launch'],
    [6, 'migrate', 'Migrated to the AMM'],
  ]
  for (const [op, kind, label] of cases) {
    const r = decode(txn({ program: A.THRUPAD_PROGRAM, data: bytes(op) }))
    assert.equal(r.kind, kind, `op ${op} kind`)
    assert.equal(r.label, label, `op ${op} label`)
    assert.equal(r.op, op)
  }
})

test('the AMM and our old swap use different opcode numbering', () => {
  // The native AMM starts at 0, thruswap started at 1. Reading one with the
  // other's table turns a swap into a pool creation, so they are separate.
  assert.equal(decode(txn({ program: A.AMM_PROGRAM, data: bytes(3) })).kind, 'swap')
  assert.equal(decode(txn({ program: A.AMM_PROGRAM, data: bytes(0) })).kind, 'pool')
  assert.equal(decode(txn({ program: A.THRUSWAP_PROGRAM, data: bytes(4) })).kind, 'swap')
  assert.equal(decode(txn({ program: A.THRUSWAP_PROGRAM, data: bytes(1) })).kind, 'pool')
})

test('token program opcodes', () => {
  const m = { 0: 'token', 1: 'account', 2: 'transfer', 3: 'mint', 4: 'burn' }
  for (const [op, kind] of Object.entries(m)) {
    assert.equal(decode(txn({ program: A.TOKEN_PROGRAM, data: bytes(Number(op)) })).kind, kind)
  }
})

test('account program reads its opcode as a u32', () => {
  assert.equal(decode(txn({ program: A.EOA_PROGRAM, data: u32le(0) })).label, 'Account created')
  assert.equal(decode(txn({ program: A.EOA_PROGRAM, data: u32le(1) })).kind, 'transfer')
})

test('a name registration carries the name', () => {
  const name = 'greyy'
  const data = u32le(1, name.length, ...new TextEncoder().encode(name))
  const r = decode(txn({ program: A.NAME_SERVICE_PROGRAM, data }))
  assert.equal(r.kind, 'name')
  assert.equal(r.label, 'Registered greyy')
})

test('a faucet claim is its own kind', () => {
  assert.equal(decode(txn({ program: A.NATIVE_FAUCET_PROGRAM, data: u32le(1) })).kind, 'faucet')
})

test('an unknown program still produces a row', () => {
  // Betanet is full of the node's own keepalive traffic. It has to index
  // cleanly rather than throw, or the loop stops on the first one.
  const r = decode(txn({ program: other, data: bytes(7) }))
  assert.equal(r.kind, 'other')
  assert.ok(r.signature)
})

test('every account touched becomes a participant, fee payer included', () => {
  const r = decode(txn({ program: A.THRUPAD_PROGRAM, data: bytes(2), rw: [other], ro: [A.TOKEN_PROGRAM] }))
  const addrs = r.participants.map((p) => p.address)
  assert.ok(addrs.includes(payer), 'fee payer is a participant')
  assert.ok(addrs.includes(other))
  assert.ok(addrs.includes(A.TOKEN_PROGRAM))
  assert.equal(r.participants.find((p) => p.address === A.TOKEN_PROGRAM).writable, 0)
})

test('a failed transaction is recorded, not dropped', () => {
  // A reverted buy is a thing that happened and a thing a user wants to see.
  const r = decode(txn({ program: A.THRUPAD_PROGRAM, data: bytes(2), userError: 19 }))
  assert.equal(r.ok, 0)
  assert.equal(r.userError, 19)
  assert.equal(r.kind, 'buy')
})

test('a signature survives the round trip', () => {
  // 64 bytes, not 32. Running it through the address formatter returns null
  // rather than throwing, which silently drops every row it touches.
  const r = decode(txn({ program: A.THRUPAD_PROGRAM, data: bytes(2) }))
  assert.ok(r.signature, 'signature present')
  assert.ok(r.signature.startsWith('ts'), `signature in Thru format, got ${r.signature}`)
})

test('an empty instruction does not crash the decoder', () => {
  const r = decode(txn({ program: A.THRUPAD_PROGRAM, data: new Uint8Array(0) }))
  assert.equal(r.op, null)
  assert.equal(r.label, 'Launchpad')
})

/* ---------- bundles, which is what nearly every write actually is ---------- */

function bundle(calls, accounts) {
  // [count u16] then per call [program_idx u16][size u64][data]
  const size = 2 + calls.reduce((n, c) => n + 10 + c.data.length, 0)
  const out = new Uint8Array(size)
  const dv = new DataView(out.buffer)
  let o = 0
  dv.setUint16(o, calls.length, true); o += 2
  for (const c of calls) {
    dv.setUint16(o, accounts.indexOf(c.program), true); o += 2
    dv.setBigUint64(o, BigInt(c.data.length), true); o += 8
    out.set(c.data, o); o += c.data.length
  }
  return out
}

test('a bundle is named after the most interesting thing in it', () => {
  // A launchpad buy really arrives as: open a token account, wrap some THRU,
  // then buy. Naming it after the first step would be true and useless.
  const accounts = [payer, A.MULTICALL_PROGRAM, A.TOKEN_PROGRAM, A.THRUPAD_PROGRAM]
  const data = bundle([
    { program: A.TOKEN_PROGRAM, data: bytes(1) },     // open an account
    { program: A.THRUPAD_PROGRAM, data: bytes(2) },   // the buy
  ], accounts)
  const r = decode(txn({ program: A.MULTICALL_PROGRAM, data, ro: [A.TOKEN_PROGRAM, A.THRUPAD_PROGRAM] }))
  assert.equal(r.kind, 'buy')
  assert.equal(r.label, 'Bought on the launchpad')
})

test('a bundle of nothing but infrastructure is infrastructure', () => {
  // The oracle posts its updates bundled. Left as "bundled transaction" they
  // slip past the filter that hides them and fill the feed.
  const accounts = [payer, A.MULTICALL_PROGRAM, A.ORACLE_PROGRAM]
  const data = bundle([
    { program: A.ORACLE_PROGRAM, data: bytes(1) },
    { program: A.ORACLE_PROGRAM, data: bytes(1) },
  ], accounts)
  assert.equal(decode(txn({ program: A.MULTICALL_PROGRAM, data, ro: [A.ORACLE_PROGRAM] })).kind, 'oracle')
})

test('a truncated bundle returns what it could read', () => {
  // This runs over whatever is on chain. One malformed transaction must not
  // stop a feed.
  const accounts = [payer, A.MULTICALL_PROGRAM, A.THRUPAD_PROGRAM]
  const good = bundle([{ program: A.THRUPAD_PROGRAM, data: bytes(1) }], accounts)
  const cut = good.subarray(0, good.length - 1)
  const r = decode(txn({ program: A.MULTICALL_PROGRAM, data: cut, ro: [A.THRUPAD_PROGRAM] }))
  assert.ok(r, 'still produced a row')
  assert.equal(r.kind, 'bundle', 'and did not invent a reading of it')
})

test('the do-nothing program is read by the flag, not the program', () => {
  // The same program is both a wallet's first transaction and the node filling
  // an empty slot. Only the create-fee-payer flag tells them apart.
  assert.equal(decode(txn({ program: A.NOOP_PROGRAM, data: new Uint8Array(0), flags: 1 })).kind, 'account')
  assert.equal(decode(txn({ program: A.NOOP_PROGRAM, data: new Uint8Array(0), flags: 0 })).kind, 'noop')
})
