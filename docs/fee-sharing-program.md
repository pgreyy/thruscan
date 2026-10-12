# Fee sharing with holders: proposed ThruPad program change

Status: **proposal, not built.** Update 02 (section 7b, artboard 5h) designs a way for a token's creator to share part of their creator fees with the token's holders. The website side is built and hidden behind `VITE_FEE_SHARING` (off unless set to `true`). Nothing in it can work until the program below exists, and the site must never hold creator funds or keys to fake it.

## What the program does today

`programs/thrupad2.c` (registry version 2) has six instructions: `INIT`, `LAUNCH`, `BUY`, `SELL`, `CLAIM`, `GRADUATE`. There is no fee split and no distribution.

- On every `BUY` and `SELL`, `fee_bps` of the trade is added to `launch_rec.creator_fees`. The tokens stay in the launch's quote vault.
- `CLAIM` pays **all** of `creator_fees` to a token account owned by the recorded `creator`, then sets it to zero.
- The launch record is a fixed 253 bytes inside the registry account (`LAUNCH_SZ`, asserted at compile time), so new per-launch state cannot be appended to it without a registry migration.

## The change

### 1. A per-launch `FeeShareConfig` account

A program-derived account per launch, seeded from the registry and the launch id, so the website and any crank can find it without an index.

| Field | Type | Meaning |
|---|---|---|
| `version` | u8 | 1 |
| `launch_id` | u16 | which launch |
| `bps` | u16 | holders' share of creator fees, 100–10,000 (1–100%) |
| `interval_secs` | u32 | 86,400 × (1–90) days |
| `min_holding` | u64 | minimum token balance (base units) to qualify |
| `last_distribution_ts` | i64 | block time of the last distribution, 0 before the first |
| `holder_bucket` | u64 | quote set aside for holders, not yet distributed |
| `distributed_total` | u64 | quote ever sent to holders ("Sent to holders" on the site) |
| `earned_total` | u64 | creator fees ever accrued, both buckets ("Earned, all time") |
| `ever_enabled` | u8 | 1 once sharing has been switched on, so the UI keeps showing history |

Keeping it outside the 253-byte launch record means no registry migration and no change to the record the site already decodes.

### 2. `SET_FEE_SHARE` (creator-signed)

- Accounts: registry (read), the launch's `FeeShareConfig` (read-write, created on first use and paid for by the creator), creator (signer, must equal `launch_rec.creator`).
- Args: `bps`, `interval_secs`, `min_holding`. `bps = 0` turns sharing off; anything already in `holder_bucket` is still distributed, never returned to the creator.
- Reverts unless `100 ≤ bps ≤ 10,000` (or 0) and `1 ≤ days ≤ 90`.
- A change applies from the next distribution, which matches the copy on the settings panel.

### 3. Split on accrual (`BUY` / `SELL`)

When a trade accrues a creator fee `f` and the launch has an enabled config:

```
holders = f * bps / 10_000
creator_fees    += f - holders
holder_bucket   += holders
earned_total    += f
```

Both buckets stay in the same quote vault, so no extra transfer happens on a trade. `CLAIM` is unchanged and can only ever take `creator_fees`, which is why the site can say "The holders' n% is set aside for the next distribution." `BUY` and `SELL` gain one optional read-write account (the config); a trade that omits it on a launch with sharing on must revert, otherwise a trader could route around the split.

### 4. `DISTRIBUTE` (permissionless crank)

- Callable by anyone once `now ≥ last_distribution_ts + interval_secs`.
- Accounts: registry, config, quote vault, the token's mint, then the holders' token accounts and their quote token accounts, in pairs.
- Snapshot: the program reads each listed token account's balance at execution time. The curve's token vault, any pool vault, and the creator's own accounts are always excluded, as are balances below `min_holding`.
- Pro rata: each qualifying holder gets `holder_bucket * balance / total_qualifying`, rounded down; dust stays in the bucket for next time.
- Thru transactions carry a limited number of accounts, so a large holder set needs paging: the first call records a snapshot id and the total qualifying balance in the config, later calls with the same id pay further pages, and the snapshot closes when every listed holder is paid or a timeout passes. The crank cannot choose who is excluded, only which page it submits; a holder left out of every page keeps their share in the bucket.
- On completion: `distributed_total += paid`, `holder_bucket -= paid`, `last_distribution_ts = now`.

The crank can be run by ThruScan, by the creator, or by anyone; it moves funds only from the vault to holders, by the program's own rules, so whoever runs it cannot redirect anything.

### 5. Reads the website needs

- "Next distribution": `last_distribution_ts + interval_secs`.
- "Set aside so far": `holder_bucket`.
- "Qualifying holders now": counted off chain from token accounts of the mint with balance ≥ `min_holding`, minus the excluded accounts.
- "Your next share (est.)": `holder_bucket * your_balance / total_qualifying`, labelled an estimate.
- Token header badge: shown while `bps > 0`.

## Wiring the site once this ships

1. Add the config decoder and the `SET_FEE_SHARE` builder to `src/lib/pad.js`, beside `buildClaimInstruction`.
2. In `src/components/FeeSharing.jsx`, load the config, prefill the panel from it, and enable **Save settings** to sign `SET_FEE_SHARE` through the standard tx flow (`useTxFlow` + `TxDialog`).
3. In the creator panel (`CreatorFees` in `src/pages/Dex.jsx`), read "Earned, all time" and "Sent to holders" from the config instead of the trade history, and show the "Sharing with holders: n% · interval — Edit" row on phones.
4. Add the non-creator rows ("Shared with holders", "Your next share (est.)") and the header badge.
5. Set `VITE_FEE_SHARING=true` for the build.

Nothing above should be deployed without its own review and a test on betanet first.
