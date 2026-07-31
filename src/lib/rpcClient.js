// src/lib/rpcClient.js
//
// Browser side of the CORS fix. Replaces direct createThruClient() calls in
// the Explorer with same-origin calls to /api/rpc.
//
// Nothing here imports @thru/thru-sdk, so the browser bundle no longer needs
// the SDK for reads at all. That also removes the risk of the SDK silently
// falling back to its own DEFAULT_HOST, which is still hardcoded to the dead
// grpc-web.alphanet.thruput.org.

const BASE = '/api/rpc'

export class RpcError extends Error {
  constructor(message, { status, endpoint, tried } = {}) {
    super(message)
    this.name = 'RpcError'
    this.status = status
    this.endpoint = endpoint
    this.tried = tried
  }
}

async function call(action, params = {}, { signal } = {}) {
  const query = new URLSearchParams({ action, ...params })
  let res
  try {
    res = await fetch(`${BASE}?${query}`, { signal })
  } catch (err) {
    throw new RpcError('could not reach ThruScan API', { status: 0 })
  }

  let body
  try {
    body = await res.json()
  } catch {
    throw new RpcError(`bad response from API (${res.status})`, { status: res.status })
  }

  if (!res.ok || body.ok === false) {
    throw new RpcError(body.error ?? `request failed (${res.status})`, {
      status: res.status,
      endpoint: body.endpoint,
      tried: body.tried,
    })
  }
  return body
}

/** Which node the proxy is actually talking to. Useful for a status badge. */
export function getEndpoint(opts) {
  return call('endpoint', {}, opts).then((b) => b.endpoint)
}

export function getNodeStatus(opts) {
  return call('status', {}, opts).then((b) => b.status)
}

export function getVersion(opts) {
  return call('version', {}, opts).then((b) => b.version)
}

export function getBlockHeight(opts) {
  return call('height', {}, opts).then((b) => b.height)
}

export function getChainInfo(opts) {
  return call('chainInfo', {}, opts).then((b) => b.info)
}

/**
 * Fetch an account. Shape is flattened and JSON safe:
 *   { address, meta: { owner, balance, dataSize, seq, nonce, flags },
 *     data: { base64, byteLength, compressed } }
 *
 * account.data.base64 feeds straight into decodeNameServiceAccount()
 * from src/lib/nameservice.js.
 */
export function getAccount(address, opts) {
  if (!address || typeof address !== 'string') {
    return Promise.reject(new RpcError('address is required'))
  }
  return call('account', { address: address.trim() }, opts).then((b) => b.account)
}

/** True if the account looks like a name service account (kind byte 1 or 2). */
export function isNameServiceAccount(account) {
  const b64 = account?.data?.base64
  if (!b64) return false
  const first = atob(b64).charCodeAt(0)
  return first === 1 || first === 2
}
