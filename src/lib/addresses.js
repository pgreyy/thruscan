// src/lib/addresses.js
//
// Every on-chain address ThruScan needs, in one file.
//
// These are public, not secrets: anyone reading the chain can find them, and
// they appear in every transaction these pages generate. They sit in source
// rather than in environment variables because Vercel's Hobby plan caps how
// many of those a project can hold, and spending a dozen of them on values
// that are already public is a poor trade. They still read from the
// environment first, so nothing has to change here if you later move them.
//
// There are two kinds below, and the difference matters when something breaks.
//
// OURS are the programs and accounts ThruScan deployed. A genesis reset wipes
// them and they all change together.
//
// THEIRS are the programs the Thru runtime ships. Those used to sit at
// placeholder addresses (31 zero bytes and a counter, which is why they all
// read taAAAA...). Thru v0.4.0 moved every one of them to a real address. Any
// copy of ThruScan still pointing at the placeholders talks to accounts that do
// not exist, which is quiet rather than loud: the call simply reverts.
//
// Last set: 28 September 2026, for Thru v0.4.0 on the reset alphanet.

/* Read by the browser bundle and by serverless functions, which have no
   import.meta.env at all: touching it there is a TypeError, not an undefined. */
const env = (() => {
  try { if (typeof import.meta !== 'undefined' && import.meta.env) return import.meta.env } catch { /* Node */ }
  return typeof process !== 'undefined' ? process.env : {}
})()

/* ------------------------------------------------------------------ theirs
 *
 * Thru's own programs, from rpc/thru-base/src/bootstrap_addresses.rs at
 * v0.4.0. Nothing here is ours to change; it changes when Thru moves it.
 */

/** The token program: mints, token accounts, transfers, burns. */
export const TOKEN_PROGRAM = 'taTOKENKRgcl3vO0yVhftATDbXuhgWcfaaxv9xpEEdMdUE'

/** The externally-owned-account program, which brings a new wallet into being. */
export const EOA_PROGRAM = 'taEOAD2uLK1SLzPgtabFLUAx22yDlBs9DE9nZFTOESIGRr'

/** Runs several instructions in one transaction, atomically. */
export const MULTICALL_PROGRAM = 'taMULTIrOL8WpIFr16C1ECsO60qAsuwmwJephZHDOTvSeP'

/** Thru's name service, under which ThruScan runs a root. */
export const NAME_SERVICE_PROGRAM = 'taNAMEqRNEDeMWp0cDYmMVdZyTZiF5NyGDR9zTwH42rWQG'

/** Thru's faucet: a program plus the vault it pays native THRU out of. */
export const NATIVE_FAUCET_PROGRAM = 'taFCTxR0y2eabGGaEdtTwC9pHz7ZY4CYD7FOiBFUJeAW16'
export const NATIVE_FAUCET_ACCOUNT =
  env.VITE_NATIVE_FAUCET || 'taTigKYAf5mNxUNUVXeXq1HQodKc07DBzF4Pl7tCi1iXxt'

/** Wrapped THRU: the program, the mint it controls, and the vault backing it. */
export const WTHRU_PROGRAM = 'taWTHRUBelpONhTRjYc7n4OovodUsUtZKTIuREWAi9G9lm'
export const WTHRU_VAULT = 'taEqcObTD3WldMGFOW28FBKF6_mQfSbci1TC77YyssQQhP'

/**
 * Wrapped native THRU, a plain token mint the runtime ships, at 8 declared
 * decimals. One native THRU unit wraps to exactly one WTHRU base unit, which
 * is why src/lib/wthru.js shows it on THRU's scale rather than at 8 places.
 */
export const WTHRU_MINT =
  env.VITE_WTHRU_MINT || 'taaoXQw03WlYWdo1jhfFi2Nqfqsf4RqYySn_89mchjCiLb'

/** Thru's NFT program, which Pixel Pals is a collection on. */
export const NFT_PROGRAM = 'taNFTjOaeDBSPHNf0LVRWAkF4raUFQgrz0EQIgJd60ENb5'

/* -------------------------------------------------------------------- ours
 *
 * Deployed 28 September 2026. A genesis reset wipes all of these at once, and
 * then this block is the only edit the site needs.
 */

export const THRUSWAP_PROGRAM =
  env.VITE_THRUSWAP_PROGRAM || 'taCXE0eEQbUHU90dyZ__Bz1yfQabjyaD4xaSHKUw3Q1M4N'

export const THRUSWAP_REGISTRY =
  env.VITE_THRUSWAP_REGISTRY || 'taxd8oXrKJTRejpLPUPrrjWMR8PnSFC03SRCphFW2p1Cpj'

export const THRUPAD_PROGRAM =
  env.VITE_THRUPAD_PROGRAM || 'tastnRlQL8RGYeByXK2QAzaqdnfvI6pVn0e89JSl6Hiu8I'

export const THRUPAD_REGISTRY =
  env.VITE_THRUPAD_REGISTRY || 'takPPySUoh_Vew_AoHfDaCIm0X5vf2vpgRgW5TR0aVkYbJ'

/** The quote currency every pool and every launch is priced against. */
export const TUSD_MINT =
  env.VITE_TUSD_MINT || 'ta4OJoJQcZRIx4Sm3MLdEUrn_j5gb4vFeFPhpSJraHZTeB'

/** The .id root ThruScan registers names under. */
export const NAME_ROOT =
  env.VITE_NAME_ROOT || 'taLu3d1rxGdQWWHJxUOK6eT9ti4lWeTijNp0Kk_5YKHARg'

/**
 * The wall, v2: the version whose messages can be addressed to an account.
 *
 * Blank is a state the wall page handles rather than a crash: it says the
 * program is not deployed yet, which is true and useful, instead of failing to
 * read an account at the empty address.
 *
 * They live here rather than in App.jsx because App.jsx is already a very large
 * file that every change has to be surgically cut into, and an address is
 * configuration.
 */
export const WALL_PROGRAM = env.VITE_THRU_WALL2_PROGRAM || 'tagNpTX6NLyLv1099dM7HQySw9j_dSH8GBoijY4fGCFVwH'
export const WALL_ACCOUNT = env.VITE_THRU_WALL2_ACCOUNT || 'ta_t7GTjgkL-Jt8PIL1n826P6AFcC-59xtmrWpKGKeQ_fF'

/* The games and the username registry.
 *
 * These were Vercel environment variables until 28 September 2026, which meant
 * a reset needed a trip to the dashboard as well as a deploy, and a variable
 * left holding an old address quietly beat a corrected default. They are read
 * from here now, by the pages and by api/play.js alike. These variables are no
 * longer read anywhere and can be deleted from Vercel:
 *
 *   VITE_THRU_WALL_PROGRAM   VITE_THRU_WALL_ACCOUNT   VITE_THRU_WORDLE_BOARD
 *   VITE_THRU_2048_BOARD     VITE_THRU_ID_REGISTRY    THRU_ID_PROGRAM
 *   THRU_ID_REGISTRY         THRU_WORDLE_PROGRAM      THRU_WORDLE_BOARD
 *   THRU_2048_PROGRAM        THRU_2048_BOARD
 */
export const ID_PROGRAM = 'taSXTzs8mjKZoBAbYPXQHh8LNkbn-eRqgBhdY4-CA_UV-z'
export const ID_REGISTRY = 'tamTImRuoNie6gbzJtRWq7FrclVgfxh5xIRJdxzA8pFlIg'
export const WORDLE_PROGRAM = 'tar7SW2hDhnizBJT8gcJ6XBfBgNobwsxTwNcUvCrDQu-eF'
export const WORDLE_BOARD = 'ta_NmQH2Nc-WCgUzswdm5xZ76oFIT1m9UHs-hDD24TWFI4'
export const G2048_PROGRAM = 'taXyq3jDXavyDXwVEq85vInMz5YfKpprmTGgSa4ayd4mSa'
export const G2048_BOARD = 'ta17eN7VuVh-HgHKxEkmuhyIWwlKd3QggRgjrOy1bJb-vC'

/** Pixel Pals. The collection's own module re-exports these; see pals/chain.js. */
export const PALS_PROGRAM = 'taXgi_tvqshzois9iLBY5msTGlQvW_GydSKRODoPgPVInH'

/* ---------------------------------------------------------------- the cap
 *
 * State units are 4096-byte pages, and the chain admits at most
 * max_state_units_per_block of them per block. Asking for more than a whole
 * block's budget is not rejected: the transaction is never admitted, the
 * signature comes back, and the transaction reads "not found" forever.
 *
 * ThruScan asked for 60,000 until 28 September 2026, which is how every write
 * on the site stopped working the moment the chain set this to 8192. Read the
 * live value with:  thru feature-gates list
 */
export const MAX_STATE_UNITS = 8192
