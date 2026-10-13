# Changelog

## Update 03

- **Footer: desktop only.** Below 1024px the site footer is hidden and the bottom tab bar replaces it; the body keeps its tab-bar padding, and ThruScan Wallet (`/get-wallet`) stays in the phone drawer.
- **Explorer, Blocks & transactions:** three stat boxes in one row (Finalized block, Block time, Transactions / sec). The ThruPad boxes (Tokens launched, Trades in the last 24 h, WTHRU held in curves) and the data that fed them are gone.
- **Explorer, Activity:** no description line and no "reading from the chain" warning; the live "Updated … · refreshes every 10 s" indicator sits at the right of the filter chips (under them on phones). Retired 2048 events ("Moved in 2048", "Set a leaderboard name" and the rest) are filtered out of every activity list.
- **No network badge.** The "● TEST ▾" badge, its menu and its phone sheet are removed; the logo stands alone. "Show test network notice" moved to the bottom of the More menu and into the phone drawer above Theme. The dismissible test-network strip is unchanged.
- **ThruPad home:** Recent activity and its polling are removed and the token list spans the full width; on phones there is no Create button under the title (the tab bar's Launch covers it).
- **Tab bar:** Home · Launch · Trade · Explorer · Assets, with "Explore" renamed "Explorer".

## Update 02 (website, and ThruScan Wallet 0.5.1)

- **Header and navigation.** The desktop bar is a three-column grid with the search in the true centre; the nav reads ThruPad · Swap · Explorer · More, and More holds Collections · ThruID · Faucet · ThruScan Wallet · Wordle. The network menu loses the "not available" line and "How ThruScan works"; the network name everywhere comes from the network config.
- **Notifications.** A bell in the desktop bar and the phone bar, with an unread badge. It lists the wallet's own transactions (from the tx flow), wall messages to it, tokens it received and creator fees ready to claim, kept per network and address in localStorage, with filters, "Mark all read" and a full-screen sheet on phones.
- **Phone tab bar.** Home · Explore · Trade (raised) · Launch · Assets below 1024px, hidden while a sheet, a modal or the keyboard is open; the token page's Buy/Sell bar sits above it.
- **ThruPad home.** No lead paragraph and no stats row. New Trending carousel (top 10 by 24 h trades, then 24 h volume) and list tabs Market cap · New · Active · Near graduation · Graduated, with a market cap column.
- **Explorer.** `/explorer` now holds three tabs: Blocks & transactions (six stat boxes, latest blocks and transactions), Activity (the feed, with a Wall chip and `?address=`), and Wall (composer beside the list; filters, Reply, clamped messages, a Write sheet on phones). `/activity` and `/wall` redirect there. The "temporary explorer" warning and the Overview tab are gone.
- **Status and trade colours.** Tinted Success/Failed pills and Buy/Sell/Launch event pills across the Explorer, the tx page, trades, profile activity and the home feed; green "+" and red "−" amounts. Buy and Sell are green and red on the trade panel, its CTA and the phone's sticky bar.
- **Creator fees.** A "Creator fees" panel on the token page for the creator, with a Claim button that runs the ThruPad claim through the standard tx flow; read-only rows for everyone else; unclaimed fees on the profile's Launched tab.
- **Fee sharing with holders (7b): hidden.** `thrupad2` has no fee split or distribution, so the settings UI is built behind `VITE_FEE_SHARING` (off) and the program change is proposed in `docs/fee-sharing-program.md`. No program was changed.
- **Assets (`/profile`).** Tabs Tokens · Items · Launched · Activity (no Overview), an estimated value in WTHRU, and Send · Receive · Swap using the existing wallet send code. Other wallets' account pages get "Write on Wall".
- **Footer.** The symbol, "Launch, swap and track tokens on Thru." and one link, ThruScan Wallet.
- **Removed.** Archives, Guides, Community, Projects, Builders, Updates, the moderation page and 2048 (old addresses land on ThruPad; Wordle keeps `/games`), every CLI and terminal instruction, the faucet's CLI route, and the "Mint a Pixel Pal" links on the profile.
- **ThruScan Wallet 0.5.1.** The popup is restyled to the wallet's own layout: dark by default with a light theme, Wallet · Activity · Settings tabs, a 3-step setup with a strength meter and a press-and-hold recovery phrase, an estimated value and Send/Receive/Swap/Faucet tiles (Swap and Faucet open ThruScan), day-grouped activity, a QR card with the mark, and approval screens where an unreadable transaction makes Reject the primary action. Keys, storage and messaging are unchanged.
