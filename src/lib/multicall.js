// src/lib/multicall.js
//
// Several instructions, one transaction, one signature.
//
// Thru ships a multicall program that runs a list of instructions in order
// inside a single transaction. Either all of them happen or none of them do,
// and the person approves once instead of once per step.
//
// That matters here for two reasons. The obvious one is that signing four
// times to launch a token is four chances to wander off, and the launch is
// half-done if you do: a mint exists with no curve behind it. The less obvious
// one is that some sequences are only safe together. Wrapping THRU is a
// transfer into a vault followed by a deposit that mints against whatever the
// vault now holds; split across two transactions, anyone can claim the THRU in
// between.
//
// THE ONE RULE. A multicall is one transaction, so there is one account list
// and every inner instruction's indices point into it. An index that was
// correct for a standalone instruction is almost never correct inside a
// bundle. So the builders here take account ADDRESSES and are handed an `at`
// function that resolves them against the combined list, rather than taking
// indices worked out somewhere else.
//
// The wire format, recovered from live transactions and confirmed against the
// wrap that has been running since September:
//
//   [count u16] then count x [program_idx u16][data_size u64][data]

import { Pubkey } from '@thru/sdk'
import { MULTICALL_PROGRAM } from './addresses.js'

const bytes = (a) => Pubkey.from(a).toBytes()

/** Sorted by raw key bytes, which is the order a transaction's lists are in. */
export function sortAccounts(list) {
  return [...new Set(list)].sort((a, b) => {
    const x = bytes(a), y = bytes(b)
    for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i]
    return 0
  })
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** One entry: [program_idx u16][data_size u64][data]. */
function entry(programIdx, data) {
  const out = new Uint8Array(10 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint16(0, programIdx, true)
  dv.setBigUint64(2, BigInt(data.length), true)
  out.set(data, 10)
  return out
}

/**
 * Build a multicall transaction.
 *
 * `readWrite` and `readOnly` are the union of everything the steps touch, and
 * every program called is itself a read-only account. `steps` is a list of
 * { program, build } where build(at) returns that step's instruction data,
 * using `at(address)` for every account index.
 *
 * Index 0 is the fee payer and 1 the multicall program itself, then the
 * read-write accounts in sorted order, then the read-only ones.
 */
export function buildMulticall({ payer, readWrite = [], readOnly = [], steps }) {
  const rw = sortAccounts(readWrite.filter((a) => a && a !== payer))
  const ro = sortAccounts([...readOnly, ...steps.map((s) => s.program)].filter((a) => a && a !== payer && !rw.includes(a)))

  const at = (a) => {
    if (a === payer) return 0
    const i = rw.indexOf(a)
    if (i >= 0) return 2 + i
    const j = ro.indexOf(a)
    if (j >= 0) return 2 + rw.length + j
    throw new Error(`multicall: ${a} is not in the account list`)
  }

  const parts = steps.map((s) => entry(at(s.program), s.build(at)))
  const head = new Uint8Array(2)
  new DataView(head.buffer).setUint16(0, steps.length, true)

  return { program: MULTICALL_PROGRAM, readWrite: rw, readOnly: ro, data: concat(head, ...parts) }
}
