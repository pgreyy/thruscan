// src/lib/tokenix.js
//
// The token program's two creation instructions, written so they can sit
// inside a multicall.
//
// The versions in wallet.js each build their own account list and work out
// their own indices, which is right for a transaction that contains only them
// and wrong for one that contains several. These take an `at` function instead
// and let the caller own the list. See src/lib/multicall.js for why.
//
// Both also need a state proof, which proves the address is empty right now.
// The caller fetches those, because fetching is a round trip and a bundle
// wants them all at once.

import { Pubkey, deriveProgramAddress } from '@thru/sdk'
import { TOKEN_PROGRAM } from './addresses.js'

const toBytes = (a) => Pubkey.from(a).toBytes()

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

export function randomSeed() {
  const s = new Uint8Array(32)
  crypto.getRandomValues(s)
  return s
}

/** Where a mint this creator makes with this seed will land. */
export async function deriveMint(creator, seed) {
  return deriveProgramAddress({
    programAddress: TOKEN_PROGRAM,
    seed: await sha256(concat(toBytes(creator), seed)),
  }).address
}

/** Where a token account for this mint and owner will land. */
export async function deriveTokenAccountAt(mint, owner, seed = new Uint8Array(32)) {
  return deriveProgramAddress({
    programAddress: TOKEN_PROGRAM,
    seed: await sha256(concat(toBytes(owner), toBytes(mint), seed)),
  }).address
}

/**
 * CREATE MINT.
 *
 *   [0x00][mint u16][decimals u8][creator 32][mint authority 32]
 *   [freeze authority 32][has freeze u8][ticker len u8][ticker 8][seed 32][proof]
 *
 * The creator must be the fee payer. The mint authority is whoever may mint,
 * which for a launch is the launchpad program, and that is what makes the
 * supply fixed: nothing else can mint afterwards.
 */
export function createMintStep({ mint, creator, mintAuthority, ticker, seed, proof, decimals = 6 }) {
  const sym = String(ticker).trim().toUpperCase()
  if (!/^[A-Z0-9]{2,8}$/.test(sym)) throw new Error('A ticker is 2 to 8 letters or digits.')
  return {
    program: TOKEN_PROGRAM,
    build: (at) => {
      const head = new Uint8Array(1 + 2 + 1 + 32 + 32 + 32 + 1 + 1 + 8 + 32)
      const dv = new DataView(head.buffer)
      let o = 0
      head[o] = 0x00; o += 1
      dv.setUint16(o, at(mint), true); o += 2
      head[o] = decimals; o += 1
      head.set(toBytes(creator), o); o += 32
      head.set(toBytes(mintAuthority), o); o += 32
      o += 32                       // freeze authority: none
      head[o] = 0; o += 1           // has_freeze
      head[o] = sym.length; o += 1
      head.set(new TextEncoder().encode(sym), o); o += 8
      head.set(seed, o)
      return concat(head, proof)
    },
  }
}

/**
 * INIT ACCOUNT.
 *
 *   [0x01][account u16][mint u16][owner u16][seed 32][proof]
 */
export function openAccountStep({ account, mint, owner, seed = new Uint8Array(32), proof }) {
  return {
    program: TOKEN_PROGRAM,
    build: (at) => {
      const head = new Uint8Array(39)
      const dv = new DataView(head.buffer)
      head[0] = 0x01
      dv.setUint16(1, at(account), true)
      dv.setUint16(3, at(mint), true)
      dv.setUint16(5, at(owner), true)
      head.set(seed, 7)
      return concat(head, proof)
    },
  }
}
