// tools/betanet/chain.mjs
//
// Signing and sending from the deploy scripts, through the same SDK the site
// uses. Separate from config.mjs because the CLI cannot build the program
// instructions these steps need (each INIT carries a state proof for the
// account it creates).
//
// The private key is read from THRUSCAN_SECRETS into memory, used to sign, and
// never printed, logged or written anywhere.

import dns from 'node:dns'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createThruClient, Pubkey, TransactionBuilder, deriveProgramAddress, proofs } from '@thru/sdk'
import { createGrpcTransport } from '@connectrpc/connect-node'
import { sendLanded } from '../../src/lib/sendLanded.js'
import { RPC, SECRETS, MAX_STATE_UNITS } from './config.mjs'

dns.setDefaultResultOrder('ipv4first')

export const client = createThruClient({ transport: createGrpcTransport({ baseUrl: RPC }) })

const PROOF_CREATING = 1

export const toBytes = (a) => Pubkey.from(a).toBytes()
export const fmt = (bytes) => Pubkey.from(bytes).toThruFmt()

/** A key from the secrets folder, held in memory only. */
export function signer(name) {
  const j = JSON.parse(readFileSync(join(SECRETS, `${name}.json`), 'utf8'))
  return { publicKey: j.publicKey, privateKey: Uint8Array.from(Buffer.from(j.privateKeyHex, 'hex')) }
}

export async function getAccount(address) {
  try { return await client.accounts.get(address) } catch { return null }
}

/** Wait for an account to appear, for up to about 20 seconds. */
export async function landed(address) {
  for (let i = 0; i < 14; i++) {
    if (await getAccount(address)) return true
    await new Promise((r) => setTimeout(r, 1500))
  }
  return false
}

/** UTF-8 seed, zero padded to 32 bytes, as the CLI does. */
export function seed32(text) {
  const b = Buffer.alloc(32)
  const s = Buffer.from(text, 'utf8')
  if (s.length > 32) throw new Error(`seed "${text}" is longer than 32 bytes`)
  s.copy(b)
  return new Uint8Array(b)
}

/** Where an account a program creates from this seed will land. */
export function programAccount(program, seed) {
  return deriveProgramAddress({ programAddress: program, seed }).address
}

export async function creationProof(address) {
  return (await proofs.generateStateProof(client.ctx, { address, proofType: PROOF_CREATING })).proof
}

/** Thru sorts accounts by raw key bytes; instruction indices follow that order. */
export function sortAccounts(list) {
  return [...new Set(list)].sort((a, b) => {
    const x = toBytes(a), y = toBytes(b)
    for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i]
    return 0
  })
}

/**
 * Sign and send one instruction from `from` (a signer), and wait until it has
 * landed. Indices: 0 is the fee payer, 1 the program, then read-write accounts
 * in sorted order, then read-only accounts in sorted order.
 */
export async function send(from, { program, readWrite = [], readOnly = [], data, stateUnits = 2048, computeUnits = 300_000_000, fee = 0n }) {
  const chainId = await client.chain.getChainId()
  return sendLanded(client, {
    nonceOf: async () => (await client.accounts.get(from.publicKey))?.meta?.nonce ?? 0n,
    build: async (nonce) => {
      const height = await client.blocks.getBlockHeight()
      return new TransactionBuilder().buildAndSign({
        feePayer: from,
        program,
        accounts: { readWriteAccounts: readWrite, readOnlyAccounts: readOnly },
        header: {
          fee,
          nonce,
          startSlot: height.finalized,
          expiryAfter: 100,
          chainId,
          computeUnits,
          stateUnits: Math.min(stateUnits, MAX_STATE_UNITS),
          memoryUnits: 60_000,
        },
        instructionData: data,
      })
    },
  })
}

/** Whether a landed transaction succeeded, with its error if not. */
export async function outcome(signature) {
  for (let i = 0; i < 20; i++) {
    try {
      const t = await client.transactions.get(signature)
      const r = t?.executionResult
      if (r) {
        // The same three fields api/rpc.js reports; all zero means it ran clean.
        const vm = Number(r.vmError ?? 0)
        const user = Number(r.userErrorCode ?? 0n)
        const exec = Number(r.executionResult ?? 0n)
        return { ok: vm === 0 && user === 0 && exec === 0, vm, user, exec }
      }
    } catch { /* not indexed yet */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return { ok: false, error: 'not found after 20 seconds' }
}

export const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
export const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
