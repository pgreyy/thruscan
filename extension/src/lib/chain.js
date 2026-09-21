// extension/src/lib/chain.js
//
// Everything the wallet asks of the Thru network, talking to the node directly
// over gRPC-Web. No ThruScan server, no sponsor: the wallet's own key pays for
// and signs everything it does.
//
// A signer is { address, publicKey: Uint8Array, privateKey: Uint8Array }.

import {
  createThruClient, TransactionBuilder, Transaction, Pubkey, Signature,
  deriveProgramAddress, signMessage as sdkSignMessage,
} from '@thru/sdk'

export const DEFAULT_RPC = 'https://rpc.alphanet.thru.org'
export const EXPLORER = 'https://thruscan.vercel.app'

export const PROGRAMS = {
  EOA: 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  TOKEN: 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq',
  NAME_SERVICE: 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUF',
  FAUCET: 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPr6',
  // Thru's own NFT program. Its ABI is published on chain through the ABI
  // manager; the layouts below were read from it and checked by minting and
  // transferring on alphanet.
  NFT: 'taVRt8dNq3B1IGXWpYx17GWEfFcpmU8LF9uWy75XIIcA03',
}
const FAUCET_ACCOUNT = 'taxoImN8fTEOxXYnvgC6JZ0lN0n0qvZERwz_vlOjX3MkIn'
const FAUCET_MAX = 10_000n
// The .id names root on Thru's name service.
const NAMES_ROOT = 'taGEX4QNK_WjsknEK4kl0_ppCJUimoanrmFuU27t1gS3pw'
// Tokens worth checking for on every wallet even before it has any history.
export const KNOWN_MINTS = [
  'tabAx2SejGxnH7qDY02xofs0rrhBV2Cdoxg0yeG0hv7Z0R', // tUSD
  'tacdgTUGud8OgzN5HnVVv4u3x82UBe8ciZAtjOLJZE_SNg', // WTHRU
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let current = { url: null, client: null }
export function client(url = DEFAULT_RPC) {
  if (current.url !== url) current = { url, client: createThruClient({ baseUrl: url }) }
  return current.client
}

const bytesOf = (a) => Pubkey.from(a).toBytes()
export const isAddress = (a) => { try { Pubkey.from(String(a)); return String(a).startsWith('ta') } catch { return false } }

/** Accounts sort by raw public key bytes, not by their text. */
export function sortAddresses(list) {
  return [...new Set(list)].sort((a, b) => {
    const x = bytesOf(a), y = bytesOf(b)
    for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i]
    return 0
  })
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/* ---------- reading ---------- */

export async function accountInfo(url, address) {
  try {
    const a = await client(url).accounts.get(address)
    return { exists: true, balance: a.meta?.balance ?? 0n, nonce: a.meta?.nonce ?? 0n, data: a.data?.data ?? new Uint8Array(), owner: a.meta?.owner?.toThruFmt?.() ?? null }
  } catch {
    return { exists: false, balance: 0n, nonce: 0n, data: new Uint8Array(), owner: null }
  }
}

export async function deriveTokenAccount(mint, owner) {
  const digest = await sha256(concat(bytesOf(owner), bytesOf(mint), new Uint8Array(32)))
  return deriveProgramAddress({ programAddress: PROGRAMS.TOKEN, seed: digest }).address
}

function readU64(b, at) { return new DataView(b.buffer, b.byteOffset).getBigUint64(at, true) }

export function decodeMint(b) {
  if (!b || b.length !== 115) return null
  const len = Math.min(b[0x6a], 8)
  return { decimals: b[0], supply: readU64(b, 1), ticker: new TextDecoder().decode(b.slice(0x6b, 0x6b + len)) }
}
export function decodeTokenAccount(b) {
  if (!b || b.length !== 73) return null
  return { mint: Pubkey.from(b.slice(0, 32)).toThruFmt(), owner: Pubkey.from(b.slice(32, 64)).toThruFmt(), amount: readU64(b, 64) }
}

/** Raw history, newest first: one page of the account's transactions. */
export async function history(url, address, pageToken = null, { times: withTimes = true } = {}) {
  const c = client(url)
  const res = await c.ctx.query.listTransactionsForAccount({
    account: Pubkey.from(address).toProtoPubkey(),
    page: { pageSize: 20, ...(pageToken ? { pageToken } : {}) },
  })
  const txs = (res.transactions ?? []).map((p) => Transaction.fromProto(p))
  const slots = withTimes ? [...new Set(txs.map((t) => t.slot?.toString()).filter(Boolean))] : []
  const times = {}
  await Promise.all(slots.map(async (s) => {
    try {
      const blk = await c.ctx.query.getBlock({ selector: { case: 'slot', value: BigInt(s) }, view: 1 })
      const t = blk.header?.blockTime
      if (t) times[s] = Number(t.seconds) * 1000 + Math.floor((t.nanos ?? 0) / 1e6)
    } catch { /* time unknown */ }
  }))
  const items = txs.map((t) => {
    const ex = t.executionResult
    return {
      signature: t.getSignature?.()?.toThruFmt?.() ?? null,
      slot: t.slot?.toString() ?? null,
      time: times[t.slot?.toString()] ?? null,
      program: t.program?.toThruFmt?.() ?? null,
      feePayer: t.feePayer?.toThruFmt?.() ?? null,
      rw: (t.readWriteAccounts ?? []).map((a) => a.toThruFmt()),
      ro: (t.readOnlyAccounts ?? []).map((a) => a.toThruFmt()),
      data: Array.from(t.instructionData ?? []),
      ok: ex ? (ex.vmError ?? 0) === 0 && BigInt(ex.userErrorCode ?? 0n) === 0n : null,
    }
  })
  return { items, next: res.page?.nextPageToken || null }
}

/** A short label for a transaction, from this wallet's point of view. */
export function describe(item, me) {
  const d = Uint8Array.from(item.data ?? [])
  const dv = d.length >= 4 ? new DataView(d.buffer) : null
  const byMe = item.feePayer === me
  switch (item.program) {
    case PROGRAMS.EOA: {
      const op = dv?.getUint32(0, true)
      if (op === 0) return { label: 'Account created' }
      if (op === 1 && d.length >= 12) {
        const amount = dv.getBigUint64(4, true)
        return { label: byMe ? 'Sent THRU' : 'Received THRU', delta: `${byMe ? '−' : '+'}${amount.toLocaleString()} THRU` }
      }
      return { label: 'Account program' }
    }
    case PROGRAMS.FAUCET:
      return { label: 'THRU from faucet', delta: d.length >= 16 ? `+${dv.getBigUint64(8, true).toLocaleString()} THRU` : null }
    case PROGRAMS.TOKEN:
      return { label: ({ 0: 'Created a token', 1: 'Opened a token account', 2: byMe ? 'Sent tokens' : 'Received tokens', 3: 'Minted tokens', 4: 'Burned tokens' })[d[0]] ?? 'Token program' }
    case PROGRAMS.NAME_SERVICE:
      return { label: ({ 1: 'Registered a name', 2: 'Set a name record', 3: 'Removed a name record', 4: 'Released a name' })[dv?.getUint32(0, true)] ?? 'Name service' }
    case 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkJ':
      return { label: 'Wrapped THRU' }
    case PROGRAMS.NFT:
      return { label: ({ 0: 'Created an NFT collection', 1: 'Minted an NFT', 2: byMe ? 'Sent an NFT' : 'Received an NFT', 3: 'Burned an NFT' })[dv?.getUint32(0, true)] ?? 'NFT program' }
    case 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcH':
      return { label: 'Unwrapped WTHRU' }
    default:
      // The runtime's account-creation program ends in ...MD and takes no data.
      return { label: item.program === 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMD' ? 'Account created' : 'App transaction' }
  }
}

/**
 * An NFT account: [mint 32][owner 32][id u64][flags u64][metadata uri 256].
 * Its address is derived from its mint and id, so the pair is its identity.
 */
export function decodeNft(b) {
  if (!b || b.length !== 336) return null
  const uri = new TextDecoder().decode(b.slice(80, 336)).replace(/\0+$/, '')
  return {
    mint: Pubkey.from(b.slice(0, 32)).toThruFmt(),
    owner: Pubkey.from(b.slice(32, 64)).toThruFmt(),
    id: readU64(b, 64).toString(),
    uri,
  }
}

/** Read an NFT's metadata JSON, if its link is a web address. */
async function nftMetadata(uri) {
  if (!/^https:\/\//.test(uri)) return {}
  try {
    const r = await fetch(uri, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) return {}
    const j = await r.json()
    const image = typeof j.image === 'string' ? j.image.replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/') : null
    return { name: typeof j.name === 'string' ? j.name.slice(0, 80) : null, image: image && /^https:\/\//.test(image) ? image : null, collection: typeof j.collection === 'string' ? j.collection.slice(0, 60) : null }
  } catch { return {} }
}

/** The NFTs this address holds, found the same way as its tokens. */
export async function nfts(url, address) {
  const candidates = new Set()
  let page = null
  for (let i = 0; i < 3; i++) {
    try {
      const h = await history(url, address, page, { times: false })
      for (const it of h.items) for (const a of [...it.rw, ...it.ro]) candidates.add(a)
      page = h.next
      if (!page) break
    } catch { break }
  }
  const infos = await Promise.all([...candidates].map(async (a) => [a, await accountInfo(url, a)]))
  const held = infos
    .filter(([, info]) => info.owner === PROGRAMS.NFT)
    .map(([account, info]) => ({ account, ...decodeNft(info.data) }))
    .filter((n) => n.owner === address)
  // Each collection's mint records its authority. On Thru's NFT program that
  // authority, not the holder, is what can move an NFT (checked on alphanet),
  // so it decides who can send it: the holder directly only when the holder is
  // also the authority, otherwise through the collection's own program.
  const mints = [...new Set(held.map((n) => n.mint))]
  const authority = Object.fromEntries(await Promise.all(mints.map(async (m) => {
    const d = (await accountInfo(url, m)).data
    return [m, d.length === 48 ? Pubkey.from(d.slice(0, 32)).toThruFmt() : null]
  })))
  return Promise.all(held.map(async (n) => ({ ...n, authority: authority[n.mint], ...(await nftMetadata(n.uri)) })))
}

/** TRANSFER: [u32 2][nft u16][new owner u16][mint u16]. The current owner signs. */
export async function sendNft(url, signer, nftAccount, to) {
  const n = decodeNft((await accountInfo(url, nftAccount)).data)
  if (!n || n.owner !== signer.address) throw new Error('This wallet does not hold that NFT.')
  const m = (await accountInfo(url, n.mint)).data
  if (m.length !== 48 || Pubkey.from(m.slice(0, 32)).toThruFmt() !== signer.address) {
    throw new Error('This collection moves its NFTs through its own program. Send it from the collection\'s site.')
  }
  const readOnly = sortAddresses([to, n.mint])
  const at = (a) => (a === nftAccount ? 2 : 3 + readOnly.indexOf(a))
  const data = new Uint8Array(10)
  const dv = new DataView(data.buffer)
  dv.setUint32(0, 2, true)
  dv.setUint16(4, at(nftAccount), true)
  dv.setUint16(6, at(to), true)
  dv.setUint16(8, at(n.mint), true)
  return sendInstruction(url, signer, { program: PROGRAMS.NFT, readWrite: [nftAccount], readOnly, data })
}

/**
 * Token balances. Tokens a wallet holds leave traces in its history (opening an
 * account, receiving, swapping), so the history names the token accounts to
 * check; the well-known quote tokens are checked regardless.
 */
export async function holdings(url, address) {
  const candidates = new Set(await Promise.all(KNOWN_MINTS.map((m) => deriveTokenAccount(m, address))))
  let page = null
  for (let i = 0; i < 3; i++) {
    try {
      const h = await history(url, address, page, { times: false })
      for (const it of h.items) for (const a of [...it.rw, ...it.ro]) candidates.add(a)
      page = h.next
      if (!page) break
    } catch { break }
  }
  const infos = await Promise.all([...candidates].map(async (a) => [a, await accountInfo(url, a)]))
  const tokens = []
  for (const [account, info] of infos) {
    const t = decodeTokenAccount(info.data)
    if (t && t.owner === address) tokens.push({ account, ...t })
  }
  const mints = await Promise.all([...new Set(tokens.map((t) => t.mint))].map(async (m) => [m, decodeMint((await accountInfo(url, m)).data)]))
  const byMint = Object.fromEntries(mints)
  return tokens
    .map((t) => ({ ...t, ticker: byMint[t.mint]?.ticker || `${t.mint.slice(0, 4)}…`, decimals: byMint[t.mint]?.decimals ?? 6 }))
    .sort((a, b) => (b.amount > a.amount ? 1 : -1))
}

/** name.id to an address: the name's `addr` record if set, else its owner. */
export async function resolveName(url, input) {
  const name = String(input).trim().toLowerCase().replace(/\.id$/, '')
  const digest = await sha256(concat(bytesOf(NAMES_ROOT), new TextEncoder().encode(name)))
  const domain = deriveProgramAddress({ programAddress: PROGRAMS.NAME_SERVICE, seed: digest }).address
  const info = await accountInfo(url, domain)
  if (!info.exists || info.data.length < 145) throw new Error(`${name}.id is not registered.`)
  const b = info.data
  const owner = Pubkey.from(b.slice(33, 65)).toThruFmt()
  // Records follow the 145-byte header: [u32 key_len][32 key][u32 value_len][256 value]
  for (let at = 145; at + 296 <= b.length; at += 296) {
    const kl = new DataView(b.buffer, b.byteOffset).getUint32(at, true)
    const key = new TextDecoder().decode(b.slice(at + 4, at + 4 + Math.min(kl, 32)))
    if (key === 'addr') {
      const vl = new DataView(b.buffer, b.byteOffset).getUint32(at + 36, true)
      const v = new TextDecoder().decode(b.slice(at + 40, at + 40 + Math.min(vl, 256)))
      if (isAddress(v)) return { address: v, name: `${name}.id` }
    }
  }
  return { address: owner, name: `${name}.id` }
}

/* ---------- writing ---------- */

/**
 * Build and sign a transaction paid for by `signer`. Accounts must already be
 * in the order the instruction's indices assume, which is sorted by raw bytes.
 */
export async function buildSigned(url, signer, { program, readWrite = [], readOnly = [], data, computeUnits = 300_000_000, stateUnits = 60_000, memoryUnits = 60_000 }) {
  const c = client(url)
  const [me, height, chainId] = await Promise.all([accountInfo(url, signer.address), c.blocks.getBlockHeight(), c.chain.getChainId()])
  if (!me.exists) throw new Error('This account is not on chain yet. Activate it first.')
  return new TransactionBuilder().buildAndSign({
    feePayer: { publicKey: signer.address, privateKey: signer.privateKey },
    program,
    accounts: { readWriteAccounts: readWrite, readOnlyAccounts: readOnly },
    header: {
      // Pay a fee when there is THRU to pay it with. Alphanet accepts zero.
      fee: me.balance > 0n ? 1n : 0n,
      nonce: me.nonce,
      startSlot: height.finalized,
      expiryAfter: 100,
      chainId,
      computeUnits, stateUnits, memoryUnits,
    },
    instructionData: data,
  })
}

/** The chain's verdict on a signature, polled for up to ~20 seconds. */
export async function waitFor(url, signature, timeoutMs = 20_000) {
  const c = client(url)
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    await sleep(1000)
    try {
      const t = await c.transactions.get(signature)
      const ex = t.executionResult
      if (ex) return { settled: true, ok: (ex.vmError ?? 0) === 0 && BigInt(ex.userErrorCode ?? 0n) === 0n, vmError: ex.vmError ?? 0, userError: Number(ex.userErrorCode ?? 0n) }
    } catch { /* not landed yet */ }
  }
  return { settled: false }
}

/** Send signed bytes. The node sometimes answers "busy" to a send it then runs. */
export async function submit(url, rawTransaction, signatureBytes) {
  const signature = Signature.from(signatureBytes).toThruFmt()
  try { await client(url).transactions.send(rawTransaction) } catch (e) {
    const r = await waitFor(url, signature, 6000)
    if (!r.settled) throw e
  }
  return signature
}

export async function sendInstruction(url, signer, args) {
  const { rawTransaction, signature } = await buildSigned(url, signer, args)
  return submit(url, rawTransaction, signature)
}

/**
 * Bring this key's account into existence on chain. Thru allows a brand-new key
 * to pay for its own creation with a state proof, so nobody else is involved.
 */
export async function activate(url, signer) {
  const c = client(url)
  const tx = await c.accounts.create({ publicKey: signer.address })
  tx.chainId = await c.chain.getChainId()
  const sig = await tx.sign(signer.privateKey)
  await submit(url, tx.toWire(), sig)
  for (let i = 0; i < 15; i++) {
    await sleep(1000)
    if ((await accountInfo(url, signer.address)).exists) return true
  }
  throw new Error('The account did not appear yet. Try again in a moment.')
}

/** Thru's own alphanet faucet: up to 10,000 test THRU per claim, to whoever signs. */
export async function claimThru(url, signer, amount = FAUCET_MAX) {
  const data = new Uint8Array(16)
  const dv = new DataView(data.buffer)
  dv.setUint32(0, 1, true)
  dv.setUint32(4, 2, true)
  dv.setBigUint64(8, amount > FAUCET_MAX ? FAUCET_MAX : amount, true)
  return sendInstruction(url, signer, { program: PROGRAMS.FAUCET, readWrite: [FAUCET_ACCOUNT], data, computeUnits: 300_000, stateUnits: 10_000, memoryUnits: 10_000 })
}

export async function sendThru(url, signer, to, amount) {
  const data = new Uint8Array(16)
  const dv = new DataView(data.buffer)
  dv.setUint32(0, 1, true)
  dv.setBigUint64(4, BigInt(amount), true)
  dv.setUint16(12, 0, true)
  dv.setUint16(14, 2, true)
  return sendInstruction(url, signer, { program: PROGRAMS.EOA, readWrite: [to], data, computeUnits: 300_000, stateUnits: 10_000, memoryUnits: 10_000 })
}

/** Open the token account `owner` needs for `mint`, paid for by `signer`. */
export async function openTokenAccount(url, signer, mint, owner) {
  const account = await deriveTokenAccount(mint, owner)
  if ((await accountInfo(url, account)).exists) return account
  const proof = await client(url).proofs.generate({ address: account, proofType: 1 })
  const readOnly = owner === signer.address ? [mint] : sortAddresses([mint, owner])
  const at = (a) => (a === signer.address ? 0 : a === account ? 2 : 3 + readOnly.indexOf(a))
  const head = new Uint8Array(39)
  const dv = new DataView(head.buffer)
  head[0] = 0x01
  dv.setUint16(1, at(account), true)
  dv.setUint16(3, at(mint), true)
  dv.setUint16(5, at(owner), true)
  const sig = await sendInstruction(url, signer, { program: PROGRAMS.TOKEN, readWrite: [account], readOnly, data: concat(head, proof.proof) })
  const r = await waitFor(url, sig)
  if (r.settled && !r.ok) throw new Error(`Could not open the token account (error ${r.userError || r.vmError}).`)
  return account
}

/** TRANSFER: [0x02][source u16][dest u16][amount u64]. The source's owner signs. */
export async function sendToken(url, signer, mint, to, amount) {
  const source = await deriveTokenAccount(mint, signer.address)
  const dest = await openTokenAccount(url, signer, mint, to)
  const readWrite = sortAddresses([source, dest])
  const data = new Uint8Array(13)
  const dv = new DataView(data.buffer)
  data[0] = 0x02
  dv.setUint16(1, 2 + readWrite.indexOf(source), true)
  dv.setUint16(3, 2 + readWrite.indexOf(dest), true)
  dv.setBigUint64(5, BigInt(amount), true)
  return sendInstruction(url, signer, { program: PROGRAMS.TOKEN, readWrite, data })
}

export async function signMessageBytes(signer, message) {
  return sdkSignMessage(message, signer.privateKey, signer.publicKey)
}
