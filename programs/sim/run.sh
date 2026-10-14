#!/usr/bin/env bash
# Run a simulation against betanet's current state.
#
#   bash programs/sim/run.sh             # sim_fees.c: pool creator fees
#   bash programs/sim/run.sh sim         # sim.c: graduation (needs launches
#                                        # still live on the curve; GIL and
#                                        # BNPROOF have since graduated)
#
# Reads betanet (no transactions), compiles thrupad2.c and thruswap.c natively
# against the stand-in SDK in include/ and the stand-in VM in vm.h, and runs.

set -euo pipefail
SIM="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT="$( cd "$SIM/../.." && pwd )"
WHICH="${1:-sim_fees}"
WORK="$( mktemp -d )"
trap 'rm -rf "$WORK"' EXIT

node "$ROOT/programs/sim/gen-state.mjs" "$WORK/state.h"

CFLAGS=( -std=gnu17 -O1 -g -Wall -Wextra -I"$SIM/include" -I"$SIM" -I"$ROOT/programs" -I"$WORK" )
gcc "${CFLAGS[@]}" -Dstart=pad_start  -c "$ROOT/programs/thrupad2.c" -o "$WORK/pad.o"
gcc "${CFLAGS[@]}" -Dstart=swap_start -c "$ROOT/programs/thruswap.c" -o "$WORK/swap.o"
gcc "${CFLAGS[@]}" -c "$SIM/$WHICH.c" -o "$WORK/main.o"
gcc "$WORK/pad.o" "$WORK/swap.o" "$WORK/main.o" -o "$WORK/sim"
"$WORK/sim"
