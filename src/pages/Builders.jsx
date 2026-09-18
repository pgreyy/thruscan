// src/pages/Builders.jsx
//
// What we learned building on Thru, written down because nobody else has.
//
// This page used to be a step in the Guides rail, back when the front door to
// ThruScan was a list of things to do in a terminal. It is not a beginner's
// page and it should not sit next to "create a wallet": it is for the handful
// of people who want to ship a program on Thru, and every one of the facts
// below cost somebody an afternoon.

const REPO = 'https://github.com/pgreyy/thruscan'

const PROGRAMS = [
  {
    name: 'thruswap',
    what: 'A constant-product AMM. Pools, liquidity, LP tokens, swaps.',
    file: 'programs/thruswap.c',
    note: 'Reserves are read live from the vaults rather than cached in the pool record, so the curve can never price against a balance that is not there.',
  },
  {
    name: 'thrupad',
    what: 'A bonding-curve launchpad. Launch, buy, sell, creator fees, graduation.',
    file: 'programs/thrupad.c',
    note: 'The anti-snipe tax starts at 90% and decays to zero over 25 slots. It is paid to nobody and stays in the curve, so early buyers subsidise later ones rather than the deployer.',
  },
  {
    name: 'thru_token.h',
    what: "The token program's instruction ABI, as seen from inside a program.",
    file: 'programs/thru_token.h',
    note: 'Not published anywhere. Recovered by building transactions with the CLI, decoding their bytes, and confirming each layout against the state-proof size arithmetic.',
  },
  {
    name: 'thruwall, thruwordle, thru2048, thruid',
    what: 'The wall and the games. Smaller, and a better place to start reading.',
    file: 'programs/',
    note: 'thruwall.c carries the comment that explains the writable-before-resize trap, which is the single most expensive thing to discover by yourself.',
  },
]

const FINDINGS = [
  {
    title: 'Mark an account writable before you resize it',
    body: 'The other order fails at every size, and it fails in a way that looks exactly like a size cap, so the natural response is to try smaller numbers forever. There is no size cap worth worrying about: TSDK_ACCOUNT_DATA_SZ_MAX is 16 MiB.',
  },
  {
    title: 'Accounts are sorted by raw public key bytes, and every index refers to the sorted order',
    body: 'Not the order you passed them in. A string sort does not match either, because base64url orders differently from the bytes it encodes. Index 0 is the fee payer, 1 is the program, then read-write sorted, then read-only sorted. Building a payload by hand without sorting is a good way to send tokens somewhere unintended.',
  },
  {
    title: 'A program can own token accounts and spend from them',
    body: 'With no wallet signature and no authorisation descriptor. The program’s identity is already in the call frame. This is the fact that makes pools and curves possible at all, and it took a dedicated probe program to establish.',
  },
  {
    title: 'An authorisation entry may only name an account the calling program owns',
    body: 'Naming the program’s own account returns the runtime sentinel 0xBAD0A171, which appears in no documentation and no header.',
  },
  {
    title: 'A reverted call does not return',
    body: 'tsys_invoke does not come back when the callee reverts. The callee’s error code replaces the transaction’s, so a handler that expects to inspect a return value never runs.',
  },
  {
    title: 'Programs are permanent and bound to their seed',
    body: 'Running program create on a seed that has one fails with 0x0504 and leaves the old binary live, which is worse than failing loudly. Use program upgrade, or a fresh seed, and check the deployed size against your binary afterwards.',
  },
  {
    title: 'The build flags are stricter than most projects',
    body: '-std=c17 -Werror -Wall -Wextra -Wpedantic -Wstrict-aliasing=2 -Wconversion. In particular __int128 needs __extension__ before the typedef, not inside it.',
  },
  {
    title: 'State units are capped at 65535 per transaction',
    body: 'Anything larger is rejected as an invalid argument rather than clamped, which reads like a different problem entirely.',
  },
  {
    title: 'getaccountinfo --json returns its payload under account_info',
    body: 'Not under getAccountInfo.account. Parsing the wrong key produces a confident and completely wrong report that a deployment did not take.',
  },
  {
    title: 'The EOA create message is signed raw',
    body: 'It already carries its own 16-byte domain tag, so signing it through the generic message helper prepends a second one and the program rejects it with user error 5. The equivalent that needs no extra dependency is signWithDomain(message.slice(16), key, pub, EOA_CREATE).',
  },
  {
    title: 'The name service’s name field is 64 bytes',
    body: 'A 32-byte guess reverts with no user error code at all, which gives you nothing to work from. Registration also takes its owner as an account index rather than implying the fee payer, which is what allows a sponsor to register a name that somebody else owns.',
  },
  {
    title: 'A fresh account holds no native THRU, and a fee above your balance fails the transaction',
    body: 'It is not taken from somewhere else and it is not clamped. Alphanet accepts a fee of zero, which is the only reason a brand new key can do anything at all. Thru’s own faucet pays whoever pays the fee, so a wallet can claim for itself and stop depending on that.',
  },
]

export function BuildersPage() {
  return (
    <div className="wrap">
      <p className="eyebrow">Builders</p>
      <h1 className="h1">Building on Thru</h1>
      <p className="lede">
        Everything ThruScan runs on is a C program compiled to RISC-V and deployed to alphanet. The
        source is in the repo, and so is this list of things the documentation does not say. If you
        are shipping a program on Thru, the second half of this page will save you more time than
        the first.
      </p>

      <section className="card">
        <h2 className="h2">The programs</h2>
        <div className="rows" style={{ marginTop: 12 }}>
          {PROGRAMS.map((p) => (
            <div className="row" key={p.name} style={{ alignItems: 'flex-start' }}>
              <span style={{ maxWidth: '62%' }}>
                <b className="mono">{p.name}</b>
                <br />
                <span className="fine">{p.what}</span>
                <br />
                <span className="fine" style={{ opacity: 0.8 }}>{p.note}</span>
              </span>
              <a className="mono fine" href={`${REPO}/blob/main/${p.file}`} target="_blank" rel="noreferrer">
                {p.file}
              </a>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2 className="h2">How they get built</h2>
        <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
          The Windows toolchain does not work. Build in WSL2, where the SDK installs cleanly, and
          deploy from wherever your keys live. The full recipe, including the exact flags, is in the
          repo's programs README rather than repeated here, because a command that drifts out of
          date is worse than a link.
        </p>
        <p className="fine" style={{ marginTop: 12 }}>
          <a href={`${REPO}/blob/main/programs/README.md`} target="_blank" rel="noreferrer">
            programs/README.md
          </a>
        </p>
      </section>

      <section className="card">
        <h2 className="h2">Things that are true and not written down</h2>
        <p className="fine" style={{ marginTop: 10 }}>
          Every one of these was found the hard way, on chain, and then confirmed twice.
        </p>
        <div className="stack" style={{ marginTop: 16, gap: 18 }}>
          {FINDINGS.map((f) => (
            <div key={f.title}>
              <b>{f.title}</b>
              <p className="fine" style={{ marginTop: 6, lineHeight: 1.65 }}>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2 className="h2">If you are just starting</h2>
        <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>
          You do not need any of this to use ThruScan. Open a <a href="/wallet">wallet</a>, take
          some tUSD from the <a href="/faucet">faucet</a>, and <a href="/swap">trade</a> or{' '}
          <a href="/launch">launch something</a>. The terminal route still works and every trading
          page prints the command, but nothing here requires it any more.
        </p>
      </section>
    </div>
  )
}
