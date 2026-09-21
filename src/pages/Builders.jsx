// src/pages/Builders.jsx
//
// What we learned building on Thru, written down because nobody else has.
// A reference, not an essay: every fact is kept, each in one line.

const REPO = 'https://github.com/pgreyy/thruscan'

const PROGRAMS = [
  { name: 'thruswap', what: 'Constant-product AMM', file: 'programs/thruswap.c' },
  { name: 'thrupad', what: 'Bonding-curve launchpad', file: 'programs/thrupad2.c' },
  { name: 'thruwall', what: 'Wall and addressed messages', file: 'programs/thruwall2.c' },
  { name: 'thruwordle · thru2048 · thruid', what: 'Games and player names', file: 'programs/' },
  { name: 'thru_token.h', what: 'Token program ABI, recovered from CLI transactions', file: 'programs/thru_token.h' },
]

const FINDINGS = [
  ['Mark writable before resize', 'The other order fails at every size and looks like a size cap. The real cap is 16 MiB.'],
  ['Accounts sort by raw pubkey bytes', 'Not by string. 0 fee payer, 1 program, then read-write sorted, then read-only sorted.'],
  ['Programs can spend from token accounts they own', 'No signature or authorisation needed. This is what makes pools possible.'],
  ['Authorisation entries must name an owned account', 'Otherwise the runtime returns 0xBAD0A171, documented nowhere.'],
  ['A reverted invoke never returns', 'The callee’s error replaces the transaction’s.'],
  ['Programs are permanent per seed', 'Re-creating fails with 0x0504 and keeps the old binary. Upgrade, or use a new seed.'],
  ['Build flags are strict', '-std=c17 -Werror -Wall -Wextra -Wpedantic -Wconversion. __int128 needs __extension__ before the typedef.'],
  ['State units: u16, and a reservation', 'Max 65535, and asking for 65535 can fail outright. 60000 works. A 37 KB account used 10.'],
  ['getaccountinfo --json nests under account_info', 'Parsing the wrong key reports a failed deploy that succeeded.'],
  ['EOA create is signed raw', 'It carries its own domain tag. Use signWithDomain(msg.slice(16), key, pub, 5).'],
  ['Name service name field is 64 bytes', 'A 32-byte guess reverts with no error code. Owner is an account index, so a sponsor can register for someone else.'],
  ['New accounts hold no THRU', 'A fee above balance fails. Alphanet accepts fee 0; Thru’s faucet pays the fee payer.'],
  ['Owner is not indexed', 'accounts.list filters by data_size, not owner. No reverse lookup from an address.'],
  ['Pubkey has no toString()', 'It returns "[object Object]". Use toThruFmt().'],
]

export function BuildersPage() {
  return (
    <div className="wrap">
      <h1 className="h1">Building on Thru</h1>
      <p className="lede">C programs on RISC-V, deployed to alphanet. Source and build recipe in the repo.</p>

      <section className="card">
        <div className="card-head">
          <h2 className="h2">Programs</h2>
          <a className="fine" href={`${REPO}/blob/main/programs/README.md`} target="_blank" rel="noreferrer">
            Build recipe
          </a>
        </div>
        <div className="rows" style={{ marginTop: 12 }}>
          {PROGRAMS.map((p) => (
            <div className="row" key={p.name}>
              <span><b className="mono">{p.name}</b> <span className="fine">{p.what}</span></span>
              <a className="mono fine" href={`${REPO}/blob/main/${p.file}`} target="_blank" rel="noreferrer">source</a>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <details>
          <summary className="h2 move-summary">
            <span>Undocumented, confirmed on chain <span className="fine" style={{ fontWeight: 400 }}>{FINDINGS.length} findings</span></span>
          </summary>
        <div className="findings" style={{ marginTop: 12 }}>
          {FINDINGS.map(([title, body]) => (
            <div className="finding" key={title}>
              <b>{title}</b>
              <span className="fine">{body}</span>
            </div>
          ))}
        </div>
        </details>
      </section>
    </div>
  )
}
