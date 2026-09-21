// src/lib/seed.js
//
// Twelve words instead of sixty-four hex characters.
//
// A private key you can only move by copying a hex string is a key you will
// eventually paste into a chat window, and an account you can lose by clearing
// a browser. A phrase you can write on paper fixes both, and it is the thing
// every wallet does because it is the thing that works.
//
// ---------------------------------------------------------------------------
// THIS IS THRU'S OWN SCHEME, NOT ONE OF MINE
//
// Thru ships an HD wallet: BIP39 for the phrase, SLIP-0010 for ed25519
// derivation, at m/44'/9999'/<account>'/<change>'. So a phrase generated here
// produces the same address in any other Thru wallet that follows the spec, and
// an account made elsewhere restores here.
//
// The SDK does not re-export that HD wallet from its root, only from an
// internal chunk whose filename carries a build hash. Importing that would
// break silently on the next SDK release, so this reimplements the same three
// lines from the same two libraries and the result was checked against the
// SDK's own implementation: identical address, same phrase.
//
// ---------------------------------------------------------------------------
// WHAT A PHRASE IS WORTH
//
// Anyone holding these twelve words holds the account. There is no second
// factor and no revocation. That is the trade for being able to write it down
// and carry it anywhere, and it is why nothing here ever puts a phrase on a
// network, in a URL, or in an error message.

import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import HDKey from 'micro-key-producer/slip10.js'
import { Pubkey } from '@thru/sdk'

/** Thru's registered coin type. Changing this changes every address. */
export const COIN_TYPE = 9999

export const pathFor = (account = 0, change = 0) =>
  `m/44'/${COIN_TYPE}'/${account}'/${change}'`

/** A fresh twelve word phrase, from the browser's own randomness. */
export function newPhrase() {
  return generateMnemonic(wordlist)
}

export function phraseWords(phrase) {
  return String(phrase ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * Why a phrase is not acceptable, in words rather than a boolean.
 *
 * BIP39 phrases carry a checksum, so a single mistyped word is detectable
 * rather than silently producing a different, empty account. Saying which word
 * is wrong is the difference between a recoverable typo and a lost wallet.
 */
export function phraseProblem(phrase) {
  const words = phraseWords(phrase)
  if (words.length === 0) return 'Enter your phrase.'
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    return `A phrase is 12 words. That is ${words.length}.`
  }
  const unknown = words.filter((w) => !wordlist.includes(w))
  if (unknown.length) {
    return unknown.length === 1
      ? `"${unknown[0]}" is not a word in the list. Check the spelling.`
      : `These are not in the word list: ${unknown.join(', ')}.`
  }
  if (!validateMnemonic(words.join(' '), wordlist)) {
    return 'Those are all real words, but not in a valid order. One of them is wrong.'
  }
  return null
}

/**
 * Phrase to keypair.
 *
 * The 64-byte BIP39 seed goes through SLIP-0010, which is the ed25519 variant
 * of hardened-only derivation. Every segment is hardened, which is why the path
 * has an apostrophe on each one.
 */
export function accountFromPhrase(phrase, account = 0, change = 0) {
  const words = phraseWords(phrase).join(' ')
  const problem = phraseProblem(words)
  if (problem) throw new Error(problem)

  const seed = mnemonicToSeedSync(words)
  const derived = HDKey.fromMasterSeed(seed).derive(pathFor(account, change))
  if (!derived.privateKey || !derived.publicKeyRaw) throw new Error('Could not derive a key.')

  const publicKey = new Uint8Array(derived.publicKeyRaw)
  return {
    address: Pubkey.from(publicKey).toThruFmt(),
    publicKey,
    privateKey: new Uint8Array(derived.privateKey),
    path: pathFor(account, change),
  }
}

/** Is this word in the list? Used for per-word feedback while typing. */
export const isWord = (w) => wordlist.includes(String(w ?? '').toLowerCase())

/** Suggestions for a partly typed word, so twelve words is not twelve guesses. */
export function completions(prefix, limit = 4) {
  const p = String(prefix ?? '').toLowerCase()
  if (p.length < 2) return []
  return wordlist.filter((w) => w.startsWith(p)).slice(0, limit)
}
