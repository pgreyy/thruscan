# ThruScan on-chain programs

The C half of ThruScan. These compile to RISC-V and run on ThruVM.

Building needs Linux or WSL2, because the Thru toolchain does not run on
Windows. From a WSL shell:

```bash
p=thruswap                      # or any program below
rm -rf ~/$p
cd ~ && thru dev init c $p
t=$(find ~/$p -name '*.c' -not -path '*/deps/*' | head -1)
cp programs/$p.c "$t"
cp programs/thru_token.h "$(dirname "$t")/"
cd "$(dirname "$(find ~/$p -name Makefile | head -1)")"
make -j
```

The SDK compiles with `-Wall -Wextra -Wpedantic -Werror -Wconversion`, which is
stricter than most projects. Anything relying on a compiler extension has to say
so explicitly; see the `__extension__` on the 128-bit typedef in `thruswap.c`.

## The programs

| file | what it is |
| --- | --- |
| `thru_token.h` | The token program's instruction ABI, recovered from live transactions. Shared by every program that touches tokens. |
| `thruwall.c` | A public message wall. Ring of fixed-size slots, oldest overwritten. |
| `thruwordle.c` | Scoreboard for a word game. Recomputes each result on chain rather than trusting the client. |
| `thru2048.c` | 2048 where every swipe is its own transaction and the chain does the sliding and merging. |
| `thruid.c` | Username registry, so a name means the same thing across every game. |
| `thrucpi.c` | A probe, not a product. Established that a program can hold and spend tokens. Kept because it is the cheapest way to re-test that assumption after a network reset. |
| `thruswap.c` | Constant-product AMM. Pools, liquidity, swaps, 30 basis points to liquidity providers. |
| `thrupad2.c` | Bonding-curve launchpad. Fixed supply, each launch priced in tUSD or WTHRU, creator fee, graduation. The live version. |
| `thruwall2.c` | The wall, version 2: posts signed by the sender, optionally addressed to another account. The live version; `thruwall.c` is the original. |

## What was learned the hard way

Undocumented behaviour, each of which cost real debugging time.

**The token program's instruction encoding is not published anywhere.** It was
recovered by issuing each instruction from the CLI with deliberately
distinctive arguments and reading the bytes back off the chain. The layouts and
the method are documented at the top of `thru_token.h`. Opcodes: `0x00`
initialize_mint, `0x01` initialize_account, `0x02` transfer, `0x03` mint_to,
`0x04` burn.

**Accounts are sorted ascending by raw public key bytes, and instruction
indices refer to that sorted order**, not the order they are passed on the
command line. A program with a single read-write account can assume index 2. A
program with several cannot assume anything, which is why every `thruswap`
instruction carries its indices as parameters and validates each one against
the pubkey recorded in the pool.

**Mark an account writable BEFORE resizing it.** The other order fails at every
size, and the failure looks exactly like an account size limit. There is no
such limit worth worrying about: `TSDK_ACCOUNT_DATA_SZ_MAX` is 16 MiB, and
state units are 4 KB pages.

**A program can own token accounts and spend from them** with no wallet
signature and no invoke authorization descriptor. Its identity is already in
the call frame. An auth descriptor may only name accounts the calling program
owns, so naming the program's own account returns the runtime sentinel
`0xBAD0A171`. This is what makes AMM pools possible.

**When a callee reverts, its error code propagates up and replaces the
transaction's.** `tsys_invoke` does not return on a callee revert, so wrapping
its result in your own error codes achieves nothing.

**Programs are permanent and bound to their seed.** `thru program create` on a
seed that already holds a program fails with "Account not available error in
meta account" and leaves the old binary live, which then reads downstream as a
code bug. Use `thru program upgrade` to replace code at an existing address, or
a fresh seed during iteration.

**`getaccountinfo --json` returns its payload under `account_info`.** Guessing
any other shape silently reads nothing.

## Error codes

Programs revert with their own codes, which surface as `user_error` in a
transaction lookup. Each program defines its `ERR_` list at the top of its
file. `thruswap` additionally reports a failed resize as `0x8000 | rc`, so the
syscall's own return value is visible rather than flattened into a shared code.
