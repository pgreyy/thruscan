// indexer/addresses.mjs
//
// Which programs to recognise, per network.
//
// Thru's own programs are bootstrap addresses: the runtime places them at the
// same address on every network, which I confirmed by reading all of them off
// betanet before writing this. Ours are not. A program's address is derived
// from whoever deployed it, so ThruScan's programs have one set of addresses on
// alphanet and will have a different set on betanet, and the indexer has to be
// told which it is looking at.
//
// Getting this wrong does not throw. It just quietly labels everything
// "Program call", which is why the loader shouts about an unknown network
// rather than falling back to a guess.

/* Thru's, identical everywhere. */
export const SYSTEM = {
  TOKEN_PROGRAM: 'taTOKENKRgcl3vO0yVhftATDbXuhgWcfaaxv9xpEEdMdUE',
  EOA_PROGRAM: 'taEOAD2uLK1SLzPgtabFLUAx22yDlBs9DE9nZFTOESIGRr',
  MULTICALL_PROGRAM: 'taMULTIrOL8WpIFr16C1ECsO60qAsuwmwJephZHDOTvSeP',
  NAME_SERVICE_PROGRAM: 'taNAMEqRNEDeMWp0cDYmMVdZyTZiF5NyGDR9zTwH42rWQG',
  NATIVE_FAUCET_PROGRAM: 'taFCTxR0y2eabGGaEdtTwC9pHz7ZY4CYD7FOiBFUJeAW16',
  WTHRU_PROGRAM: 'taWTHRUBelpONhTRjYc7n4OovodUsUtZKTIuREWAi9G9lm',
  NFT_PROGRAM: 'taNFTjOaeDBSPHNf0LVRWAkF4raUFQgrz0EQIgJd60ENb5',
  /* Betanet ships these two; alphanet did not. Harmless to carry on both,
     because an address that is not there simply never appears in a block. */
  AMM_PROGRAM: 'taAMMx8gG44RcOyRqNYZ55pDaAJoGS0R8kPYxBN96sO8kD',
  /* The do-nothing program. It is how a wallet with no account gets its
     first transaction accepted, and it is also what the node fills empty
     slots with, so the decoder tells those apart by the transaction's
     create-fee-payer flag rather than by the program. */
  NOOP_PROGRAM: 'taNOOPV4A7S3WTsirr149To2GoGZ9q8zllQaBrbekHfkJT',
  /* The price oracle. It posts updates continuously, bundled through the
     multicall program, and on a quiet chain those are most of the traffic.
     Infrastructure rather than anybody's activity, so the feed hides it. */
  ORACLE_PROGRAM: 'taORCLOkTSYq5enR2XOGoSDmzMc0P5NlqjP8nKpfd3vgps',
  CLOB_PROGRAM: 'taCLOBcFk1PT8JTHQM1LzsyK6HLv1YkSJKZ2ZyIxo8fiTe',
}

/* Ours, per network. Betanet is empty until the deploy happens, and empty is
   the honest value: writing alphanet's addresses in here would make the
   indexer claim to recognise programs that are not on the chain. */
export const OURS = {
  alphanet: {
    THRUPAD_PROGRAM: 'tastnRlQL8RGYeByXK2QAzaqdnfvI6pVn0e89JSl6Hiu8I',
    THRUSWAP_PROGRAM: 'taCXE0eEQbUHU90dyZ__Bz1yfQabjyaD4xaSHKUw3Q1M4N',
    PALS_PROGRAM: 'taXgi_tvqshzois9iLBY5msTGlQvW_GydSKRODoPgPVInH',
    WALL_PROGRAM: 'tagNpTX6NLyLv1099dM7HQySw9j_dSH8GBoijY4fGCFVwH',
  },
  betanet: {},
}

/** The network a URL points at, by name, so the caller need not repeat itself. */
export function networkOf(rpcUrl) {
  if (/betanet/i.test(rpcUrl)) return 'betanet'
  if (/alphanet/i.test(rpcUrl)) return 'alphanet'
  return process.env.THRU_NETWORK || 'unknown'
}

/**
 * The full address set for a network.
 *
 * Environment variables win over the table, so the betanet deploy needs no
 * code change: set THRUPAD_PROGRAM and the rest and restart.
 */
export async function addressesFor(rpcUrl) {
  const net = networkOf(rpcUrl)
  const ours = OURS[net] ?? {}
  if (!OURS[net]) {
    console.warn(`indexer: unknown network for ${rpcUrl}; recognising Thru's programs only.`)
    console.warn('indexer: set THRU_NETWORK, or the program addresses directly, to see ours.')
  }
  const out = { ...SYSTEM, ...ours }
  for (const key of ['THRUPAD_PROGRAM', 'THRUSWAP_PROGRAM', 'PALS_PROGRAM', 'WALL_PROGRAM', 'AMM_PROGRAM', 'CLOB_PROGRAM']) {
    if (process.env[key]) out[key] = process.env[key]
  }
  return out
}
