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
import { open, openForEdit, resealWith, sealForEdit, b64, hex } from './lib/vault.js'
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

/* ---------- keys and accounts ----------
 *
 * The vault holds every secret in one encrypted object:
 *
 *   { v: 2,
 *     seeds:    [{ id, phrase }],                  recovery phrases
 *     keys:     [{ id, privateKey }],              imported single keys
 *     accounts: [{ id, name, kind: 'phrase', seed, index }
 *              | { id, name, kind: 'key', key }] }
 *
 * An account from a phrase is that phrase's key at an index (m/44'/.../index'),
 * so one phrase can hold many accounts, as in MetaMask. More phrases or plain
 * keys can be added beside it. Which account is in use is not secret, so it
 * lives outside the vault, as does the list of names and addresses, which the
 * popup shows even while locked.
 *
 * Version 1 vaults held one secret ({ kind, phrase, index } or { kind, key });
 * they are converted the first time they are unlocked.
 */

const rid = () => crypto.randomUUID().slice(0, 8)

function upgrade(secret) {
  if (secret?.v === 2) return secret
  const acc = { id: rid(), name: 'Account 1' }
  if (secret.kind === 'phrase') {
    const seed = { id: rid(), phrase: secret.phrase }
    return { v: 2, seeds: [seed], keys: [], accounts: [{ ...acc, kind: 'phrase', seed: seed.id, index: secret.index ?? 0 }] }
  }
  const key = { id: rid(), privateKey: secret.privateKey }
  return { v: 2, seeds: [], keys: [key], accounts: [{ ...acc, kind: 'key', key: key.id }] }
}

/** The keypair for one account of the vault. */
async function signerFor(secret, acc) {
  if (acc.kind === 'phrase') {
    const seed = secret.seeds.find((x) => x.id === acc.seed)
    const a = accountFromPhrase(seed.phrase, acc.index ?? 0)
    return { address: a.address, publicKey: a.publicKey, privateKey: a.privateKey }
  }
  const k = secret.keys.find((x) => x.id === acc.key)
  const privateKey = hex.decode(k.privateKey)
  const publicKey = await keys.fromPrivateKey(privateKey)
  return { address: Pubkey.from(publicKey).toThruFmt(), publicKey, privateKey }
}

async function unlockedSecret() {
  return session.get('secret')
}

async function activeAccount(secret) {
  const id = await local.get('active')
  return secret.accounts.find((a) => a.id === id) ?? secret.accounts[0]
}

async function signer() {
  const secret = await unlockedSecret()
  if (!secret) throw new Error('The wallet is locked.')
  await touch()
  return signerFor(secret, await activeAccount(secret))
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

/** Write the public side: every account's name and address, and the one in use. */
async function publish(secret) {
  const list = []
  for (const a of secret.accounts) {
    const s = await signerFor(secret, a)
    list.push({ id: a.id, name: a.name, address: s.address, kind: a.kind })
  }
  await local.set('accounts', list)
  const id = await local.get('active')
  const active = list.find((a) => a.id === id) ?? list[0]
  await local.set('active', active.id)
  await local.set('account', active)
  return list
}

/** A new vault (first setup). */
async function saveVault(password, secret) {
  if (!password || password.length < 8) throw new Error('Use a password of at least 8 characters.')
  const { sealed, edit } = await sealForEdit(password, secret)
  await local.set('vault', sealed)
  await local.set('active', secret.accounts[0].id)
  await session.set('secret', secret)
  await session.set('edit', edit)
  const list = await publish(secret)
  await touch()
  return { address: list[0].address }
}

/** Save a changed vault while unlocked, without asking for the password again. */
async function persist(secret) {
  const edit = await session.get('edit')
  if (!edit) throw new Error('Unlock the wallet again to change accounts.')
  await local.set('vault', await resealWith(edit, secret))
  await session.set('secret', secret)
  return publish(secret)
}

async function switchTo(id) {
  const list = (await local.get('accounts')) ?? []
  const acc = list.find((a) => a.id === id)
  if (!acc) throw new Error('No such account.')
  await local.set('active', acc.id)
  await local.set('account', acc)
  // Sites connected to this wallet now see the new address.
  for (const origin of Object.keys(await sites())) broadcast('accountChanged', { publicKey: acc.address }, origin)
  return acc
}

async function requireUnlocked() {
  const secret = await unlockedSecret()
  if (!secret) throw new Error('The wallet is locked.')
  await touch()
  return secret
}

function nextName(secret) {
  return `Account ${secret.accounts.length + 1}`
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
      const seed = { id: rid(), phrase: phraseWords(msg.phrase).join(' ') }
      return saveVault(msg.password, { v: 2, seeds: [seed], keys: [], accounts: [{ id: rid(), name: 'Account 1', kind: 'phrase', seed: seed.id, index: 0 }] })
    }
    case 'importKey': {
      const k = hex.decode(msg.privateKey)
      if (k.length !== 32) throw new Error('A Thru private key is 32 bytes: 64 hex characters.')
      const key = { id: rid(), privateKey: hex.encode(k) }
      return saveVault(msg.password, { v: 2, seeds: [], keys: [key], accounts: [{ id: rid(), name: 'Account 1', kind: 'key', key: key.id }] })
    }
    case 'unlock': {
      const sealed = await local.get('vault')
      if (!sealed) throw new Error('No wallet here yet.')
      const { secret: stored, edit } = await openForEdit(msg.password, sealed)
      const secret = upgrade(stored)
      await session.set('secret', secret)
      await session.set('edit', edit)
      if (stored?.v !== 2) await persist(secret)
      else if (!(await local.get('accounts'))) await publish(secret)
      await touch()
      broadcast('unlock')
      return true
    }
    case 'lock': await lock(); return true
    case 'accounts': {
      return { list: (await local.get('accounts')) ?? [], active: await local.get('active'), seeds: (await unlockedSecret())?.seeds?.length ?? 0 }
    }
    case 'switchAccount': return switchTo(msg.id)
    case 'addAccount': {
      // The next account of a phrase already in the wallet.
      const secret = structuredClone(await requireUnlocked())
      const seed = secret.seeds.find((x) => x.id === msg.seed) ?? secret.seeds[0]
      if (!seed) throw new Error('This wallet has no recovery phrase to add accounts from. Create or import one.')
      const used = secret.accounts.filter((a) => a.kind === 'phrase' && a.seed === seed.id).map((a) => a.index ?? 0)
      const index = used.length ? Math.max(...used) + 1 : 0
      const acc = { id: rid(), name: (msg.name || '').trim().slice(0, 24) || nextName(secret), kind: 'phrase', seed: seed.id, index }
      secret.accounts.push(acc)
      await persist(secret)
      return switchTo(acc.id)
    }
    case 'addPhraseAccount': {
      // A new or imported recovery phrase, as its own account.
      const problem = phraseProblem(msg.phrase)
      if (problem) throw new Error(problem)
      const secret = structuredClone(await requireUnlocked())
      const phrase = phraseWords(msg.phrase).join(' ')
      let seed = secret.seeds.find((x) => x.phrase === phrase)
      if (!seed) { seed = { id: rid(), phrase }; secret.seeds.push(seed) }
      const used = secret.accounts.filter((a) => a.kind === 'phrase' && a.seed === seed.id).map((a) => a.index ?? 0)
      const index = used.length ? Math.max(...used) + 1 : 0
      const acc = { id: rid(), name: (msg.name || '').trim().slice(0, 24) || nextName(secret), kind: 'phrase', seed: seed.id, index }
      secret.accounts.push(acc)
      await persist(secret)
      return switchTo(acc.id)
    }
    case 'addKeyAccount': {
      const k = hex.decode(msg.privateKey)
      if (k.length !== 32) throw new Error('A Thru private key is 32 bytes: 64 hex characters.')
      const secret = structuredClone(await requireUnlocked())
      const address = Pubkey.from(await keys.fromPrivateKey(k)).toThruFmt()
      const list = (await local.get('accounts')) ?? []
      const same = list.find((a) => a.address === address)
      if (same) return switchTo(same.id)
      const key = { id: rid(), privateKey: hex.encode(k) }
      secret.keys.push(key)
      const acc = { id: rid(), name: (msg.name || '').trim().slice(0, 24) || nextName(secret), kind: 'key', key: key.id }
      secret.accounts.push(acc)
      await persist(secret)
      return switchTo(acc.id)
    }
    case 'renameAccount': {
      const name = String(msg.name ?? '').trim().slice(0, 24)
      if (!name) throw new Error('Give it a name.')
      const secret = structuredClone(await requireUnlocked())
      const acc = secret.accounts.find((a) => a.id === msg.id)
      if (!acc) throw new Error('No such account.')
      acc.name = name
      await persist(secret)
      return true
    }
    case 'reveal': {
      // Always asks for the password again, even when unlocked.
      const secret = upgrade(await open(msg.password, await local.get('vault')))
      const acc = await activeAccount(secret)
      const s = await signerFor(secret, acc)
      const seed = acc.kind === 'phrase' ? secret.seeds.find((x) => x.id === acc.seed) : null
      return { phrase: seed?.phrase ?? null, privateKey: hex.encode(s.privateKey), name: acc.name }
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
