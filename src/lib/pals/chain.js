// src/lib/pals/chain.js
//
// Where Pixel Pals live on chain, how to read the collection's state and its
// market, and how to build every transaction a visitor can send.
//
// A Pal has two numbers. Its Pal number (0..2025) is the one everyone sees,
// drawn at random by the program when it is minted. Its NFT id (0, 1, 2... in
// mint order) is what Thru's NFT program uses to derive the NFT account. The
// config records both directions, and every builder here that touches a
// minted Pal takes the Pal number plus its NFT id.
//
// Everything here is public. The addresses are fixed by the seeds they were
// deployed with; the state is two accounts anyone can read.
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
/** Its state account (seed palcfg7Q2 under the program). */
export const PALS_CONFIG = env.VITE_PALS_CONFIG || 'tajW5wGlaVs_sAhHH2v-RBc3NLeutgsE7VYCsDbTootFMa'
/** The market: listings and recent sales (seed palmkt7Q1 under the program). */
export const PALS_MARKET = env.VITE_PALS_MARKET || 'taRnEmml22MOTV8UN6Y4w3Qp8G_cHRF_ShM9xT7DcCSlyW'
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

export const HDR_SZ = 459
export const ALLOW_SZ = 48

/** Decode the config account (version 3). `bytes` is its raw data. */
export function decodeConfig(bytes) {
  if (!bytes || bytes.length < HDR_SZ || bytes[0] !== 3) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const key = (o) => bytes.slice(o, o + 32)
  const supply = dv.getUint32(202, true)
  const minted = dv.getUint32(206, true)
  const maxAllow = dv.getUint32(210, true)
  const allowCnt = dv.getUint32(214, true)
  const uriLen = bytes[218]
  const n = supply, bits = Math.ceil(n / 8)
  const offOwners = HDR_SZ, offMinters = HDR_SZ + n * 32, offPrizes = HDR_SZ + n * 64
  const offClaimed = HDR_SZ + n * 72, offReserved = offClaimed + bits, offMinted = offReserved + bits
  const offNftOf = offMinted + bits, offOrder = offNftOf + n * 2, offAllow = offOrder + n * 2
  const bit = (o, i) => Boolean(bytes[o + (i >> 3)] & (1 << (i & 7)))

  // Minted Pals in mint order: Pal number, who minted it, who holds it now.
  const pals = []
  for (let k = 0; k < minted; k++) {
    const num = dv.getUint16(offOrder + k * 2, true)
    pals.push({ num, nftId: k, minter: addr(key(offMinters + num * 32)), owner: addr(key(offOwners + num * 32)) })
  }
  const prizeVault = key(130)
  const reservedCnt = dv.getUint32(451, true)
  const gifted = dv.getUint32(455, true)
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
    reservedCnt, gifted,
    /** Numbers set aside for the reserve wallet and not minted yet. */
    reservedLeft: reservedCnt - gifted,
    /** Numbers the public can still get. */
    publicLeft: supply - reservedCnt - (minted - gifted),
    reserved: (num) => bit(offReserved, num),
    isMinted: (num) => bit(offMinted, num),
    nftIdOf: (num) => (bit(offMinted, num) ? dv.getUint16(offNftOf + num * 2, true) : null),
    ownerOf: (num) => (bit(offMinted, num) ? addr(key(offOwners + num * 32)) : null),
    pals,
    prize: (num) => (num < n ? dv.getBigUint64(offPrizes + num * 8, true) : 0n),
    claimed: (num) => bit(offClaimed, num),
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

export const MKT_HDR_SZ = 56
export const LISTING_SZ = 80
export const SALE_SZ = 84
export const SALES_RING = 64

/** Decode the market account: fee, totals, every live listing and the recent sales. */
export function decodeMarket(bytes) {
  if (!bytes || bytes.length < MKT_HDR_SZ || bytes[0] !== 0x4d) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const key = (o) => bytes.slice(o, o + 32)
  const supply = dv.getUint32(36, true)
  const salesCnt = dv.getUint32(44, true)
  const listings = new Map()
  for (let id = 0; id < supply; id++) {
    const o = MKT_HDR_SZ + id * LISTING_SZ
    const price = dv.getBigUint64(o + 64, true)
    if (price === 0n) continue
    listings.set(id, { id, seller: addr(key(o)), payout: addr(key(o + 32)), price, slot: dv.getBigUint64(o + 72, true) })
  }
  const offSales = MKT_HDR_SZ + supply * LISTING_SZ
  const sales = []
  const live = Math.min(salesCnt, SALES_RING)
  for (let k = 0; k < live; k++) {
    const n = salesCnt - 1 - k
    const o = offSales + (n % SALES_RING) * SALE_SZ
    sales.push({ n, id: dv.getUint32(o, true), price: dv.getBigUint64(o + 4, true), buyer: addr(key(o + 12)), seller: addr(key(o + 44)), slot: dv.getBigUint64(o + 76, true) })
  }
  return {
    feeBps: dv.getUint16(2, true),
    config: addr(key(4)),
    supply,
    listed: dv.getUint32(40, true),
    sales: salesCnt,
    volume: dv.getBigUint64(48, true),
    listings,
    recent: sales,
  }
}

/** The NFT account for NFT id `nftId` (mint order), derived by the NFT program from (mint, id). */
export async function nftAccountFor(nftId, mint = PALS_NFT_MINT) {
  const le = new Uint8Array(8)
  new DataView(le.buffer).setBigUint64(0, BigInt(nftId), true)
  return deriveProgramAddress({ programAddress: NFT_PROGRAM, seed: await sha256(concat(B(mint), le)) }).address
}

/** A wallet's standard token account for a mint (the zero seed). */
export async function tokenAccountFor(mint, owner) {
  return deriveProgramAddress({ programAddress: TOKEN_PROGRAM, seed: await sha256(concat(B(owner), B(mint), new Uint8Array(32))) }).address
}

// --------------------------------------------------------- instructions

/**
 * MINT, paid by `payer`. `nftId` is the next NFT id (the config's `minted`),
 * `proof` the creation proof for that NFT account. The program draws the Pal
 * number.
 *   [0x02][cfg][nft_prog][nft_mint][nft_acct][token_prog][pay_from][treasury][proof]
 */
export async function buildMint({ payer, nftId, treasury, proof }) {
  const nft = await nftAccountFor(nftId)
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
  return { program: PALS_PROGRAM, readWrite: rw, readOnly: ro, data: concat(head, proof), nft }
}

/**
 * GIFT reserved Pal `num` to the reserve wallet, as NFT id `nftId`. Signed by
 * the admin or the allower.
 *   [0x0A][cfg][nft_prog][nft_mint][nft_acct][reserve][num u32][proof]
 */
export async function buildGift({ payer, nftId, num, reserve, proof }) {
  const nft = await nftAccountFor(nftId)
  const { rw, ro, at } = layout(payer, [PALS_CONFIG, PALS_NFT_MINT, nft], [NFT_PROGRAM, reserve])
  const head = new Uint8Array(15)
  const dv = new DataView(head.buffer)
  head[0] = 0x0a
  dv.setUint16(1, at(PALS_CONFIG), true)
  dv.setUint16(3, at(NFT_PROGRAM), true)
  dv.setUint16(5, at(PALS_NFT_MINT), true)
  dv.setUint16(7, at(nft), true)
  dv.setUint16(9, at(reserve), true)
  dv.setUint32(11, num, true)
  return { program: PALS_PROGRAM, readWrite: rw, readOnly: ro, data: concat(head, proof), nft }
}

/** RESERVE (set = true) or UNRESERVE a list of Pal numbers. Admin only. */
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

/** SEND Pal `num` (NFT id `nftId`) from `payer`, its holder, to `dest`. */
export async function buildSend({ payer, num, nftId, dest }) {
  const nft = await nftAccountFor(nftId)
  const { rw, ro, at } = layout(payer, [PALS_CONFIG, nft], [NFT_PROGRAM, PALS_NFT_MINT, dest])
  const data = new Uint8Array(15)
  const dv = new DataView(data.buffer)
  data[0] = 0x03
  dv.setUint16(1, at(PALS_CONFIG), true)
  dv.setUint16(3, at(NFT_PROGRAM), true)
  dv.setUint16(5, at(PALS_NFT_MINT), true)
  dv.setUint16(7, at(nft), true)
  dv.setUint16(9, at(dest), true)
  dv.setUint32(11, num, true)
  return { program: PALS_PROGRAM, readWrite: rw, readOnly: ro, data }
}

/** CLAIM what Pal `num` holds, into the holder's WTHRU account. */
export async function buildClaim({ payer, num, vault }) {
  const dest = await tokenAccountFor(WTHRU_MINT, payer)
  const { rw, ro, at } = layout(payer, [PALS_CONFIG, vault, dest], [TOKEN_PROGRAM])
  const data = new Uint8Array(13)
  const dv = new DataView(data.buffer)
  data[0] = 0x06
  dv.setUint16(1, at(PALS_CONFIG), true)
  dv.setUint16(3, at(TOKEN_PROGRAM), true)
  dv.setUint16(5, at(vault), true)
  dv.setUint16(7, at(dest), true)
  dv.setUint32(9, num, true)
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

/**
 * LIST Pal `num` for `price` WTHRU base units (1 THRU each). The Pal moves into
 * the program's keeping until it sells or is delisted. Listing a Pal that is
 * already listed by the same wallet changes its price.
 *   [0x0D][cfg][market][nft_prog][nft_mint][nft_acct][escrow][payout][num u32][price u64]
 */
export async function buildList({ payer, num, nftId, price }) {
  const nft = await nftAccountFor(nftId)
  const payout = await tokenAccountFor(WTHRU_MINT, payer)
  const { rw, ro, at } = layout(payer, [PALS_CONFIG, PALS_MARKET, nft], [NFT_PROGRAM, PALS_NFT_MINT, payout])
  const data = new Uint8Array(27)
  const dv = new DataView(data.buffer)
  data[0] = 0x0d
  dv.setUint16(1, at(PALS_CONFIG), true)
  dv.setUint16(3, at(PALS_MARKET), true)
  dv.setUint16(5, at(NFT_PROGRAM), true)
  dv.setUint16(7, at(PALS_NFT_MINT), true)
  dv.setUint16(9, at(nft), true)
  dv.setUint16(11, 1, true) // the program itself holds listed Pals
  dv.setUint16(13, at(payout), true)
  dv.setUint32(15, num, true)
  dv.setBigUint64(19, BigInt(price), true)
  return { program: PALS_PROGRAM, readWrite: rw, readOnly: ro, data }
}

/** DELIST: the Pal comes back to the seller. [0x0E][cfg][market][nft_prog][nft_mint][nft_acct][num u32] */
export async function buildDelist({ payer, num, nftId }) {
  const nft = await nftAccountFor(nftId)
  const { rw, ro, at } = layout(payer, [PALS_CONFIG, PALS_MARKET, nft], [NFT_PROGRAM, PALS_NFT_MINT])
  const data = new Uint8Array(15)
  const dv = new DataView(data.buffer)
  data[0] = 0x0e
  dv.setUint16(1, at(PALS_CONFIG), true)
  dv.setUint16(3, at(PALS_MARKET), true)
  dv.setUint16(5, at(NFT_PROGRAM), true)
  dv.setUint16(7, at(PALS_NFT_MINT), true)
  dv.setUint16(9, at(nft), true)
  dv.setUint32(11, num, true)
  return { program: PALS_PROGRAM, readWrite: rw, readOnly: ro, data }
}

/**
 * BUY one or more listed Pals (a sweep) in one transaction, all or nothing.
 * `items` are [{ id (Pal number), nftId, payout, price }]; each price is also
 * the most this buyer agrees to pay, so a seller raising it first makes it fail.
 *   [0x0F][cfg][market][nft_prog][nft_mint][token_prog][pay_from][fee_to][count u8]
 *   then count x { nft_acct u16, payout u16, num u32, max_price u64 }
 */
export async function buildBuy({ payer, items, treasury }) {
  if (!items.length || items.length > 8) throw new Error('Pick between 1 and 8 Pals.')
  const payFrom = await tokenAccountFor(WTHRU_MINT, payer)
  const nfts = await Promise.all(items.map((it) => nftAccountFor(it.nftId)))
  const payouts = items.map((it) => it.payout)
  const { rw, ro, at } = layout(payer, [PALS_CONFIG, PALS_MARKET, payFrom, treasury, ...nfts, ...payouts], [NFT_PROGRAM, PALS_NFT_MINT, TOKEN_PROGRAM])
  const data = new Uint8Array(16 + items.length * 16)
  const dv = new DataView(data.buffer)
  data[0] = 0x0f
  dv.setUint16(1, at(PALS_CONFIG), true)
  dv.setUint16(3, at(PALS_MARKET), true)
  dv.setUint16(5, at(NFT_PROGRAM), true)
  dv.setUint16(7, at(PALS_NFT_MINT), true)
  dv.setUint16(9, at(TOKEN_PROGRAM), true)
  dv.setUint16(11, at(payFrom), true)
  dv.setUint16(13, at(treasury), true)
  data[15] = items.length
  items.forEach((it, i) => {
    const o = 16 + i * 16
    dv.setUint16(o, at(nfts[i]), true)
    dv.setUint16(o + 2, at(it.payout), true)
    dv.setUint32(o + 4, it.id, true)
    dv.setBigUint64(o + 8, BigInt(it.price), true)
  })
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
    30: 'That Pal is no longer for sale.',
    31: 'The price went up before your purchase landed. Nothing was charged.',
    32: 'The market is not set up yet.',
  }
  if (words[c]) return words[c]
  if ((c & 0xff00) === 0x0300) return 'The payment did not go through. Check your WTHRU balance.'
  if ((c & 0xff00) === 0x0400) return 'The NFT program refused it.'
  return `Error ${code}.`
}
