// api/rpc.js
//
// Vercel serverless proxy for the Thru node.
//
// Why this exists: the Thru node sends no CORS headers, so the browser cannot
// call it directly. This function calls the node server to server and returns
// plain JSON, so the browser only ever talks to thruscan.vercel.app.
//
// It also sidesteps a protocol problem. @thru/thru-sdk in the browser uses
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
//   /api/rpc?action=status
//   /api/rpc?action=height
//   /api/rpc?action=version
//   /api/rpc?action=chainInfo
//   /api/rpc?action=endpoint      -> which endpoint/protocol is live

import dns from 'node:dns'
import { createThruClient } from '@thru/thru-sdk'
import { createGrpcTransport, createGrpcWebTransport } from '@connectrpc/connect-node'

export const config = { runtime: 'nodejs' }

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

async function resolveClient() {
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

function withTimeout(promise, ms) {
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
