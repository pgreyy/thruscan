// tools/betanet/init-accounts.mjs
//
// Step 4: create each program's state account with its INIT instruction.
//
//   node tools/betanet/init-accounts.mjs                      # all but the pad
//   GRAD_THRESHOLD=<base units> node tools/betanet/init-accounts.mjs THRUPAD_REGISTRY
//
// Every one is the same shape, [0x00][seed 32][slots u16][state proof], and the
// program creates and sizes the account itself. thrupad2 adds the graduation
// threshold (u64, in WTHRU base units) after the slots and reads the quote mint
// (WTHRU) as its first read-only account. The threshold cannot be changed after
// INIT, so the pad is only initialised when GRAD_THRESHOLD is given explicitly.
//
// Idempotent: an account that already exists is recorded and left alone.

import { AUTHORITY, SIZES, record, save, log } from './config.mjs'
import { signer, seed32, programAccount, creationProof, getAccount, landed, send, outcome, u16, u64 } from './chain.mjs'

const WTHRU_MINT = 'taaoXQw03WlYWdo1jhfFi2Nqfqsf4RqYySn_89mchjCiLb'

const ACCOUNTS = {
  THRUSWAP_REGISTRY: { program: 'THRUSWAP_PROGRAM', seed: 'thruscan-bn-swap-reg-1' },
  THRUPAD_REGISTRY: { program: 'THRUPAD_PROGRAM', seed: 'thruscan-bn-pad-reg-1', pad: true },
  WALL_ACCOUNT: { program: 'WALL_PROGRAM', seed: 'thruscan-bn-wall-acc-1' },
  WORDLE_BOARD: { program: 'WORDLE_PROGRAM', seed: 'thruscan-bn-wordle-brd-1' },
  G2048_BOARD: { program: 'G2048_PROGRAM', seed: 'thruscan-bn-2048-brd-1' },
  ID_REGISTRY: { program: 'ID_PROGRAM', seed: 'thruscan-bn-id-reg-1' },
}

const only = process.argv.slice(2)
const keys = Object.keys(ACCOUNTS).filter((k) => (only.length ? only.includes(k) : !ACCOUNTS[k].pad))
const authority = signer(AUTHORITY)
const deployed = record().addresses
let failed = 0

for (const key of keys) {
  const { program: progKey, seed: seedText, pad } = ACCOUNTS[key]
  const program = deployed[progKey]
  if (!program) { log(`${key.padEnd(17)} SKIPPED: ${progKey} is not deployed yet`); failed++; continue }

  const seed = seed32(seedText)
  const account = programAccount(program, seed)
  if (await getAccount(account)) {
    log(`${key.padEnd(17)} ${account} already exists, recorded`)
    save({ addresses: { [key]: account } })
    continue
  }

  const parts = [Buffer.from([0x00]), Buffer.from(seed), u16(SIZES[key])]
  const readOnly = []
  if (pad) {
    const threshold = process.env.GRAD_THRESHOLD
    if (!/^\d+$/.test(threshold ?? '')) {
      log(`${key.padEnd(17)} SKIPPED: set GRAD_THRESHOLD (WTHRU base units) to initialise the pad; it is permanent`)
      failed++
      continue
    }
    parts.push(u64(threshold))
    readOnly.push(WTHRU_MINT)
  }

  try {
    const proof = await creationProof(account)
    const data = new Uint8Array(Buffer.concat([...parts, Buffer.from(proof)]))
    const signature = await send(authority, { program, readWrite: [account], readOnly, data, stateUnits: 2048 })
    const result = await outcome(signature)
    if (!result.ok || !(await landed(account))) throw new Error(`transaction ${signature} did not create it (${JSON.stringify(result)})`)
    log(`${key.padEnd(17)} ${account} created, ${SIZES[key]} slots, ${signature}`)
    save({ addresses: { [key]: account }, signatures: { [`init ${key}`]: signature } })
  } catch (e) {
    log(`${key.padEnd(17)} FAILED: ${e.message}`)
    failed++
  }
}

process.exit(failed ? 1 : 0)
