/* sim_fees.c - runs the real thrupad2.c and thruswap.c, compiled natively,
 * against betanet's current state for the fee rule cases:
 *
 *   1. a swap through a new pool pays the 1% LP fee plus the creator fee
 *   2. the creator lowers the fee, then a swap pays the lower fee
 *   3. the creator tries to raise it above the launch value: must revert
 *   4. a launch at 9% works, and one at 9.01% reverts
 *   5. an existing pool still swaps exactly as before
 *
 * The new pool is made the way graduation makes one, with CREATE_SEEDED's
 * long form over funded fresh vaults, and its caller asks for a 0.3% LP fee
 * to show that the program does not let anyone choose it. The stand-in VM is
 * vm.h; see sim.c for what it models and what it does not.
 */

#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "thru-sdk/c/tn_sdk.h"
#include "thru-sdk/c/tn_sdk_syscall.h"
#include "state.h"
#include "vm.h"

#define SWAP_HDR 37UL
#define SWAP_REC 179UL
#define EXT_REC  53UL
#define PAD_HDR  77UL
#define PAD_REC  253UL

static ushort A_STRANGER, A_SWAP, A_SREG, A_PREG, A_TOKEN, A_PAD, A_CREATOR, A_TRADER;
static ushort P0_VA, P0_VB, N_VA, N_VB, N_LP, N_MA, N_MB, TR0_A, TR0_B, TRN_A, TRN_B;
static ushort L_MINT, L_TOKV, L_QV, L_MINT2, L_TOKV2, L_QV2;

static ulong  rd64( uchar const * p ) { ulong v; memcpy( &v, p, 8 ); return v; }
static ushort rd16( uchar const * p ) { ushort v; memcpy( &v, p, 2 ); return v; }

/* A mint whose authority is `authority`, as LAUNCH needs (thrupad must be
   able to mint the supply). */
static ushort
add_mint( uchar tag, uchar const authority[ 32 ] ) {
  uchar k[ 32 ], d[ 115 ];
  fake_key( k, tag );
  memset( d, 0, sizeof( d ) );
  d[ 0 ] = 6;
  memcpy( d + 41, authority, 32 );
  return add( k, token_key, d, 115, 1 );
}

static void
setup( void ) {
  nacc = 0; illegal = 0;
  uchar k[ 32 ], zero[ 32 ];
  memset( zero, 0, 32 );
  fake_key( k, 0x01 ); A_STRANGER = add( k, zero, NULL, 0, 1 );
  A_SWAP  = add( K_SWAP_PROGRAM, zero, NULL, 0, 0 );
  A_PAD   = add( K_PAD_PROGRAM,  zero, NULL, 0, 0 );
  A_TOKEN = add( token_key, zero, NULL, 0, 0 );
  A_SREG  = add( K_SWAP_REGISTRY, K_SWAP_PROGRAM, D_SWAP_REGISTRY, sizeof( D_SWAP_REGISTRY ), 1 );
  A_PREG  = add( K_PAD_REGISTRY,  K_PAD_PROGRAM,  D_PAD_REGISTRY,  sizeof( D_PAD_REGISTRY ),  1 );
  P0_VA = add( K_POOL0_VA, token_key, D_POOL0_VA, sizeof( D_POOL0_VA ), 1 );
  P0_VB = add( K_POOL0_VB, token_key, D_POOL0_VB, sizeof( D_POOL0_VB ), 1 );

  fake_key( k, 0x20 ); A_CREATOR = add( k, zero, NULL, 0, 1 );
  fake_key( k, 0x70 ); A_TRADER  = add( k, zero, NULL, 0, 1 );

  /* A new pool: WTHRU (pool 0's mint A) against a fresh token, funded the
     way graduation funds it, at GIL's real final reserves. */
  N_MA = add( K_POOL0_MA, token_key, D_POOL0_MA, sizeof( D_POOL0_MA ), 0 );
  N_MB = add_mint( 0x41, K_PAD_PROGRAM );
  N_VA = add_token_acct( 0x42, K_POOL0_MA,          K_SWAP_PROGRAM, 49578UL );
  N_VB = add_token_acct( 0x43, acc[ N_MB ].key.key, K_SWAP_PROGRAM, 858405252945UL );
  N_LP = add_lp_mint( 0x44, K_SWAP_PROGRAM );

  TR0_A = add_token_acct( 0x73, K_POOL0_MA, acc[ A_TRADER ].key.key, 1000000UL );
  TR0_B = add_token_acct( 0x74, K_POOL0_MB, acc[ A_TRADER ].key.key, 0 );
  TRN_A = add_token_acct( 0x75, K_POOL0_MA, acc[ A_TRADER ].key.key, 1000000UL );
  TRN_B = add_token_acct( 0x76, acc[ N_MB ].key.key, acc[ A_TRADER ].key.key, 0 );

  /* Two launches' worth of fresh accounts for the 9% / 9.01% case. */
  L_MINT  = add_mint( 0x51, K_PAD_PROGRAM );
  L_TOKV  = add_token_acct( 0x52, acc[ L_MINT ].key.key, K_PAD_PROGRAM, 0 );
  L_QV    = add_token_acct( 0x53, K_POOL0_MA, K_PAD_PROGRAM, 0 );
  L_MINT2 = add_mint( 0x54, K_PAD_PROGRAM );
  L_TOKV2 = add_token_acct( 0x55, acc[ L_MINT2 ].key.key, K_PAD_PROGRAM, 0 );
  L_QV2   = add_token_acct( 0x56, K_POOL0_MA, K_PAD_PROGRAM, 0 );
}

#define P16( v ) do { ushort t_ = (ushort)(v); memcpy( ix + o, &t_, 2 ); o += 2; } while( 0 )

static ushort next_pool_id( void ) { uint n; memcpy( &n, acc[ A_SREG ].data + 1, 4 ); return (ushort)n; }

static ulong create_seeded( ushort pool_id, ushort asked_lp_bps, ushort creator_bps ) {
  uchar ix[ 51 ]; ulong o = 0; ix[ o++ ] = 0x05;
  P16( A_SREG ); P16( pool_id ); P16( N_MA ); P16( N_MB ); P16( N_VA ); P16( N_VB ); P16( N_LP ); P16( asked_lp_bps );
  memcpy( ix + o, acc[ A_CREATOR ].key.key, 32 ); o += 32; P16( creator_bps );
  return txn( A_STRANGER, A_SWAP, ix, o );
}

static ulong set_fee( ushort pool_id, ushort bps ) {
  uchar ix[ 7 ]; ulong o = 0; ix[ o++ ] = 0x06;
  P16( A_SREG ); P16( pool_id ); P16( bps );
  return txn( A_CREATOR, A_SWAP, ix, o );
}

static ulong swap( ushort pool_id, ushort vin, ushort vout, ushort uin, ushort uout, ulong amount_in, ulong min_out ) {
  uchar ix[ 35 ]; ulong o = 0; ix[ o++ ] = 0x04;
  P16( A_TOKEN ); P16( A_SREG ); P16( pool_id ); P16( vin ); P16( vout ); P16( uin ); P16( uout ); P16( 0 ); P16( 0 );
  memcpy( ix + o, &amount_in, 8 ); o += 8; memcpy( ix + o, &min_out, 8 ); o += 8;
  return txn( A_TRADER, A_SWAP, ix, o );
}

static ulong launch( ushort launch_id, ushort mint, ushort tokv, ushort qv, ushort fee_bps ) {
  uchar ix[ 64 ]; ulong o = 0; ix[ o++ ] = 0x01;
  P16( A_TOKEN ); P16( A_PREG ); P16( launch_id ); P16( mint ); P16( tokv ); P16( qv ); P16( N_MA ); P16( fee_bps );
  ulong supply = 1000000000000000UL, vq = 30UL;
  memcpy( ix + o, &supply, 8 ); o += 8; memcpy( ix + o, &vq, 8 ); o += 8;
  ix[ o++ ] = 4; ix[ o++ ] = 3;
  memcpy( ix + o, "Test", 4 ); o += 4; memcpy( ix + o, "TST", 3 ); o += 3;
  return txn( A_CREATOR, A_PAD, ix, o );
}

static uchar const * pool_rec( ushort id ) { return acc[ A_SREG ].data + SWAP_HDR + id * SWAP_REC; }
static uchar const * ext_rec( ushort id ) { return acc[ A_SREG ].data + SWAP_HDR + 256UL * SWAP_REC + 8 + id * EXT_REC; }
#define E_CBPS  33
#define E_MAX   35
#define E_ACC_A 37

/* The program's arithmetic, written again here: whole fee off the input,
   total rounded up, creator part rounded down, owed fees out of reserves. */
static ulong expect_out( ulong r_in, ulong r_out, ulong a_in, ulong total_bps ) {
  ulong in_less = (ulong)( (u128)a_in * ( 10000 - total_bps ) / 10000 );
  return (ulong)( (u128)r_out * in_less / ( (u128)r_in + in_less ) );
}

static int fails;
#define CHECK( cond, ... ) do { if( cond ) printf( "  ok    " __VA_ARGS__ ); else { printf( "  FAIL  " __VA_ARGS__ ); fails++; } printf( "\n" ); } while( 0 )

int
main( void ) {
  setup();
  printf( "betanet: %u pools, registry %s\n\n", POOL_COUNT,
          sizeof( D_SWAP_REGISTRY ) > SWAP_HDR + 256UL * SWAP_REC ? "already extended" : "NOT extended" );

  printf( "setup: a new pool, created with a 3%% creator fee; its caller asks for a 0.3%% LP fee\n" );
  ushort pid = next_pool_id();
  ulong rc = create_seeded( pid, 30, 300 );
  CHECK( rc == 0, "CREATE_SEEDED landed as pool %u (rc %lu)", pid, rc );
  CHECK( rd16( pool_rec( pid ) + 1 ) == 100, "its LP fee is the program's 1%%, not the 0.3%% asked for (got %u bps)", rd16( pool_rec( pid ) + 1 ) );
  CHECK( rd16( ext_rec( pid ) + E_CBPS ) == 300 && rd16( ext_rec( pid ) + E_MAX ) == 300, "creator fee 3%%, launch value 3%%" );

  printf( "\n== 1. a swap pays the 1%% LP fee plus the creator fee\n" );
  {
    ulong va = bal( N_VA ), vb = bal( N_VB ), a_in = 10000;
    ulong out = expect_out( va, vb, a_in, 400 );
    ulong cut = a_in * 300 / 10000;
    rc = swap( pid, N_VA, N_VB, TRN_A, TRN_B, a_in, out - out / 100 );
    CHECK( rc == 0 && bal( TRN_B ) == out, "%lu in -> %lu out, as quoted at 4%% total (rc %lu)", a_in, bal( TRN_B ), rc );
    CHECK( rd64( ext_rec( pid ) + E_ACC_A ) == cut, "creator accrued %lu (3%% of %lu)", rd64( ext_rec( pid ) + E_ACC_A ), a_in );
    CHECK( bal( N_VA ) - rd64( ext_rec( pid ) + E_ACC_A ) == va + a_in - cut, "liquidity grew by the input less the creator part (the 1%% LP part stays in)" );
    CHECK( !illegal, "no illegal writes" );
  }

  printf( "\n== 2. the creator lowers the fee to 1%%, then a swap\n" );
  {
    rc = set_fee( pid, 100 );
    CHECK( rc == 0 && rd16( ext_rec( pid ) + E_CBPS ) == 100, "fee now 1%% (rc %lu)", rc );
    ulong owed = rd64( ext_rec( pid ) + E_ACC_A );
    ulong r_in = bal( N_VA ) - owed, r_out = bal( N_VB ), a_in = 10000, before = bal( TRN_B );
    ulong out = expect_out( r_in, r_out, a_in, 200 );
    rc = swap( pid, N_VA, N_VB, TRN_A, TRN_B, a_in, out - out / 100 );
    CHECK( rc == 0 && bal( TRN_B ) - before == out, "%lu in -> %lu out at 2%% total (rc %lu)", a_in, bal( TRN_B ) - before, rc );
    CHECK( rd64( ext_rec( pid ) + E_ACC_A ) == owed + a_in * 100 / 10000, "creator accrued 1%% more (%lu)", rd64( ext_rec( pid ) + E_ACC_A ) - owed );
  }

  printf( "\n== 3. the creator tries to raise the fee\n" );
  {
    rc = set_fee( pid, 301 );
    CHECK( rc == 28, "above the 3%% launch value: reverts with ERR_ABOVE_CAP (28), got %lu", rc );
    rc = set_fee( pid, 300 );
    CHECK( rc == 28, "back up to the 3%% launch value after lowering: also reverts (down only), got %lu", rc );
    CHECK( rd16( ext_rec( pid ) + E_CBPS ) == 100, "fee still 1%%" );
  }

  printf( "\n== 4. a launch at 9%% and at 9.01%%\n" );
  {
    uint count; memcpy( &count, acc[ A_PREG ].data + 1, 4 );
    ushort id = (ushort)count;
    rc = launch( id, L_MINT, L_TOKV, L_QV, 900 );
    uchar const * l = acc[ A_PREG ].data + PAD_HDR + (ulong)id * PAD_REC;
    CHECK( rc == 0 && l[ 0 ] == 1 && rd16( l + 1 ) == 900, "launch %u at 900 bps landed, live, fee 9%% (rc %lu)", id, rc );
    rc = launch( (ushort)( id + 1 ), L_MINT2, L_TOKV2, L_QV2, 901 );
    CHECK( rc == 20, "launch at 901 bps reverts with ERR_FEE_RANGE (20), got %lu", rc );
    CHECK( !illegal, "no illegal writes" );
  }

  printf( "\n== 5. the existing WTHRU/BNTEST pool still swaps\n" );
  {
    ulong va = bal( P0_VA ), vb = bal( P0_VB ), a_in = 1000;
    ushort stored = rd16( pool_rec( 0 ) + 1 );
    ulong out = expect_out( va, vb, a_in, stored );
    rc = swap( 0, P0_VA, P0_VB, TR0_A, TR0_B, a_in, out - out / 100 );
    CHECK( stored == 30, "its record still holds its own 0.3%% LP fee (%u bps)", stored );
    CHECK( rc == 0 && bal( TR0_B ) == out, "%lu in -> %lu out, the same formula as before (rc %lu)", a_in, bal( TR0_B ), rc );
    CHECK( !illegal, "no illegal writes" );
  }

  printf( "\n%s: %d failure(s)\n", fails ? "FAILED" : "PASSED", fails );
  return fails ? 1 : 0;
}
