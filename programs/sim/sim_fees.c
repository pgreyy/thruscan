/* sim_fees.c - runs the real thruswap.c, compiled natively, against betanet's
 * current pools for the creator fee cases:
 *
 *   1. a swap pays the creator part
 *   2. the creator lowers the fee to 0, then a swap pays none
 *   3. the creator tries to raise the fee above its cap: must revert
 *   4. a claim pays out, and a second claim reverts
 *   5. an existing pool with no creator still swaps exactly as before
 *
 * The pool with a creator is BNPROOF's, which graduated before creator fees
 * existed: the table is appended with EXTEND and BNPROOF's creator opts in,
 * as the deploy would do. The stand-in VM is vm.h; see sim.c for what it
 * models and what it does not.
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

static ushort A_STRANGER, A_SWAP, A_SREG, A_PREG, A_TOKEN, A_PAD, A_CREATOR, A_TRADER;
static ushort P0_VA, P0_VB, P1_VA, P1_VB, CR_A, CR_B, TR0_A, TR0_B, TR1_A, TR1_B;

static ulong rd64( uchar const * p ) { ulong v; memcpy( &v, p, 8 ); return v; }
static ushort rd16( uchar const * p ) { ushort v; memcpy( &v, p, 2 ); return v; }

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
  A_PREG  = add( K_PAD_REGISTRY,  K_PAD_PROGRAM,  D_PAD_REGISTRY,  sizeof( D_PAD_REGISTRY ),  0 );
  P0_VA = add( K_POOL0_VA, token_key, D_POOL0_VA, sizeof( D_POOL0_VA ), 1 );
  P0_VB = add( K_POOL0_VB, token_key, D_POOL0_VB, sizeof( D_POOL0_VB ), 1 );
  /* BNPROOF's pool. */
#define PV( side ) ( BNPROOF_POOL_ID == 1 ? K_POOL1_##side : K_POOL2_##side )
#define PD( side ) ( BNPROOF_POOL_ID == 1 ? D_POOL1_##side : D_POOL2_##side )
  P1_VA = add( PV( VA ), token_key, PD( VA ), 73, 1 );
  P1_VB = add( PV( VB ), token_key, PD( VB ), 73, 1 );
  A_CREATOR = add( K_BNPROOF_CREATOR, zero, NULL, 0, 1 );
  CR_A = add_token_acct( 0x31, PV( MA ), K_BNPROOF_CREATOR, 0 );
  CR_B = add_token_acct( 0x32, PV( MB ), K_BNPROOF_CREATOR, 0 );
  fake_key( k, 0x70 ); A_TRADER = add( k, zero, NULL, 0, 1 );
  TR1_A = add_token_acct( 0x71, PV( MA ), acc[ A_TRADER ].key.key, 1000000UL );
  TR1_B = add_token_acct( 0x72, PV( MB ), acc[ A_TRADER ].key.key, 0 );
  TR0_A = add_token_acct( 0x73, K_POOL0_MA, acc[ A_TRADER ].key.key, 1000000UL );
  TR0_B = add_token_acct( 0x74, K_POOL0_MB, acc[ A_TRADER ].key.key, 0 );
}

#define P16( v ) do { ushort t_ = (ushort)(v); memcpy( ix + o, &t_, 2 ); o += 2; } while( 0 )

static ulong extend( void ) { uchar ix[ 3 ]; ulong o = 0; ix[ o++ ] = 0x08; P16( A_SREG ); return txn( A_STRANGER, A_SWAP, ix, o ); }

static ulong opt_in( ushort payer, ushort bps ) {
  uchar ix[ 11 ]; ulong o = 0; ix[ o++ ] = 0x09;
  P16( A_SREG ); P16( BNPROOF_POOL_ID ); P16( A_PREG ); P16( BNPROOF_ID ); P16( bps );
  return txn( payer, A_SWAP, ix, o );
}

static ulong set_fee( ushort payer, ushort bps ) {
  uchar ix[ 7 ]; ulong o = 0; ix[ o++ ] = 0x06;
  P16( A_SREG ); P16( BNPROOF_POOL_ID ); P16( bps );
  return txn( payer, A_SWAP, ix, o );
}

static ulong claim( ushort payer ) {
  uchar ix[ 15 ]; ulong o = 0; ix[ o++ ] = 0x07;
  P16( A_TOKEN ); P16( A_SREG ); P16( BNPROOF_POOL_ID ); P16( P1_VA ); P16( P1_VB ); P16( CR_A ); P16( CR_B );
  return txn( payer, A_SWAP, ix, o );
}

static ulong swap( ushort pool_id, ushort vin, ushort vout, ushort uin, ushort uout, ulong amount_in, ulong min_out ) {
  uchar ix[ 35 ]; ulong o = 0; ix[ o++ ] = 0x04;
  P16( A_TOKEN ); P16( A_SREG ); P16( pool_id ); P16( vin ); P16( vout ); P16( uin ); P16( uout ); P16( 0 ); P16( 0 );
  memcpy( ix + o, &amount_in, 8 ); o += 8; memcpy( ix + o, &min_out, 8 ); o += 8;
  return txn( A_TRADER, A_SWAP, ix, o );
}

static uchar const * pool_rec( ushort id ) { return acc[ A_SREG ].data + SWAP_HDR + id * SWAP_REC; }
static uchar const * ext_rec( ushort id ) {
  ulong slots = ( sizeof( D_SWAP_REGISTRY ) - SWAP_HDR ) / SWAP_REC;
  return acc[ A_SREG ].data + SWAP_HDR + slots * SWAP_REC + 8 + id * EXT_REC;
}
#define E_CBPS   33
#define E_MAX    35
#define E_ACC_A  37
#define E_ACC_B  45

/* The program's arithmetic, written again here: fee off the input, total
   rounded up, creator part rounded down, owed fees left out of reserves. */
static ulong expect_out( ulong r_in, ulong r_out, ulong a_in, ulong total_bps ) {
  ulong in_less = (ulong)( (u128)a_in * ( 10000 - total_bps ) / 10000 );
  return (ulong)( (u128)r_out * in_less / ( (u128)r_in + in_less ) );
}

static int fails;
#define CHECK( cond, ... ) do { if( cond ) printf( "  ok    " __VA_ARGS__ ); else { printf( "  FAIL  " __VA_ARGS__ ); fails++; } printf( "\n" ); } while( 0 )

int
main( void ) {
  setup();
  ushort pid = BNPROOF_POOL_ID;
  ushort lp_bps = rd16( pool_rec( pid ) + 1 );
  ushort cap = BNPROOF_FEE_BPS < 100 - lp_bps ? (ushort)BNPROOF_FEE_BPS : (ushort)( 100 - lp_bps );
  printf( "betanet: %u pools; BNPROOF is pool %u, LP fee %u bps, launch curve fee %u bps -> creator cap %u bps\n\n",
          POOL_COUNT, pid, lp_bps, BNPROOF_FEE_BPS, cap );

  printf( "setup: append the creator fee table, BNPROOF's creator opts in at the cap\n" );
  ulong old_sz = acc[ A_SREG ].meta.data_sz;
  ulong rc = extend();
  CHECK( rc == 0 && acc[ A_SREG ].meta.data_sz == old_sz + 8 + ( old_sz - SWAP_HDR ) / SWAP_REC * EXT_REC,
         "EXTEND by a stranger grew the registry %lu -> %u bytes (rc %lu)", old_sz, acc[ A_SREG ].meta.data_sz, rc );
  CHECK( !memcmp( acc[ A_SREG ].data, D_SWAP_REGISTRY, sizeof( D_SWAP_REGISTRY ) ), "every existing pool record is byte for byte unchanged" );
  rc = opt_in( A_CREATOR, cap );
  CHECK( rc == 0 && rd16( ext_rec( pid ) + E_CBPS ) == cap && ext_rec( pid )[ 0 ] == 1, "opt-in at %u bps (rc %lu)", cap, rc );

  printf( "\n== 1. a swap pays the creator part\n" );
  {
    ulong va = bal( P1_VA ), vb = bal( P1_VB ), a_in = 10000;
    ulong out = expect_out( va, vb, a_in, (ulong)lp_bps + cap );
    ulong cut = a_in * cap / 10000;
    rc = swap( pid, P1_VA, P1_VB, TR1_A, TR1_B, a_in, out - out / 100 );
    CHECK( rc == 0 && bal( TR1_B ) == out, "swap %lu in -> %lu out, as quoted at %u bps total (rc %lu)", a_in, bal( TR1_B ), lp_bps + cap, rc );
    CHECK( rd64( ext_rec( pid ) + E_ACC_A ) == cut, "creator accrued %lu (floor of %lu x %u bps)", rd64( ext_rec( pid ) + E_ACC_A ), a_in, cap );
    CHECK( bal( P1_VA ) - rd64( ext_rec( pid ) + E_ACC_A ) == va + a_in - cut, "pool liquidity grew by the input less the creator part only" );
    CHECK( !illegal, "no illegal writes" );
  }

  printf( "\n== 2. creator lowers the fee to 0, then a swap\n" );
  {
    rc = set_fee( A_CREATOR, 0 );
    CHECK( rc == 0 && rd16( ext_rec( pid ) + E_CBPS ) == 0 && rd16( ext_rec( pid ) + E_MAX ) == cap, "fee now 0, cap still %u (rc %lu)", cap, rc );
    ulong owed = rd64( ext_rec( pid ) + E_ACC_A );
    ulong r_in = bal( P1_VA ) - owed, r_out = bal( P1_VB ), a_in = 10000, before = bal( TR1_B );
    ulong out = expect_out( r_in, r_out, a_in, lp_bps );
    rc = swap( pid, P1_VA, P1_VB, TR1_A, TR1_B, a_in, out - out / 100 );
    CHECK( rc == 0 && bal( TR1_B ) - before == out, "swap paid the LP fee only: %lu out (rc %lu)", bal( TR1_B ) - before, rc );
    CHECK( rd64( ext_rec( pid ) + E_ACC_A ) == owed, "creator accrued nothing more (%lu)", rd64( ext_rec( pid ) + E_ACC_A ) );
  }

  printf( "\n== 3. creator tries to raise the fee above its cap\n" );
  {
    rc = set_fee( A_CREATOR, (ushort)( cap + 1 ) );
    CHECK( rc == 28, "set to %u bps reverts with ERR_ABOVE_CAP (28), got %lu", cap + 1, rc );
    CHECK( rd16( ext_rec( pid ) + E_CBPS ) == 0, "fee still 0" );
  }

  printf( "\n== 4. claim, then claim again\n" );
  {
    ulong owed = rd64( ext_rec( pid ) + E_ACC_A ), va = bal( P1_VA );
    rc = claim( A_CREATOR );
    CHECK( rc == 0 && bal( CR_A ) == owed && bal( P1_VA ) == va - owed, "claim paid %lu to the creator's account (rc %lu)", bal( CR_A ), rc );
    CHECK( rd64( ext_rec( pid ) + E_ACC_A ) == 0 && rd64( ext_rec( pid ) + E_ACC_B ) == 0, "nothing left owed" );
    rc = claim( A_CREATOR );
    CHECK( rc == 29, "second claim reverts with ERR_NO_FEES (29), got %lu", rc );
    CHECK( !illegal, "no illegal writes" );
  }

  printf( "\n== 5. the existing WTHRU/BNTEST pool still swaps\n" );
  {
    ulong va = bal( P0_VA ), vb = bal( P0_VB ), a_in = 1000;
    ulong out = expect_out( va, vb, a_in, rd16( pool_rec( 0 ) + 1 ) );
    rc = swap( 0, P0_VA, P0_VB, TR0_A, TR0_B, a_in, out - out / 100 );
    CHECK( rc == 0 && bal( TR0_B ) == out, "swap %lu in -> %lu out, the same as the pre-upgrade formula (rc %lu)", a_in, bal( TR0_B ), rc );
    CHECK( ext_rec( 0 )[ 0 ] == 0 && rd64( ext_rec( 0 ) + E_ACC_A ) == 0, "no creator, nothing accrued" );
    CHECK( !illegal, "no illegal writes" );
  }

  printf( "\n%s: %d failure(s)\n", fails ? "FAILED" : "PASSED", fails );
  return fails ? 1 : 0;
}
