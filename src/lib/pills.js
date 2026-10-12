// src/lib/pills.js
//
// What the status and event pills say and which tint they take (Update 02,
// section 6). components/Pill.jsx draws them.

/* The words for the feed's kinds (lib/feed.js). */
export const EVENT_WORD = {
  pad: 'Pad', launch: 'Launch', buy: 'Buy', sell: 'Sell', claim: 'Claim',
  graduate: 'Graduate', migrate: 'Migrate', swap: 'Swap',
  pool: 'Pool', liquidity: 'Liquidity', nft: 'NFT', name: 'ThruID',
  wall: 'Wall', game: 'Game', wrap: 'Wrap', mint: 'Mint', burn: 'Burn', transfer: 'Transfer',
  faucet: 'Faucet', token: 'Token', account: 'Account',
  bundle: 'Bundle', oracle: 'Oracle', noop: 'Idle', other: 'Call',
}

/** positive | negative | brand | neutral, for an event kind or its word. */
export function eventTone(kind) {
  const k = String(kind ?? '').toLowerCase()
  if (k === 'buy' || k === 'bought') return 'positive'
  if (k === 'sell' || k === 'sold') return 'negative'
  if (k === 'launch') return 'brand'
  return 'neutral'
}

/** An event kind from describe()'s plain label, for rows read straight from
 *  the chain rather than from the indexer (which already knows the kind). */
export function kindOfLabel(label) {
  const l = String(label ?? '').toLowerCase()
  if (l.startsWith('bought')) return 'buy'
  if (l.startsWith('sold')) return 'sell'
  if (l.startsWith('launched')) return 'launch'
  if (l.startsWith('claimed')) return 'claim'
  if (l.startsWith('graduated')) return 'graduate'
  if (l.includes('wrapped')) return 'wrap'
  if (l === 'swap' || l.includes('liquidity') || l.includes('pool')) return l === 'swap' ? 'swap' : 'liquidity'
  if (l.includes('wall')) return 'wall'
  if (l.includes('name')) return 'name'
  if (l.includes('transfer') || l.startsWith('sent') || l.startsWith('received')) return 'transfer'
  if (l.includes('faucet')) return 'faucet'
  if (l.startsWith('minted')) return 'mint'
  if (l.includes('burn')) return 'burn'
  if (l.includes('account')) return 'account'
  return 'other'
}
