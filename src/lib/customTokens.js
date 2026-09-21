// src/lib/customTokens.js
//
// Tokens the user added by pasting their mint address. ThruScan finds tokens
// from its own pools and launches; anything minted elsewhere is invisible to
// it until the user names it here. Kept in this browser only: the list is a
// preference, the balances still come from the chain.

import { getAccount } from './rpcClient.js'
import { decodeMintAccount } from './token.js'

const KEY = 'thruscan.customMints'
const EVENT = 'thruscan:custom-mints'

export function customMints() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]').filter((m) => typeof m === 'string') } catch { return [] }
}

function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify([...new Set(list)])) } catch { /* private mode */ }
  window.dispatchEvent(new Event(EVENT))
}

const META = 'thruscan.customMintMeta'

/** Ticker and decimals remembered from the lookup, for before a balance read. */
export function customMeta() {
  try { return JSON.parse(localStorage.getItem(META) || '{}') } catch { return {} }
}

export function addCustomMint(mint, meta = null) {
  if (meta) {
    try { localStorage.setItem(META, JSON.stringify({ ...customMeta(), [mint]: { ticker: meta.ticker, decimals: meta.decimals } })) } catch { /* ignore */ }
  }
  save([...customMints(), mint])
}
export function removeCustomMint(mint) { save(customMints().filter((m) => m !== mint)) }

/** Re-render when the list changes, in this tab or another. */
export function onCustomMintsChange(fn) {
  const storage = (e) => { if (e.key === KEY) fn() }
  window.addEventListener(EVENT, fn)
  window.addEventListener('storage', storage)
  return () => { window.removeEventListener(EVENT, fn); window.removeEventListener('storage', storage) }
}

/** Read a pasted address and say whether it is a token mint. */
export async function lookupToken(input) {
  const mint = String(input ?? '').trim()
  if (!/^ta[A-Za-z0-9_-]{44}$/.test(mint)) throw new Error('That is not a Thru address (46 characters starting with ta).')
  const acc = await getAccount(mint).catch(() => null)
  if (!acc) throw new Error('Nothing at that address on chain.')
  let info
  try { info = decodeMintAccount(acc?.data?.base64) } catch { throw new Error('That address is not a token mint. Paste the token\'s mint (contract) address, not a wallet or token account.') }
  return { mint, ticker: info.ticker || null, decimals: info.decimals, supply: info.supply }
}
