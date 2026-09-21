// src/lib/gameid.js
//
// One identity, everywhere.
//
// The games had an identity system of their own: an eight byte player code held
// in local storage, a separate name claimed in a separate registry, and a QR
// code for moving it between devices. That was the right design when it was
// built, because there was no wallet and asking someone to make a keypair
// before their first game of Wordle would have lost most of them.
//
// There is a wallet now, and a name service pointing names at it, so keeping a
// third identity is worse than useless: it means your leaderboard name and your
// .id name can disagree, and it means "move to another device" has two separate
// answers that do not help each other.
//
// So the player code is now derived from the wallet, and the leaderboard name
// comes from the .id pointing at it.
//
// ---------------------------------------------------------------------------
// Why it derives from the private key and not the address
//
// The player code is a secret: anyone holding it can play as you, because the
// games are sponsored and nothing else proves who is submitting a score. If it
// were derived from the address, which is public, anyone reading a leaderboard
// could compute someone else's code and post scores as them. That would be a
// real regression dressed up as a simplification.
//
// Deriving from the private key keeps the secret a secret while still making it
// deterministic: the same wallet produces the same code on every device, so
// restoring your phrase restores your scores, and there is no separate code to
// copy any more.
//
// The tag makes the hash single purpose. Without it, a hash of the private key
// is a value that might be reused somewhere else for something that matters
// more, and identical derivations across different uses is how one leak
// becomes several.

import { exportPrivateKey, isUnlocked, currentAddress, isExternal } from './wallet.js'

const ID_KEY = 'thruscan_player_id'
const TAG = 'thruscan.games.playercode.v1'

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** The code this wallet always produces. Requires the wallet to be unlocked. */
export async function playerCodeForWallet() {
  // A connected wallet never shows this site its key, so games stay on the
  // guest code for it.
  if (!isUnlocked() || isExternal()) return null
  const priv = exportPrivateKey()
  const material = new TextEncoder().encode(`${TAG}:${priv}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material))
  const code = hex(digest.subarray(0, 8))
  // The registry treats all-zeroes as an empty slot, so a code of zero would be
  // invisible rather than wrong. Astronomically unlikely, cheap to rule out.
  return code === '0000000000000000' ? hex(digest.subarray(8, 16)) : code
}

/** What the games are currently using. */
export const currentPlayerCode = () => localStorage.getItem(ID_KEY)

/**
 * Point the games at this wallet.
 *
 * Returns { changed, code } so the caller can reload the board only when
 * something actually moved. Writing the same value back would otherwise cause a
 * refresh on every render.
 */
export async function usePlayerCodeFromWallet() {
  const code = await playerCodeForWallet()
  if (!code) return { changed: false, code: null }
  const before = currentPlayerCode()
  if (before === code) return { changed: false, code }
  localStorage.setItem(ID_KEY, code)
  return { changed: true, code, previous: before }
}

/**
 * Go back to playing as nobody in particular.
 *
 * Kept deliberately: someone may want to play without unlocking a wallet, and
 * the guest code is how that has always worked. It is not a downgrade path so
 * much as the anonymous path still being available.
 */
export function newGuestCode() {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  const code = hex(bytes)
  localStorage.setItem(ID_KEY, code)
  return code
}

/** True when the games are already following the unlocked wallet. */
export async function isFollowingWallet() {
  const code = await playerCodeForWallet()
  return Boolean(code) && code === currentPlayerCode()
}

export { currentAddress }
