# ThruScan Wallet

A Chrome extension wallet for Thru. Self-custody: the keys are made in the browser, encrypted with the user's password, and never sent anywhere. ThruScan runs no server for it and cannot see, recover or move anything in it.

## What it does

- Create a wallet (12 words, checked back before it is saved) or import one from 12 words or a private key
- Unlock with a password; locks itself after a set number of idle minutes
- THRU balance first, then every token the wallet holds
- Activate a new address on chain, signed and paid for by the address itself
- Claim test THRU from Thru's alphanet faucet
- Send THRU or any token to an address or a `.id` name, with Max and the balance shown
- Receive with a QR code
- Activity, each item linking to its ThruScan transaction page
- Connected sites, with disconnect
- Show the 12 words or private key (asks for the password again)
- Change the RPC address, remove the wallet from the browser

## For Thru apps: `window.thru`

```js
const thru = window.thru                       // present when the extension is installed
const { publicKey } = await thru.connect()     // asks the user once per site

const signature = await thru.signAndSendTransaction({
  programAddress: 'ta…',
  instructionData: bytesOrBase64,
  readWriteAddresses: ['ta…'],                 // sorted as the instruction's indices expect
  readOnlyAddresses: [],
})

const raw = await thru.signTransaction({ … })  // signed, not sent: base64 wire bytes
const sig = await thru.signMessage('Sign in to my app')   // base64 ed25519 signature
await thru.getAccount()                        // { publicKey } or null, never prompts
await thru.disconnect()
thru.on('disconnect', () => …)                 // also 'connect', 'lock', 'unlock'
```

The transaction shape is the same as Thru's own wallet SDK, so an app written for one works with the other. The wallet is always the fee payer. Every request opens a window showing the site, the program and what the instruction does; closing it is a rejection (error code 4001). Apps that list wallets can listen for the `thru:announceProvider` event and dispatch `thru:requestProvider`.

## How it is built

```
extension/
  public/manifest.json   Manifest V3
  public/content.js      bridge between the page and the wallet (isolated world)
  public/inpage.js       window.thru, injected into the page (main world)
  src/background.js      the only place keys exist while unlocked; signs and sends
  src/lib/vault.js       PBKDF2-SHA256 (600,000 rounds) + AES-GCM, WebCrypto only
  src/lib/seed.js        BIP39 + SLIP-0010 at m/44'/9999'/0'/0', Thru's standard path
  src/lib/chain.js       reads and writes over gRPC-Web straight to the Thru node
  src/popup/             the screens (React)
```

The encrypted vault sits in `chrome.storage.local`. The unlocked secret sits in `chrome.storage.session`, which lives in memory, is cleared when the browser closes, and cannot be read by pages or content scripts.

## Build and install

From the repository root:

```
npm run build:extension
```

Then in Chrome open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose `extension\dist`. After a rebuild, press the reload arrow on the extension's card.
