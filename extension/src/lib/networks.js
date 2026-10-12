// extension/src/lib/networks.js
//
// Which chain the wallet talks to, and every address that goes with it.
//
// This is the extension's copy of src/lib/networks.js. It is a copy rather than
// an import because the extension builds as its own bundle with its own
// dependencies, and reaching into the site's source would tie the wallet's
// release to the site's. Keep the two in step by hand when a network is added.
//
// The wallet settings used to hold a bare RPC URL and nothing else, so pointing
// the wallet at a second chain left it reading the first chain's programs: the
// wallet would appear to work and every balance would be wrong. A network is
// one object here for the same reason it is on the site. Choosing a network
// chooses its node and its addresses together, or it does not choose anything.
//
// Alphanet and betanet are two separate chains. They once served the same
// state under two names; on 12 October 2026 betanet was at height 1.28M with
// chain id 2 and alphanet at 7.1M with chain id 1. So each has its own
// accounts below, and nothing of ThruScan's is shared between them. The
// wallet's default is betanet; alphanet stays as a legacy choice.

/** Thru's own programs. Identical on every network the runtime starts. */
const SYSTEM = {
  EOA: 'taEOAD2uLK1SLzPgtabFLUAx22yDlBs9DE9nZFTOESIGRr',
  TOKEN: 'taTOKENKRgcl3vO0yVhftATDbXuhgWcfaaxv9xpEEdMdUE',
  NAME_SERVICE: 'taNAMEqRNEDeMWp0cDYmMVdZyTZiF5NyGDR9zTwH42rWQG',
  FAUCET: 'taFCTxR0y2eabGGaEdtTwC9pHz7ZY4CYD7FOiBFUJeAW16',
  NFT: 'taNFTjOaeDBSPHNf0LVRWAkF4raUFQgrz0EQIgJd60ENb5',
}

/* Thru's faucet vault and WTHRU mint, also identical everywhere. */
const FAUCET_ACCOUNT = 'taTigKYAf5mNxUNUVXeXq1HQodKc07DBzF4Pl7tCi1iXxt'
const WTHRU_MINT = 'taaoXQw03WlYWdo1jhfFi2Nqfqsf4RqYySn_89mchjCiLb'

/* ThruScan's programs, named on the approval screen. Per network, because
   they are deployed separately on each. */
const NO_PALS = { program: '', config: '', mint: '' }

export const NETWORKS = {
  /* Where ThruScan runs. Filled in by the betanet deploy (tools/betanet/);
     never copied from alphanet. Pixel Pals is not deployed here. */
  betanet: {
    id: 'betanet',
    label: 'Betanet',
    test: true,
    rpc: 'https://rpc.betanet.thru.org',
    explorer: 'https://thruscan.xyz',
    programs: SYSTEM,
    FAUCET_ACCOUNT,
    NAMES_ROOT: '',
    WTHRU_MINT,
    ours: { THRUSWAP: '', THRUPAD: '', WALL: '' },
    pals: NO_PALS,
  },
  /* Legacy: a separate chain now, kept so a wallet made there still works. */
  alphanet: {
    id: 'alphanet',
    label: 'Alphanet (legacy)',
    test: true,
    rpc: 'https://rpc.alphanet.thru.org',
    explorer: 'https://thruscan.xyz',
    programs: SYSTEM,
    FAUCET_ACCOUNT,
    NAMES_ROOT: 'taLu3d1rxGdQWWHJxUOK6eT9ti4lWeTijNp0Kk_5YKHARg',
    WTHRU_MINT,
    ours: {
      THRUSWAP: 'taCXE0eEQbUHU90dyZ__Bz1yfQabjyaD4xaSHKUw3Q1M4N',
      THRUPAD: 'tastnRlQL8RGYeByXK2QAzaqdnfvI6pVn0e89JSl6Hiu8I',
      WALL: 'tagNpTX6NLyLv1099dM7HQySw9j_dSH8GBoijY4fGCFVwH',
    },
    pals: {
      program: 'taXgi_tvqshzois9iLBY5msTGlQvW_GydSKRODoPgPVInH',
      config: 'taZIF42RAX-0q3mDj2UAZlDTJd-yYmJELr9cl7o-LgKJtv',
      mint: 'taLckvZN2i5VHomAQvLqvtDUBJHH2iwHAmX1UZrB2GqUjr',
    },
  },
  /* Not live. Listed so that the day it exists the wallet needs a setting
     changed rather than a release, and so the signing guard has a non-test
     network to compare against before there is one. Nothing of ours is
     deployed there, and a blank address is a thing every screen handles by
     saying the feature is not available. */
  mainnet: {
    id: 'mainnet',
    label: 'Mainnet',
    test: false,
    rpc: 'https://rpc.thru.org',
    explorer: 'https://thruscan.xyz',
    programs: SYSTEM,
    FAUCET_ACCOUNT: '',
    NAMES_ROOT: '',
    WTHRU_MINT: '',
    ours: { THRUSWAP: '', THRUPAD: '', WALL: '' },
    pals: NO_PALS,
  },
}

export const DEFAULT_NETWORK = 'betanet'

/**
 * The network a settings record names.
 *
 * Settings from before this existed hold `rpc` and no `network`, so the URL is
 * matched back to a name. An unrecognised URL is somebody's own node: it keeps
 * working, and it is shown as custom rather than silently relabelled as a
 * network whose addresses it may not share.
 */
export function networkFor(settings) {
  const named = NETWORKS[settings?.network]
  if (named) return named

  const url = (settings?.rpc ?? '').replace(/\/$/, '')
  const matched = Object.values(NETWORKS).find((n) => n.rpc === url)
  if (matched) return matched

  if (url) {
    return {
      ...NETWORKS[DEFAULT_NETWORK],
      id: 'custom',
      label: 'Custom node',
      test: true,
      rpc: url,
    }
  }
  return NETWORKS[DEFAULT_NETWORK]
}

/** The node URL a settings record resolves to. */
export function rpcFor(settings) {
  return networkFor(settings).rpc
}
