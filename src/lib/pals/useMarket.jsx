// src/lib/pals/useMarket.js
//
// Buying, listing and delisting Pixel Pals. Prices are in THRU; the market
// settles in WTHRU (one base unit per THRU), so a buyer's missing WTHRU is
// wrapped first, exactly as the mint does.
//
// Buying asks first. It is the one action here that spends money, and until
// this it went straight from a press to a signature with nothing in between
// saying what was about to leave the wallet. The question comes before the
// password rather than after, so the order is: what this costs, then prove it
// is you, then it happens.

import { useEffect, useState } from 'react'
import { useUnlockGate, isDismissal } from '../../components/Unlock.jsx'
import { useConfirm } from '../../components/Confirm.jsx'
import { requestRefresh } from '../notify.js'
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
  const confirm = useConfirm()
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
      requestRefresh()
      await onDone?.()
      return true
    } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
      return false
    } finally { setBusy(null) }
  }

  /** Buy one or more listings (up to 8) in one transaction. */
  const buy = async (items) => {
    setError(null); setNote(null)
    if (!items?.length) return false
    if (!(await ensureWallet())) return false

    const me = currentAddress()
    if (items.some((l) => l.seller === me)) { setError('One of those is your own listing.'); return false }
    const total = items.reduce((t, l) => t + BigInt(l.price), 0n)

    /* Read the balances before asking, so the question can say whether some
       THRU has to be wrapped on the way. Both are public reads: the wallet
       does not need unlocking to answer them.

       This takes a second or two, which is a second or two in which the button
       has been pressed and nothing has happened, so it counts as busy even
       though nothing is being signed yet. */
    let toWrap = 0n
    let short = null
    setBusy('checking')
    try {
      const [row] = await tokenBalances([WTHRU_MINT], me)
      const have = BigInt(row?.amount ?? 0)
      if (have < total) {
        toWrap = total - have
        const native = await nativeBalance(me)
        if (native < toWrap + 3n) short = `You have ${fmt(native + have)} THRU. This needs ${fmt(total)} plus a few for fees.`
      }
    } catch { /* the send checks again, properly */ } finally { setBusy(null) }

    const detail = [
      ...items.slice(0, 4).map((l) => ({ label: `Pixel Pal #${l.id}`, value: `${fmt(l.price)} THRU` })),
      ...(items.length > 4 ? [{ label: `and ${items.length - 4} more`, value: '' }] : []),
      { label: 'You pay', value: `${fmt(total)} THRU` },
    ]

    const ok = await confirm.ask({
      title: items.length > 1 ? `Buy ${items.length} Pixel Pals` : `Buy Pixel Pal #${items[0].id}`,
      body: short
        ? `${short} Add some THRU first and try again.`
        : toWrap > 0n
          ? `The market settles in wrapped THRU, so ${fmt(toWrap)} of yours is wrapped first. That is two signatures, one after the other.`
          : 'Paid from your wrapped THRU balance. The Pal moves to this wallet as soon as it lands.',
      detail,
      confirmLabel: short ? 'Close' : `Pay ${fmt(total)} THRU`,
      cancelLabel: short ? 'Back' : 'Cancel',
      tone: 'go',
    })
    if (!ok || short) return false

    return run('buy', async (who) => {
      if (toWrap > 0n) {
        setBusy('wrapping')
        const w = await waitForResult(await wrapThru(toWrap), 30_000)
        if (w.settled && !w.succeeded) throw new Error('Wrapping THRU failed. Nothing was bought.')
        setBusy('buy')
      }
      const now = await (await fetch('/api/rpc?action=pals&lite=1')).json()
      return signAndSend({ ...(await buildBuy({ payer: who, items: items.map((l) => ({ ...l, price: BigInt(l.price) })), treasury: now.treasury })), ...UNITS })
    }, items.length > 1 ? `Bought ${items.length} Pals.` : `Bought Pixel Pal #${items[0].id}.`)
  }

  /** List a Pal, or change its price if it is already listed. */
  const list = (num, nftId, price) => run('list', async (me) => {
    const p = BigInt(price)
    if (p <= 0n) throw new Error('Set a price above zero.')
    await openTokenAccount(WTHRU_MINT) // where the money arrives when it sells
    return signAndSend({ ...(await buildList({ payer: me, num, nftId, price: p })), ...UNITS })
  }, `Listed for ${fmt(price)} THRU.`)

  const delist = (num, nftId) => run('delist', async (me) => signAndSend({ ...(await buildDelist({ payer: me, num, nftId })), ...UNITS }), 'Taken off the market. It is back in your wallet.')

  return {
    buy, list, delist, busy, error, note, needWallet,
    modal: <>{gate.modal}{confirm.modal}</>,
    clear: () => { setError(null); setNote(null) },
  }
}
