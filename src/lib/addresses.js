// src/lib/addresses.js
//
// Every on-chain address ThruScan needs, in one file.
//
// The values themselves moved to src/lib/networks.js on 5 October 2026, where
// each one sits beside the node URL it belongs with. This file is now the
// naming layer: it gives every address its own export so that nothing else in
// the site has to know a network exists, and it is still where you come to find
// out what an address is for.
//
// These are public, not secrets: anyone reading the chain can find them, and
// they appear in every transaction these pages generate. They sit in source
// rather than in environment variables because Vercel's Hobby plan caps how
// many of those a project can hold, and spending a dozen of them on values that
// are already public is a poor trade. Each one still reads its own environment
// variable first, so moving a single program is a dashboard change.
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
// Last set: 28 September 2026, for Thru v0.4.0.

import { addressOf, network, ACTIVE_NETWORK, NETWORKS } from './networks.js'

/** Which chain this build is talking to. Re-exported so pages need one import. */
export { network, ACTIVE_NETWORK, NETWORKS }

/* ------------------------------------------------------------------ theirs
 *
 * Thru's own programs, from rpc/thru-base/src/bootstrap_addresses.rs at
 * v0.4.0. Nothing here is ours to change; it changes when Thru moves it.
 */

/** The token program: mints, token accounts, transfers, burns. */
export const TOKEN_PROGRAM = addressOf('TOKEN_PROGRAM')

/** The externally-owned-account program, which brings a new wallet into being. */
export const EOA_PROGRAM = addressOf('EOA_PROGRAM')

/** Runs several instructions in one transaction, atomically. */
export const MULTICALL_PROGRAM = addressOf('MULTICALL_PROGRAM')

/** Thru's name service, under which ThruScan runs a root. */
export const NAME_SERVICE_PROGRAM = addressOf('NAME_SERVICE_PROGRAM')

/** Thru's faucet: a program plus the vault it pays native THRU out of. */
export const NATIVE_FAUCET_PROGRAM = addressOf('NATIVE_FAUCET_PROGRAM')
export const NATIVE_FAUCET_ACCOUNT = addressOf('NATIVE_FAUCET_ACCOUNT')

/** Wrapped THRU: the program, the mint it controls, and the vault backing it. */
export const WTHRU_PROGRAM = addressOf('WTHRU_PROGRAM')
export const WTHRU_VAULT = addressOf('WTHRU_VAULT')

/**
 * Wrapped native THRU, a plain token mint the runtime ships, at 8 declared
 * decimals. One native THRU unit wraps to exactly one WTHRU base unit, which
 * is why src/lib/wthru.js shows it on THRU's scale rather than at 8 places.
 */
export const WTHRU_MINT = addressOf('WTHRU_MINT')

/** Thru's NFT program, which Pixel Pals is a collection on. */
export const NFT_PROGRAM = addressOf('NFT_PROGRAM')

/** The do-nothing program, which is how a new wallet's first write is accepted. */
export const NOOP_PROGRAM = addressOf('NOOP_PROGRAM')

/* -------------------------------------------------------------------- ours
 *
 * Deployed 28 September 2026. A genesis reset wipes all of these at once, and
 * then src/lib/networks.js is the only edit the site needs.
 */

export const THRUSWAP_PROGRAM = addressOf('THRUSWAP_PROGRAM')
export const THRUSWAP_REGISTRY = addressOf('THRUSWAP_REGISTRY')
export const THRUPAD_PROGRAM = addressOf('THRUPAD_PROGRAM')
export const THRUPAD_REGISTRY = addressOf('THRUPAD_REGISTRY')

/** An older quote currency. Kept named because old records still mention it. */
export const TUSD_MINT = addressOf('TUSD_MINT')

/** The .id root ThruScan registers names under. */
export const NAME_ROOT = addressOf('NAME_ROOT')

/**
 * The wall, v2: the version whose messages can be addressed to an account.
 *
 * Blank is a state the wall page handles rather than a crash: it says the
 * program is not deployed yet, which is true and useful, instead of failing to
 * read an account at the empty address. That is also what every page does on a
 * network where we have not deployed, which is how mainnet can be selected
 * before anything is on it.
 */
export const WALL_PROGRAM = addressOf('WALL_PROGRAM')
export const WALL_ACCOUNT = addressOf('WALL_ACCOUNT')

/* The games and the username registry.
 *
 * These were Vercel environment variables until 28 September 2026, which meant
 * a reset needed a trip to the dashboard as well as a deploy, and a variable
 * left holding an old address quietly beat a corrected default. These variables
 * are no longer read anywhere and can be deleted from Vercel:
 *
 *   VITE_THRU_WALL_PROGRAM   VITE_THRU_WALL_ACCOUNT   VITE_THRU_WORDLE_BOARD
 *   VITE_THRU_2048_BOARD     VITE_THRU_ID_REGISTRY    THRU_ID_PROGRAM
 *   THRU_ID_REGISTRY         THRU_WORDLE_PROGRAM      THRU_WORDLE_BOARD
 *   THRU_2048_PROGRAM        THRU_2048_BOARD
 */
export const ID_PROGRAM = addressOf('ID_PROGRAM')
export const ID_REGISTRY = addressOf('ID_REGISTRY')
export const WORDLE_PROGRAM = addressOf('WORDLE_PROGRAM')
export const WORDLE_BOARD = addressOf('WORDLE_BOARD')
export const G2048_PROGRAM = addressOf('G2048_PROGRAM')
export const G2048_BOARD = addressOf('G2048_BOARD')

/** Pixel Pals. The collection's own module re-exports these; see pals/chain.js. */
export const PALS_PROGRAM = addressOf('PALS_PROGRAM')

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
