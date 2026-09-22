// api/rpc.js
//
// Vercel serverless proxy for the Thru node.
//
// Why this exists: the Thru node sends no CORS headers, so the browser cannot
// call it directly. This function calls the node server to server and returns
// plain JSON, so the browser only ever talks to thruscan.vercel.app.
//
// It also sidesteps a protocol problem. The SDK in the browser uses
// createGrpcWebTransport, but the node the CLI talks to (rpc.alphanet.thru.org)
// speaks native gRPC over HTTP/2. Node can do both, so this function tries
// native gRPC first and falls back to gRPC-Web, then remembers which worked.
//
// Must run on the Node runtime, not Edge. connect-node needs node:http2.
//
// Requires: npm i @connectrpc/connect-node
//
// Routes (GET or POST):
//   /api/rpc?action=account&address=ta...
//   /api/rpc?action=transaction&signature=ts...
//   /api/rpc?action=status
//   /api/rpc?action=height
//   /api/rpc?action=version
//   /api/rpc?action=chainInfo
//   /api/rpc?action=endpoint      -> which endpoint/protocol is live
//   /api/rpc?action=history&addresses=ta...,ta...&pages={json}  -> recent transactions
//   /api/rpc?action=pals[&wallet=ta...]  -> Pixel Pals: count, price, minters, and this wallet's Pals
//   /api/rpc?action=pal&id=N             -> Pal N's metadata (what the NFT on chain points at)
//   /api/rpc?action=palimg&id=N          -> Pal N's picture, as SVG

import dns from 'node:dns'
import { createThruClient, Pubkey, Signature, Transaction } from '@thru/sdk'
import { createGrpcTransport, createGrpcWebTransport } from '@connectrpc/connect-node'
import { decodeConfig, decodeMarket, nftAccountFor, PALS_CONFIG, PALS_MARKET, PALS_NFT_MINT, PALS_PROGRAM, PALS_SITE } from '../src/lib/pals/chain.js'
import { palsInOrder, toSvg } from '../src/lib/pals/art.js'

export const config = { runtime: 'nodejs', maxDuration: 30 }

// Prefer IPv4. rpc.alphanet.thru.org publishes a NAT64 AAAA record alongside
// its A record, and Node will happily pick the v6 one and fail with EAI_AGAIN
// on networks without working v6. This is the programmatic equivalent of
// running node with --dns-result-order=ipv4first.
dns.setDefaultResultOrder('ipv4first')

// Ordered candidates. First one that answers a health check wins.
// THRU_RPC_URL in Vercel env jumps the queue if Unto Labs moves hosts again.
const CANDIDATES = [
  ...(process.env.THRU_RPC_URL
    ? [{ url: process.env.THRU_RPC_URL, protocol: process.env.THRU_RPC_PROTOCOL || 'grpc' }]
    : []),
  { url: 'https://rpc.alphanet.thru.org', protocol: 'grpc' },
  { url: 'https://rpc.alphanet.thru.org', protocol: 'grpc-web' },
  { url: 'https://grpc-web.alphanet.thru.org', protocol: 'grpc-web' },
]

const PROBE_TIMEOUT_MS = 6000
const CALL_TIMEOUT_MS = 10000

// Module scope, so a warm lambda reuses the working endpoint instead of
// re-probing every request.
let cached = null

function buildClient({ url, protocol }) {
  const make = protocol === 'grpc-web' ? createGrpcWebTransport : createGrpcTransport
  return createThruClient({ transport: make({ baseUrl: url }) })
}

export async function resolveClient() {
  if (cached) return cached

  const failures = []
  for (const candidate of CANDIDATES) {
    try {
      const client = buildClient(candidate)
      // Cheapest possible round trip that proves the wire protocol matches.
      await withTimeout(client.chain.getChainId(), PROBE_TIMEOUT_MS)
      cached = { client, ...candidate }
      return cached
    } catch (err) {
      failures.push(`${candidate.protocol} ${candidate.url}: ${err?.message ?? err}`)
    }
  }

  const error = new Error('no reachable Thru RPC endpoint')
  error.detail = failures
  throw error
}

export function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ])
}

function toBase64(bytes) {
  if (!bytes) return null
  return Buffer.from(bytes).toString('base64')
}

// The SDK returns bigints and Pubkey instances, neither of which survive
// JSON.stringify. Flatten to a shape the browser can use directly.
function serializeAccount(account) {
  const meta = account.meta
  const data = account.data
  return {
    address: account.address?.toThruFmt() ?? null,
    meta: meta
      ? {
          version: meta.version,
          dataSize: meta.dataSize,
          seq: meta.seq?.toString() ?? null,
          owner: meta.owner?.toThruFmt() ?? null,
          balance: meta.balance?.toString() ?? null,
          nonce: meta.nonce?.toString() ?? null,
          flags: meta.flags ? { ...meta.flags } : null,
        }
      : null,
    data: data
      ? {
          // base64, ready for decodeNameServiceAccount() in src/lib/nameservice.js
          base64: toBase64(data.data),
          byteLength: data.data?.length ?? 0,
          compressed: Boolean(data.compressed),
          compressionAlgorithm: data.compressionAlgorithm ?? null,
        }
      : null,
    consensusStatus: account.consensusStatus ?? null,
  }
}

// Transactions carry bigints, Pubkey/Signature instances and raw byte arrays,
// none of which survive JSON.stringify. Flatten to what the UI actually shows.
function serializeTransaction(tx, statusSnapshot) {
  const exec = tx.executionResult
  const sig = typeof tx.getSignature === 'function' ? tx.getSignature() : undefined

  return {
    signature: sig?.toThruFmt?.() ?? null,
    slot: tx.slot?.toString() ?? null,
    blockOffset: tx.blockOffset ?? null,
    version: tx.version ?? null,
    chainId: tx.chainId ?? null,

    feePayer: tx.feePayer?.toThruFmt?.() ?? null,
    program: tx.program?.toThruFmt?.() ?? null,
    fee: tx.fee?.toString() ?? null,
    nonce: tx.nonce?.toString() ?? null,
    startSlot: tx.startSlot?.toString() ?? null,
    expiryAfter: tx.expiryAfter ?? null,

    requested: {
      compute: tx.requestedComputeUnits ?? null,
      state: tx.requestedStateUnits ?? null,
      memory: tx.requestedMemoryUnits ?? null,
    },

    readWriteAccounts: (tx.readWriteAccounts ?? []).map((a) => a.toThruFmt()),
    readOnlyAccounts: (tx.readOnlyAccounts ?? []).map((a) => a.toThruFmt()),

    instructionData: tx.instructionData ? toBase64(tx.instructionData) : null,
    instructionDataSize: tx.instructionDataSize ?? tx.instructionData?.length ?? 0,

    status: statusSnapshot
      ? { label: statusSnapshot.status ?? null, code: statusSnapshot.statusCode ?? null }
      : null,

    execution: exec
      ? {
          consumedCompute: exec.consumedComputeUnits ?? null,
          consumedState: exec.consumedStateUnits ?? null,
          consumedMemory: exec.consumedMemoryUnits ?? null,
          pagesUsed: exec.pagesUsed ?? null,
          eventsCount: exec.eventsCount ?? null,
          eventsSize: exec.eventsSize ?? null,
          // 0 on both of these means the program ran without raising an error.
          userErrorCode: exec.userErrorCode?.toString() ?? null,
          executionResult: exec.executionResult?.toString() ?? null,
          vmError: exec.vmError ?? null,
          errorProgramAccIdx: exec.errorProgramAccIdx ?? null,
        }
      : null,
  }
}


/* ---------- history ----------
   The node's list call already returns whole transactions. The SDK's wrapper
   throws them away and fetches each one again, which made a page of ten take
   twelve seconds, so this calls the query service directly. Times come from
   header-only block reads, one per distinct slot, all in parallel. */

const HISTORY_LIMIT = 15
const MAX_HISTORY_ADDRESSES = 6

async function historyFor(client, address, pageToken) {
  const res = await withTimeout(client.ctx.query.listTransactionsForAccount({
    account: Pubkey.from(address).toProtoPubkey(),
    page: { pageSize: HISTORY_LIMIT, ...(pageToken ? { pageToken } : {}) },
  }), CALL_TIMEOUT_MS)
  return {
    txs: (res.transactions ?? []).map((p) => Transaction.fromProto(p)),
    next: res.page?.nextPageToken || null,
  }
}

const timeCache = new Map()

async function blockTimes(client, slots) {
  const out = {}
  await Promise.all(slots.map(async (slot) => {
    if (timeCache.has(String(slot))) { out[slot] = timeCache.get(String(slot)); return }
    try {
      const b = await withTimeout(
        client.ctx.query.getBlock({ selector: { case: 'slot', value: BigInt(slot) }, view: 1 }),
        CALL_TIMEOUT_MS,
      )
      const t = b.header?.blockTime
      if (t) {
        out[slot] = Number(t.seconds) * 1000 + Math.floor((t.nanos ?? 0) / 1e6)
        if (timeCache.size > 20000) timeCache.clear()
        timeCache.set(String(slot), out[slot])
      }
    } catch { /* a missing time is shown as blank, not as an error */ }
  }))
  return out
}

function serializeHistoryItem(tx) {
  const ex = tx.executionResult
  const data = tx.instructionData ?? new Uint8Array()
  return {
    signature: tx.getSignature?.()?.toThruFmt?.() ?? null,
    slot: tx.slot?.toString() ?? null,
    offset: tx.blockOffset ?? 0,
    program: tx.program?.toThruFmt?.() ?? null,
    feePayer: tx.feePayer?.toThruFmt?.() ?? null,
    rw: (tx.readWriteAccounts ?? []).map((a) => a.toThruFmt()),
    ro: (tx.readOnlyAccounts ?? []).map((a) => a.toThruFmt()),
    // Enough of the instruction to name the action and read a name or amount,
    // not the proofs that follow.
    data: toBase64(data.slice(0, 96)),
    ok: ex ? (ex.vmError ?? 0) === 0 && BigInt(ex.userErrorCode ?? 0n) === 0n : null,
    error: ex ? { vm: ex.vmError ?? 0, user: ex.userErrorCode?.toString() ?? '0' } : null,
  }
}

/* ---------- overview ----------
   The explorer's front page: the newest blocks and transactions on the whole
   chain, in one round trip. Each list is a single query to the node. */

function tsMs(t) {
  return t ? Number(t.seconds) * 1000 + Math.floor((t.nanos ?? 0) / 1e6) : null
}

async function overview(client, blockCount = 60, txCount = 25) {
  const [blocks, txs, status] = await Promise.all([
    withTimeout(client.ctx.query.listBlocks({ page: { pageSize: blockCount }, view: 2 }), CALL_TIMEOUT_MS),
    withTimeout(client.ctx.query.listTransactions({ page: { pageSize: 100 } }), CALL_TIMEOUT_MS),
    withTimeout(client.node.getStatus(), CALL_TIMEOUT_MS).catch(() => null),
  ])

  const perSlot = {}
  const items = (txs.transactions ?? []).map((p) => Transaction.fromProto(p))
  for (const t of items) {
    const k = t.slot?.toString()
    perSlot[k] = (perSlot[k] ?? 0) + 1
  }

  const blockRows = (blocks.blocks ?? []).map((b) => {
    const slot = b.header?.slot?.toString() ?? null
    return {
      slot,
      time: tsMs(b.header?.blockTime),
      producer: b.header?.producer?.value ? Pubkey.from(b.header.producer.value).toThruFmt() : null,
      compute: b.footer?.consumedComputeUnits?.toString() ?? '0',
      txs: perSlot[slot] ?? null,
    }
  })
  const times = Object.fromEntries(blockRows.map((b) => [b.slot, b.time]))

  // Counts are only known for slots the transaction list reaches back to.
  const oldestTxSlot = items.length ? items[items.length - 1].slot : null
  for (const b of blockRows) {
    if (b.txs === null && oldestTxSlot !== null && BigInt(b.slot) > oldestTxSlot) b.txs = 0
  }

  const latest = items.slice(0, txCount).map((t) => {
    const row = serializeHistoryItem(t)
    row.time = times[row.slot] ?? null
    return row
  })

  const timed = blockRows.filter((b) => b.time)
  const blockTime = timed.length > 1
    ? (timed[0].time - timed[timed.length - 1].time) / (Number(BigInt(timed[0].slot) - BigInt(timed[timed.length - 1].slot)) || 1)
    : null

  // Throughput over the slots the transaction list covers, timed by the
  // average block time, since the oldest of those blocks may not be listed.
  let tps = null
  if (items.length > 1 && blockTime) {
    const span = Number(items[0].slot - items[items.length - 1].slot) + 1
    tps = items.length / ((span * blockTime) / 1000)
  }

  return {
    finalized: status?.finalizedSlot?.toString() ?? blockRows[0]?.slot ?? null,
    executed: status?.locallyExecutedSlot?.toString() ?? null,
    blockTimeMs: blockTime,
    tps,
    blocks: blockRows,
    transactions: latest,
  }
}

/* ---------- token movements ----------
   The token program records every transfer, mint and burn as an event on the
   transaction: which accounts, and how much. The list call leaves events out,
   so each transaction is fetched once more with them. Token accounts and mints
   are read once per warm server and kept, since neither changes. */

const TOKEN_PROGRAM_HEX = '00'.repeat(31) + 'aa'
const accountInfo = new Map()   // address -> { kind: 'token', mint, owner } | { kind: 'mint', ticker, decimals } | { kind: 'other' }

async function describeAccounts(client, addresses) {
  const missing = [...new Set(addresses)].filter((a) => !accountInfo.has(a))
  await Promise.all(missing.map(async (a) => {
    try {
      const acc = await withTimeout(client.accounts.get(a), CALL_TIMEOUT_MS)
      const b = acc.data?.data ?? new Uint8Array()
      if (b.length === 73) {
        accountInfo.set(a, { kind: 'token', mint: Pubkey.from(b.slice(0, 32)).toThruFmt(), owner: Pubkey.from(b.slice(32, 64)).toThruFmt() })
      } else if (b.length === 115) {
        const len = Math.min(b[0x6a], 8)
        accountInfo.set(a, { kind: 'mint', decimals: b[0], ticker: Buffer.from(b.slice(0x6b, 0x6b + len)).toString('ascii') })
      } else {
        accountInfo.set(a, { kind: 'other' })
      }
    } catch { /* unknown for now; tried again next time */ }
  }))
}

// A landed transaction's events never change, so a warm server keeps them.
const eventCache = new Map()

async function tokenEvents(client, signature) {
  if (eventCache.has(signature)) return eventCache.get(signature)
  const list = await tokenEventsFresh(client, signature)
  if (eventCache.size > 5000) eventCache.clear()
  eventCache.set(signature, list)
  return list
}

async function tokenEventsFresh(client, signature) {
  const t = await withTimeout(
    client.ctx.query.getTransaction({ signature: { value: Signature.from(signature).toBytes() }, returnEvents: true }),
    CALL_TIMEOUT_MS,
  )
  const out = []
  for (const e of t.executionResult?.events ?? []) {
    if (Buffer.from(e.program?.value ?? []).toString('hex') !== TOKEN_PROGRAM_HEX) continue
    const p = Buffer.from(e.payload ?? [])
    if (p.length < 73) continue
    const a = Pubkey.from(p.subarray(1, 33)).toThruFmt()
    const b = Pubkey.from(p.subarray(33, 65)).toThruFmt()
    if (p[0] === 2) out.push({ op: 'transfer', from: a, to: b, amount: p.readBigUInt64LE(65).toString() })
    else if (p[0] === 3 && p.length >= 105) out.push({ op: 'mint', mint: a, to: b, amount: p.readBigUInt64LE(97).toString() })
    else if (p[0] === 4 && p.length >= 105) out.push({ op: 'burn', from: a, mint: b, amount: p.readBigUInt64LE(97).toString() })
  }
  return out
}

/** Events for several transactions, plus what every account in them is. */
async function eventsFor(client, signatures) {
  const lists = await Promise.all(signatures.map((s) => tokenEvents(client, s).catch(() => null)))
  const events = {}
  const touched = []
  signatures.forEach((s, i) => {
    if (!lists[i]) return
    events[s] = lists[i]
    for (const e of lists[i]) touched.push(...[e.from, e.to, e.mint].filter(Boolean))
  })
  await describeAccounts(client, touched)
  // Burns name the account and the mint in an order that is easiest to settle
  // by what each account turns out to be.
  for (const list of Object.values(events)) {
    for (const e of list) {
      if (e.op === 'burn' && accountInfo.get(e.from)?.kind === 'mint') [e.from, e.mint] = [e.mint, e.from]
    }
  }
  const mints = new Set()
  for (const a of touched) {
    const info = accountInfo.get(a)
    if (info?.kind === 'token') mints.add(info.mint)
    if (info?.kind === 'mint') mints.add(a)
  }
  await describeAccounts(client, [...mints])
  const accounts = {}
  for (const a of new Set([...touched, ...mints])) if (accountInfo.has(a)) accounts[a] = accountInfo.get(a)
  return { events, accounts }
}

function json(res, status, body, { cacheSeconds = 0 } = {}) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader(
    'Cache-Control',
    cacheSeconds > 0
      ? `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 4}`
      : 'no-store'
  )
  res.status(status).send(JSON.stringify(body))
}

/* ---------- ThruScan's own numbers ----------

   Everything the site does for a visitor is paid for by one key, the sponsor:
   putting a new wallet on chain, the faucet, registering a .id name, clearing
   a wallet to mint a Pal. So its transaction history IS the usage record, and
   it cannot be inflated by page refreshes or bots. The scan is paginated and
   cached here; each request continues where the last one stopped.
*/

const SPONSOR = process.env.THRU_SPONSOR_PUBKEY || ''
const EOA_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const FAUCET_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPr6'
const NAME_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUF'
const TOKEN_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq'
const STATS_PAGE = 200          // transactions per request to the node
const STATS_PAGES_PER_CALL = 2  // at most, so one request stays inside its 30s
const STATS_TTL_MS = 5 * 60 * 1000

let statsScan = null   // { at, done, next, seen:Set, rows:[] }

function statsDay(ms) { return new Date(ms).toISOString().slice(0, 10) }

async function scanSponsor(client) {
  const fresh = !statsScan || (statsScan.done && Date.now() - statsScan.at > STATS_TTL_MS)
  if (fresh) statsScan = { at: Date.now(), done: false, next: null, seen: new Set(), rows: [] }
  const scan = statsScan
  for (let i = 0; i < STATS_PAGES_PER_CALL && !scan.done; i++) {
    const res = await withTimeout(client.ctx.query.listTransactionsForAccount({
      account: Pubkey.from(SPONSOR).toProtoPubkey(),
      page: { pageSize: STATS_PAGE, ...(scan.next ? { pageToken: scan.next } : {}) },
    }), 20000)
    for (const p of res.transactions ?? []) {
      const tx = Transaction.fromProto(p)
      const sig = tx.getSignature?.()?.toThruFmt?.() ?? null
      if (!sig || scan.seen.has(sig)) continue
      scan.seen.add(sig)
      const ex = tx.executionResult
      const data = tx.instructionData ?? new Uint8Array()
      scan.rows.push({
        program: tx.program?.toThruFmt?.() ?? null,
        op: data.length ? data[0] : null,
        rw: (tx.readWriteAccounts ?? []).map((a) => a.toThruFmt()),
        ro: (tx.readOnlyAccounts ?? []).map((a) => a.toThruFmt()),
        slot: tx.slot?.toString() ?? null,
        ok: ex ? (ex.vmError ?? 0) === 0 && BigInt(ex.userErrorCode ?? 0n) === 0n : true,
      })
    }
    scan.next = res.page?.nextPageToken || null
    if (!scan.next) { scan.done = true; scan.at = Date.now() }
  }
  return scan
}

/** Turns the scanned rows into the counts the stats page shows. */
async function sponsorStats(client) {
  const scan = await scanSponsor(client)
  const wallets = new Set(), names = new Set(), cleared = new Set(), tokens = new Set()
  const slots = new Set()
  const events = []
  for (const r of scan.rows) {
    if (!r.ok) continue
    let kind = null, who = null
    if (r.program === EOA_PROGRAM) {
      // A wallet made on ThruScan, put on chain at the site's expense.
      kind = 'wallet'; who = r.rw[0]
    } else if (r.program === NAME_PROGRAM) {
      kind = 'name'; who = r.rw.join(',')
    } else if (r.program === PALS_PROGRAM && r.op === 0x01) {
      // ALLOW: a wallet cleared to mint a Pal, one per person who tried.
      kind = 'cleared'; who = r.ro[0]
    } else if (r.program === TOKEN_PROGRAM && r.ro.length === 2) {
      // A token account opened for somebody: [mint, owner] are read-only.
      kind = 'token'; who = r.ro[1]
    }
    if (!kind || !who) continue
    if (kind === 'wallet') wallets.add(who)
    if (kind === 'name') names.add(who)
    if (kind === 'cleared') cleared.add(who)
    if (kind === 'token') tokens.add(who)
    events.push({ kind, slot: r.slot })
    if (r.slot) slots.add(r.slot)
  }
  // Dates for the daily chart: block times for the newest slots only, and
  // never allowed to hold up the answer.
  const recent = [...slots].sort((a, b) => Number(BigInt(b) - BigInt(a))).slice(0, 200)
  const times = recent.length ? await withTimeout(blockTimes(client, recent), 5000).catch(() => ({})) : {}
  const byDay = new Map()
  for (const e of events) {
    const t = times[e.slot]
    if (!t) continue
    const day = statsDay(t)
    const row = byDay.get(day) ?? { day, wallet: 0, name: 0, cleared: 0, token: 0 }
    row[e.kind] += 1
    byDay.set(day, row)
  }
  return {
    sponsor: SPONSOR,
    scanned: scan.rows.length,
    complete: scan.done,
    wallets: wallets.size,
    names: names.size,
    cleared: cleared.size,
    tokens: tokens.size,
    daily: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-30),
  }
}

/* ---------- Pixel Pals ----------
   One account holds the whole collection's state. Read it at most every few
   seconds per warm instance; the art is a pure function of that state. */

let palsCache = null
let marketCache = null

async function palsState(client) {
  if (palsCache && Date.now() - palsCache.at < 4000) return palsCache.cfg
  let cfg = null
  try {
    // The node is sometimes slow to answer for this (large) account. Wait a
    // little longer than for other calls, and if it still fails, serve the
    // last good copy for up to two minutes rather than an error.
    const a = await withTimeout(client.accounts.get(PALS_CONFIG), 18000)
    cfg = decodeConfig(a?.data?.data)
  } catch (err) {
    if (!/not ?found/i.test(String(err?.message ?? err))) {
      if (palsCache?.cfg && Date.now() - palsCache.at < 120000) return palsCache.cfg
      throw err
    }
  }
  palsCache = { at: Date.now(), cfg }
  return cfg
}

/* The market account: every live listing and the last 64 sales. Missing
   until the admin creates it, in which case the market is simply closed. */
async function marketState(client) {
  if (marketCache && Date.now() - marketCache.at < 4000) return marketCache.m
  let m = null
  try {
    const a = await withTimeout(client.accounts.get(PALS_MARKET), 18000)
    m = decodeMarket(a?.data?.data)
  } catch (err) {
    if (!/not ?found|invalid/i.test(String(err?.message ?? err))) {
      if (marketCache?.m && Date.now() - marketCache.at < 120000) return marketCache.m
      throw err
    }
  }
  marketCache = { at: Date.now(), m }
  return m
}

async function marketSummary(client, cfg, m) {
  const holders = new Set(cfg.pals.map((p) => p.owner).filter((o) => o !== PALS_PROGRAM))
  // A listing counts only while the program really holds that Pal.
  const listings = m ? [...m.listings.values()].filter((l) => cfg.ownerOf(l.id) === PALS_PROGRAM) : []
  listings.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : a.id - b.id))
  const recent = m ? m.recent : []
  // Times for the newest sales only, and never allowed to hold up the page.
  const slots = [...new Set(recent.slice(0, 16).map((r) => r.slot.toString()))]
  const times = slots.length ? await withTimeout(blockTimes(client, slots), 3000).catch(() => ({})) : {}
  if (!m) return { live: false, holders: holders.size, listings: [], recent: [] }
  return {
    live: true,
    feeBps: m.feeBps,
    listed: listings.length,
    floor: listings.length ? listings[0].price.toString() : null,
    sales: m.sales,
    volume: m.volume.toString(),
    holders: holders.size,
    listings: listings.map((l) => ({ id: l.id, nftId: cfg.nftIdOf(l.id), seller: l.seller, payout: l.payout, price: l.price.toString(), slot: l.slot.toString() })),
    recent: recent.map((r) => ({ id: r.id, price: r.price.toString(), buyer: r.buyer, seller: r.seller, slot: r.slot.toString(), time: times[r.slot.toString()] ?? null })),
  }
}

function palMeta(id, pal) {
  const attributes = Object.entries(pal.traits).map(([trait_type, value]) => ({ trait_type, value }))
  return {
    name: `Pixel Pal #${id}`,
    description: 'One of 2,026 Pixel Pals on Thru. Every one is different.',
    image: `${PALS_SITE}/api/rpc?action=palimg&id=${id}`,
    external_url: `${PALS_SITE}/pals?id=${id}`,
    attributes,
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {})

  const params = req.method === 'POST' ? req.body ?? {} : req.query ?? {}
  const action = params.action ?? 'status'

  let live
  try {
    live = await resolveClient()
  } catch (err) {
    return json(res, 502, {
      ok: false,
      error: err.message,
      tried: err.detail ?? [],
    })
  }

  const { client, url, protocol } = live
  const endpoint = { url, protocol }

  try {
    switch (action) {
      case 'endpoint':
        return json(res, 200, { ok: true, endpoint }, { cacheSeconds: 30 })

      case 'status': {
        const status = await withTimeout(client.node.getStatus(), CALL_TIMEOUT_MS)
        return json(res, 200, { ok: true, endpoint, status: plain(status) }, { cacheSeconds: 5 })
      }

      case 'version': {
        const version = await withTimeout(client.version.get(), CALL_TIMEOUT_MS)
        return json(res, 200, { ok: true, endpoint, version: plain(version) }, { cacheSeconds: 30 })
      }

      case 'height': {
        const height = await withTimeout(client.blocks.getBlockHeight(), CALL_TIMEOUT_MS)
        return json(res, 200, { ok: true, endpoint, height: plain(height) }, { cacheSeconds: 2 })
      }

      case 'chainInfo': {
        const info = await withTimeout(client.chain.getChainInfo(), CALL_TIMEOUT_MS)
        return json(res, 200, { ok: true, endpoint, info: plain(info) }, { cacheSeconds: 30 })
      }

      case 'account': {
        const address = params.address
        if (!address) {
          return json(res, 400, { ok: false, error: 'missing address' })
        }
        const account = await withTimeout(client.accounts.get(address), CALL_TIMEOUT_MS)
        return json(
          res,
          200,
          { ok: true, endpoint, account: serializeAccount(account) },
          { cacheSeconds: 5 }
        )
      }

      case 'transaction': {
        const signature = params.signature
        if (!signature) {
          return json(res, 400, { ok: false, error: 'missing signature' })
        }
        const target = signature.trim()
        const tx = await withTimeout(client.transactions.get(target), CALL_TIMEOUT_MS)

        // Status is a separate call and is allowed to fail on its own — a
        // transaction that resolves is still worth showing without it.
        let statusSnapshot = null
        try {
          statusSnapshot = await withTimeout(client.transactions.getStatus(target), CALL_TIMEOUT_MS)
        } catch {
          statusSnapshot = null
        }

        return json(
          res,
          200,
          { ok: true, endpoint, transaction: serializeTransaction(tx, statusSnapshot) },
          { cacheSeconds: 10 }
        )
      }


      case 'blocktimes': {
        const slots = String(params.slots ?? '').split(',').map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).slice(0, 50)
        const times = await blockTimes(client, slots)
        // A block's time never changes, so these can be cached for a long time.
        return json(res, 200, { ok: true, times }, { cacheSeconds: 86400 })
      }

      case 'events': {
        const signatures = String(params.signatures ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 30)
        const out = await eventsFor(client, signatures)
        // A transaction's events never change once it has landed.
        return json(res, 200, { ok: true, ...out }, { cacheSeconds: 3600 })
      }

      case 'launchtrades': {
        // Every buy and sell moves quote tokens through the launch's quote
        // vault, so that account's history is the launch's trade history.
        const quoteVault = String(params.quoteVault ?? '')
        const tokenVault = String(params.tokenVault ?? '')
        if (!quoteVault || !tokenVault) return json(res, 400, { ok: false, error: 'missing vaults' })
        const txs = []
        let token = null
        // The first load reads back four pages; a live refresh needs only the newest.
        const pageCount = Math.min(Math.max(Number(params.pages) || 4, 1), 4)
        for (let i = 0; i < pageCount; i++) {
          const page = await historyFor(client, quoteVault, token)
          txs.push(...page.txs)
          token = page.next
          if (!token) break
        }
        const items = txs.map(serializeHistoryItem).filter((t) => t.ok !== false && t.signature)
        const { events } = await eventsFor(client, items.map((t) => t.signature).slice(0, 60))
        const times = await blockTimes(client, [...new Set(items.map((t) => t.slot))])
        const trades = []
        for (const t of items) {
          const ev = events[t.signature] ?? []
          const qIn = ev.find((e) => e.op === 'transfer' && e.to === quoteVault)
          const qOut = ev.find((e) => e.op === 'transfer' && e.from === quoteVault)
          const tIn = ev.find((e) => e.op === 'transfer' && e.to === tokenVault)
          const tOut = ev.find((e) => e.op === 'transfer' && e.from === tokenVault)
          if (qIn && tOut) trades.push({ side: 'buy', quote: qIn.amount, tokens: tOut.amount, trader: t.feePayer, signature: t.signature, time: times[t.slot] ?? null })
          else if (tIn && qOut) trades.push({ side: 'sell', quote: qOut.amount, tokens: tIn.amount, trader: t.feePayer, signature: t.signature, time: times[t.slot] ?? null })
        }
        trades.sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
        return json(res, 200, { ok: true, trades }, { cacheSeconds: 1 })
      }

      case 'overview': {
        const data = await overview(client)
        return json(res, 200, { ok: true, ...data }, { cacheSeconds: 2 })
      }

      case 'history': {
        const addresses = String(params.addresses ?? params.address ?? '')
          .split(',').map((a) => a.trim()).filter(Boolean).slice(0, MAX_HISTORY_ADDRESSES)
        if (addresses.length === 0) return json(res, 400, { ok: false, error: 'missing addresses' })
        let pages = {}
        try { pages = params.pages ? JSON.parse(params.pages) : {} } catch { pages = {} }

        // An address that has run out of pages is skipped on "more".
        const wanted = params.pages ? addresses.filter((a) => pages[a]) : addresses
        const lists = await Promise.all(wanted.map((a) =>
          historyFor(client, a, pages[a]).catch(() => ({ txs: [], next: null }))))

        const seen = new Map()
        const next = {}
        lists.forEach((l, i) => {
          if (l.next) next[wanted[i]] = l.next
          for (const tx of l.txs) {
            const item = serializeHistoryItem(tx)
            if (item.signature && !seen.has(item.signature)) seen.set(item.signature, item)
          }
        })
        const items = [...seen.values()].sort((a, b) =>
          (BigInt(b.slot ?? 0) > BigInt(a.slot ?? 0) ? 1 : BigInt(b.slot ?? 0) < BigInt(a.slot ?? 0) ? -1 : (b.offset - a.offset)))

        const times = await blockTimes(client, [...new Set(items.map((t) => t.slot).filter(Boolean))])
        for (const t of items) t.time = times[t.slot] ?? null

        return json(res, 200, { ok: true, items, next: Object.keys(next).length ? next : null }, { cacheSeconds: 3 })
      }

      case 'stats': {
        if (!SPONSOR) return json(res, 200, { ok: false, error: 'No sponsor key configured on this deployment.' })
        // Optional password: set STATS_KEY in the project's environment to
        // keep these numbers to yourself.
        if (process.env.STATS_KEY && params.key !== process.env.STATS_KEY) {
          return json(res, 401, { ok: false, error: 'Wrong key.', needsKey: true })
        }
        const cfg = await palsState(client).catch(() => null)
        const mkt = cfg ? await marketState(client).catch(() => null) : null
        const site = await sponsorStats(client)
        return json(res, 200, {
          ok: true,
          site,
          pals: cfg ? {
            minted: cfg.minted,
            gifted: cfg.gifted,
            publicLeft: cfg.publicLeft,
            supply: cfg.supply,
            holders: new Set(cfg.pals.map((p) => p.owner).filter((o) => o !== PALS_PROGRAM)).size,
            minters: new Set(cfg.pals.map((p) => p.minter)).size,
            listed: mkt ? [...mkt.listings.values()].filter((l) => cfg.ownerOf(l.id) === PALS_PROGRAM).length : null,
            sales: mkt?.sales ?? null,
            volume: (mkt?.volume ?? 0n).toString(),
          } : null,
        }, { cacheSeconds: 0 })
      }

      case 'pals': {
        // Both accounts at once: the node can be slow, and one after the
        // other doubles the wait.
        const [cfg, mkt] = await Promise.all([palsState(client), marketState(client).catch(() => null)])
        if (!cfg) return json(res, 200, { ok: true, live: false, supply: 2026, minted: 0, price: '1000' }, { cacheSeconds: 5 })
        const wallet = typeof params.wallet === 'string' && /^ta[A-Za-z0-9_-]{44}$/.test(params.wallet) ? params.wallet : null
        let mine = null
        if (wallet) {
          const holding = cfg.pals.filter((p) => p.owner === wallet).map((p) => p.num)
          // A Pal's prize shows only to the wallet holding it, and only once
          // the prizes are locked in and funded.
          const prizes = cfg.prizesLocked
            ? holding.filter((id) => cfg.prize(id) > 0n && !cfg.claimed(id)).map((id) => ({ id, amount: cfg.prize(id).toString() }))
            : []
          mine = {
            listed: [],
            minted: cfg.pals.some((p) => p.minter === wallet),
            allowed: cfg.allowed().some((r) => r.wallet === wallet),
            holding,
            prizes,
          }
        }
        const market = await marketSummary(client, cfg, mkt)
        if (mine) {
          const mineListed = market.listings.filter((l) => l.seller === wallet)
          mine.listed = mineListed.map((l) => l.id)
          // Listed Pals sit with the market until they sell, so the wallet no
          // longer holds them; wallets show them from this list.
          mine.listings = await Promise.all(mineListed.map(async (l) => ({ id: l.id, nftId: l.nftId, price: l.price, account: await nftAccountFor(l.nftId) })))
          // Every Pal this wallet has, with its NFT account, for wallets that
          // cannot find them from their own history (a busy wallet's history
          // scrolls past the transaction that brought the Pal in).
          mine.nfts = await Promise.all(mine.holding.map(async (id) => ({ id, nftId: cfg.nftIdOf(id), account: await nftAccountFor(cfg.nftIdOf(id)) })))
        }
        // lite=1: counts only, for the home page banner and the mint button.
        const lite = params.lite === '1'
        if (lite) { delete market.listings; delete market.recent }
        return json(res, 200, {
          ok: true, live: true, market,
          supply: cfg.supply, minted: cfg.minted, price: cfg.price.toString(),
          // Numbers set aside for the team wallet and not minted yet. They are
          // taken, so the page counts them with the minted ones.
          reservedAhead: cfg.reservedLeft,
          publicLeft: cfg.publicLeft,
          treasury: cfg.treasury, nftMint: PALS_NFT_MINT, prizeVault: cfg.prizeVault,
          // Minted Pals in mint order (the index is the NFT id): [number, minter, holder].
          pals: lite ? undefined : cfg.pals.map((p) => [p.num, p.minter, p.owner]),
          mine,
        }, { cacheSeconds: wallet ? 0 : 3 })
      }

      case 'pal':
      case 'palimg': {
        const id = Number(params.id)
        const cfg = await palsState(client)
        const nftId = cfg && Number.isInteger(id) && id >= 0 && id < cfg.supply ? cfg.nftIdOf(id) : null
        if (nftId === null) return json(res, 404, { ok: false, error: 'No such Pal yet.' })
        const pal = palsInOrder(cfg.pals.slice(0, nftId + 1).map((p) => ({ num: p.num, minter: p.minter }))).get(id)
        // A minted Pal never changes, so these can be cached for a long time.
        if (action === 'palimg') {
          res.setHeader('Content-Type', 'image/svg+xml')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Cache-Control', 'public, s-maxage=31536000, max-age=86400, immutable')
          return res.status(200).send(toSvg(pal.grid, 480))
        }
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Cache-Control', 'public, s-maxage=31536000, max-age=86400, immutable')
        return res.status(200).send(JSON.stringify(palMeta(id, pal)))
      }

      default:
        return json(res, 400, { ok: false, error: `unknown action: ${action}` })
    }
  } catch (err) {
    // A cached endpoint can go stale mid-deploy. Drop it so the next request
    // re-probes instead of failing forever against a dead host.
    cached = null
    const message = err?.message ?? String(err)
    const notFound = /not ?found/i.test(message)
    return json(res, notFound ? 404 : 502, { ok: false, endpoint, error: message })
  }
}

// Protobuf messages carry bigints and byte arrays. Make them JSON safe.
function plain(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return v.toString()
      if (v instanceof Uint8Array) return Buffer.from(v).toString('base64')
      return v
    })
  )
}
