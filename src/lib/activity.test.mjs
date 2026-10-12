// src/lib/activity.test.mjs
//
// Wrap and unwrap, read from the instruction, checked against the bytes the
// site's own builders write (src/lib/wthru.js) and against a real betanet
// transaction.
//
//   node --test src/lib/activity.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describe, movements, withDetail } from './activity.js'
import { buildWrap, buildUnwrap, WTHRU_MINT_ADDRESS } from './wthru.js'
import { MULTICALL_PROGRAM } from './addresses.js'
import { poolFee, quoteSwap } from './swap.js'

const PAYER = 'taWQKThxZZv8C9sKZp9GusPTCM3qt9XEGol3xp_QEl7VIM'
const DEST = 'taTOT29zfAzbPtz15_hZNkNVOp8gi_8tQnmsqxjLgOw3Md'
const b64 = (u) => Buffer.from(u).toString('base64')

/* A history item as /api/rpc?action=history serves it: the program, the first
   96 bytes of the instruction, and both account lists. */
function itemOf(built, extra = {}) {
  return { program: built.program, feePayer: PAYER, rw: built.readWrite, ro: built.readOnly, data: b64(built.data.slice(0, 96)), ok: true, signature: 'tsX', ...extra }
}

test('a wrap is "Wrapped THRU" with its amount, whatever bundles it', () => {
  const built = buildWrap({ payer: PAYER, dest: WTHRU_MINT_ADDRESS, amount: 5000 })
  assert.equal(built.program, MULTICALL_PROGRAM)
  const d = describe(itemOf(built), null)
  assert.equal(d.label, 'Wrapped THRU')
  assert.equal(d.detail, '5,000 THRU')
  assert.equal(withDetail(d), 'Wrapped THRU · 5,000 THRU')
})

test('an unwrap is "Unwrapped THRU" with its amount', () => {
  const built = buildUnwrap({ source: DEST, amount: 1234 })
  const d = describe(itemOf(built), null)
  assert.equal(d.label, 'Unwrapped THRU')
  assert.equal(d.detail, '1,234 THRU')
})

test('a wrap is still recognised when only the read-write accounts are known', () => {
  const built = buildWrap({ payer: PAYER, dest: WTHRU_MINT_ADDRESS, amount: 77 })
  const d = describe({ ...itemOf(built), ro: undefined }, null)
  assert.equal(d.label, 'Wrapped THRU')
  assert.equal(d.detail, '77 THRU')
})

test('the THRU leg of a wrap and an unwrap shows up in what moved', () => {
  const wrap = itemOf(buildWrap({ payer: PAYER, dest: WTHRU_MINT_ADDRESS, amount: 5000 }))
  assert.deepEqual(movements(wrap, null, PAYER), [{ label: 'THRU', delta: -5000 }])
  const unwrap = itemOf(buildUnwrap({ source: DEST, amount: 400 }))
  assert.deepEqual(movements(unwrap, null, PAYER), [{ label: 'THRU', delta: 400 }])
  // Somebody else's wrap moved nothing of mine.
  assert.deepEqual(movements(wrap, null, 'ta_wRonVNRc94sa2mfLpWxj4rXRRxN9dJgcALltsd_z21k'), [])
})

test('a bundle that is not a wrap stays a program call', () => {
  const d = describe({ program: MULTICALL_PROGRAM, feePayer: PAYER, rw: [], ro: [], data: b64(new Uint8Array([0, 0])) }, null)
  assert.equal(d.label, 'Program call')
  assert.equal(d.detail, undefined)
})

test("WTHRU amounts are read on the THRU scale, not the mint's 8 decimals", () => {
  const wrap = itemOf(buildWrap({ payer: PAYER, dest: DEST, amount: 5000 }))
  const extra = {
    events: { tsX: [{ op: 'mint', mint: WTHRU_MINT_ADDRESS, to: DEST, amount: '5000' }] },
    accounts: {
      [DEST]: { kind: 'token', owner: PAYER, mint: WTHRU_MINT_ADDRESS },
      [WTHRU_MINT_ADDRESS]: { kind: 'mint', decimals: 8, ticker: 'WTHRU' },
    },
  }
  // 5,000 wrapped is 5,000 WTHRU base units. At the mint's 8 decimals this read +0.00005.
  assert.deepEqual(movements(wrap, extra, PAYER), [{ label: 'THRU', delta: -5000 }, { label: 'WTHRU', delta: 5000 }])
})

test('a token with its own decimals keeps them', () => {
  const swap = { program: 'taEj_vKiRMfShniAZG5eOg1TJNXbLTcpqyoTUQVFiJFcUL', feePayer: PAYER, rw: [], ro: [], data: '', ok: true, signature: 'tsY' }
  const BNTEST = 'tadRs4WoP6-sxx6FgiEXMVOIkDhw3g9CU3xCMgNyCtSYo3'
  const extra = {
    events: { tsY: [{ op: 'transfer', from: 'taH7fb-E5-dsPfneas-8eQRBqZmgJ3RYg0nXizj-T0O0vO', to: DEST, amount: '98029507' }] },
    accounts: { [DEST]: { kind: 'token', owner: PAYER, mint: BNTEST }, [BNTEST]: { kind: 'mint', decimals: 6, ticker: 'BNTEST' } },
  }
  assert.deepEqual(movements(swap, extra, PAYER), [{ label: 'BNTEST', delta: 98.029507 }])
})

test('the pool fee is what thruswap withholds, which never rounds a real fee to nothing', () => {
  // The swap on betanet: 100 base units in, 30 basis points.
  assert.equal(poolFee(100n, 30), 1n)         // 100 * 30 / 10000 floors to 0; the pool kept 1
  assert.equal(poolFee(10_000n, 30), 30n)
  assert.equal(poolFee(2n, 30), 1n)
  assert.equal(poolFee(0n, 30), 0n)
  // And it matches the quote's own arithmetic: 100 in leaves 99 to price against.
  const q = quoteSwap({ reserveIn: 10_000n, reserveOut: 10_000_000_000n, amountIn: 100n, feeBps: 30 })
  assert.equal(100n - poolFee(100n, 30), 99n)
  assert.ok(q.amountOut > 0n)
})
