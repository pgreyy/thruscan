// src/lib/collections.js
//
// Every collection ThruScan lists. Each one says where its page is and how
// to read its numbers; the Collections page ranks them all in one table.
// Collections from the artist launchpad get added here.

import { GENESIS, palFor } from './pals/art.js'

async function palsStats() {
  const r = await fetch('/api/rpc?action=pals&lite=1')
  const j = await r.json()
  if (!j.ok) throw new Error(j.error || 'Could not load Pixel Pals.')
  const m = j.market ?? {}
  const taken = (j.minted ?? 0) + (j.reservedAhead ?? 0)
  return {
    floor: m.floor ? Number(m.floor) : null,
    volume: m.live ? Number(m.volume) : null,
    sales: m.live ? m.sales : null,
    listed: m.live ? m.listed : null,
    owners: m.holders ?? null,
    minted: taken,
    supply: j.supply ?? 2026,
    minting: taken < (j.supply ?? 2026),
    price: Number(j.price ?? 0),
  }
}

export const COLLECTIONS = [
  {
    slug: 'pixel-pals',
    name: 'Pixel Pals',
    to: '/pals',
    creator: 'fuck.id',
    avatar: () => palFor(GENESIS.id, GENESIS.wallet),
    stats: palsStats,
  },
]
