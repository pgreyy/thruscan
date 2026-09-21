# ThruScan

A community explorer and app suite for [Thru](https://thru.org) alphanet. Live at **[thruscan.vercel.app](https://thruscan.vercel.app)**.

Everything on the site is read from the chain or written to it. There is no database of balances, trades or names: when ThruScan shows something, it read it from Thru a moment ago.

Not affiliated with Unto Labs. Alphanet tokens have no value, and every balance disappears when the network resets.

## What's on it

| Page | What it does |
| --- | --- |
| **Explorer** | Search any address, transaction or `.id` name. Live chain stats, latest blocks and transactions, and a page for every transaction and account. |
| **Wall** | Public messages stored on chain, signed by whoever sent them, optionally addressed to someone. |
| **Wallet** | A browser wallet. The key is made and encrypted in the browser and never sent anywhere. Balances, activity with amounts, backup phrase, and moving everything to another wallet. |
| **Swap** | Constant-product pools: swap, add and remove liquidity. |
| **Launchpad** | Launch a fixed-supply token on a bonding curve, trade it, and see its price history. |
| **Faucet** | Test tUSD from ThruScan and THRU from Thru's own faucet. |
| **Names** | Free `.id` names on Thru's name service, with records such as `x`, `url` and `avatar`. |
| **Games** | Wordle and 2048, with scores recorded on chain. |
| **Builders** | The programs behind all of this, and what building on Thru taught us. |

Plus **ThruScan Wallet**, a Chrome extension wallet in [`extension/`](extension/README.md): self-custody, 12 words or a private key, and a `window.thru` provider so any Thru app can connect to it.

## How it fits together

```
browser (React + Vite)
   │
   ├── /api/rpc      reads: accounts, transactions, history, blocks, events
   ├── /api/wallet   writes ThruScan pays for: creating wallets, opening
   │                 token accounts, the faucet, names, launch accounts
   └── wallet in the browser signs everything the user does themselves:
                     swaps, buys, sells, launches, records, transfers
   │
Thru alphanet (rpc.alphanet.thru.org)
   └── ThruScan's own C programs: thruswap, thrupad2, thruwall2,
       thruwordle, thru2048, thruid (source in programs/)
```

The browser never talks to the Thru node directly, because the node sends no CORS headers. The serverless functions in `api/` do that for it.

A Thru transaction carries exactly one signature, the fee payer's. So ThruScan can pay for things like opening a token account, but it can never move a user's tokens: anything that spends has to be signed by the user's own key in their browser.

## Running it locally

Needs Node 20 or newer.

```
npm install
npm run dev
```

The pages load, but anything that reads the chain needs the `api/` functions, which run on Vercel. Use `vercel dev` (Vercel CLI) to run those locally as well.

### Environment variables (Vercel)

| Name | Used by | What |
| --- | --- | --- |
| `THRU_SPONSOR_PUBKEY` | `api/wallet.js` | The account that pays for sponsored transactions |
| `THRU_SPONSOR_PRIVKEY` | `api/wallet.js` | Its private key, hex. Never commit this. |
| `THRU_PAD_PROGRAM` | `api/wallet.js` | The launchpad program, if not the default |
| `THRU_RPC_URL` | `api/rpc.js` | Optional: override the Thru node address |
| `VITE_*` | `src/lib/addresses.js` | Optional: override program and account addresses after a redeploy |

Program and account addresses have working defaults in `src/lib/addresses.js`. After an alphanet reset they change, and that file is where to update them.

## Repository layout

```
src/pages/       one file per page (Dex.jsx holds Swap, Launchpad and Faucet)
src/components/  shared pieces: wallet pill, tabs, activity list, dialogs
src/lib/         chain decoders and builders: wallet, swap, pad, names, wall, activity
api/             serverless functions (rpc.js, wallet.js, and the smaller ones)
programs/        the on-chain C programs, with a build recipe in programs/README.md
extension/       ThruScan Wallet, the Chrome extension (npm run build:extension)
tools/           diagnostic scripts used while building
```

## Building the programs

See [`programs/README.md`](programs/README.md). Short version: the Thru toolchain runs on Linux or WSL2, not Windows.
