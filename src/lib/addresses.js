// src/lib/addresses.js
//
// Where the DEX and launchpad live on chain.
//
// These are public addresses, not secrets: anyone reading the chain can find
// them, and they appear in every transaction these pages generate. They sit in
// source rather than in environment variables because Vercel's Hobby plan caps
// how many of those a project can hold, and spending five of them on values
// that are already public is a poor trade.
//
// They still read from the environment first, so nothing has to change here if
// you later move them back. Update after a genesis reset: alphanet wipes every
// account, so all of these change together and this file is the only edit.
//
// Last set: 17 September 2026.

/* Read by the browser bundle and by serverless functions, which have no
   import.meta.env at all: touching it there is a TypeError, not an undefined. */
const env = (() => {
  try { if (typeof import.meta !== 'undefined' && import.meta.env) return import.meta.env } catch { /* Node */ }
  return typeof process !== 'undefined' ? process.env : {}
})()

export const THRUSWAP_PROGRAM =
  env.VITE_THRUSWAP_PROGRAM || 'taanfNIPSm5OA3LDWSLFFAgo3iszZ1rOVsdJPYp4dzDfTg'

export const THRUSWAP_REGISTRY =
  env.VITE_THRUSWAP_REGISTRY || 'taPDf6IsnMvBCa3II-F6OjF-mbZEnMmZXxrdIres0QzGrt'

export const THRUPAD_PROGRAM =
  env.VITE_THRUPAD_PROGRAM || 'taX1wTP2Zmfddk6T3VAbncDzeDRXtc9HUCwUamm6d8rmPu'

export const THRUPAD_REGISTRY =
  env.VITE_THRUPAD_REGISTRY || 'taeDl4PfjrwhTYAxUEu4Jzn0RABo3CojWVTLohkIYE_unP'

/** The quote currency every pool and every launch is priced against. */
export const TUSD_MINT =
  env.VITE_TUSD_MINT || 'tabAx2SejGxnH7qDY02xofs0rrhBV2Cdoxg0yeG0hv7Z0R'

/**
 * Wrapped native THRU, a plain token mint the runtime ships, at 8 decimals.
 * It is what a launch should be priced in once THRU is actually distributed;
 * today tUSD is where the liquidity is. There is a WTHRU/tUSD pool so it has a
 * price either way.
 */
export const WTHRU_MINT =
  env.VITE_WTHRU_MINT || 'tacdgTUGud8OgzN5HnVVv4u3x82UBe8ciZAtjOLJZE_SNg'

/** The token program, fixed by the runtime rather than by us. */
export const TOKEN_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq'

/** Thru's own name service, and the root ThruScan runs under it. */
export const NAME_SERVICE_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUF'
export const NAME_ROOT =
  env.VITE_NAME_ROOT || 'taGEX4QNK_WjsknEK4kl0_ppCJUimoanrmFuU27t1gS3pw'

/** Thru's own faucet, which pays native THRU to whoever pays the fee. */
export const NATIVE_FAUCET_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPr6'
export const NATIVE_FAUCET_ACCOUNT =
  env.VITE_NATIVE_FAUCET || 'taxoImN8fTEOxXYnvgC6JZ0lN0n0qvZERwz_vlOjX3MkIn'

/**
 * The wall, v2: the version whose messages can be addressed to an account.
 *
 * These are blank until thruwall2 is deployed, and the deploy script fills them
 * in. Blank is a state the wall page handles rather than a crash: it says the
 * program is not deployed yet, which is true and useful, instead of failing to
 * read an account at the empty address.
 *
 * They live here rather than in App.jsx because App.jsx is already a very large
 * file that every change has to be surgically cut into, and an address is
 * configuration.
 */
export const WALL_PROGRAM = env.VITE_THRU_WALL2_PROGRAM || 'taX-QuhkQ4-7zGh4emeIn3JMAy05aZnQwC7WWyuyUoDRCI'
export const WALL_ACCOUNT = env.VITE_THRU_WALL2_ACCOUNT || 'taHp1p8yxw_2089Zcm8TyqAUWDQIiAs9mLt2nc2PI2vjwC'
