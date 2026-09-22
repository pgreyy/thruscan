// src/lib/pals/useMint.js
//
// The whole mint in one hook, so the Mint button works the same wherever it
// sits (the home page banner, the collection page): connect the wallet if
// needed, wrap only the THRU that is missing, get cleared by the server,
// then mint, retrying when someone takes the same number first.

import { useState } from 'react'
import { useUnlockGate, isDismissal } from '../../components/Unlock.jsx'
import { hasProvider, connectExternal } from '../external.js'
import {
  hasWallet, currentAddress, signAndSend, waitForResult, wrapThru, nativeBalance, tokenBalances,
  requestProof, palsAllow, accountExists,
} from '../wallet.js'
import { buildMint, palsError, nftAccountFor, WTHRU_MINT } from './chain.js'

const fmt = (n) => Number(n).toLocaleString('en-US')
const state = async (me) => (await fetch(`/api/rpc?action=pals&lite=1${me ? `&wallet=${me}` : ''}`)).json()

export function useMint({ price = 1000n, onMinted } = {}) {
  const gate = useUnlockGate()
  const [step, setStep] = useState(null)
  const [error, setError] = useState(null)
  const [minted, setMinted] = useState(null)
  const [needWallet, setNeedWallet] = useState(false)

  const run = async () => {
    setError(null)
    try { await gate.ensure() } catch (e) { if (!isDismissal(e)) setError(String(e?.message ?? e)); return }
    const me = currentAddress()
    const landed = async (sig, what) => {
      const r = await waitForResult(sig, 30_000)
      if (r.settled && !r.succeeded) throw new Error(`${what} failed (error ${r.userError || r.vmError}).`)
      return r
    }
    try {
      setStep('checking')
      if (!(await accountExists(me))) throw new Error('This wallet is not on chain yet. Set it up on the Wallet page first.')
      const first = await state(me)
      if (first.mine?.minted) throw new Error('This wallet has already minted its Pal.')
      const cost = BigInt(first.price ?? price)

      // Pay in WTHRU: wrap only what is missing.
      const [row] = await tokenBalances([WTHRU_MINT], me)
      const have = BigInt(row?.amount ?? 0)
      if (have < cost) {
        const need = cost - have
        const native = await nativeBalance(me)
        if (native < need + 3n) throw new Error(`You need ${fmt(cost)} THRU plus a few for fees. You have ${fmt(native + have)}.`)
        setStep('wrapping')
        await landed(await wrapThru(need), 'Wrapping THRU')
      }

      setStep('clearing')
      await palsAllow(me)

      // The program draws the Pal's number at random. What is fixed in
      // advance is only the NFT id (the mint count); if someone else takes
      // that id first, the program says so and this tries again.
      for (let attempt = 0; attempt < 6; attempt++) {
        setStep('minting')
        const now = await state(me)
        if ((now.publicLeft ?? 1) <= 0) throw new Error('Sold out.')
        const nftId = now.minted
        const proof = await requestProof(await nftAccountFor(nftId))
        const tx = await buildMint({ payer: me, nftId, treasury: now.treasury, proof })
        const sig = await signAndSend({ ...tx, computeUnits: 300_000_000, stateUnits: 60_000, memoryUnits: 60_000 })
        const r = await waitForResult(sig, 30_000)
        if (r.settled && !r.succeeded && Number(r.userError) === 23) continue
        if (r.settled && !r.succeeded) throw new Error(palsError(r.userError))
        // Which number it drew: the Pal in this wallet with that NFT id.
        let num = null
        for (let i = 0; i < 5 && num === null; i++) {
          const after = await state(me)
          num = after.mine?.nfts?.find((x) => x.nftId === nftId)?.id ?? null
          if (num === null) await new Promise((res) => setTimeout(res, 2000))
        }
        setMinted(num ?? 'unknown')
        setStep(null)
        await onMinted?.(num)
        return
      }
      throw new Error('Busy right now. Try again in a moment.')
    } catch (e) {
      if (!isDismissal(e)) setError(String(e?.message ?? e))
    } finally {
      setStep(null)
    }
  }

  /** The button's handler: connects a wallet first when there is none. */
  const mint = async () => {
    setError(null)
    if (hasWallet()) return run()
    if (!hasProvider()) { setNeedWallet(true); return }
    try { await connectExternal() } catch (e) { if (!isDismissal(e)) setError(String(e?.message ?? e)); return }
    if (hasWallet()) return run()
    setNeedWallet(true)
  }

  const label = step === 'checking' ? 'Checking…'
    : step === 'wrapping' ? 'Wrapping THRU…'
    : step === 'clearing' ? 'Getting cleared…'
    : step === 'minting' ? 'Minting…'
    : null

  return { mint, step, busy: step !== null, label, error, minted, needWallet, modal: gate.modal, clearError: () => setError(null) }
}
