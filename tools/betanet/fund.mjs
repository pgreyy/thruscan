// tools/betanet/fund.mjs
//
// Steps 1 and 8: make sure the authority and the sponsor exist on betanet and
// hold at least a target amount of native THRU, from Thru's own faucet.
//
//   node tools/betanet/fund.mjs                 # both, to the default targets
//   node tools/betanet/fund.mjs betanet-sponsor 50000
//
// The faucet pays at most 10,000 per withdrawal, so this repeats until the
// target is reached. Each key pays its own (zero) fee.

import { AUTHORITY, SPONSOR, thru, log, save } from './config.mjs'

const FAUCET_MAX = 10_000
const TARGETS = { [AUTHORITY]: 40_000, [SPONSOR]: 30_000 }

const [onlyKey, onlyTarget] = process.argv.slice(2)
const plan = onlyKey ? { [onlyKey]: Number(onlyTarget || TARGETS[onlyKey] || FAUCET_MAX) } : TARGETS

const balance = (key) => BigInt(thru(['getbalance', key], { allowFail: true })?.balance?.balance ?? -1)

for (const [key, target] of Object.entries(plan)) {
  if (balance(key) < 0n) {
    const r = thru(['account', 'create', key]).account_create
    log(`${key}: account created ${r.public_key} ${r.signature}`)
    save({ signatures: { [`account create ${key}`]: r.signature } })
  }
  let have = balance(key)
  while (have < BigInt(target)) {
    const amount = Math.min(FAUCET_MAX, Number(BigInt(target) - have))
    const r = thru(['faucet', 'withdraw', key, String(amount), '--fee-payer', key]).faucet_withdraw
    save({ signatures: { [`faucet ${key} ${new Date().toISOString()}`]: r.signature } })
    for (let i = 0; i < 10 && balance(key) === have; i++) await new Promise((res) => setTimeout(res, 1000))
    have = balance(key)
    log(`${key}: +${amount} THRU (${r.signature}), now ${have}`)
  }
  log(`${key}: ${have} THRU (target ${target})`)
}
