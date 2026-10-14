#!/usr/bin/env bash
# Run the graduation simulation (sim.c) against betanet's current state.
#
#   bash programs/sim/run.sh        # from the repo root, in WSL or Linux
#
# Reads betanet (no transactions), compiles thrupad2.c and thruswap.c natively
# against the stand-in SDK in include/, and runs the four cases.

set -euo pipefail
SIM="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT="$( cd "$SIM/../.." && pwd )"
WORK="$( mktemp -d )"
trap 'rm -rf "$WORK"' EXIT

node "$ROOT/programs/sim/gen-state.mjs" "$WORK/state.h"

CFLAGS=( -std=gnu17 -O1 -g -Wall -Wextra -I"$SIM/include" -I"$ROOT/programs" -I"$WORK" )
gcc "${CFLAGS[@]}" -Dstart=pad_start  -c "$ROOT/programs/thrupad2.c" -o "$WORK/pad.o"
gcc "${CFLAGS[@]}" -Dstart=swap_start -c "$ROOT/programs/thruswap.c" -o "$WORK/swap.o"
gcc "${CFLAGS[@]}" -c "$SIM/sim.c" -o "$WORK/sim.o"
gcc "$WORK/pad.o" "$WORK/swap.o" "$WORK/sim.o" -o "$WORK/sim"
"$WORK/sim"
