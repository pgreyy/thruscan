// src/lib/wthru.js
//
// THRU <-> WTHRU, through Thru's own wrapped-THRU program.
//
// Pools only hold tokens, and THRU is the chain's native coin, so it trades as
// WTHRU: one WTHRU base unit for every native THRU unit, backed by THRU held
// in the program's vault.
//
// Wrapping is two steps that must happen in ONE transaction: send THRU into
// the vault, then call DEPOSIT, which mints the vault's new balance to your
// WTHRU account. Split across two transactions, anyone could claim the THRU
// in between, so both go through Thru's multicall program together.
// Unwrapping is a single WITHDRAW: burn WTHRU, receive THRU.
//
// Both verified on alphanet: 100 THRU wrapped to 100 WTHRU base units, then
// 40 unwrapped back, with a wallet-paid WTHRU account.

import { Pubkey } from '@thru/sdk'

export const WTHRU_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcH'
export const WTHRU_VAULT = 'tavBundQnIZaeuFuzQyydWytISqLWedn49iLRXsBj085lN'
export const WTHRU_MINT_ADDRESS = 'tacdgTUGud8OgzN5HnVVv4u3x82UBe8ciZAtjOLJZE_SNg'
const MULTICALL = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkJ'
const TOKEN = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq'
const EOA = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

const bytes = (a) => Pubkey.from(a).toBytes()
function sort(list) {
  return [...new Set(list)].sort((a, b) => {
    const x = bytes(a), y = bytes(b)
    for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i]
    return 0
  })
}

/** One multicall entry: [program_idx u16][data_size u64][data]. */
function call(programIdx, data) {
  const out = new Uint8Array(10 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint16(0, programIdx, true)
  dv.setBigUint64(2, BigInt(data.length), true)
  out.set(data, 10)
  return out
}

/** Wrap `amount` THRU into the payer's WTHRU account `dest`. */
export function buildWrap({ dest, amount }) {
  const readWrite = sort([WTHRU_VAULT, WTHRU_MINT_ADDRESS, dest])
  const readOnly = sort([EOA, TOKEN, WTHRU_PROGRAM])
  const at = (a) => (readWrite.includes(a) ? 2 + readWrite.indexOf(a) : 2 + readWrite.length + readOnly.indexOf(a))

  // EOA TRANSFER: [u32 1][u64 amount][u16 from = payer][u16 to = vault]
  const transfer = new Uint8Array(16)
  const t = new DataView(transfer.buffer)
  t.setUint32(0, 1, true)
  t.setBigUint64(4, BigInt(amount), true)
  t.setUint16(12, 0, true)
  t.setUint16(14, at(WTHRU_VAULT), true)

  // WTHRU DEPOSIT: [u32 1][token_program][vault][mint][dest]
  const deposit = new Uint8Array(12)
  const d = new DataView(deposit.buffer)
  d.setUint32(0, 1, true)
  d.setUint16(4, at(TOKEN), true)
  d.setUint16(6, at(WTHRU_VAULT), true)
  d.setUint16(8, at(WTHRU_MINT_ADDRESS), true)
  d.setUint16(10, at(dest), true)

  const a = call(at(EOA), transfer)
  const b = call(at(WTHRU_PROGRAM), deposit)
  const data = new Uint8Array(2 + a.length + b.length)
  new DataView(data.buffer).setUint16(0, 2, true)
  data.set(a, 2)
  data.set(b, 2 + a.length)
  return { program: MULTICALL, readWrite, readOnly, data }
}

/** Unwrap `amount` WTHRU from the payer's account `source` back to THRU. */
export function buildUnwrap({ source, amount }) {
  const readWrite = sort([WTHRU_MINT_ADDRESS, WTHRU_VAULT, source])
  const readOnly = [TOKEN]
  const at = (a) => (readWrite.includes(a) ? 2 + readWrite.indexOf(a) : 2 + readWrite.length + readOnly.indexOf(a))
  // WITHDRAW: [u32 2][token_program][vault][mint][token_account][owner][recipient][u64 amount]
  const data = new Uint8Array(24)
  const dv = new DataView(data.buffer)
  dv.setUint32(0, 2, true)
  dv.setUint16(4, at(TOKEN), true)
  dv.setUint16(6, at(WTHRU_VAULT), true)
  dv.setUint16(8, at(WTHRU_MINT_ADDRESS), true)
  dv.setUint16(10, at(source), true)
  dv.setUint16(12, 0, true)   // owner: the payer
  dv.setUint16(14, 0, true)   // recipient: the payer
  dv.setBigUint64(16, BigInt(amount), true)
  return { program: WTHRU_PROGRAM, readWrite, readOnly, data, computeUnits: 400_000, stateUnits: 10_000, memoryUnits: 10_000 }
}
