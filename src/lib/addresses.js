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

const env = import.meta.env

export const THRUSWAP_PROGRAM =
  env.VITE_THRUSWAP_PROGRAM || 'taanfNIPSm5OA3LDWSLFFAgo3iszZ1rOVsdJPYp4dzDfTg'

export const THRUSWAP_REGISTRY =
  env.VITE_THRUSWAP_REGISTRY || 'taPDf6IsnMvBCa3II-F6OjF-mbZEnMmZXxrdIres0QzGrt'

export const THRUPAD_PROGRAM =
  env.VITE_THRUPAD_PROGRAM || 'taPrhpGvUsQJQ5RKWNxwm_zMMIxE1qefsTD1SwEWOac8We'

export const THRUPAD_REGISTRY =
  env.VITE_THRUPAD_REGISTRY || 'talx8PESmxMqxxG0gfRgyLPMcxIecfxNI224zQabWGzYCt'

/** The quote currency every pool and every launch is priced against. */
export const TUSD_MINT =
  env.VITE_TUSD_MINT || 'tabAx2SejGxnH7qDY02xofs0rrhBV2Cdoxg0yeG0hv7Z0R'

/** The token program, fixed by the runtime rather than by us. */
export const TOKEN_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq'
