// src/lib/pals/chain.js
//
// Where Pixel Pals live on chain, how to read the collection's state, and how
// to build the four transactions a visitor can send: MINT, SEND and CLAIM (and
// the wallet's own token account, which the wallet library opens).
//
// Everything here is public. The addresses are fixed by the seeds they were
// deployed with; the state is one account anyone can read.
//
// This file runs in the browser and in the API (Node), so it touches neither
// the DOM nor import.meta.env directly.

import { Pubkey, deriveProgramAddress } from '@thru/sdk'

const env = (() => {
  try { if (typeof import.meta !== 'undefined' && import.meta.env) return import.meta.env } catch { /* Node */ }
  return typeof process !== 'undefined' ? process.env : {}
})()

/** The Pixel Pals program (seed pxpals7Q1). */
export const PALS_PROGRAM = env.VITE_PALS_PROGRAM || 'taxb0oMEdQIZKaL2CxCI98QnPIOvuxVBNqVhflRfB1jT4M'
/** Its one state account (seed palcfg7Q2 under the program). */
export const PALS_CONFIG = env.VITE_PALS_CONFIG || 'tajW5wGlaVs_sAhHH2v-RBc3NLeutgsE7VYCsDbTootFMa'
/** The collection, a mint of Thru's NFT program (seed palsmint7Q1), whose authority is PALS_PROGRAM. */
export const PALS_NFT_MINT = env.VITE_PALS_NFT_MINT || 'ta9l4qt8fTyuAofmu1oi3Hy_jc31vWCxLEXyaNEpuGEnMv'

export const NFT_PROGRAM = 'taVRt8dNq3B1IGXWpYx17GWEfFcpmU8LF9uWy75XIIcA03'
export const TOKEN_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq'
export const WTHRU_MINT = 'tacdgTUGud8OgzN5HnVVv4u3x82UBe8ciZAtjOLJZE_SNg'

export const PALS_SITE = 'https://thruscan.vercel.app'
export const PAL_URI_BASE = `${PALS_SITE}/api/rpc?action=pal&id=`

// ------------------------------------------------------------- bytes

const B = (a) => Pubkey.from(a).toBytes()
const addr = (bytes) => Pubkey.from(bytes).toThruFmt()
const isZero = (b) => b.every((x) => x === 0)

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

function cmp(a, b) {
  const x = B(a), y = B(b)
  for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}
const sorted = (list) => [...new Set(list)].sort(cmp)

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

/**
 * Account indices for a transaction: 0 is the fee payer, 1 the program,
 * then read-write then read-only, each sorted by raw key bytes.
 */
function layout(payer, readWrite, readOnly) {
  const rw = sorted(readWrite.filter((a) => a !== payer))
  const ro = sorted(readOnly.filter((a) => a !== payer && !rw.includes(a)))
  const at = (a) => {
    if (a === payer) return 0
    if (rw.includes(a)) return 2 + rw.indexOf(a)
    if (ro.includes(a)) return 2 + rw.length + ro.indexOf(a)
    throw new Error(`account ${a} is not in the transaction`)
  }
  return { rw, ro, at }
}

// ------------------------------------------------------------- state

export const HDR_SZ = 455
export const ALLOW_SZ = 48

/** Decode the config account. `bytes` is its raw data. */
export function decodeConfig(bytes) {
  if (!bytes || bytes.length < HDR_SZ) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const key = (o) => bytes.slice(o, o + 32)
  const supply = dv.getUint32(202, true)
  const minted = dv.getUint32(206, true)
  const maxAllow = dv.getUint32(210, true)
  const allowCnt = dv.getUint32(214, true)
  const uriLen = bytes[218]
  const n = supply
  const offOwners = HDR_SZ, offMinters = HDR_SZ + n * 32, offPrizes = HDR_SZ + n * 64
  const offClaimed = HDR_SZ + n * 72, offReserved = offClaimed + Math.ceil(n / 8)
  const offAllow = offReserved + Math.ceil(n / 8)

  const owners = [], minters = []
  for (let i = 0; i < minted; i++) {
    owners.push(addr(key(offOwners + i * 32)))
    minters.push(addr(key(offMinters + i * 32)))
  }
  const prizeVault = key(130)
  return {
    version: bytes[0],
    prizesLocked: bytes[1] === 1,
    admin: addr(key(2)),
    nftMint: addr(key(34)),
    treasury: addr(key(66)),
    payMint: addr(key(98)),
    prizeVault: isZero(prizeVault) ? null : addr(prizeVault),
    allower: addr(key(162)),
    price: dv.getBigUint64(194, true),
    supply, minted, maxAllow, allowCnt,
    uri: new TextDecoder().decode(bytes.slice(219, 219 + uriLen)),
    reserveWallet: addr(key(419)),
    reservedCnt: dv.getUint32(451, true),
    reserved: (id) => Boolean(bytes[offReserved + (id >> 3)] & (1 << (id & 7))),
    owners, minters,
    prize: (id) => (id < n ? dv.getBigUint64(offPrizes + id * 8, true) : 0n),
    claimed: (id) => Boolean(bytes[offClaimed + (id >> 3)] & (1 << (id & 7))),
    /** The allowlist ring, newest last. */
    allowed: () => {
      const live = Math.min(allowCnt, maxAllow), out = []
      for (let i = 0; i < live; i++) {
        const o = offAllow + i * ALLOW_SZ
        out.push({ wallet: addr(key(o)), tag: dv.getBigUint64(o + 32, true), slot: dv.getBigUint64(o + 40, true) })
      }
      return out
    },
  }
}

/** The NFT account for Pal `id`: derived by the NFT program from (mint, id). */
export async function nftAccountFor(id) {
  const le = new Uint8Array(8)
  new DataView(le.buffer).setBigUint64(0, BigInt(id), true)
  return deriveProgramAddress({ programAddress: NFT_PROGRAM, seed: await sha256(concat(B(PALS_NFT_MINT), le)) }).address
}

/** A wallet's standard token account for a mint (the zero seed). */
export async function tokenAccountFor(mint, owner) {
  return deriveProgramAddress({ programAddress: TOKEN_PROGRAM, seed: await sha256(concat(B(owner), B(mint), new Uint8Array(32))) }).address
}

// --------------------------------------------------------- instructions

/**
 * MINT, paid by `payer`. `id` is the number it will get (the config's
 * `minted`), `proof` the creation proof for that Pal's NFT account.
 *
 *   [0x02][cfg][nft_prog][nft_mint][nft_acct][token_prog][pay_from][treasury]
 *   then the NFT program's mint_to, forwarded as is:
 *   [u32 1][mint][nft][owner = 0][flags u64 = 0][uri 256][proof]
 */
export async function buildMint({ payer, id, treasury, proof }) {
  const nft = await nftAccountFor(id)
  const payFrom = await tokenAccountFor(WTHRU_MINT, payer)
  const { rw, ro, at } = layout(payer, [PALS_CONFIG, PALS_NFT_MINT, nft, payFrom, treasury], [NFT_PROGRAM, TOKEN_PROGRAM])

  const head = new Uint8Array(15)
  const dv = new DataView(head.buffer)
  head[0] = 0x02
  dv.setUint16(1, at(PALS_CONFIG), true)
  dv.setUint16(3, at(NFT_PROGRAM), true)
  dv.setUint16(5, at(PALS_NFT_MINT), true)
  dv.setUint16(7, at(nft), true)
  dv.setUint16(9, at(TOKEN_PROGRAM), true)
  dv.setUint16(11, at(payFrom), true)
  dv.setUint16(13, at(treasury), true)

  const fwd = new Uint8Array(274)
  const fv = new DataView(fwd.buffer)
  fv.setUint32(0, 1, true)
  fv.setUint16(4, at(PALS_NFT_MINT), true)
  fv.setUint16(6, at(nft), true)
  fv.setUint16(8, 0, true)
  fwd.set(new TextEncoder().encode(PAL_URI_BASE + String(id)), 18)

  return { program: PALS_PROGRAM, readWrite: rw, readOnly: ro, data: concat(head, fwd, proof), nft }
}

/**
 * GIFT: the next Pal, reserved, minted free to the reserve wallet. Signed by
 * the admin or the allower (the server).
 *   [0x0A][cfg][nft_prog][nft_mint][nft_acct][reserve] then mint_to, owner = reserve
 */
export async function buildGift({ payer, id, reserve, proof }) {
  const nft = await nftAccountFor(id)
  const { rw, ro, at } = layout(payer, [PALS_CONFIG, PALS_NFT_MINT, nft], [NFT_PROGRAM, reserve])
  const head = new Uint8Array(11)
  const dv = new DataView(head.buffer)
  head[0] = 0x0a
  dv.setUint16(1, at(PALS_CONFIG), true)
  dv.setUint16(3, at(NFT_PROGRAM), true)
  dv.setUint16(5, at(PALS_NFT_MINT), true)
  dv.setUint16(7, at(nft), true)
  dv.setUint16(9, at(reserve), true)
  const fwd = new Uint8Array(274)
  const fv = new DataView(fwd.buffer)
  fv.setUint32(0, 1, true)
  fv.setUint16(4, at(PALS_NFT_MINT), true)
  fv.setUint16(6, at(nft), true)
  fv.setUint16(8, at(reserve), true)
  fwd.set(new TextEncoder().encode(PAL_URI_BASE + String(id)), 18)
  return { program: PALS_PROGRAM, readWrite: rw, readOnly: ro, data: concat(head, fwd, proof), nft }
}

/** RESERVE (set = true) or UNRESERVE a list of numbers. Admin only. */
export function buildReserve({ payer, ids, set = true }) {
  const { rw, at } = layout(payer, [PALS_CONFIG], [])
  const data = new Uint8Array(5 + ids.length * 4)
  const dv = new DataView(data.buffer)
  data[0] = set ? 0x08 : 0x09
  dv.setUint16(1, at(PALS_CONFIG), true)
  dv.setUint16(3, ids.length, true)
  ids.forEach((id, i) => dv.setUint32(5 + i * 4, id, true))
  return { program: PALS_PROGRAM, readWrite: rw, readOnly: [], data }
}

/** SEND Pal `id` from `payer` (its holder) to `dest`. */
export async function buildSend({ payer, id, dest }) {
  const nft = await nftAccountFor(id)
  const { rw, ro, at } = layout(payer, [PALS_CONFIG, nft], [NFT_PROGRAM, PALS_NFT_MINT, dest])
  const data = new Uint8Array(15)
  const dv = new DataView(data.buffer)
  data[0] = 0x03
  dv.setUint16(1, at(PALS_CONFIG), true)
  dv.setUint16(3, at(NFT_PROGRAM), true)
  dv.setUint16(5, at(PALS_NFT_MINT), true)
  dv.setUint16(7, at(nft), true)
  dv.setUint16(9, at(dest), true)
  dv.setUint32(11, id, true)
  return { program: PALS_PROGRAM, readWrite: rw, readOnly: ro, data }
}

/** CLAIM what Pal `id` holds, into the holder's WTHRU account. */
export async function buildClaim({ payer, id, vault }) {
  const dest = await tokenAccountFor(WTHRU_MINT, payer)
  const { rw, ro, at } = layout(payer, [PALS_CONFIG, vault, dest], [TOKEN_PROGRAM])
  const data = new Uint8Array(13)
  const dv = new DataView(data.buffer)
  data[0] = 0x06
  dv.setUint16(1, at(PALS_CONFIG), true)
  dv.setUint16(3, at(TOKEN_PROGRAM), true)
  dv.setUint16(5, at(vault), true)
  dv.setUint16(7, at(dest), true)
  dv.setUint32(9, id, true)
  return { program: PALS_PROGRAM, readWrite: rw, readOnly: ro, data }
}

/** ALLOW `wallet`, signed by the admin or the allower. Used by the server. */
export function buildAllow({ payer, wallet, tag }) {
  const { rw, ro, at } = layout(payer, [PALS_CONFIG], [wallet])
  const data = new Uint8Array(13)
  const dv = new DataView(data.buffer)
  data[0] = 0x01
  dv.setUint16(1, at(PALS_CONFIG), true)
  dv.setUint16(3, at(wallet), true)
  dv.setBigUint64(5, BigInt(tag), true)
  return { program: PALS_PROGRAM, readWrite: rw, readOnly: ro, data }
}

/** What a transaction's user error code means, in words. */
export function palsError(code) {
  const c = Number(code)
  const words = {
    5: 'The collection is not set up yet.',
    14: 'Sold out.',
    15: 'This wallet is not cleared to mint yet. Try again.',
    16: 'This wallet has already minted its Pal.',
    17: 'That Pal is not in this wallet.',
    20: 'That Pal holds nothing.',
    21: 'Already claimed.',
    23: 'Someone minted at the same moment. Try again.',
    25: 'Pick a different wallet to send to.',
    28: 'That number is reserved. Trying the next one.',
  }
  if (words[c]) return words[c]
  if ((c & 0xff00) === 0x0300) return 'The payment did not go through. Check your WTHRU balance.'
  if ((c & 0xff00) === 0x0400) return 'The NFT program refused it.'
  return `Error ${code}.`
}
