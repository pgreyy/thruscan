#!/usr/bin/env bash
# Build the on-chain C programs into bin/*.bin.
#
# Run this from a Linux or WSL2 shell (the RISC-V toolchain does not run on
# Windows). It does NOT use `thru dev init` / `thru dev toolchain install`,
# because those download from GitHub releases and are not always reachable.
# Instead it drives the SDK's own make-based build system directly, with
# Ubuntu's riscv64-unknown-elf gcc and picolibc, which is how the deployed
# binaries were built.
#
#   cd programs
#   THRU_C_SDK_DIR=/path/to/thru-sdk ./build.sh              # all three
#   THRU_C_SDK_DIR=/path/to/thru-sdk ./build.sh thrupad2     # just one
#
# Output goes to bin/<program>.bin: a raw image (objcopy -O binary) made of the
# 8-byte header from the SDK's config/link.ld followed by .text/.rodata. That is
# the exact format the deploy path validates, so do not post-process it.
#
# What you need, and where each thing comes from:
#
#   THRU_C_SDK_DIR   the Thru C SDK checkout, i.e. the directory that contains
#                    thru_c_program.mk, config/ and c/. In a clone of
#                    github.com/Unto-Labs/thru (tag v0.4.0 built these) that is
#                    sdks/c/thru-sdk. Default below, override with the env var.
#
#   the toolchain    sudo apt install gcc-riscv64-unknown-elf \
#                                     picolibc-riscv64-unknown-elf
#                    RISCV_TOOLCHAIN_ROOT and RISCV_SYSROOT below point the
#                    SDK's config/extra/with-gcc.mk at those system packages
#                    instead of at a ./.thru/sdk/toolchain it would otherwise
#                    hunt for up the directory tree.

set -euo pipefail

HERE="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# --- SDK ---------------------------------------------------------------------

: "${THRU_C_SDK_DIR:=$HOME/thru/sdks/c/thru-sdk}"

if [[ ! -f "$THRU_C_SDK_DIR/thru_c_program.mk" ]]; then
  cat >&2 <<EOF
build.sh: no Thru C SDK at
    $THRU_C_SDK_DIR

That directory must contain thru_c_program.mk, config/ and c/. Get it with:

    git clone https://github.com/Unto-Labs/thru ~/thru
    cd ~/thru && git checkout v0.4.0

then re-run with:

    THRU_C_SDK_DIR=~/thru/sdks/c/thru-sdk ./build.sh
EOF
  exit 1
fi
THRU_C_SDK_DIR="$( cd "$THRU_C_SDK_DIR" && pwd )"

# The programs say #include <thru-sdk/c/tn_sdk.h>, so the SDK's PARENT has to be
# on the include path for "thru-sdk/..." to resolve.
SDK_PARENT="$( dirname "$THRU_C_SDK_DIR" )"

# --- toolchain ---------------------------------------------------------------

: "${RISCV_TOOLCHAIN_ROOT:=/usr}"
: "${RISCV_SYSROOT:=/usr/lib/picolibc/riscv64-unknown-elf}"

if ! command -v riscv64-unknown-elf-gcc >/dev/null 2>&1; then
  echo "build.sh: riscv64-unknown-elf-gcc not found." >&2
  echo "          sudo apt install gcc-riscv64-unknown-elf picolibc-riscv64-unknown-elf" >&2
  exit 1
fi
if [[ ! -d "$RISCV_SYSROOT/include" ]]; then
  echo "build.sh: no picolibc sysroot at $RISCV_SYSROOT" >&2
  echo "          sudo apt install picolibc-riscv64-unknown-elf" >&2
  echo "          (or set RISCV_SYSROOT / RISCV_TOOLCHAIN_ROOT for a different install)" >&2
  exit 1
fi

# --- which programs ----------------------------------------------------------

PROGRAMS=( "$@" )
if [[ ${#PROGRAMS[@]} -eq 0 ]]; then
  PROGRAMS=( thrupad2 thrupals thruswap )
fi
for p in "${PROGRAMS[@]}"; do
  [[ -f "$HERE/$p.c" ]] || { echo "build.sh: no such program: $HERE/$p.c" >&2; exit 1; }
done

# --- scratch build tree ------------------------------------------------------
#
# The SDK's make rules build in the current directory, so give them their own
# tree rather than scattering build/ and .o files through programs/.

WORK="$( mktemp -d )"
trap 'rm -rf "$WORK"' EXIT

cp "$HERE"/*.c "$HERE"/*.h "$WORK/"

echo 'include $(THRU_C_SDK_DIR)/thru_c_program.mk' > "$WORK/Makefile"

{
  # The SDK library, built from the SDK's own sources. This mirrors
  # $THRU_C_SDK_DIR/c/Local.mk but leaves out tn_crypto (it #includes <blst.h>,
  # which the SDK only ships when blst is installed, and none of our programs
  # call it) and tn_rle (also unused here). Both are separate archive members,
  # so omitting them cannot change the bytes of a program that never referenced
  # them -- see "verifying" at the bottom of this file. THRU_C_SKIP_SDK_LOCAL_MK
  # below is what stops the SDK's own Local.mk from adding them back.
  echo 'MKPATH:=$(THRU_C_SDK_DIR)/c/'
  echo '$(call make-lib,tn_sdk)'
  for o in tn_sdk tn_sdk_syscall tn_sdk_sha256 tn_sdk_blake3; do
    echo "\$(call add-objs,$o,tn_sdk)"
  done
  echo '$(call add-asms,entrypoint,tn_sdk)'
  echo 'MKPATH:='
  # One .bin per program: make-bin links the .elf and objcopies it to raw.
  for p in "${PROGRAMS[@]}"; do
    echo "\$(call make-bin,$p,$p,tn_sdk,)"
  done
} > "$WORK/Local.mk"

# --- build -------------------------------------------------------------------

make -C "$WORK" -j"$(nproc)" \
  THRU_C_SDK_DIR="$THRU_C_SDK_DIR" \
  THRU_C_SKIP_SDK_LOCAL_MK=1 \
  RISCV_TOOLCHAIN_ROOT="$RISCV_TOOLCHAIN_ROOT" \
  RISCV_SYSROOT="$RISCV_SYSROOT" \
  EXTRA_CPPFLAGS="-I$SDK_PARENT" \
  bin

# --- install -----------------------------------------------------------------

mkdir -p "$HERE/bin"
for p in "${PROGRAMS[@]}"; do
  out="$WORK/build/thruvm/bin/$p.bin"
  [[ -s "$out" ]] || { echo "build.sh: $p produced no binary" >&2; exit 1; }
  # Sanity: every image starts with link.ld's 8-byte header.
  hdr="$( head -c 8 "$out" | od -An -tx1 | tr -d ' \n' )"
  [[ "$hdr" == "0100000000000000" ]] || {
    echo "build.sh: $p.bin has header $hdr, expected 0100000000000000" >&2
    echo "          refusing to install; the deploy path validates this image" >&2
    exit 1
  }
  install -m 644 "$out" "$HERE/bin/$p.bin"
  printf '  %-10s %6d bytes  %s\n' "$p" "$( stat -c%s "$HERE/bin/$p.bin" )" \
    "$( sha256sum "$HERE/bin/$p.bin" | cut -c1-16 )"
done

echo "Wrote $HERE/bin/{$( IFS=,; echo "${PROGRAMS[*]}" )}.bin"

# --- verifying ---------------------------------------------------------------
#
# Two checks worth re-running whenever this script or the toolchain changes.
#
# 1. The token program's address must appear verbatim in any program that calls
#    it. The Sept 2026 outage was exactly this: thru_token.h was fixed to take
#    the address from the SDK's TSDK_TOKEN_PROGRAM_ADDR_BYTES, the binaries were
#    never rebuilt, and every launch reverted with ERR_TOKEN_PROG. Against the
#    old placeholder (31 zero bytes then 0xaa) gcc folded the comparison into a
#    test for zero and emitted no constant at all, so its absence is a reliable
#    tell that a stale binary is installed:
#
#      grep -c $'\x4c\xe2\x84\x34\xa4\x60\x72\x5d\xef\x3b\x4c\x95\x85\xfb\x40\x4c' bin/thrupad2.bin
#
#    (that is the first 16 bytes of taTOKENKRgcl3vO0yVhftATDbXuhgWcfaaxv9xpEEdMdUE;
#    it must be 1, not 0.)
#
# 2. This script reproduces the previously deployed binaries bit for bit. Check
#    out an older commit's programs/ into a scratch dir, build it there, and cmp
#    against that commit's bin/*.bin. Commit 0e98bf5 reproduces byte-identically
#    with the toolchain above, which is what established that leaving tn_crypto
#    out of libtn_sdk changes nothing.
