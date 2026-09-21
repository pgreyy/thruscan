// extension/src/inpage.js
//
// window.thru: what a Thru app talks to. It runs inside the page itself, holds
// nothing secret, and forwards every call to the wallet, which asks the user
// before anything is connected or signed.
//
//   const thru = window.thru
//   const { publicKey } = await thru.connect()
//   const signature = await thru.signAndSendTransaction({
//     programAddress, instructionData /* base64 */, readWriteAddresses, readOnlyAddresses,
//   })
//
// The transaction shape matches Thru's own wallet SDK, so an app written for
// one works with the other.

(() => {
  if (window.thru?.isThruScanWallet) return

  const FROM_PAGE = 'thruscan-wallet:page'
  const TO_PAGE = 'thruscan-wallet:content'
  const waiting = new Map()
  const listeners = new Map()
  let nextId = 1

  const emit = (event, data) => {
    for (const fn of listeners.get(event) ?? []) { try { fn(data) } catch (e) { console.error(e) } }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.target !== TO_PAGE) return
    const m = e.data
    if (m.event) {
      if (m.event === 'lock') emit('lock')
      if (m.event === 'unlock') emit('unlock')
      if (m.event === 'disconnect') { provider.publicKey = null; provider.isConnected = false; emit('disconnect') }
      if (m.event === 'accountChanged') { provider.publicKey = m.data?.publicKey ?? null; emit('accountChanged', m.data) }
      return
    }
    const w = waiting.get(m.id)
    if (!w) return
    waiting.delete(m.id)
    if (m.ok) w.resolve(m.result)
    else {
      const err = new Error(m.error || 'The wallet refused.')
      if (/reject|closed/i.test(err.message)) err.code = 4001
      w.reject(err)
    }
  })

  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    waiting.set(id, { resolve, reject })
    window.postMessage({ target: FROM_PAGE, id, method, params: params ?? null }, window.location.origin)
  })

  const toB64 = (v) => {
    if (typeof v === 'string') return v
    const bytes = v instanceof Uint8Array ? v : Uint8Array.from(v ?? [])
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s)
  }

  const provider = {
    isThruScanWallet: true,
    name: 'ThruScan Wallet',
    publicKey: null,
    isConnected: false,

    async connect() {
      const r = await call('connect')
      provider.publicKey = r.publicKey
      provider.isConnected = true
      emit('connect', r)
      return r
    },
    async disconnect() {
      await call('disconnect')
      provider.publicKey = null
      provider.isConnected = false
      emit('disconnect')
    },
    /** The connected address, or null, without asking the user anything. */
    async getAccount() {
      const r = await call('getAccount')
      provider.publicKey = r?.publicKey ?? null
      provider.isConnected = Boolean(r)
      return r
    },
    /** Signs and returns the raw transaction, base64, without sending it. */
    signTransaction(intent) {
      return call('signTransaction', { ...intent, instructionData: toB64(intent?.instructionData) })
    },
    /** Signs, sends, and returns the signature (ts…). */
    signAndSendTransaction(intent) {
      return call('signAndSendTransaction', { ...intent, instructionData: toB64(intent?.instructionData) })
    },
    /** Signs arbitrary bytes (or text) and returns the signature, base64. */
    signMessage(message) {
      const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message
      return call('signMessage', { message: toB64(bytes) })
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(fn)
      return () => provider.off(event, fn)
    },
    off(event, fn) { listeners.get(event)?.delete(fn) },
  }

  Object.freeze(provider.on)
  Object.defineProperty(window, 'thru', { value: provider, configurable: false, writable: false })

  // Discovery, for apps that list every wallet present.
  const info = { name: 'ThruScan Wallet', rdns: 'app.thruscan.wallet' }
  const announce = () => window.dispatchEvent(new CustomEvent('thru:announceProvider', { detail: Object.freeze({ info, provider }) }))
  window.addEventListener('thru:requestProvider', announce)
  announce()
})()
