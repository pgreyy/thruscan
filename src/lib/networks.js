// src/lib/networks.js
//
// Which chain this build talks to, and every address that goes with it.
//
// Until now the node URL lived in api/rpc.js, the addresses lived in
// addresses.js, the extension had its own copy of both, and nothing tied any of
// them together. That is survivable with one chain. It is not survivable with
// two, because the failure it produces is silent: point the site at a new node
// and leave the addresses alone and every read returns "account not found",
// which looks exactly like a chain being down rather than a build being
// misconfigured. We have now lost most of a day to that exact symptom, twice.
//
// So a network is one object. Its node and its programs are chosen together or
// not at all, and THRU_NETWORK picks which one by name.
//
//   THRU_NETWORK=alphanet   (the default; also VITE_THRU_NETWORK in the browser)
//
// Individual addresses can still be overridden one at a time by environment
// variable, which is what makes a redeploy of one program a dashboard change
// rather than a commit. The override wins over the table.
//
// A WORD ON ALPHANET AND BETANET, because it is not what anyone assumes:
// rpc.alphanet.thru.org and rpc.betanet.thru.org are two names for the same
// chain. Verified on 5 October 2026 by reading slot 2,908,038 from both, which
// returned the same block hash, and by both reporting chainId 1 within ten
// slots of each other. They are listed separately below so a build can be
// pointed at either name, and they carry the same addresses because they are
// the same state.

/* Read by the browser bundle and by serverless functions, which have no
   import.meta.env at all: touching it there is a TypeError, not an undefined.
   Same trick as addresses.js, and for the same reason. */
const env = (() => {
  try { if (typeof import.meta !== 'undefined' && import.meta.env) return import.meta.env } catch { /* Node */ }
  return typeof process !== 'undefined' ? process.env : {}
})()

/**
 * Thru's own programs.
 *
 * The runtime places these at the same address on every network it starts,
 * which I confirmed by reading all of them off two networks before writing
 * this. They are spread into each network below rather than referenced
 * globally, so that if mainnet ever disagrees, one network can say so without
 * a code change anywhere else.
 */
const SYSTEM = {
  TOKEN_PROGRAM: 'taTOKENKRgcl3vO0yVhftATDbXuhgWcfaaxv9xpEEdMdUE',
  EOA_PROGRAM: 'taEOAD2uLK1SLzPgtabFLUAx22yDlBs9DE9nZFTOESIGRr',
  MULTICALL_PROGRAM: 'taMULTIrOL8WpIFr16C1ECsO60qAsuwmwJephZHDOTvSeP',
  NAME_SERVICE_PROGRAM: 'taNAMEqRNEDeMWp0cDYmMVdZyTZiF5NyGDR9zTwH42rWQG',
  NATIVE_FAUCET_PROGRAM: 'taFCTxR0y2eabGGaEdtTwC9pHz7ZY4CYD7FOiBFUJeAW16',
  NATIVE_FAUCET_ACCOUNT: 'taTigKYAf5mNxUNUVXeXq1HQodKc07DBzF4Pl7tCi1iXxt',
  WTHRU_PROGRAM: 'taWTHRUBelpONhTRjYc7n4OovodUsUtZKTIuREWAi9G9lm',
  WTHRU_VAULT: 'taEqcObTD3WldMGFOW28FBKF6_mQfSbci1TC77YyssQQhP',
  WTHRU_MINT: 'taaoXQw03WlYWdo1jhfFi2Nqfqsf4RqYySn_89mchjCiLb',
  NFT_PROGRAM: 'taNFTjOaeDBSPHNf0LVRWAkF4raUFQgrz0EQIgJd60ENb5',
  NOOP_PROGRAM: 'taNOOPV4A7S3WTsirr149To2GoGZ9q8zllQaBrbekHfkJT',
  ORACLE_PROGRAM: 'taORCLOkTSYq5enR2XOGoSDmzMc0P5NlqjP8nKpfd3vgps',
  AMM_PROGRAM: 'taAMMx8gG44RcOyRqNYZ55pDaAJoGS0R8kPYxBN96sO8kD',
  CLOB_PROGRAM: 'taCLOBcFk1PT8JTHQM1LzsyK6HLv1YkSJKZ2ZyIxo8fiTe',
}

/** ThruScan's own programs and accounts, as deployed on 28 September 2026. */
const OURS_ALPHANET = {
  THRUSWAP_PROGRAM: 'taCXE0eEQbUHU90dyZ__Bz1yfQabjyaD4xaSHKUw3Q1M4N',
  THRUSWAP_REGISTRY: 'taxd8oXrKJTRejpLPUPrrjWMR8PnSFC03SRCphFW2p1Cpj',
  THRUPAD_PROGRAM: 'tastnRlQL8RGYeByXK2QAzaqdnfvI6pVn0e89JSl6Hiu8I',
  THRUPAD_REGISTRY: 'takPPySUoh_Vew_AoHfDaCIm0X5vf2vpgRgW5TR0aVkYbJ',
  TUSD_MINT: 'ta4OJoJQcZRIx4Sm3MLdEUrn_j5gb4vFeFPhpSJraHZTeB',
  NAME_ROOT: 'taLu3d1rxGdQWWHJxUOK6eT9ti4lWeTijNp0Kk_5YKHARg',
  WALL_PROGRAM: 'tagNpTX6NLyLv1099dM7HQySw9j_dSH8GBoijY4fGCFVwH',
  WALL_ACCOUNT: 'ta_t7GTjgkL-Jt8PIL1n826P6AFcC-59xtmrWpKGKeQ_fF',
  ID_PROGRAM: 'taSXTzs8mjKZoBAbYPXQHh8LNkbn-eRqgBhdY4-CA_UV-z',
  ID_REGISTRY: 'tamTImRuoNie6gbzJtRWq7FrclVgfxh5xIRJdxzA8pFlIg',
  WORDLE_PROGRAM: 'tar7SW2hDhnizBJT8gcJ6XBfBgNobwsxTwNcUvCrDQu-eF',
  WORDLE_BOARD: 'ta_NmQH2Nc-WCgUzswdm5xZ76oFIT1m9UHs-hDD24TWFI4',
  G2048_PROGRAM: 'taXyq3jDXavyDXwVEq85vInMz5YfKpprmTGgSa4ayd4mSa',
  G2048_BOARD: 'ta17eN7VuVh-HgHKxEkmuhyIWwlKd3QggRgjrOy1bJb-vC',
  PALS_PROGRAM: 'taXgi_tvqshzois9iLBY5msTGlQvW_GydSKRODoPgPVInH',
}

/* Nothing is deployed on mainnet, and empty is the honest value. Writing
   alphanet's addresses in here would make a mainnet build claim to know where
   programs are that do not exist, which fails as a read of nothing rather than
   as an error anybody would notice. Every page already handles a blank address
   by saying the thing is not connected yet. */
const OURS_MAINNET = {}

/**
 * Every network this build knows about.
 *
 * `rpc` is ordered: the first endpoint that answers a health check wins, which
 * is what lets one entry carry both a gRPC and a gRPC-Web spelling of the same
 * host without anybody choosing between them.
 *
 * `test` is the flag the badge reads. It is not cosmetic. It is the difference
 * between a page that quietly looks like money and a page that says, in the
 * chrome, that none of this is real yet.
 */
export const NETWORKS = {
  alphanet: {
    id: 'alphanet',
    label: 'Alphanet',
    test: true,
    chainId: 1,
    rpc: [
      { url: 'https://rpc.alphanet.thru.org', protocol: 'grpc' },
      { url: 'https://rpc.alphanet.thru.org', protocol: 'grpc-web' },
      { url: 'https://grpc-web.alphanet.thru.org', protocol: 'grpc-web' },
    ],
    addresses: { ...SYSTEM, ...OURS_ALPHANET },
  },

  /* The same chain as alphanet under a second name, not a second chain.
     Same addresses, deliberately, because the state is the same state. */
  betanet: {
    id: 'betanet',
    label: 'Betanet',
    test: true,
    chainId: 1,
    rpc: [
      { url: 'https://rpc.betanet.thru.org', protocol: 'grpc' },
      { url: 'https://rpc.betanet.thru.org', protocol: 'grpc-web' },
    ],
    addresses: { ...SYSTEM, ...OURS_ALPHANET },
  },

  /* Not live. Listed so that pointing a build at it is a one-word change and
     so that the signing guard in the wallet has a non-test network to compare
     against before there is one. The URL is a guess at Thru's own naming and
     must be confirmed before anybody relies on it. */
  mainnet: {
    id: 'mainnet',
    label: 'Mainnet',
    test: false,
    chainId: null,
    rpc: [
      { url: 'https://rpc.thru.org', protocol: 'grpc' },
      { url: 'https://rpc.thru.org', protocol: 'grpc-web' },
    ],
    addresses: { ...SYSTEM, ...OURS_MAINNET },
  },
}

/** The network this build is pointed at, by name. */
export const ACTIVE_NETWORK =
  (env.VITE_THRU_NETWORK || env.THRU_NETWORK || 'alphanet').toLowerCase()

/* An unknown name is a configuration mistake, and falling back silently to
   alphanet would hide it behind a working site pointed at the wrong chain.
   Shout, then fall back, so at least the console says why. */
if (!NETWORKS[ACTIVE_NETWORK]) {
  // eslint-disable-next-line no-console
  console.error(
    `THRU_NETWORK is "${ACTIVE_NETWORK}", which is not one of: ${Object.keys(NETWORKS).join(', ')}. Using alphanet.`,
  )
}

export const network = NETWORKS[ACTIVE_NETWORK] ?? NETWORKS.alphanet

/**
 * One address, with its environment override applied.
 *
 * The override is per key and per build, not per network: a variable named
 * VITE_THRUPAD_PROGRAM means "this build's launchpad lives here", which is the
 * only thing it can usefully mean when a build talks to one chain.
 */
export function addressOf(key) {
  return env[`VITE_${key}`] || env[key] || network.addresses[key] || ''
}

/** Every address for the active network, overrides applied. */
export function activeAddresses() {
  const out = {}
  for (const key of Object.keys(network.addresses)) out[key] = addressOf(key)
  return out
}

/**
 * The node endpoints to try, in order.
 *
 * THRU_RPC_URL still jumps the queue, because when a host moves the fix has to
 * be available without a deploy.
 */
export function rpcCandidates() {
  const first = env.THRU_RPC_URL
    ? [{ url: env.THRU_RPC_URL, protocol: env.THRU_RPC_PROTOCOL || 'grpc' }]
    : []
  return [...first, ...network.rpc]
}
