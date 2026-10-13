// src/components/Unlock.jsx
//
// Asking for the password where you are, instead of somewhere else.
//
// The old flow sent people to the Wallet page to unlock and left them there,
// which is bad on its own and was made worse by a second bug: every internal
// link was a plain <a href>, so each one was a full page load, and a full page
// load wipes the key from memory. Unlocking on one page and acting on another
// was therefore impossible by construction. The links are now router links, and
// this is the prompt that appears in place.
//
// There is one prompt for the whole site, mounted once (UnlockHost.jsx, in
// the shell). Anything that needs a signature awaits ensureUnlocked() in
// lib/wallet.js, which opens it only when the wallet is locked; several
// signatures at once share it. Nothing that only reads ever opens it.
//
// Usage, unchanged for older callers:
//
//   const gate = useUnlockGate()
//   ...
//   await gate.ensure()      // resolves once unlocked, rejects if dismissed
//   ...
//   {gate.modal}             // kept for older callers; renders nothing now

import { useMemo } from 'react'
import { ensureUnlocked } from '../lib/wallet.js'

/**
 * A promise that resolves once the wallet is usable.
 *
 * Resolves immediately when it already is, opens the prompt when it is not, and
 * rejects with a recognisable error when there is no wallet at all or the
 * person dismisses it. Callers should treat a rejection as "they changed their
 * mind" rather than as a failure worth shouting about.
 */
export function useUnlockGate() {
  return useMemo(() => ({ ensure: ensureUnlocked, modal: null }), [])
}

/** True when an error from `ensure` just means the person backed out. */
export const isDismissal = (e) =>
  e?.message === 'CANCELLED' || e?.message === 'NO_WALLET'
