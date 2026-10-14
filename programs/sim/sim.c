/* sim.c - runs the real thrupad2.c and thruswap.c, compiled natively, against
 * betanet's current state, for the four graduation cases:
 *
 *   1. normal graduation (GIL, then BNPROOF, which has creator fees owed)
 *   2. graduation called too early: must revert and change nothing
 *   3. graduation called twice: the second must revert and change nothing
 *   4. trades in the first block after the pool opens, including a round trip
 *      across the curve and the pool, which must lose money
 *
 * What is modelled, and how faithfully:
 *
 *   - Accounts are the transaction's account list. Account data starts as the
 *     bytes betanet holds now (state.h, from gen-state.mjs); the pool vaults
 *     and LP mints a keeper would open beforehand are made here, empty.
 *   - A frame is a program running. tsdk_revert unwinds the frame and restores
 *     every account to how it was when the frame started, as the VM does; a
 *     revert in a callee becomes the caller's callee error code.
 *   - The token program is modelled from what thru_token.h records about it:
 *     TRANSFER moves only from an account whose owner is the fee payer or the
 *     program that made the call; MINT_TO needs the mint's authority, the same
 *     way. That is the behaviour thrupad's SELL and CLAIM rely on today.
 *   - Writes are checked after the fact: an account whose bytes changed must be
 *     a token account (written by the token model) or one the running program
 *     owns and marked writable. Anything else fails the run.
 *
 * What is NOT modelled: compute, state and memory units, the real VM's memory
 * protection, and whether betanet's runtime allows thrupad to invoke thruswap
 * at all. Those need a real transaction.
 */

#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "thru-sdk/c/tn_sdk.h"
#include "thru-sdk/c/tn_sdk_syscall.h"
#include "state.h"

#include "vm.h"

/* ----------------------------------------------------------------- layout */

#define PAD_HDR 77
#define PAD_REC 253
#define SWAP_HDR 37
#define SWAP_REC 179

static uchar * launch( ushort id ) { return acc[ 2 ].data + PAD_HDR + (ulong)id * PAD_REC; }
static ulong rd64( uchar const * p ) { ulong v; memcpy( &v, p, 8 ); return v; }

/* The pad record, from thrupad2.c: state@0 ... quote_mint@0xad vq@0xcd vt@0xd5
   creator_fees@0xdd tokens_sold@0xe5 trade_count@0xed start_slot@0xf5. */
#define L_STATE 0x00
#define L_VQ    0xcd
#define L_VT    0xd5
#define L_FEES  0xdd
#define L_START 0xf5

/* ---------------------------------------------------------------- the txn */

typedef struct {
  ushort tok_vault, quote_vault, mint, quote_mint, pool_tok, pool_quote, lp, id;
} launch_accts_t;

static ushort A_PAYER, A_PAD, A_PREG, A_SREG, A_TOKEN, A_SWAP, A_TRADER, A_TR_TOK, A_TR_QUOTE;
static launch_accts_t gil, bnp, gil2;

static void
setup( void ) {
  nacc = 0; illegal = 0;
  uchar k[ 32 ], zero[ 32 ];
  memset( zero, 0, 32 );
  fake_key( k, 0x01 ); A_PAYER = add( k, zero, NULL, 0, 1 );
  A_PAD   = add( K_PAD_PROGRAM, zero, NULL, 0, 0 );
  A_PREG  = add( K_PAD_REGISTRY,  K_PAD_PROGRAM,  D_PAD_REGISTRY,  sizeof( D_PAD_REGISTRY ),  1 );
  A_SREG  = add( K_SWAP_REGISTRY, K_SWAP_PROGRAM, D_SWAP_REGISTRY, sizeof( D_SWAP_REGISTRY ), 1 );
  A_TOKEN = add( token_key, zero, NULL, 0, 0 );
  A_SWAP  = add( K_SWAP_PROGRAM, zero, NULL, 0, 0 );

#define LAUNCH_ACCTS( L, SYM, TAG ) do { \
    L.id          = SYM##_ID; \
    L.tok_vault   = add( K_##SYM##_TOKEN_VAULT, token_key, D_##SYM##_TOKEN_VAULT, sizeof( D_##SYM##_TOKEN_VAULT ), 1 ); \
    L.quote_vault = add( K_##SYM##_QUOTE_VAULT, token_key, D_##SYM##_QUOTE_VAULT, sizeof( D_##SYM##_QUOTE_VAULT ), 1 ); \
    L.mint        = add( K_##SYM##_MINT, token_key, D_##SYM##_MINT, sizeof( D_##SYM##_MINT ), 0 ); \
    L.quote_mint  = add( K_##SYM##_QUOTE_MINT, token_key, D_##SYM##_QUOTE_MINT, sizeof( D_##SYM##_QUOTE_MINT ), 0 ); \
    L.pool_tok    = add_token_acct( TAG,     K_##SYM##_MINT,       K_SWAP_PROGRAM, 0 ); \
    L.pool_quote  = add_token_acct( TAG + 1, K_##SYM##_QUOTE_MINT, K_SWAP_PROGRAM, 0 ); \
    L.lp          = add_lp_mint( TAG + 2, K_SWAP_PROGRAM ); \
  } while( 0 )

  LAUNCH_ACCTS( gil, GIL, 0x40 );
  LAUNCH_ACCTS( bnp, BNPROOF, 0x50 );
  /* A second, fresh pool set for GIL: what a second graduation would use. */
  gil2 = gil;
  gil2.pool_tok   = add_token_acct( 0x60, K_GIL_MINT,       K_SWAP_PROGRAM, 0 );
  gil2.pool_quote = add_token_acct( 0x61, K_GIL_QUOTE_MINT, K_SWAP_PROGRAM, 0 );
  gil2.lp         = add_lp_mint( 0x62, K_SWAP_PROGRAM );

  fake_key( k, 0x70 ); A_TRADER = add( k, zero, NULL, 0, 1 );
  A_TR_TOK   = add_token_acct( 0x71, K_GIL_MINT,       acc[ A_TRADER ].key.key, 0 );
  A_TR_QUOTE = add_token_acct( 0x72, K_GIL_QUOTE_MINT, acc[ A_TRADER ].key.key, 1000000UL );

  /* Well past the anti-snipe window of every launch, as on betanet now. */
  ctx.slot = rd64( launch( gil.id ) + L_START ) + rd64( launch( bnp.id ) + L_START ) + 1000UL;
}

static ushort next_pool_id( void ) { uint n; memcpy( &n, acc[ A_SREG ].data + 1, 4 ); return (ushort)n; }

static ulong
graduate( launch_accts_t const * L, ushort pool_id, ulong min_seed_quote ) {
  uchar ix[ 37 ]; ulong o = 0;
#define P16( v ) do { ushort t_ = (ushort)(v); memcpy( ix + o, &t_, 2 ); o += 2; } while( 0 )
  ix[ o++ ] = 0x05;
  P16( A_TOKEN ); P16( A_PREG ); P16( L->id ); P16( L->tok_vault ); P16( L->quote_vault );
  P16( L->mint ); P16( L->quote_mint ); P16( A_SWAP ); P16( A_SREG ); P16( pool_id );
  P16( L->pool_tok ); P16( L->pool_quote ); P16( L->lp );
  memcpy( ix + o, &min_seed_quote, 8 ); o += 8;
  return txn( A_PAYER, A_PAD, ix, o );
}

static ulong
pad_trade( uchar op, launch_accts_t const * L, ulong amount_in, ulong min_out ) {
  uchar ix[ 31 ]; ulong o = 0;
  ix[ o++ ] = op;
  P16( A_TOKEN ); P16( A_PREG ); P16( L->id ); P16( L->tok_vault ); P16( L->quote_vault );
  P16( A_TR_TOK ); P16( A_TR_QUOTE );
  memcpy( ix + o, &amount_in, 8 ); o += 8; memcpy( ix + o, &min_out, 8 ); o += 8;
  return txn( A_TRADER, A_PAD, ix, o );
}

static ulong
pool_swap( ushort pool_id, ushort vin, ushort vout, ushort uin, ushort uout, ulong amount_in, ulong min_out ) {
  uchar ix[ 35 ]; ulong o = 0;
  ix[ o++ ] = 0x04;
  P16( A_TOKEN ); P16( A_SREG ); P16( pool_id ); P16( vin ); P16( vout ); P16( uin ); P16( uout ); P16( 0 ); P16( 0 );
  memcpy( ix + o, &amount_in, 8 ); o += 8; memcpy( ix + o, &min_out, 8 ); o += 8;
  return txn( A_TRADER, A_SWAP, ix, o );
}

/* The seed, recomputed here independently of thrupad2.c. */
static void
expect_seed( launch_accts_t const * L, ulong * q, ulong * t ) {
  uchar const * r = launch( L->id );
  ulong vq = rd64( r + L_VQ ), vt = rd64( r + L_VT ), fees = rd64( r + L_FEES );
  ulong Q = bal( L->quote_vault ) - fees, T = bal( L->tok_vault );
  if( (u128)Q * vt <= (u128)vq * T ) { *q = Q; *t = (ulong)( (u128)Q * vt / vq ); }
  else                               { *t = T; *q = (ulong)( (u128)T * vq / vt ); }
}

static ulong isqrt( u128 n ) { u128 x = n, y = ( x + 1 ) / 2; while( y < x ) { x = y; y = ( x + n / x ) / 2; } return (ulong)x; }

static int fails;
#define CHECK( cond, ... ) do { if( cond ) printf( "  ok    " __VA_ARGS__ ); else { printf( "  FAIL  " __VA_ARGS__ ); fails++; } printf( "\n" ); } while( 0 )

static acct_t whole[ ACC_MAX ];
static void save_all( void ) { memcpy( whole, acc, sizeof( acct_t ) * nacc ); }
static int  unchanged( void ) {
  for( ushort i=0; i<nacc; i++ ) if( memcmp( whole[ i ].data, acc[ i ].data, DATA_MAX ) ) return 0;
  return 1;
}

/* ------------------------------------------------------------------ cases */

static void
case_normal( launch_accts_t const * L, char const * name ) {
  ulong q, t; expect_seed( L, &q, &t );
  uchar const * r = launch( L->id );
  ulong vq = rd64( r + L_VQ ), vt = rd64( r + L_VT ), fees = rd64( r + L_FEES );
  ulong quote_before = bal( L->quote_vault ), tok_before = bal( L->tok_vault );
  ushort pid = next_pool_id();
  printf( "%s: raised %lu (vault %lu - fees %lu), curve vq %lu vt %lu; expect seed %lu quote + %lu tokens into pool %u\n",
          name, quote_before - fees, quote_before, fees, vq, vt, q, t, pid );

  ulong rc = graduate( L, pid, q - q / 100UL );
  CHECK( rc == 0, "graduation succeeded (rc %lu)", rc );
  CHECK( r[ L_STATE ] == 3, "launch state is POOLED (3), got %u", r[ L_STATE ] );
  CHECK( rd64( r + L_START ) == pid, "launch record names pool %lu", rd64( r + L_START ) );
  CHECK( bal( L->pool_quote ) == q && bal( L->pool_tok ) == t, "pool vaults hold %lu quote, %lu tokens", bal( L->pool_quote ), bal( L->pool_tok ) );
  CHECK( bal( L->quote_vault ) == quote_before - q, "curve quote vault keeps %lu", bal( L->quote_vault ) );
  CHECK( bal( L->quote_vault ) >= fees && rd64( r + L_FEES ) == fees, "creator fees %lu still owed and still in the vault", fees );
  CHECK( bal( L->tok_vault ) == tok_before - t, "curve token vault keeps %lu tokens, out of circulation", bal( L->tok_vault ) );

  /* Price equality: pool q/t against curve vq/vt, as a cross-product gap. */
  u128 lhs = (u128)q * vt, rhs = (u128)vq * t;
  double gap = (double)( lhs > rhs ? lhs - rhs : rhs - lhs ) / (double)rhs;
  CHECK( gap < 1e-6, "pool opens at the curve's final price (relative gap %.2e)", gap );

  uchar const * p = acc[ A_SREG ].data + SWAP_HDR + (ulong)pid * SWAP_REC;
  CHECK( p[ 0 ] == 1 && rd64( p + 0xa3 ) == isqrt( (u128)q * t ), "pool %u recorded, burned seed lp_supply %lu", pid, rd64( p + 0xa3 ) );
  CHECK( rd64( acc[ L->lp ].data + 1 ) == 0, "no LP token was minted to anyone (LP mint supply %lu)", rd64( acc[ L->lp ].data + 1 ) );
  CHECK( !illegal, "no illegal writes" );
}

static void
case_too_early( void ) {
  printf( "too early: GIL with only threshold - 1 raised\n" );
  ulong thr = rd64( acc[ A_PREG ].data + 0x45 );
  ulong fees = rd64( launch( gil.id ) + L_FEES );
  set_bal( gil.quote_vault, thr - 1 + fees );
  save_all();
  ulong rc = graduate( &gil, next_pool_id(), 0 );
  CHECK( rc == 27, "reverted with ERR_TOO_SOON (27), got %lu", rc );
  CHECK( unchanged(), "nothing changed" );
}

static void
case_twice( void ) {
  printf( "twice: GIL again after it graduated\n" );
  save_all();
  ulong rc = graduate( &gil2, next_pool_id(), 0 );
  CHECK( rc == 24, "fresh pool accounts: reverted with ERR_NOT_LIVE (24), got %lu", rc );
  rc = graduate( &gil, (ushort)rd64( launch( gil.id ) + L_START ), 0 );
  CHECK( rc == 24, "same pool accounts: reverted with ERR_NOT_LIVE (24), got %lu", rc );
  rc = pad_trade( 0x02, &gil, 1000, 1 );
  CHECK( rc == 25, "a buy on the frozen curve reverts with ERR_GRADUATED (25), got %lu", rc );
  CHECK( unchanged(), "nothing changed" );
}

/* Quote out of a constant-product pool after the 30 bps fee, as thruswap does. */
static ulong cp_out( ulong r_in, ulong r_out, ulong a_in ) {
  ulong in_less = (ulong)( (u128)a_in * 9970 / 10000 );
  return (ulong)( (u128)r_out * in_less / ( (u128)r_in + in_less ) );
}

static void
case_first_block( void ) {
  printf( "first block after the pool opens (same slot %lu)\n", ctx.slot );
  ushort pid = (ushort)rd64( launch( gil.id ) + L_START );
  uchar const * r = launch( gil.id );
  ulong vq = rd64( r + L_VQ ), vt = rd64( r + L_VT );
  ulong a_in = 1000;
  ulong expect = cp_out( bal( gil.pool_quote ), bal( gil.pool_tok ), a_in );
  ulong min_out = expect - expect / 100;          /* the app's default 1% */
  ulong rc = pool_swap( pid, gil.pool_quote, gil.pool_tok, A_TR_QUOTE, A_TR_TOK, a_in, min_out );
  ulong got = bal( A_TR_TOK );
  CHECK( rc == 0 && got == expect, "buy %lu quote -> %lu tokens, as quoted (rc %lu)", a_in, got, rc );
  /* Paid per token versus the curve's last price: never a discount. */
  CHECK( (u128)a_in * vt >= (u128)vq * got, "paid %.6g quote/token >= curve's final %.6g",
         (double)a_in / (double)got, (double)vq / (double)vt );
  ulong rc2 = pool_swap( pid, gil.pool_quote, gil.pool_tok, A_TR_QUOTE, A_TR_TOK, a_in, expect * 2 );
  CHECK( rc2 == 19, "a swap whose min_out the pool cannot meet reverts with ERR_SLIPPAGE (19), got %lu", rc2 );
  CHECK( !illegal, "no illegal writes" );
}

/* Round trips across graduation, from betanet's state each time. */
static void
case_round_trips( void ) {
  printf( "round trip: buy on the curve, graduate, sell into the pool, same block\n" );
  setup();
  ulong q0 = bal( A_TR_QUOTE ), spend = 20000;
  ulong rc = pad_trade( 0x02, &gil, spend, 1 );
  ulong toks = bal( A_TR_TOK );
  ulong gq, gt; expect_seed( &gil, &gq, &gt );
  ushort pid = next_pool_id();
  ulong rc2 = graduate( &gil, pid, 0 );
  ulong rc3 = pool_swap( pid, gil.pool_tok, gil.pool_quote, A_TR_TOK, A_TR_QUOTE, toks, 1 );
  ulong q1 = bal( A_TR_QUOTE );
  CHECK( rc == 0 && rc2 == 0 && rc3 == 0, "all three landed (%lu %lu %lu)", rc, rc2, rc3 );
  CHECK( q1 < q0, "attacker ends with %lu quote, started with %lu: lost %lu", q1, q0, q0 - q1 );

  printf( "round trip: sell on the curve, graduate, buy back from the pool, same block\n" );
  setup();
  ulong rc0 = pad_trade( 0x02, &gil, spend, 1 );  /* tokens bought earlier */
  ulong hold = bal( A_TR_TOK );
  q0 = bal( A_TR_QUOTE );
  rc = pad_trade( 0x03, &gil, hold, 1 ) | rc0;
  ulong got_q = bal( A_TR_QUOTE ) - q0;
  pid = next_pool_id();
  rc2 = graduate( &gil, pid, 0 );
  /* Spend everything the sale returned on buying back from the pool. */
  rc3 = pool_swap( pid, gil.pool_quote, gil.pool_tok, A_TR_QUOTE, A_TR_TOK, got_q, 1 );
  ulong back = bal( A_TR_TOK );
  CHECK( rc == 0 && rc2 == 0 && rc3 == 0, "all three landed (%lu %lu %lu)", rc, rc2, rc3 );
  CHECK( back < hold, "attacker gets back %lu of %lu tokens: lost %lu", back, hold, hold - back );
}

int
main( void ) {
  setup();
  printf( "betanet state: GIL id %u, BNPROOF id %u, %u pool(s) already in thruswap\n\n", gil.id, bnp.id, next_pool_id() );

  printf( "== 1. normal graduation\n" );
  case_normal( &gil, "GIL" );
  case_normal( &bnp, "BNPROOF" );

  printf( "\n== 4. trade in the first block after the pool opens\n" );
  case_first_block();

  printf( "\n== 3. graduation called twice\n" );
  case_twice();

  printf( "\n== 2. graduation called too early\n" );
  setup();
  case_too_early();

  printf( "\n== 4b. round trips across graduation\n" );
  case_round_trips();

  printf( "\n%s: %d failure(s)\n", fails ? "FAILED" : "PASSED", fails );
  return fails ? 1 : 0;
}
