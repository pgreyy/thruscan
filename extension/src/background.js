// extension/src/background.js
//
// The wallet's engine. Holds the unlocked keys, answers the popup, and handles
// every request a website makes through window.thru. Nothing that can sign ever
// leaves this worker: the popup and websites only ever get addresses,
// signatures and results.
//
// Storage:
//   chrome.storage.local    vault (ciphertext only), settings, connected sites
//   chrome.storage.session  the unlocked secrets, so a worker restart does not
//                           lock the wallet. Session storage lives in memory,
//                           is cleared when the browser closes, and is not
//                           readable by content scripts.

import { Pubkey, keys } from '@thru/sdk'
import { seal, open, b64, hex } from './lib/vault.js'
import { newPhrase, accountFromPhrase, phraseProblem, phraseWords } from './lib/seed.js'
import * as chain from './lib/chain.js'

const DEFAULT_SETTINGS = { rpc: chain.DEFAULT_RPC, autoLockMinutes: 15 }
const LOCK_ALARM = 'auto-lock'

const local = {
  get: (k) => chrome.storage.local.get(k).then((r) => r[k]),
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
}
const session = {
  get: (k) => chrome.storage.session.get(k).then((r) => r[k]),
  set: (k, v) => chrome.storage.session.set({ [k]: v }),
  clear: () => chrome.storage.session.clear(),
}

async function settings() {
  return { ...DEFAULT_SETTINGS, ...((await local.get('settings')) ?? {}) }
}

/* ---------- keys ---------- */

/** Turn a stored secret into a signer. */
async function signerFrom(secret) {
  if (secret.kind === 'phrase') {
    const a = accountFromPhrase(secret.phrase, secret.index ?? 0)
    return { address: a.address, publicKey: a.publicKey, privateKey: a.privateKey }
  }
  const privateKey = hex.decode(secret.privateKey)
  const publicKey = await keys.fromPrivateKey(privateKey)
  return { address: Pubkey.from(publicKey).toThruFmt(), publicKey, privateKey }
}

async function unlockedSecret() {
  return session.get('secret')
}

async function signer() {
  const secret = await unlockedSecret()
  if (!secret) throw new Error('The wallet is locked.')
  await touch()
  return signerFrom(secret)
}

/** Restart the auto-lock countdown. */
async function touch() {
  const s = await settings()
  chrome.alarms.create(LOCK_ALARM, { delayInMinutes: Math.max(1, s.autoLockMinutes) })
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === LOCK_ALARM) lock() })

async function lock() {
  await session.clear()
  chrome.alarms.clear(LOCK_ALARM)
  broadcast('lock')
}

async function saveVault(password, secret) {
  if (!password || password.length < 8) throw new Error('Use a password of at least 8 characters.')
  const s = await signerFrom(secret)
  await local.set('vault', await seal(password, secret))
  await local.set('account', { address: s.address, kind: secret.kind })
  await session.set('secret', secret)
  await touch()
  return { address: s.address }
}

/* ---------- one transaction at a time ----------
   Two transactions signed at the same moment carry the same nonce, and the
   second fails with -511. Each send holds the line until the nonce moves. */

let line = Promise.resolve()
function serial(fn) {
  const run = line.then(fn)
  line = run.then(async (sig) => {
    if (typeof sig === 'string') await chain.waitFor((await settings()).rpc, sig, 8000)
  }).catch(() => {})
  return run
}

/* ---------- connected sites ---------- */

async function sites() { return (await local.get('sites')) ?? {} }
async function isConnected(origin) { return Boolean((await sites())[origin]) }

/** Tell open pages (all of them, or one site's) that something changed. */
function broadcast(event, data, origin = null) {
  chrome.tabs.query({}, (tabs) => {
    // Tab URLs are hidden without the "tabs" permission, which this wallet
    // does not ask for; each page's bridge checks the origin itself.
    for (const t of tabs) chrome.tabs.sendMessage(t.id, { from: 'thruscan-wallet', event, data, origin }).catch(() => {})
  })
}

/* ---------- approvals ----------
   A site's request waits here while a small window asks the user. Closing the
   window counts as a no. */

const pending = new Map()   // id -> { origin, method, params, resolve, reject, windowId }

async function ask(origin, method, params) {
  const id = crypto.randomUUID()
  const w = await chrome.windows.create({
    url: chrome.runtime.getURL(`popup.html#/approve/${id}`),
    type: 'popup', width: 380, height: 640, focused: true,
  })
  return new Promise((resolve, reject) => {
    pending.set(id, { origin, method, params, resolve, reject, windowId: w.id })
  })
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, p] of pending) {
    if (p.windowId === windowId) { pending.delete(id); p.reject(new Error('The user closed the request.')) }
  }
})

/* ---------- what a site can ask for ---------- */

function intentFrom(params) {
  const p = params ?? {}
  const program = p.programAddress ?? p.program
  if (!chain.isAddress(program)) throw new Error('programAddress is not a Thru address.')
  const data = typeof p.instructionData === 'string' ? b64.decode(p.instructionData) : Uint8Array.from(p.instructionData ?? [])
  const readWrite = p.readWriteAddresses ?? p.readWrite ?? []
  const readOnly = p.readOnlyAddresses ?? p.readOnly ?? []
  for (const a of [...readWrite, ...readOnly]) if (!chain.isAddress(a)) throw new Error(`${a} is not a Thru address.`)
  return { program, data, readWrite, readOnly, computeUnits: p.computeUnits, stateUnits: p.stateUnits, memoryUnits: p.memoryUnits }
}

async function fromSite(origin, method, params) {
  const account = await local.get('account')
  switch (method) {
    case 'connect': {
      if (!account) throw new Error('No wallet has been set up yet.')
      if (!(await isConnected(origin)) || !(await unlockedSecret())) {
        const ok = await ask(origin, 'connect', {})
        if (!ok) throw new Error('The user rejected the connection.')
        const all = await sites()
        all[origin] = { address: account.address, at: Date.now() }
        await local.set('sites', all)
      }
      return { publicKey: account.address, accounts: [{ address: account.address, accountType: 'thru', label: 'ThruScan Wallet' }] }
    }
    case 'disconnect': {
      const all = await sites()
      delete all[origin]
      await local.set('sites', all)
      return true
    }
    case 'getAccount':
      return (await isConnected(origin)) && account ? { publicKey: account.address } : null
    case 'signTransaction':
    case 'signAndSendTransaction': {
      if (!(await isConnected(origin))) throw new Error('Connect first.')
      const intent = intentFrom(params)
      const ok = await ask(origin, method, {
        program: intent.program,
        readWrite: intent.readWrite,
        readOnly: intent.readOnly,
        dataHex: hex.encode(intent.data),
        review: params?.review ?? null,
      })
      if (!ok) throw new Error('The user rejected the transaction.')
      const s = await signer()
      const url = (await settings()).rpc
      return serial(async () => {
        const { rawTransaction, signature } = await chain.buildSigned(url, s, {
          program: intent.program, readWrite: intent.readWrite, readOnly: intent.readOnly, data: intent.data,
          ...(intent.computeUnits ? { computeUnits: intent.computeUnits } : {}),
          ...(intent.stateUnits ? { stateUnits: intent.stateUnits } : {}),
          ...(intent.memoryUnits ? { memoryUnits: intent.memoryUnits } : {}),
        })
        if (method === 'signTransaction') return b64.encode(rawTransaction)
        return chain.submit(url, rawTransaction, signature)
      })
    }
    case 'signMessage': {
      if (!(await isConnected(origin))) throw new Error('Connect first.')
      const message = typeof params?.message === 'string' ? b64.decode(params.message) : Uint8Array.from(params?.message ?? [])
      const ok = await ask(origin, 'signMessage', { messageB64: b64.encode(message) })
      if (!ok) throw new Error('The user rejected the signature.')
      const s = await signer()
      return b64.encode(await chain.signMessageBytes(s, message))
    }
    default:
      throw new Error(`Unknown method ${method}.`)
  }
}

/* ---------- what the popup can ask for ---------- */

async function fromPopup(msg) {
  const url = (await settings()).rpc
  switch (msg.type) {
    case 'state': {
      const account = await local.get('account')
      return { hasWallet: Boolean(account), unlocked: Boolean(await unlockedSecret()), account: account ?? null, settings: await settings() }
    }
    case 'newPhrase': return newPhrase()
    case 'phraseProblem': return phraseProblem(msg.phrase)
    case 'create': {
      const problem = phraseProblem(msg.phrase)
      if (problem) throw new Error(problem)
      return saveVault(msg.password, { kind: 'phrase', phrase: phraseWords(msg.phrase).join(' '), index: 0 })
    }
    case 'importKey': {
      const k = hex.decode(msg.privateKey)
      if (k.length !== 32) throw new Error('A Thru private key is 32 bytes: 64 hex characters.')
      return saveVault(msg.password, { kind: 'key', privateKey: hex.encode(k) })
    }
    case 'unlock': {
      const sealed = await local.get('vault')
      if (!sealed) throw new Error('No wallet here yet.')
      const secret = await open(msg.password, sealed)
      await session.set('secret', secret)
      await touch()
      broadcast('unlock')
      return true
    }
    case 'lock': await lock(); return true
    case 'reveal': {
      // Always asks for the password again, even when unlocked.
      const secret = await open(msg.password, await local.get('vault'))
      const s = await signerFrom(secret)
      return { phrase: secret.kind === 'phrase' ? secret.phrase : null, privateKey: hex.encode(s.privateKey) }
    }
    case 'forget': {
      await open(msg.password, await local.get('vault'))
      await chrome.storage.local.clear()
      await session.clear()
      broadcast('disconnect')
      return true
    }
    case 'overview': {
      const account = await local.get('account')
      if (!account) return null
      if (await unlockedSecret()) await touch()
      const [info, tokens] = await Promise.all([
        chain.accountInfo(url, account.address),
        chain.holdings(url, account.address).catch(() => []),
      ])
      return {
        address: account.address,
        exists: info.exists,
        thru: info.balance.toString(),
        tokens: tokens.map((t) => ({ ...t, amount: t.amount.toString() })),
      }
    }
    case 'balance': {
      // The quick part of the overview, so THRU shows before tokens are found.
      const account = await local.get('account')
      if (!account) return null
      const info = await chain.accountInfo(url, account.address)
      return { address: account.address, exists: info.exists, thru: info.balance.toString(), tokens: null }
    }
    case 'nfts': {
      const account = await local.get('account')
      if (!account) return []
      return chain.nfts(url, account.address)
    }
    case 'sendNft': {
      const s = await signer()
      const to = chain.isAddress(msg.to) ? msg.to : (await chain.resolveName(url, msg.to)).address
      if (to === s.address) throw new Error('That is this wallet.')
      return serial(() => chain.sendNft(url, s, msg.account, to))
    }
    case 'history': {
      const account = await local.get('account')
      if (!account) return { items: [], next: null }
      const h = await chain.history(url, account.address, msg.page ?? null)
      return { next: h.next, items: h.items.map((i) => ({ ...i, ...chain.describe(i, account.address) })) }
    }
    case 'activate': return chain.activate(url, await signer())
    case 'faucet': {
      const s = await signer()
      return serial(() => chain.claimThru(url, s))
    }
    case 'resolve': {
      if (chain.isAddress(msg.to)) return { address: msg.to, name: null }
      return chain.resolveName(url, msg.to)
    }
    case 'send': {
      const s = await signer()
      const to = chain.isAddress(msg.to) ? msg.to : (await chain.resolveName(url, msg.to)).address
      if (to === s.address) throw new Error('That is this wallet.')
      if (!(await chain.accountInfo(url, to)).exists) throw new Error('No account at that address on chain yet.')
      return serial(() => msg.mint
        ? chain.sendToken(url, s, msg.mint, to, BigInt(msg.amount))
        : chain.sendThru(url, s, to, BigInt(msg.amount)))
    }
    case 'waitFor': return chain.waitFor(url, msg.signature)
    case 'sites': return sites()
    case 'revoke': {
      const all = await sites()
      delete all[msg.origin]
      await local.set('sites', all)
      broadcast('disconnect', null, msg.origin)
      return true
    }
    case 'reset': {
      // "Forgot password": wipe and start again from the 12 words or key.
      await chrome.storage.local.clear()
      await session.clear()
      broadcast('disconnect')
      return true
    }
    case 'ping': return true
    case 'setSettings': {
      await local.set('settings', { ...(await settings()), ...msg.settings })
      return settings()
    }
    case 'request': {
      const p = pending.get(msg.id)
      return p ? { origin: p.origin, method: p.method, params: p.params } : null
    }
    case 'decide': {
      const p = pending.get(msg.id)
      if (!p) return false
      pending.delete(msg.id)
      p.resolve(Boolean(msg.approve))
      chrome.windows.remove(p.windowId).catch(() => {})
      return true
    }
    default:
      throw new Error(`Unknown request ${msg.type}.`)
  }
}

/* ---------- wiring ---------- */

// First install: open setup in a tab.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install' && !(await local.get('account'))) {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1#/') })
  }
})

const serialize = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)))

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fromExtension = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''))
  const work = msg?.channel === 'site'
    ? fromSite(sender.origin ?? new URL(sender.url).origin, msg.method, msg.params)
    : fromExtension ? fromPopup(msg) : Promise.reject(new Error('Not allowed.'))
  work.then((result) => reply({ ok: true, result: serialize(result) }))
    .catch((e) => reply({ ok: false, error: String(e?.message ?? e) }))
  return true   // answer asynchronously
})
