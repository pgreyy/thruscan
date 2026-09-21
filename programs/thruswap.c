/* thruswap - a constant product automated market maker on Thru.
 *
 * Two reserves, a curve, and a fee. x * y = k. A pool holds each side in a
 * token account the program itself owns, which is what makes it a market rather
 * than an escrow: nobody signs for the reserves, the program decides when they
 * move, and the price is whatever the ratio says it is.
 *
 * That custody was not a given. It was established on alphanet before this file
 * was written: a program can be a token account's owner and move tokens out of
 * it with no wallet signature and no authorization descriptor. See thrucpi.c.
 *
 * ---------------------------------------------------------------------------
 * ACCOUNT INDICES
 *
 * Thru sorts a transaction's accounts ascending by raw public key bytes, so a
 * program cannot assume "the pool is at index 2". Every instruction below
 * therefore carries the indices it needs, exactly as the token program's own
 * instructions do. The caller knows the sort order; the callee cannot.
 *
 * That makes index validation a security boundary rather than a formality. A
 * caller who passes the wrong vault index is either confused or attacking, so
 * every index is checked against the pubkey recorded in the pool before a
 * single token moves.
 *
 * ---------------------------------------------------------------------------
 * RESERVES
 *
 * Reserves are read live from the vault token accounts rather than cached in
 * the pool record. A cached number can drift from the truth; a balance read
 * from the account cannot. The cost is one extra account read per swap, which
 * is cheap, and the benefit is that the curve can never price against reserves
 * that do not exist.
 *
 * LP supply IS stored, because it is the program's own bookkeeping and has no
 * on-chain source to read it back from.
 *
 * ---------------------------------------------------------------------------
 * INSTRUCTIONS
 *
 *   INIT    [0x00][seed 32][slots u16][state proof]
 *           Creates the pool registry. Run once.
 *
 *   CREATE  [0x01][pool_regs][mint_a][mint_b][vault_a][vault_b][lp_mint][fee_bps]
 *           Records a pool over two mints. The vaults must already exist as
 *           token accounts owned by this program, and lp_mint must be a mint
 *           whose authority is this program. The program verifies all of that
 *           rather than taking the caller's word for it.
 *
 *   ADD     [0x02][...][amount_a u64][amount_b u64]
 *           Deposits both sides, mints LP tokens in return.
 *
 *   REMOVE  [0x03][...][lp_amount u64]
 *           Burns LP tokens, returns a proportional share of both reserves.
 *
 *   SWAP    [0x04][...][amount_in u64][min_out u64]
 *           Trades one side for the other along the curve, after a 30 basis
 *           point fee that stays in the pool for liquidity providers.
 *
 * All u16 and u64 fields are little endian and every struct is packed, so the
 * layouts here are exactly the bytes on the wire.
 */

#include <thru-sdk/c/tn_sdk.h>
#include <thru-sdk/c/tn_sdk_syscall.h>

#include "thru_token.h"

/* Every token CPI must succeed or the whole instruction reverts. A rejected
   invocation RETURNS a code rather than reverting, so ignoring it would let
   the books move while the tokens did not. */
#define TOKEN_CALL( expr ) do { ulong rc_ = (expr); if( rc_ != 0UL ) tsdk_revert( rc_ ); } while( 0 )

#define OP_INIT   (0x00)
#define OP_CREATE (0x01)
#define OP_ADD    (0x02)
#define OP_REMOVE (0x03)
#define OP_SWAP   (0x04)

#define SWAP_VERSION ((uchar)1)
#define REG_ACC_IDX  ((ushort)2)   /* INIT declares exactly one account */
#define POOLS_MAX    (256UL)

/* 30 basis points, the rate Uniswap v2 settled on and the one liquidity
   providers on every other chain already understand. It stays in the pool
   rather than being paid out, so every swap thickens the reserves slightly. */
#define FEE_BPS_DEFAULT (30U)
#define FEE_BPS_MAX     (100U)
#define BPS_DENOM       (10000UL)

/* The smallest pool that can exist. Below this, rounding dominates the curve
   and an attacker can move the price for nothing. */
#define MIN_LIQUIDITY (1000UL)

#define ERR_BAD_INSTR      (1UL)
#define ERR_BAD_OPCODE     (2UL)
#define ERR_NO_ACCOUNT     (3UL)
#define ERR_NOT_OURS       (4UL)
#define ERR_NOT_READY      (5UL)
#define ERR_BAD_SLOTS      (6UL)
#define ERR_CREATE_FAILED  (7UL)
#define ERR_WRITE_DENIED   (8UL)
#define ERR_POOL_RANGE     (9UL)
#define ERR_POOL_EXISTS   (10UL)
#define ERR_BAD_IDX       (11UL)
#define ERR_WRONG_ACCOUNT (12UL)
#define ERR_NOT_TOKEN_ACC (13UL)
#define ERR_VAULT_OWNER   (14UL)
#define ERR_MINT_MISMATCH (15UL)
#define ERR_ZERO_AMOUNT   (16UL)
#define ERR_EMPTY_POOL    (17UL)
#define ERR_DUST          (18UL)
#define ERR_SLIPPAGE      (19UL)
#define ERR_FEE_RANGE     (20UL)
#define ERR_OVERFLOW      (21UL)
#define ERR_LP_SUPPLY     (22UL)
#define ERR_TOKEN_PROG    (23UL)  /* the "token program" named is not the token program */

/* --------------------------------------------------------------- storage */

struct __attribute__(( packed )) swap_hdr {
  uchar       version;
  uint        pool_count;
  tn_pubkey_t sponsor;      /* whoever ran INIT, recorded for provenance */
};
typedef struct swap_hdr swap_hdr_t;

struct __attribute__(( packed )) pool_rec {
  uchar       in_use;
  ushort      fee_bps;
  tn_pubkey_t mint_a;
  tn_pubkey_t mint_b;
  tn_pubkey_t vault_a;
  tn_pubkey_t vault_b;
  tn_pubkey_t lp_mint;
  ulong       lp_supply;
  ulong       swap_count;
};
typedef struct pool_rec pool_rec_t;

#define HDR_SZ  (sizeof( swap_hdr_t ))
#define POOL_SZ (sizeof( pool_rec_t ))

FD_STATIC_ASSERT( HDR_SZ  == 37UL,  swap_hdr_size );
FD_STATIC_ASSERT( POOL_SZ == 179UL, pool_rec_size );

static inline ulong
registry_capacity( ulong data_sz ) {
  if( data_sz < HDR_SZ ) return 0UL;
  return ( data_sz - HDR_SZ ) / POOL_SZ;
}

/* ------------------------------------------------------------- arithmetic */

/* Every product below can exceed 64 bits long before the reserves do, so the
   intermediate is always 128 bit. Truncating early is how AMMs get drained.

   __int128 is a GCC extension rather than ISO C, and the SDK builds with
   -Wpedantic -Werror, so it needs __extension__ to be accepted. That keyword
   silences the pedantic complaint about this one declaration and nothing else,
   which is better than loosening the build's warning settings for the whole
   program. rv64 has the 64x64->128 multiply in hardware, so this costs nothing. */
__extension__ typedef unsigned __int128 uint128;

static inline ulong
mul_div( ulong a, ulong b, ulong d ) {
  if( d == 0UL ) tsdk_revert( ERR_OVERFLOW );
  uint128 r = ( (uint128)a * (uint128)b ) / (uint128)d;
  if( r > (uint128)0xFFFFFFFFFFFFFFFFULL ) tsdk_revert( ERR_OVERFLOW );
  return (ulong)r;
}

/* Integer square root by Newton's method. Used once per pool, for the very
   first deposit, where the LP supply is defined as sqrt(a*b) so that the
   initial LP token price does not depend on the ratio chosen. */
static ulong
isqrt128( uint128 n ) {
  if( n == 0 ) return 0UL;
  uint128 x = n;
  uint128 y = ( x + 1 ) / 2;
  while( y < x ) {
    x = y;
    y = ( x + n / x ) / 2;
  }
  if( x > (uint128)0xFFFFFFFFFFFFFFFFULL ) tsdk_revert( ERR_OVERFLOW );
  return (ulong)x;
}

static inline ulong
min_u64( ulong a, ulong b ) { return a < b ? a : b; }

/* ---------------------------------------------------------- account checks */

static tn_pubkey_t const *
account_addr( ushort idx ) {
  tsdk_txn_t const * txn = tsdk_get_txn();
  if( idx >= tsdk_txn_account_cnt( txn ) ) tsdk_revert( ERR_BAD_IDX );
  return &tsdk_txn_get_acct_addrs( txn )[ idx ];
}

static void
require_addr( ushort idx, tn_pubkey_t const * expected, ulong err ) {
  tn_pubkey_t const * got = account_addr( idx );
  if( memcmp( got->key, expected->key, 32UL ) != 0 ) tsdk_revert( err );
}

/* A vault must be a token account, of the right mint, owned by this program.
   Checking the mint matters as much as checking the owner: a vault holding the
   wrong asset would let someone pay in a worthless token and take out a real
   one at the pool's price. */
static void
require_vault( ushort idx, tn_pubkey_t const * mint ) {
  if( !tsdk_is_account_idx_valid( idx ) ) tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_account_exists( idx ) )       tsdk_revert( ERR_NO_ACCOUNT );

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( idx );
  if( meta->data_sz != (uint)TN_TOKEN_TOKEN_ACCOUNT_SZ ) tsdk_revert( ERR_NOT_TOKEN_ACC );

  uchar const * d = (uchar const *)tsdk_get_account_data_ptr( idx );
  if( memcmp( d, mint->key, 32UL ) != 0 ) tsdk_revert( ERR_MINT_MISMATCH );

  tn_pubkey_t const * me = tsdk_get_current_program_acc_addr();
  if( memcmp( d + 32, me->key, 32UL ) != 0 ) tsdk_revert( ERR_VAULT_OWNER );
}

static ulong
vault_balance( ushort idx ) {
  int ok = 0;
  ulong v = tn_token_read_amount( idx, &ok );
  if( !ok ) tsdk_revert( ERR_NOT_TOKEN_ACC );
  return v;
}

static pool_rec_t *
open_registry( ushort reg_idx, ushort pool_id ) {
  if( !tsdk_is_account_idx_valid( reg_idx ) ) tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_account_exists( reg_idx ) )       tsdk_revert( ERR_NOT_READY );
  if( !tsdk_is_account_owned_by_current_program( reg_idx ) ) tsdk_revert( ERR_NOT_OURS );

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( reg_idx );
  ulong cap = registry_capacity( (ulong)meta->data_sz );
  if( cap == 0UL )                tsdk_revert( ERR_NOT_READY );
  if( (ulong)pool_id >= cap )     tsdk_revert( ERR_POOL_RANGE );

  if( tsys_set_account_data_writable( reg_idx ) != TSDK_SUCCESS ) {
    tsdk_revert( ERR_WRITE_DENIED );
  }

  uchar * base = (uchar *)tsdk_get_account_data_ptr( reg_idx );
  swap_hdr_t const * hdr = (swap_hdr_t const *)base;
  if( hdr->version != SWAP_VERSION ) tsdk_revert( ERR_NOT_READY );

  return (pool_rec_t *)( base + HDR_SZ + (ulong)pool_id * POOL_SZ );
}

/* ------------------------------------------------------------------- INIT */

struct __attribute__(( packed )) init_args {
  uchar  op;
  uchar  seed[ 32 ];
  ushort slots;
};

static void
do_init( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct init_args ) ) tsdk_revert( ERR_BAD_INSTR );

  struct init_args a;
  memcpy( &a, data, sizeof( a ) );

  ulong slots = (ulong)a.slots;
  if( slots == 0UL || slots > POOLS_MAX ) tsdk_revert( ERR_BAD_SLOTS );

  if( !tsdk_is_account_idx_valid( REG_ACC_IDX ) ) tsdk_revert( ERR_NO_ACCOUNT );

  ulong want  = HDR_SZ + slots * POOL_SZ;
  uchar const * proof    = data + sizeof( struct init_args );
  ulong         proof_sz = data_sz - sizeof( struct init_args );

  if( !tsdk_account_exists( REG_ACC_IDX ) ) {
    if( tsys_account_create( REG_ACC_IDX, a.seed, proof, proof_sz ) != TSDK_SUCCESS ) {
      tsdk_revert( ERR_CREATE_FAILED );
    }
  }
  if( !tsdk_is_account_owned_by_current_program( REG_ACC_IDX ) ) tsdk_revert( ERR_NOT_OURS );

  /* Writable BEFORE resize. The other order fails at every size, which is a
     trap already paid for once in thruwall: a freshly created account is not
     open for modification until it is marked writable, and resize counts as a
     modification. Getting this backwards produces a failure that looks like a
     size limit and is not one. */
  if( tsys_set_account_data_writable( REG_ACC_IDX ) != TSDK_SUCCESS ) {
    tsdk_revert( ERR_WRITE_DENIED );
  }

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( REG_ACC_IDX );
  if( (ulong)meta->data_sz != want ) {
    /* Report resize's own return value rather than flattening it into a shared
       code. Mapping this onto ERR_CREATE_FAILED once already sent me looking at
       the wrong syscall, so 0x8000 plus the value says "resize returned this". */
    ulong rc = tsys_account_resize( REG_ACC_IDX, want );
    if( rc != TSDK_SUCCESS ) tsdk_revert( 0x8000UL | ( rc & 0xFFUL ) );
  }

  uchar * base = (uchar *)tsdk_get_account_data_ptr( REG_ACC_IDX );
  memset( base, 0, want );

  swap_hdr_t hdr;
  memset( &hdr, 0, sizeof( hdr ) );
  hdr.version    = SWAP_VERSION;
  hdr.pool_count = 0U;
  memcpy( hdr.sponsor.key, account_addr( 0 )->key, 32UL );
  memcpy( base, &hdr, HDR_SZ );
}

/* ----------------------------------------------------------------- CREATE */

struct __attribute__(( packed )) create_args {
  uchar  op;
  ushort reg_idx;
  ushort pool_id;
  ushort mint_a_idx;
  ushort mint_b_idx;
  ushort vault_a_idx;
  ushort vault_b_idx;
  ushort lp_mint_idx;
  ushort fee_bps;
};

static void
do_create( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct create_args ) ) tsdk_revert( ERR_BAD_INSTR );

  struct create_args a;
  memcpy( &a, data, sizeof( a ) );

  if( a.fee_bps > FEE_BPS_MAX ) tsdk_revert( ERR_FEE_RANGE );

  tn_pubkey_t const * mint_a = account_addr( a.mint_a_idx );
  tn_pubkey_t const * mint_b = account_addr( a.mint_b_idx );
  if( memcmp( mint_a->key, mint_b->key, 32UL ) == 0 ) tsdk_revert( ERR_MINT_MISMATCH );

  /* The vaults are checked here, once, so that every later swap can trust the
     recorded pubkeys instead of re-deriving trust from the caller. */
  require_vault( a.vault_a_idx, mint_a );
  require_vault( a.vault_b_idx, mint_b );

  pool_rec_t * pool = open_registry( a.reg_idx, a.pool_id );
  if( pool->in_use ) tsdk_revert( ERR_POOL_EXISTS );

  pool_rec_t rec;
  memset( &rec, 0, sizeof( rec ) );
  rec.in_use  = 1U;
  rec.fee_bps = a.fee_bps == 0U ? (ushort)FEE_BPS_DEFAULT : a.fee_bps;
  memcpy( rec.mint_a.key,  mint_a->key,                  32UL );
  memcpy( rec.mint_b.key,  mint_b->key,                  32UL );
  memcpy( rec.vault_a.key, account_addr( a.vault_a_idx )->key, 32UL );
  memcpy( rec.vault_b.key, account_addr( a.vault_b_idx )->key, 32UL );
  memcpy( rec.lp_mint.key, account_addr( a.lp_mint_idx )->key, 32UL );
  memcpy( pool, &rec, POOL_SZ );

  uchar * base = (uchar *)tsdk_get_account_data_ptr( a.reg_idx );
  swap_hdr_t hdr;
  memcpy( &hdr, base, HDR_SZ );
  hdr.pool_count += 1U;
  memcpy( base, &hdr, HDR_SZ );
}

/* ------------------------------------------------------- liquidity + swap */

/* The account set every value-moving instruction needs. Bundling it keeps the
   three entry points below readable and makes it obvious that they all validate
   the same things in the same order. */
struct __attribute__(( packed )) flow_args {
  uchar  op;
  ushort token_prog_idx;
  ushort reg_idx;
  ushort pool_id;
  ushort vault_a_idx;
  ushort vault_b_idx;
  ushort user_a_idx;
  ushort user_b_idx;
  ushort lp_mint_idx;
  ushort user_lp_idx;
  ulong  amount_0;
  ulong  amount_1;
};

static pool_rec_t *
load_and_check( struct flow_args const * a ) {
  pool_rec_t * pool = open_registry( a->reg_idx, a->pool_id );
  if( !pool->in_use ) tsdk_revert( ERR_NOT_READY );

  /* The caller told us where the vaults are. The pool record says where they
     must be. Disagreement means the transaction is lying about which accounts
     it is touching, which is the whole attack surface of index-passing. */
  require_addr( a->vault_a_idx, &pool->vault_a, ERR_WRONG_ACCOUNT );
  require_addr( a->vault_b_idx, &pool->vault_b, ERR_WRONG_ACCOUNT );
  require_addr( a->lp_mint_idx, &pool->lp_mint, ERR_WRONG_ACCOUNT );
  return pool;
}

static void
do_add( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct flow_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct flow_args a;
  memcpy( &a, data, sizeof( a ) );
  if( !tn_token_is_program( a.token_prog_idx ) ) tsdk_revert( ERR_TOKEN_PROG );

  ulong amount_a = a.amount_0;
  ulong amount_b = a.amount_1;
  if( amount_a == 0UL || amount_b == 0UL ) tsdk_revert( ERR_ZERO_AMOUNT );

  pool_rec_t * pool = load_and_check( &a );

  ulong res_a = vault_balance( a.vault_a_idx );
  ulong res_b = vault_balance( a.vault_b_idx );

  ulong minted;
  if( pool->lp_supply == 0UL ) {
    /* First deposit sets the price. sqrt(a*b) makes the initial LP value
       independent of which ratio the first provider happened to pick. */
    minted = isqrt128( (uint128)amount_a * (uint128)amount_b );
    if( minted <= MIN_LIQUIDITY ) tsdk_revert( ERR_DUST );
    minted -= MIN_LIQUIDITY;   /* burned forever, so the pool can never empty */
  } else {
    if( res_a == 0UL || res_b == 0UL ) tsdk_revert( ERR_EMPTY_POOL );
    /* Whichever side is proportionally smaller decides the LP minted. Anything
       else would let a depositor skew the ratio and take value from existing
       providers. */
    minted = min_u64( mul_div( amount_a, pool->lp_supply, res_a ),
                      mul_div( amount_b, pool->lp_supply, res_b ) );
    if( minted == 0UL ) tsdk_revert( ERR_DUST );
  }

  /* Pull both sides in before minting anything. If either transfer reverts the
     whole transaction unwinds, so there is no state in which the LP tokens
     exist but the deposit does not. */
  TOKEN_CALL( tn_token_transfer( a.token_prog_idx, a.user_a_idx, a.vault_a_idx, amount_a, (tsdk_invoke_auth_t const *)0 ) );
  TOKEN_CALL( tn_token_transfer( a.token_prog_idx, a.user_b_idx, a.vault_b_idx, amount_b, (tsdk_invoke_auth_t const *)0 ) );

  TOKEN_CALL( tn_token_mint_to( a.token_prog_idx, a.lp_mint_idx, a.user_lp_idx,
                    tsdk_get_current_program_acc_idx(), minted,
                    (tsdk_invoke_auth_t const *)0 ) );

  pool->lp_supply += minted;
}

static void
do_remove( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct flow_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct flow_args a;
  memcpy( &a, data, sizeof( a ) );
  if( !tn_token_is_program( a.token_prog_idx ) ) tsdk_revert( ERR_TOKEN_PROG );

  ulong lp_amount = a.amount_0;
  if( lp_amount == 0UL ) tsdk_revert( ERR_ZERO_AMOUNT );

  pool_rec_t * pool = load_and_check( &a );
  if( pool->lp_supply == 0UL || lp_amount > pool->lp_supply ) tsdk_revert( ERR_LP_SUPPLY );

  ulong res_a = vault_balance( a.vault_a_idx );
  ulong res_b = vault_balance( a.vault_b_idx );

  ulong out_a = mul_div( lp_amount, res_a, pool->lp_supply );
  ulong out_b = mul_div( lp_amount, res_b, pool->lp_supply );
  if( out_a == 0UL && out_b == 0UL ) tsdk_revert( ERR_DUST );

  /* Burn first. A burn that fails must not be followed by a payout.
     The token program lets only the LP account's owner burn from it, and that
     owner signs this transaction as fee payer (index 0). Naming this program
     instead, as the first version did, made every REMOVE fail with token
     error 4 or 5: nobody could take liquidity out. */
  TOKEN_CALL( tn_token_burn( a.token_prog_idx, a.user_lp_idx, a.lp_mint_idx,
                 (ushort)0, lp_amount,
                 (tsdk_invoke_auth_t const *)0 ) );

  if( out_a ) TOKEN_CALL( tn_token_transfer( a.token_prog_idx, a.vault_a_idx, a.user_a_idx, out_a, (tsdk_invoke_auth_t const *)0 ) );
  if( out_b ) TOKEN_CALL( tn_token_transfer( a.token_prog_idx, a.vault_b_idx, a.user_b_idx, out_b, (tsdk_invoke_auth_t const *)0 ) );

  pool->lp_supply -= lp_amount;
}

/* SWAP reuses flow_args but reads its fields differently: vault_a/user_a are
   the INPUT side and vault_b/user_b the OUTPUT side, whichever direction the
   caller chose. The pool itself is symmetric, so direction lives entirely in
   which indices get passed. */
static void
do_swap( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct flow_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct flow_args a;
  memcpy( &a, data, sizeof( a ) );
  if( !tn_token_is_program( a.token_prog_idx ) ) tsdk_revert( ERR_TOKEN_PROG );

  ulong amount_in = a.amount_0;
  ulong min_out   = a.amount_1;
  if( amount_in == 0UL ) tsdk_revert( ERR_ZERO_AMOUNT );

  pool_rec_t * pool = open_registry( a.reg_idx, a.pool_id );
  if( !pool->in_use ) tsdk_revert( ERR_NOT_READY );

  /* Both vaults must belong to this pool, in either order. Accepting either
     order is what makes one instruction serve both directions; accepting any
     other account is what would let someone drain it. */
  tn_pubkey_t const * in_addr  = account_addr( a.vault_a_idx );
  tn_pubkey_t const * out_addr = account_addr( a.vault_b_idx );

  int in_is_a  = ( memcmp( in_addr->key,  pool->vault_a.key, 32UL ) == 0 );
  int in_is_b  = ( memcmp( in_addr->key,  pool->vault_b.key, 32UL ) == 0 );
  int out_is_a = ( memcmp( out_addr->key, pool->vault_a.key, 32UL ) == 0 );
  int out_is_b = ( memcmp( out_addr->key, pool->vault_b.key, 32UL ) == 0 );

  if( !( ( in_is_a && out_is_b ) || ( in_is_b && out_is_a ) ) ) {
    tsdk_revert( ERR_WRONG_ACCOUNT );
  }

  ulong res_in  = vault_balance( a.vault_a_idx );
  ulong res_out = vault_balance( a.vault_b_idx );
  if( res_in == 0UL || res_out == 0UL ) tsdk_revert( ERR_EMPTY_POOL );

  /* x * y = k, with the fee taken off the input before it touches the curve,
     so the fee stays in the pool and accrues to liquidity providers. */
  ulong fee_bps = (ulong)pool->fee_bps;
  ulong in_less_fee = mul_div( amount_in, BPS_DENOM - fee_bps, BPS_DENOM );
  if( in_less_fee == 0UL ) tsdk_revert( ERR_DUST );

  ulong amount_out = mul_div( res_out, in_less_fee, res_in + in_less_fee );
  if( amount_out == 0UL )      tsdk_revert( ERR_DUST );
  if( amount_out >= res_out )  tsdk_revert( ERR_EMPTY_POOL );
  if( amount_out < min_out )   tsdk_revert( ERR_SLIPPAGE );

  TOKEN_CALL( tn_token_transfer( a.token_prog_idx, a.user_a_idx, a.vault_a_idx, amount_in,  (tsdk_invoke_auth_t const *)0 ) );
  TOKEN_CALL( tn_token_transfer( a.token_prog_idx, a.vault_b_idx, a.user_b_idx, amount_out, (tsdk_invoke_auth_t const *)0 ) );

  pool->swap_count += 1UL;
}

/* ------------------------------------------------------------- entrypoint */

TSDK_ENTRYPOINT_FN void
start( void const * instruction_data,
       ulong        instruction_data_sz ) {
  uchar const * data = (uchar const *)instruction_data;

  if( instruction_data_sz < 1UL ) tsdk_revert( ERR_BAD_INSTR );

  switch( data[ 0 ] ) {
    case OP_INIT:   do_init  ( data, instruction_data_sz ); break;
    case OP_CREATE: do_create( data, instruction_data_sz ); break;
    case OP_ADD:    do_add   ( data, instruction_data_sz ); break;
    case OP_REMOVE: do_remove( data, instruction_data_sz ); break;
    case OP_SWAP:   do_swap  ( data, instruction_data_sz ); break;
    default:        tsdk_revert( ERR_BAD_OPCODE );
  }

  tsdk_return( 0UL );
}
