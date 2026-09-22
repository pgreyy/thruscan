// src/lib/pals/useMarket.js
//
// Buying, listing and delisting Pixel Pals. Prices are in THRU; the market
// settles in WTHRU (one base unit per THRU), so a buyer's missing WTHRU is
// wrapped first, exactly as the mint does.

import { useEffect, useState } from 'react'
import { useUnlockGate, isDismissal } from '../../components/Unlock.jsx'
import { hasProvider, connectExternal } from '../external.js'
import {
  hasWallet, currentAddress, signAndSend, waitForResult, wrapThru, nativeBalance, tokenBalances,
  openTokenAccount, accountExists,
} from '../wallet.js'
import { buildBuy, buildList, buildDelist, palsError, WTHRU_MINT } from './chain.js'

const fmt = (n) => Number(n).toLocaleString('en-US')
const UNITS = { computeUnits: 300_000_000, stateUnits: 60_000, memoryUnits: 60_000 }

export function useMarket({ onDone } = {}) {
  const gate = useUnlockGate()
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)
  const [needWallet, setNeedWallet] = useState(false)
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 7000); return () => clearTimeout(t) }, [note])

  const ensureWallet = async () => {
    if (hasWallet()) return true
    if (!hasProvider()) { setNeedWallet(true); return false }
    await connectExternal()
    if (hasWallet()) return true
    setNeedWallet(true)
    return false
  }

  const run = async (what, fn, done) => {
    setError(null); setNote(null)
    try {
      if (!(await ensureWallet())) return false
      await gate.ensure()
    } catch (e) { if (!isDismissal(e)) setError(String(e?.message ?? e)); return false }
    setBusy(what)
    try {
      const me = currentAddress()
      if (!(await accountExists(me))) throw new Error('This wallet is not on chain yet. Set it up on the Wallet page first.')
      const sig = await fn(me)
      const r = await waitForResult(sig, 30_000)
      if (r.settled && !r.succeeded) throw new Error(palsError(r.userError))
      setNote(done)
      await onDone?.()
      return true
    } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return false
    } finally { setBusy(null) }
  }

  /** Buy one or more listings (up to 8) in one transaction. */
  const buy = (items) => run('buy', async (me) => {
    if (items.some((l) => l.seller === me)) throw new Error('One of those is your own listing.')
    const total = items.reduce((t, l) => t + BigInt(l.price), 0n)
    const [row] = await tokenBalances([WTHRU_MINT], me)
    const have = BigInt(row?.amount ?? 0)
    if (have < total) {
      const need = total - have
      const native = await nativeBalance(me)
      if (native < need + 3n) throw new Error(`You need ${fmt(total)} THRU plus a few for fees. You have ${fmt(native + have)}.`)
      setBusy('wrapping')
      const w = await waitForResult(await wrapThru(need), 30_000)
      if (w.settled && !w.succeeded) throw new Error('Wrapping THRU failed. Nothing was bought.')
      setBusy('buy')
    }
    const now = await (await fetch('/api/rpc?action=pals&lite=1')).json()
    return signAndSend({ ...(await buildBuy({ payer: me, items: items.map((l) => ({ ...l, price: BigInt(l.price) })), treasury: now.treasury })), ...UNITS })
  }, items.length > 1 ? `Bought ${items.length} Pals.` : `Bought Pixel Pal #${items[0].id}.`)

  /** List a Pal, or change its price if it is already listed. */
  const list = (num, nftId, price) => run('list', async (me) => {
    const p = BigInt(price)
    if (p <= 0n) throw new Error('Set a price above zero.')
    await openTokenAccount(WTHRU_MINT) // where the money arrives when it sells
    return signAndSend({ ...(await buildList({ payer: me, num, nftId, price: p })), ...UNITS })
  }, `Listed for ${fmt(price)} THRU.`)

  const delist = (num, nftId) => run('delist', async (me) => signAndSend({ ...(await buildDelist({ payer: me, num, nftId })), ...UNITS }), 'Taken off the market. It is back in your wallet.')

  return { buy, list, delist, busy, error, note, needWallet, modal: gate.modal, clear: () => { setError(null); setNote(null) } }
}
