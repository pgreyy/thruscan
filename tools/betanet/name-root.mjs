// tools/betanet/name-root.mjs
//
// Step 7: the ".id" root registrar on Thru's name service, owned by the
// betanet sponsor.
//
//   node tools/betanet/name-root.mjs
//
// The owner has to be the sponsor, not the deploy authority: api/wallet.js
// registers each ThruID by signing as the root's authority with
// THRU_SPONSOR_*, so a root owned by any other key makes every registration on
// the site fail. The root's address is derived from the name alone, so it is
// the same on every network; it only has to be free on this one.

import { SPONSOR, NAME_ROOT_NAME, publicKeyOf, thru, save, log } from './config.mjs'
import { getAccount } from './chain.mjs'
import { decodeRootRegistrar } from '../../src/lib/nameservice.js'

const root = thru(['nameservice', 'derive-registrar-account', NAME_ROOT_NAME]).derive_registrar_account.registrar_account
const sponsor = publicKeyOf(SPONSOR)

const owner = async () => {
  const a = await getAccount(root)
  if (!a) return null
  const r = decodeRootRegistrar(Buffer.from(a.data.data).toString('base64'))
  return r.authority ?? r.owner ?? null
}

let current = await owner()
if (current === null) {
  const r = thru(['nameservice', 'init-root', NAME_ROOT_NAME, '--fee-payer', SPONSOR])
  const sig = r.init_root?.signature ?? r.nameservice_init_root?.signature ?? JSON.stringify(r).match(/ts[A-Za-z0-9_-]{80,}/)?.[0]
  save({ signatures: { 'init-root id': sig ?? JSON.stringify(r).slice(0, 200) } })
  log(`.${NAME_ROOT_NAME} root ${root} created ${sig ?? ''}`)
  for (let i = 0; i < 10 && current === null; i++) { await new Promise((r) => setTimeout(r, 1500)); current = await owner() }
}

if (current !== sponsor) {
  log(`PROBLEM: .${NAME_ROOT_NAME} root ${root} is owned by ${current}, not the sponsor ${sponsor}. ThruID registration on the site will fail.`)
  process.exit(1)
}
save({ addresses: { NAME_ROOT: root } })
log(`.${NAME_ROOT_NAME} root ${root} owned by the sponsor ${sponsor}`)
