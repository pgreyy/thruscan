// test-wallet.mjs - can a sponsor create an account for a key it has never seen?
//
// Run from the repo, so @thru/sdk resolves:
//
//   cd C:\projects\thruscan
//   $priv = (thru keys get wallkey --json | ConvertFrom-Json).keys.value
//   node C:\projects\src\test-wallet.mjs $priv
//
// This is the assumption the whole in-app wallet rests on. A browser cannot pay
// its own way into existence: a brand new keypair has no account, and creating
// one needs a state proof and a fee payer. But the EOA program takes a
// SIGNATURE from the new key alongside the creation, which is what the delete
// path uses to stop a stranger removing someone's account.
//
// If that works in reverse, the sponsor can pay to bring a user's account into
// being while the user's own key authorizes it, and the private key never has
// to leave their browser. That is a real non-custodial wallet.
//
// If it does not work, onboarding has to look completely different, and it is
// much better to learn that from this file than from a half-built one.

import { createThruClient, keys, eoa, proofs, transactions, Pubkey } from '@thru/sdk'
import { createGrpcTransport } from '@connectrpc/connect-node'

const RPC_URL = 'https://rpc.alphanet.thru.org'
const CHAIN_ID = 1

const SPONSOR_PUB = 'tasXJdF9qhC9DaAM0iO5exE-ajUdA4f-A3DU3-r8ec2jE5'
const SPONSOR_PRIV = process.argv[2]

if (!SPONSOR_PRIV || SPONSOR_PRIV.length < 32) {
  console.error('Pass the sponsor private key as the first argument.')
  console.error('  $priv = (thru keys get wallkey --json | ConvertFrom-Json).keys.value')
  console.error('  node test-wallet.mjs $priv')
  process.exit(1)
}

function hexToBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

const line = (s = '') => console.log(s)
const step = (n, s) => console.log(`\n=== ${n}. ${s} ===`)

async function main() {
  const client = createThruClient({ transport: createGrpcTransport({ baseUrl: RPC_URL }) })

  step(1, 'generate a keypair, the way a browser would')
  const user = await keys.generateKeyPair()
  line(`address     ${user.address}`)
  line(`public key  ${Buffer.from(user.publicKey).toString('hex').slice(0, 32)}...`)
  line('private key stays here and is never sent anywhere')

  step(2, 'does that account exist yet?')
  let exists = true
  try { await client.accounts.get(user.address) } catch { exists = false }
  line(exists ? 'it already exists, which is unexpected' : 'no, as expected. A fresh key has no account.')

  step(3, 'the user signs the creation message')
  // The message binds the chain, the payer and the new account together, so a
  // signature for one creation cannot be replayed into another.
  const msg = eoa.buildEOACreateMessage(
    CHAIN_ID,
    Pubkey.from(SPONSOR_PUB).toBytes(),
    user.publicKey,
  )
  line(`message     ${msg.length} bytes`)

  const sdk = await import('@thru/sdk')
  const signFn = sdk.signMessage ?? sdk.signWithDomain
  if (!signFn) { line('!!! no signMessage export found'); process.exit(1) }
  const signature = await signFn(msg, user.privateKey)
  const sigBytes = signature instanceof Uint8Array ? signature : signature?.toBytes?.() ?? signature
  line(`signature   ${sigBytes.length} bytes`)

  step(4, 'the sponsor builds a creation proof for that address')
  const proof = await proofs.generateStateProof(client.ctx ?? client, {
    address: user.address,
    kind: 'creating',
  }).catch(async (e) => {
    line(`generateStateProof(address, kind) failed: ${String(e?.message ?? e).slice(0, 160)}`)
    line('trying the positional form')
    return proofs.generateStateProof(client.ctx ?? client, user.address, 'creating')
  })
  const proofData = proof?.proofData ?? proof?.proof_data ?? proof
  line(`proof       ${proofData?.length ?? 'unknown'} bytes`)

  step(5, 'the sponsor submits it, paying the fee')
  // The new account is the only read-write account, so it lands at index 2.
  const instruction = eoa.buildCreateEOAInstruction(2, sigBytes, proofData)
  line(`instruction ${instruction.length} bytes`)

  const sponsor = await client.accounts.get(SPONSOR_PUB)
  const nonce = sponsor?.meta?.nonce ?? 0n

  const signed = await client.transactions.buildAndSign({
    feePayer: { publicKey: SPONSOR_PUB, privateKey: hexToBytes(SPONSOR_PRIV) },
    program: eoa.EOA_PROGRAM_ADDRESS,
    accounts: { readWrite: [user.address] },
    header: { nonce, computeUnits: 300_000_000, stateUnits: 60_000, memoryUnits: 60_000 },
    instructionData: instruction,
  })

  const sig = await client.transactions.send(signed.rawTransaction)
  line(`submitted   ${sig}`)

  step(6, 'did the account come into existence?')
  await new Promise((r) => setTimeout(r, 4000))
  try {
    const acc = await client.accounts.get(user.address)
    line(`YES. dataSize ${acc?.meta?.dataSize}, nonce ${acc?.meta?.nonce}, balance ${acc?.meta?.balance}`)
    line('')
    line('=========================================================')
    line('The sponsor created an account for a key it has never held,')
    line('authorized by that key alone. A browser wallet works.')
    line('=========================================================')
  } catch (e) {
    line(`no: ${String(e?.message ?? e).slice(0, 200)}`)
    line('')
    line('Onboarding needs a different shape. Send me this output.')
  }

  line('')
  line(`new address: ${user.address}`)
  line(`private key: ${Buffer.from(user.privateKey).toString('hex')}`)
  line('(a throwaway test key on a valueless testnet, printed so the account can be reused)')
}

main().catch((e) => {
  console.error('\nFAILED:', String(e?.message ?? e))
  console.error(e?.stack?.split('\n').slice(0, 6).join('\n'))
  process.exit(1)
})
