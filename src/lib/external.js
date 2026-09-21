// src/lib/external.js
//
// Using a wallet the visitor already has, instead of ThruScan's browser wallet.
//
// Any wallet that puts a `window.thru` provider on the page works: ThruScan
// Wallet (the Chrome extension) today, and any other wallet that speaks the
// same shape. The keys never come near this site. It hands the wallet a
// transaction request (program, instruction data, accounts), the wallet shows
// it to the user, and if they approve it the wallet signs and sends it and
// gives back the signature.
//
// The connection is remembered as a flag only. On the next visit the provider
// is asked, without a prompt, whether this site is still connected.

const KEY = 'thruscan.external.v1'

/** Where to get the extension. Swap for the Chrome Web Store link once listed. */
export const EXTENSION_URL = 'https://github.com/pgreyy/thruscan/tree/main/extension'

let state = null            // { address, name }
const listeners = new Set()
const emit = () => listeners.forEach((fn) => { try { fn(state) } catch { /* keep going */ } })

export const provider = () => (typeof window !== 'undefined' ? window.thru ?? null : null)
export const hasProvider = () => Boolean(provider())
export const providerName = () => provider()?.name ?? 'your wallet'

export const isExternal = () => state !== null
export const externalAddress = () => state?.address ?? null
export const externalName = () => state?.name ?? null

/** Subscribe to connect and disconnect. Returns an unsubscribe function. */
export function onExternalChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function watch(p) {
  if (!p?.on || p.__thruscanWatched) return
  p.__thruscanWatched = true
  p.on('disconnect', () => { if (state) { state = null; localStorage.removeItem(KEY); emit() } })
  p.on('accountChanged', (d) => { if (state && d?.publicKey) { state = { ...state, address: d.publicKey }; emit() } })
}

/** Ask the wallet to connect. Opens the wallet's approval window. */
export async function connectExternal() {
  const p = provider()
  if (!p) throw new Error('No Thru wallet found in this browser.')
  const r = await p.connect()
  if (!r?.publicKey) throw new Error('The wallet did not share an address.')
  state = { address: r.publicKey, name: p.name ?? 'Wallet' }
  try { localStorage.setItem(KEY, '1') } catch { /* private mode */ }
  watch(p)
  emit()
  return state
}

export async function disconnectExternal() {
  const p = provider()
  state = null
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
  emit()
  try { await p?.disconnect?.() } catch { /* already gone */ }
}

/**
 * Reconnect silently on page load if this site was connected before. The
 * provider script runs at document start, but give it a moment in case it is
 * slower on some pages.
 */
export async function restoreExternal() {
  let flag = null
  try { flag = localStorage.getItem(KEY) } catch { /* ignore */ }
  if (!flag) return null
  for (let i = 0; i < 10 && !provider(); i++) await new Promise((r) => setTimeout(r, 100))
  const p = provider()
  if (!p) return null
  const r = await p.getAccount().catch(() => null)
  if (r?.publicKey) {
    state = { address: r.publicKey, name: p.name ?? 'Wallet' }
    watch(p)
    emit()
  } else {
    try { localStorage.removeItem(KEY) } catch { /* ignore */ }
  }
  return state
}

/**
 * Hand a transaction to the connected wallet. The accounts must already be in
 * the sorted order the instruction's indices assume, exactly as for the
 * browser wallet. Returns the signature once the wallet has sent it.
 */
export async function externalSend({ program, readWrite = [], readOnly = [], data, computeUnits, stateUnits, memoryUnits }) {
  const p = provider()
  if (!p || !state) throw new Error('Connect your wallet first.')
  try {
    return await p.signAndSendTransaction({
      programAddress: program,
      instructionData: data,
      readWriteAddresses: readWrite,
      readOnlyAddresses: readOnly,
      computeUnits, stateUnits, memoryUnits,
    })
  } catch (e) {
    if (e?.code === 4001) throw new Error('You cancelled it in your wallet.')
    throw e
  }
}
