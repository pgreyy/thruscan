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
/* Which wallet the site is acting as. Separate from whether the extension is
   connected, because those are different things and conflating them is what
   made switching painful: the only way back to the browser wallet was to
   disconnect, and the only way back to the extension was to approve the site
   again. Both can be connected; exactly one is active. */
const ACTIVE_KEY = 'thruscan.wallet.active.v1'

/** Where to get the extension: ThruScan's own download page (desktop and phone).
    Swap for the Chrome Web Store link once it is listed. */
export const EXTENSION_URL = '/get-wallet'

let state = null            // the live provider connection: { address, name }
let active = read(ACTIVE_KEY) === 'browser' ? 'browser' : 'external'
const listeners = new Set()

function read(k) { try { return localStorage.getItem(k) } catch { return null } }
function write(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* private mode */ } }
const emit = () => listeners.forEach((fn) => { try { fn(state) } catch { /* keep going */ } })

export const provider = () => (typeof window !== 'undefined' ? window.thru ?? null : null)
export const hasProvider = () => Boolean(provider())
export const providerName = () => provider()?.name ?? 'your wallet'

/** Is the connected wallet the one signing right now? */
export const isExternal = () => state !== null && active === 'external'
/** Is a wallet connected at all, whichever one is active? */
export const externalConnected = () => state !== null
export const externalAddress = () => (isExternal() ? state.address : null)
export const externalName = () => state?.name ?? null

/**
 * Switch which wallet the site acts as, without disturbing the connection.
 * Going back to the extension afterwards costs nothing: it is still connected,
 * so there is no second approval to sit through.
 */
export function switchToBrowserWallet() {
  if (active === 'browser') return
  active = 'browser'
  write(ACTIVE_KEY, 'browser')
  emit()
}

export function switchToConnectedWallet() {
  if (!state) throw new Error('No wallet is connected.')
  if (active === 'external') return
  active = 'external'
  write(ACTIVE_KEY, null)
  emit()
}

/** Subscribe to connect and disconnect. Returns an unsubscribe function. */
export function onExternalChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function watch(p) {
  if (!p?.on || p.__thruscanWatched) return
  p.__thruscanWatched = true
  p.on('disconnect', () => { if (state) { state = null; active = 'browser'; write(KEY, null); write(ACTIVE_KEY, null); emit() } })
  p.on('accountChanged', (d) => { if (state && d?.publicKey) { state = { ...state, address: d.publicKey }; emit() } })
}

/** Ask the wallet to connect. Opens the wallet's approval window. */
export async function connectExternal() {
  const p = provider()
  if (!p) throw new Error('No Thru wallet found in this browser.')
  const r = await p.connect()
  if (!r?.publicKey) throw new Error('The wallet did not share an address.')
  state = { address: r.publicKey, name: p.name ?? 'Wallet' }
  // Connecting is an explicit act, so it also makes that wallet the active one.
  active = 'external'
  write(KEY, '1')
  write(ACTIVE_KEY, null)
  watch(p)
  emit()
  return state
}

export async function disconnectExternal() {
  const p = provider()
  state = null
  active = 'browser'
  write(KEY, null)
  write(ACTIVE_KEY, null)
  emit()
  try { await p?.disconnect?.() } catch { /* already gone */ }
}

/**
 * Reconnect silently on page load if this site was connected before. The
 * provider script runs at document start, but give it a moment in case it is
 * slower on some pages.
 */
export async function restoreExternal() {
  const flag = read(KEY)
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
    write(KEY, null)
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
  if (active !== 'external') throw new Error('The browser wallet is the active one. Switch back to your extension first.')
  try {
    return await p.signAndSendTransaction({
      programAddress: program,
      instructionData: data,
      readWriteAddresses: readWrite,
      readOnlyAddresses: readOnly,
      computeUnits, stateUnits, memoryUnits,
    })
  } catch (e) {
    if (e?.code === 4001) throw new Error('You cancelled it in your wallet.', { cause: e })
    throw e
  }
}
