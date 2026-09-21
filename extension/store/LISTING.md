# Chrome Web Store listing: ThruScan Wallet

Everything to paste into the Chrome Web Store developer dashboard.

## Package
Upload `thruscan-wallet-<version>.zip` (the contents of `extension/dist`, zipped).

## Store listing tab
**Name:** ThruScan Wallet

**Summary (132 max):**
Self-custody wallet for the Thru network. Hold THRU and tokens, send and receive, and connect to Thru apps.

**Description:**
ThruScan Wallet is a self-custody wallet for Thru.

Your keys stay yours
- Create a wallet with 12 recovery words, or import one with 12 words or a private key
- Keys are encrypted with your password and kept only in this browser
- Nobody else holds them: not ThruScan, not anyone

Everything in one place
- THRU balance and every token you hold
- Send to an address or a .id name, with your balance and Max shown
- Receive with a QR code
- Claim test THRU from Thru's alphanet faucet
- Full activity, each item linked to its transaction on ThruScan

Connect to Thru apps
- Apps connect through window.thru, the same request format as Thru's own wallet SDK
- Every connection and every transaction asks you first, showing the site, the program and what it does
- See and disconnect connected sites at any time

Security
- Locks itself after a set number of idle minutes
- Your recovery words and key are only shown after entering your password again
- No analytics, no tracking, no ThruScan server

Thru alphanet is a test network. Its tokens have no value.

**Category:** Productivity (or Tools)
**Language:** English
**Icon:** 128x128 is inside the zip (icons/icon128.png)
**Screenshots:** store-1-wallet.png, store-2-apps.png, store-3-custody.png (1280x800)
**Small promo tile:** promo-440x280.png
**Homepage URL:** https://thruscan.vercel.app
**Support URL:** https://github.com/pgreyy/thruscan/issues

## Privacy practices tab
**Single purpose:**
A self-custody cryptocurrency wallet for the Thru network: holds the user's keys, shows balances, and signs transactions the user approves, including requests from Thru websites the user connects.

**Permission justifications:**
- `storage`: keeps the password-encrypted wallet, settings and the list of connected sites on the device.
- `alarms`: locks the wallet automatically after the idle time the user sets.
- Host permission `https://rpc.alphanet.thru.org/*`: reads balances and sends the user's approved transactions to the Thru network node.
- Content scripts on all https sites (and localhost): adds `window.thru` so any Thru app can ask to connect, the same way other wallets work. It does nothing on a page until that page asks, and nothing is signed or shared without the user approving it in the wallet window.

**Remote code:** No, I am not using remote code. All code is in the package.

**Data usage:** tick none of the categories. The wallet collects no user data; keys and settings stay on the device. Then tick the three certifications (no selling, no unrelated use, no creditworthiness use).

**Privacy policy URL:** https://thruscan.vercel.app/wallet-privacy.html

## Distribution tab
Visibility: Public. Regions: all.
