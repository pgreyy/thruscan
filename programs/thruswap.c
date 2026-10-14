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
 *           whose authority is this program and which has never minted. The
 *           program verifies all of that rather than taking the caller's word
 *           for it. No vault or LP mint may belong to another pool: see
 *           require_unshared for what happened before that rule existed.
 *
 *   ADD     [0x02][...][amount_a u64][amount_b u64]
 *           Deposits both sides, mints LP tokens in return.
 *
 *   REMOVE  [0x03][...][lp_amount u64]
 *           Burns LP tokens, returns a proportional share of both reserves.
 *
 *   SWAP    [0x04][...][amount_in u64][min_out u64]
 *           Trades one side for the other along the curve, after the pool's
 *           LP fee (stays in the pool) and creator fee (booked to the creator).
 *
 *   CREATE_SEEDED [0x05][same fields as CREATE]
 *           CREATE for vaults that are already funded, called by thrupad in the
 *           same instruction that moves a graduating curve's reserves in. The
 *           opening price is the ratio of what the vaults hold. The LP supply
 *           for that liquidity is recorded but never minted, so no account
 *           holds a claim on it and nobody can ever withdraw it: the seed is
 *           burned at birth. Later providers ADD against it as normal.
 *           A 51-byte form adds [creator 32][creator_bps u16]: the pool's
 *           creator fee, which is how a graduating launch passes its own.
 *
 *   SET_CREATOR_FEE    [0x06][reg_idx u16][pool_id u16][creator_bps u16]
 *           The creator, as fee payer, lowers the creator fee or turns it
 *           off. Never up, not even back to where it started.
 *
 *   CLAIM_CREATOR_FEES [0x07][token_prog u16][reg_idx u16][pool_id u16]
 *                      [vault_a u16][vault_b u16][dest_a u16][dest_b u16]
 *           The creator, as fee payer, takes out everything accrued on both
 *           sides. Nothing accrued is a revert, so a second claim fails.
 *
 *   EXTEND  [0x08][reg_idx u16]
 *           Appends the creator fee table to the registry. Anyone may call
 *           it; it does nothing a second time.
 *
 *   OPT_IN_CREATOR_FEE [0x09][reg_idx u16][pool_id u16][pad_reg_idx u16]
 *                      [launch_id u16][creator_bps u16]
 *           For a pool a launch graduated into before creator fees existed:
 *           the launch's creator, as fee payer, gives it a creator fee once,
 *           no higher than the launch's own curve fee allowed.
 *
 * ---------------------------------------------------------------------------
 * CREATOR FEES
 *
 * A swap's fee is the pool's LP fee plus its creator fee, both charged on the
 * input: 1% LP for every pool made now (older pools keep their stored rate),
 * up to 9% creator, at most 10% together. The LP part stays in the pool as before. The
 * creator part also lands in the input vault, but is booked to the creator:
 * every reserve this program prices against, adds against or pays out from is
 * the vault balance LESS what the creator is owed, so owed fees are never
 * liquidity and no swap, deposit or withdrawal can reach them. Only
 * CLAIM_CREATOR_FEES moves them, and only to whoever the creator chooses.
 *
 * The fee lives in SWAP itself, so it applies to every swap through the pool
 * whoever builds the transaction: there is no way to swap that skips it.
 *
 * The per-pool creator data does not fit in the 179-byte pool records, and
 * the registry is a fixed table of them, so it lives in a second table
 * appended after the first (see registry_layout). A registry without it, as
 * every registry was before, reads as "no creator fee" everywhere.
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
#define OP_CREATE_SEEDED (0x05)
#define OP_SET_CREATOR_FEE    (0x06)
#define OP_CLAIM_CREATOR_FEES (0x07)
#define OP_EXTEND             (0x08)
#define OP_OPT_IN_CREATOR_FEE (0x09)

/* Every fee on a swap together: LP part plus creator part, at most 10%. The
   creator part alone is at most 9%, the same ceiling thrupad puts on a
   launch's curve fee, so a launch's fee carries into its pool unchanged. */
#define TOTAL_FEE_BPS_MAX   (1000U)
#define CREATOR_BPS_MAX     (900U)

/* thrupad, whose launch records OPT_IN_CREATOR_FEE reads to learn who a
   graduated pool's creator is. Pinned for the same reason thrupad pins this
   program: whoever could name "the launchpad" could name themselves creator.
   Betanet's by default; another network builds with -DTHRUPAD_PROGRAM_ADDR. */
#ifndef THRUPAD_PROGRAM_ADDR
/* taAqm3-RUXc5JSXyUNN87-rsZtL3hAY85m268B-KwVP-E1 */
#define THRUPAD_PROGRAM_ADDR { \
  0x02,0xa9,0xb7,0xf9,0x15,0x17,0x73,0x92,0x52,0x5f,0x25,0x0d,0x37,0xce,0xfe,0xae, \
  0xc6,0x6d,0x2f,0x78,0x40,0x63,0xce,0x66,0xdb,0xaf,0x01,0xf8,0xac,0x15,0x3f,0xe1 }
#endif
static uchar const thrupad_program_addr[ 32 ] = THRUPAD_PROGRAM_ADDR;

/* thrupad's registry, only as far as OPT_IN_CREATOR_FEE reads it. */
#define PAD_HDR_SZ      (77UL)
#define PAD_LAUNCH_SZ   (253UL)
#define PAD_VERSION     ((uchar)2)
#define PAD_STATE_POOLED ((uchar)3)
#define PAD_L_FEE_BPS   (0x01UL)
#define PAD_L_CREATOR   (0x2dUL)
#define PAD_L_MINT      (0x4dUL)
#define PAD_L_QUOTE     (0xadUL)
#define PAD_L_POOL_ID   (0xf5UL)   /* start_slot, which holds the pool id once pooled */

#define SWAP_VERSION ((uchar)1)
#define REG_ACC_IDX  ((ushort)2)   /* INIT declares exactly one account */
#define POOLS_MAX    (256UL)

/* The LP fee of every pool created from now on: 1%, set here and nowhere
   else. CREATE's fee_bps field is still on the wire, so older callers keep
   working, but its value is ignored. Pools made before this keep the fee
   stored in their records (30 basis points on betanet), untouched. The fee
   stays in the pool rather than being paid out, so every swap thickens the
   reserves slightly. */
#define LP_FEE_BPS (100U)
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
#define ERR_SHARED        (24UL)  /* a vault or LP mint already belongs to another pool */
#define ERR_LP_MINT       (25UL)  /* LP mint not ours, or it has already minted */
#define ERR_NO_EXT        (26UL)  /* the registry has no creator fee table yet: run EXTEND */
#define ERR_NOT_CREATOR   (27UL)  /* the fee payer is not this pool's creator */
#define ERR_ABOVE_CAP     (28UL)  /* creator fee above its cap, or LP + creator above 1% */
#define ERR_NO_FEES       (29UL)  /* nothing accrued to claim */
#define ERR_ALREADY_SET   (30UL)  /* this pool already has a creator */
#define ERR_NOT_LAUNCH    (31UL)  /* the launch named did not graduate into this pool */

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

/* A pool's creator fee, in the table appended after the pool records. All
   zero means no creator: that is what a freshly appended table holds. */
struct __attribute__(( packed )) pool_ext {
  uchar       has_creator;
  tn_pubkey_t creator;
  ushort      creator_bps;   /* charged now */
  ushort      max_bps;       /* set once, at creation or opt-in; never raised */
  ulong       accrued_a;     /* owed to the creator, sitting in vault_a */
  ulong       accrued_b;     /* and in vault_b */
};
typedef struct pool_ext pool_ext_t;

#define HDR_SZ  (sizeof( swap_hdr_t ))
#define POOL_SZ (sizeof( pool_rec_t ))
#define EXT_SZ  (sizeof( pool_ext_t ))

FD_STATIC_ASSERT( HDR_SZ  == 37UL,  swap_hdr_size );
FD_STATIC_ASSERT( POOL_SZ == 179UL, pool_rec_size );
FD_STATIC_ASSERT( EXT_SZ  == 53UL,  pool_ext_size );

/* "TSCRFEE1", marking the start of the creator fee table. */
#define EXT_MAGIC  (0x3145454652435354UL)
#define EXT_HDR_SZ (8UL)

/* The registry is   header | slots x pool record | [ magic | slots x pool_ext ].
 *
 * Without the table, slots is (size - header) / 179, which is what INIT made
 * and how every registry was read before. With it, the size alone is not
 * proof, since a size can fit both shapes; the magic at the exact offset the
 * second shape implies is. So: try the extended shape, believe it only if the
 * magic is where it should be, and fall back to the plain one. */
static ulong
registry_layout( ulong data_sz, uchar const * base, pool_ext_t ** ext ) {
  *ext = (pool_ext_t *)0;
  if( data_sz < HDR_SZ ) return 0UL;
  ulong body = data_sz - HDR_SZ;
  if( body > EXT_HDR_SZ && ( body - EXT_HDR_SZ ) % ( POOL_SZ + EXT_SZ ) == 0UL ) {
    ulong s = ( body - EXT_HDR_SZ ) / ( POOL_SZ + EXT_SZ );
    uchar const * m = base + HDR_SZ + s * POOL_SZ;
    if( s > 0UL && TSDK_LOAD( ulong, m ) == EXT_MAGIC ) {
      *ext = (pool_ext_t *)( m + EXT_HDR_SZ );
      return s;
    }
  }
  return body / POOL_SZ;
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

/* The registry, writable, with its shape worked out. */
static uchar *
open_registry_raw( ushort reg_idx, ulong * slots, pool_ext_t ** ext ) {
  if( !tsdk_is_account_idx_valid( reg_idx ) ) tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_account_exists( reg_idx ) )       tsdk_revert( ERR_NOT_READY );
  if( !tsdk_is_account_owned_by_current_program( reg_idx ) ) tsdk_revert( ERR_NOT_OURS );

  if( tsys_set_account_data_writable( reg_idx ) != TSDK_SUCCESS ) {
    tsdk_revert( ERR_WRITE_DENIED );
  }

  uchar * base = (uchar *)tsdk_get_account_data_ptr( reg_idx );
  ulong data_sz = (ulong)tsdk_get_account_meta( reg_idx )->data_sz;
  if( data_sz < HDR_SZ ) tsdk_revert( ERR_NOT_READY );
  swap_hdr_t const * hdr = (swap_hdr_t const *)base;
  if( hdr->version != SWAP_VERSION ) tsdk_revert( ERR_NOT_READY );

  *slots = registry_layout( data_sz, base, ext );
  if( *slots == 0UL ) tsdk_revert( ERR_NOT_READY );
  return base;
}

/* One pool's record, and its creator fee entry when the table exists. */
static pool_rec_t *
open_pool( ushort reg_idx, ushort pool_id, pool_ext_t ** ext_out ) {
  ulong slots = 0UL;
  pool_ext_t * ext = (pool_ext_t *)0;
  uchar * base = open_registry_raw( reg_idx, &slots, &ext );
  if( (ulong)pool_id >= slots ) tsdk_revert( ERR_POOL_RANGE );
  if( ext_out ) *ext_out = ext ? ext + pool_id : (pool_ext_t *)0;
  return (pool_rec_t *)( base + HDR_SZ + (ulong)pool_id * POOL_SZ );
}

static pool_rec_t *
open_registry( ushort reg_idx, ushort pool_id ) {
  return open_pool( reg_idx, pool_id, (pool_ext_t **)0 );
}

/* What is owed to the creator on each side: zero with no entry. */
static ulong owed_a( pool_ext_t const * e ) { return e ? e->accrued_a : 0UL; }
static ulong owed_b( pool_ext_t const * e ) { return e ? e->accrued_b : 0UL; }
static ulong creator_bps_of( pool_ext_t const * e ) { return e && e->has_creator ? (ulong)e->creator_bps : 0UL; }

/* A vault's balance as liquidity: what it holds less what the creator is
   owed from it. A vault holding less than is owed means the books are wrong,
   and nothing should trade against books that are wrong. */
static ulong
reserve( ushort vault_idx, ulong owed ) {
  ulong held = vault_balance( vault_idx );
  if( held < owed ) tsdk_revert( ERR_EMPTY_POOL );
  return held - owed;
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

/* The LP mint has to be one only this program can mint from, and one that has
   never minted. A mint whose authority is someone else lets that someone mint
   LP tokens for nothing and burn them in REMOVE for a share of the reserves;
   the header comment above promised this check long before the code made it. */
static void
require_lp_mint( ushort idx ) {
  if( !tsdk_is_account_idx_valid( idx ) ) tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_account_exists( idx ) )       tsdk_revert( ERR_NO_ACCOUNT );

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( idx );
  if( meta->data_sz != (uint)TN_TOKEN_MINT_ACCOUNT_SZ ) tsdk_revert( ERR_LP_MINT );

  tn_token_mint_t m;
  memcpy( &m, tsdk_get_account_data_ptr( idx ), sizeof( m ) );
  tn_pubkey_t const * me = tsdk_get_current_program_acc_addr();
  if( memcmp( m.mint_authority.key, me->key, 32UL ) != 0 ) tsdk_revert( ERR_LP_MINT );
  if( m.supply != 0UL ) tsdk_revert( ERR_LP_MINT );
}

/* A vault or LP mint may belong to one pool only.
 *
 * Before this check, CREATE accepted vaults some other pool already used. A
 * second record over the same vaults starts at lp_supply 0, so its first ADD
 * mints sqrt(a*b) LP for a deposit of a and b, and REMOVE then pays out
 * lp_amount * vault_balance / lp_supply: the whole vault, including the first
 * pool's liquidity. Any pool could be emptied that way for the price of a tiny
 * deposit. Scanning every slot costs at most 256 records, once per pool. */
static void
require_unshared( ushort reg_idx, ushort pool_id,
                  tn_pubkey_t const * vault_a, tn_pubkey_t const * vault_b,
                  tn_pubkey_t const * lp_mint ) {
  if( memcmp( vault_a->key, vault_b->key, 32UL ) == 0 ) tsdk_revert( ERR_SHARED );

  uchar const * base = (uchar const *)tsdk_get_account_data_ptr( reg_idx );
  pool_ext_t * unused_ext;
  ulong cap = registry_layout( (ulong)tsdk_get_account_meta( reg_idx )->data_sz, base, &unused_ext );
  tn_pubkey_t const * mine[ 3 ] = { vault_a, vault_b, lp_mint };

  for( ulong i=0UL; i<cap; i++ ) {
    if( i == (ulong)pool_id ) continue;
    pool_rec_t const * p = (pool_rec_t const *)( base + HDR_SZ + i * POOL_SZ );
    if( !p->in_use ) continue;
    tn_pubkey_t const * theirs[ 3 ] = { &p->vault_a, &p->vault_b, &p->lp_mint };
    for( ulong x=0UL; x<3UL; x++ ) {
      for( ulong y=0UL; y<3UL; y++ ) {
        if( memcmp( mine[ x ]->key, theirs[ y ]->key, 32UL ) == 0 ) tsdk_revert( ERR_SHARED );
      }
    }
  }
}

/* Everything CREATE and CREATE_SEEDED check in common, then the record. The
   caller decides lp_supply: zero for CREATE, the burned seed for CREATE_SEEDED. */
static pool_rec_t *
create_checked( struct create_args const * a ) {

  tn_pubkey_t const * mint_a = account_addr( a->mint_a_idx );
  tn_pubkey_t const * mint_b = account_addr( a->mint_b_idx );
  if( memcmp( mint_a->key, mint_b->key, 32UL ) == 0 ) tsdk_revert( ERR_MINT_MISMATCH );

  /* The vaults are checked here, once, so that every later swap can trust the
     recorded pubkeys instead of re-deriving trust from the caller. */
  require_vault( a->vault_a_idx, mint_a );
  require_vault( a->vault_b_idx, mint_b );
  require_lp_mint( a->lp_mint_idx );

  pool_ext_t * ext = (pool_ext_t *)0;
  pool_rec_t * pool = open_pool( a->reg_idx, a->pool_id, &ext );
  if( pool->in_use ) tsdk_revert( ERR_POOL_EXISTS );
  /* A slot never used has a zero entry already; zero it anyway, so a new
     pool can never inherit a creator or a balance from anything. */
  if( ext ) memset( ext, 0, EXT_SZ );

  require_unshared( a->reg_idx, a->pool_id,
                    account_addr( a->vault_a_idx ), account_addr( a->vault_b_idx ),
                    account_addr( a->lp_mint_idx ) );

  pool_rec_t rec;
  memset( &rec, 0, sizeof( rec ) );
  rec.in_use  = 1U;
  rec.fee_bps = (ushort)LP_FEE_BPS;   /* never the caller's choice */
  memcpy( rec.mint_a.key,  mint_a->key,                         32UL );
  memcpy( rec.mint_b.key,  mint_b->key,                         32UL );
  memcpy( rec.vault_a.key, account_addr( a->vault_a_idx )->key, 32UL );
  memcpy( rec.vault_b.key, account_addr( a->vault_b_idx )->key, 32UL );
  memcpy( rec.lp_mint.key, account_addr( a->lp_mint_idx )->key, 32UL );
  memcpy( pool, &rec, POOL_SZ );

  uchar * base = (uchar *)tsdk_get_account_data_ptr( a->reg_idx );
  swap_hdr_t hdr;
  memcpy( &hdr, base, HDR_SZ );
  hdr.pool_count += 1U;
  memcpy( base, &hdr, HDR_SZ );
  return pool;
}

static void
do_create( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct create_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct create_args a;
  memcpy( &a, data, sizeof( a ) );
  create_checked( &a );
}

/* CREATE over vaults that already hold both sides. The price is their ratio,
   which thrupad set to the curve's final price in the same instruction.
   lp_supply is set to sqrt(a*b), exactly what a first ADD of the same amounts
   would have minted before its MIN_LIQUIDITY burn, but no LP token is minted
   for it. So the seed counts toward every later provider's share and can never
   be withdrawn by anyone.

   Anyone can call this, not only thrupad. That is harmless: the vaults must be
   fresh (require_unshared) and hold only what the caller put in, so the most a
   stranger can do is give their own deposit away to a pool nobody can drain. */
/* The longer CREATE_SEEDED: the 17-byte form, then who the pool's creator is
   and their fee. The short form, which thrupad sent before creator fees, still
   works and makes a pool with no creator. */
struct __attribute__(( packed )) create_creator_args {
  struct create_args base;
  tn_pubkey_t        creator;
  ushort             creator_bps;
};

static void ensure_ext( ushort reg_idx );

static void
do_create_seeded( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct create_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct create_creator_args a;
  memset( &a, 0, sizeof( a ) );
  int with_creator = data_sz >= sizeof( struct create_creator_args );
  memcpy( &a, data, with_creator ? sizeof( a ) : sizeof( struct create_args ) );

  /* The table first: resizing the registry moves its data, so it has to
     happen before anything below holds a pointer into it. */
  if( with_creator ) ensure_ext( a.base.reg_idx );

  pool_rec_t * pool = create_checked( &a.base );

  ulong res_a = vault_balance( a.base.vault_a_idx );
  ulong res_b = vault_balance( a.base.vault_b_idx );
  if( res_a == 0UL || res_b == 0UL ) tsdk_revert( ERR_EMPTY_POOL );

  ulong seed_lp = isqrt128( (uint128)res_a * (uint128)res_b );
  if( seed_lp <= MIN_LIQUIDITY ) tsdk_revert( ERR_DUST );
  pool->lp_supply = seed_lp;

  if( with_creator && a.creator_bps > 0U ) {
    if( (ulong)a.creator_bps > CREATOR_BPS_MAX ) tsdk_revert( ERR_ABOVE_CAP );
    if( (ulong)pool->fee_bps + (ulong)a.creator_bps > TOTAL_FEE_BPS_MAX ) tsdk_revert( ERR_ABOVE_CAP );
    pool_ext_t * ext = (pool_ext_t *)0;
    open_pool( a.base.reg_idx, a.base.pool_id, &ext );
    if( !ext ) tsdk_revert( ERR_NO_EXT );
    ext->has_creator = 1U;
    memcpy( ext->creator.key, a.creator.key, 32UL );
    ext->creator_bps = a.creator_bps;
    ext->max_bps     = a.creator_bps;
  }
}

/* ---------------------------------------------------------- creator fees */

/* Append the creator fee table if it is not there. The registry must be
   exactly the plain shape, header plus whole pool records; anything else is a
   registry this code does not understand, and growing it would be a guess. */
static void
ensure_ext( ushort reg_idx ) {
  ulong slots = 0UL;
  pool_ext_t * ext = (pool_ext_t *)0;
  open_registry_raw( reg_idx, &slots, &ext );
  if( ext ) return;

  ulong data_sz = (ulong)tsdk_get_account_meta( reg_idx )->data_sz;
  ulong plain   = HDR_SZ + slots * POOL_SZ;
  if( data_sz != plain ) tsdk_revert( ERR_NOT_READY );

  ulong want = plain + EXT_HDR_SZ + slots * EXT_SZ;
  ulong rc = tsys_account_resize( reg_idx, want );
  if( rc != TSDK_SUCCESS ) tsdk_revert( 0x8000UL | ( rc & 0xFFUL ) );

  uchar * base = (uchar *)tsdk_get_account_data_ptr( reg_idx );
  memset( base + plain, 0, want - plain );
  ulong magic = EXT_MAGIC;
  memcpy( base + plain, &magic, sizeof( magic ) );
}

struct __attribute__(( packed )) extend_args {
  uchar  op;
  ushort reg_idx;
};

static void
do_extend( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct extend_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct extend_args a;
  memcpy( &a, data, sizeof( a ) );
  ensure_ext( a.reg_idx );
}

/* The pool's creator must be the fee payer, which is the one signature a Thru
   transaction carries. */
static pool_ext_t *
creator_entry( ushort reg_idx, ushort pool_id ) {
  pool_ext_t * ext = (pool_ext_t *)0;
  pool_rec_t * pool = open_pool( reg_idx, pool_id, &ext );
  if( !pool->in_use ) tsdk_revert( ERR_NOT_READY );
  if( !ext )          tsdk_revert( ERR_NO_EXT );
  if( !ext->has_creator ) tsdk_revert( ERR_NOT_CREATOR );
  if( memcmp( ext->creator.key, account_addr( 0 )->key, 32UL ) != 0 ) tsdk_revert( ERR_NOT_CREATOR );
  return ext;
}

struct __attribute__(( packed )) set_fee_args {
  uchar  op;
  ushort reg_idx;
  ushort pool_id;
  ushort creator_bps;
};

static void
do_set_creator_fee( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct set_fee_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct set_fee_args a;
  memcpy( &a, data, sizeof( a ) );
  pool_ext_t * ext = creator_entry( a.reg_idx, a.pool_id );
  /* Down only. A creator can lower the fee or turn it off, and can never put
     it back up, so what a buyer was shown is the most they will ever pay.
     max_bps, the value it started at, is kept for the record. */
  if( a.creator_bps > ext->creator_bps ) tsdk_revert( ERR_ABOVE_CAP );
  ext->creator_bps = a.creator_bps;
}

struct __attribute__(( packed )) claim_args {
  uchar  op;
  ushort token_prog_idx;
  ushort reg_idx;
  ushort pool_id;
  ushort vault_a_idx;
  ushort vault_b_idx;
  ushort dest_a_idx;
  ushort dest_b_idx;
};

static void
do_claim_creator_fees( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct claim_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct claim_args a;
  memcpy( &a, data, sizeof( a ) );
  if( !tn_token_is_program( a.token_prog_idx ) ) tsdk_revert( ERR_TOKEN_PROG );

  pool_ext_t * ext = creator_entry( a.reg_idx, a.pool_id );
  pool_rec_t const * pool = open_registry( a.reg_idx, a.pool_id );
  require_addr( a.vault_a_idx, &pool->vault_a, ERR_WRONG_ACCOUNT );
  require_addr( a.vault_b_idx, &pool->vault_b, ERR_WRONG_ACCOUNT );

  ulong out_a = ext->accrued_a;
  ulong out_b = ext->accrued_b;
  if( out_a == 0UL && out_b == 0UL ) tsdk_revert( ERR_NO_FEES );
  if( vault_balance( a.vault_a_idx ) < out_a || vault_balance( a.vault_b_idx ) < out_b ) tsdk_revert( ERR_EMPTY_POOL );

  /* Zero the books before paying. A failed transfer reverts all of it, and in
     between there is no moment where the fees count as both paid and owed. */
  ext->accrued_a = 0UL;
  ext->accrued_b = 0UL;

  /* The destinations are the creator's to choose: they sign this. The token
     program checks each one holds the vault's mint. */
  if( out_a ) TOKEN_CALL( tn_token_transfer( a.token_prog_idx, a.vault_a_idx, a.dest_a_idx, out_a, (tsdk_invoke_auth_t const *)0 ) );
  if( out_b ) TOKEN_CALL( tn_token_transfer( a.token_prog_idx, a.vault_b_idx, a.dest_b_idx, out_b, (tsdk_invoke_auth_t const *)0 ) );
}

/* OPT_IN_CREATOR_FEE, for pools that graduated before creator fees existed:
 * the launch's creator gives the pool a creator fee, once.
 *
 * Who counts as the creator is read from thrupad's own record, not taken from
 * the caller: the registry must be thrupad's (pinned above), the launch must
 * be pooled into exactly this pool id, the pool's mints must be the launch's
 * token and quote, and the fee payer must be the creator thrupad recorded.
 * The fee can be no higher than the launch's curve fee, nor take the pool past
 * 1% in all. After this the entry behaves exactly as one set at creation. */
struct __attribute__(( packed )) opt_in_args {
  uchar  op;
  ushort reg_idx;
  ushort pool_id;
  ushort pad_reg_idx;
  ushort launch_id;
  ushort creator_bps;
};

static void
do_opt_in_creator_fee( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct opt_in_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct opt_in_args a;
  memcpy( &a, data, sizeof( a ) );

  ensure_ext( a.reg_idx );
  pool_ext_t * ext = (pool_ext_t *)0;
  pool_rec_t const * pool = open_pool( a.reg_idx, a.pool_id, &ext );
  if( !pool->in_use ) tsdk_revert( ERR_NOT_READY );
  if( !ext )          tsdk_revert( ERR_NO_EXT );
  if( ext->has_creator ) tsdk_revert( ERR_ALREADY_SET );

  /* The launch, from thrupad's registry. */
  if( !tsdk_is_account_idx_valid( a.pad_reg_idx ) || !tsdk_account_exists( a.pad_reg_idx ) ) tsdk_revert( ERR_NO_ACCOUNT );
  tsdk_account_meta_t const * pm = tsdk_get_account_meta( a.pad_reg_idx );
  if( memcmp( pm->owner.key, thrupad_program_addr, 32UL ) != 0 ) tsdk_revert( ERR_NOT_LAUNCH );
  uchar const * pb = (uchar const *)tsdk_get_account_data_ptr( a.pad_reg_idx );
  ulong off = PAD_HDR_SZ + (ulong)a.launch_id * PAD_LAUNCH_SZ;
  if( (ulong)pm->data_sz < off + PAD_LAUNCH_SZ || pb[ 0 ] != PAD_VERSION ) tsdk_revert( ERR_NOT_LAUNCH );
  uchar const * l = pb + off;
  if( l[ 0 ] != PAD_STATE_POOLED )                              tsdk_revert( ERR_NOT_LAUNCH );
  if( TSDK_LOAD( ulong, l + PAD_L_POOL_ID ) != (ulong)a.pool_id ) tsdk_revert( ERR_NOT_LAUNCH );
  int mints_match =
    ( !memcmp( pool->mint_a.key, l + PAD_L_QUOTE, 32UL ) && !memcmp( pool->mint_b.key, l + PAD_L_MINT,  32UL ) ) ||
    ( !memcmp( pool->mint_a.key, l + PAD_L_MINT,  32UL ) && !memcmp( pool->mint_b.key, l + PAD_L_QUOTE, 32UL ) );
  if( !mints_match ) tsdk_revert( ERR_NOT_LAUNCH );
  if( memcmp( l + PAD_L_CREATOR, account_addr( 0 )->key, 32UL ) != 0 ) tsdk_revert( ERR_NOT_CREATOR );

  /* Zero here would use up the one opt-in on nothing, for good. */
  if( a.creator_bps == 0U ) tsdk_revert( ERR_ZERO_AMOUNT );
  ulong launch_bps = (ulong)TSDK_LOAD( ushort, l + PAD_L_FEE_BPS );
  if( (ulong)a.creator_bps > launch_bps )      tsdk_revert( ERR_ABOVE_CAP );
  if( (ulong)a.creator_bps > CREATOR_BPS_MAX ) tsdk_revert( ERR_ABOVE_CAP );
  if( (ulong)pool->fee_bps + (ulong)a.creator_bps > TOTAL_FEE_BPS_MAX ) tsdk_revert( ERR_ABOVE_CAP );

  ext->has_creator = 1U;
  memcpy( ext->creator.key, l + PAD_L_CREATOR, 32UL );
  ext->creator_bps = a.creator_bps;
  ext->max_bps     = a.creator_bps;
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
load_and_check( struct flow_args const * a, pool_ext_t ** ext ) {
  pool_rec_t * pool = open_pool( a->reg_idx, a->pool_id, ext );
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

  pool_ext_t * ext = (pool_ext_t *)0;
  pool_rec_t * pool = load_and_check( &a, &ext );

  /* Liquidity is what the vaults hold less what the creator is owed. */
  ulong res_a = reserve( a.vault_a_idx, owed_a( ext ) );
  ulong res_b = reserve( a.vault_b_idx, owed_b( ext ) );

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

  pool_ext_t * ext = (pool_ext_t *)0;
  pool_rec_t * pool = load_and_check( &a, &ext );
  if( pool->lp_supply == 0UL || lp_amount > pool->lp_supply ) tsdk_revert( ERR_LP_SUPPLY );

  /* A provider's share is of the liquidity, never of the creator's fees. */
  ulong res_a = reserve( a.vault_a_idx, owed_a( ext ) );
  ulong res_b = reserve( a.vault_b_idx, owed_b( ext ) );

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

  pool_ext_t * ext = (pool_ext_t *)0;
  pool_rec_t * pool = open_pool( a.reg_idx, a.pool_id, &ext );
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

  /* Reserves are what the vaults hold less what the creator is owed, on each
     side. Owed fees sit in the vaults but are not the pool's to trade. */
  ulong owed_in  = in_is_a ? owed_a( ext ) : owed_b( ext );
  ulong owed_out = in_is_a ? owed_b( ext ) : owed_a( ext );
  ulong res_in   = reserve( a.vault_a_idx, owed_in );
  ulong res_out  = reserve( a.vault_b_idx, owed_out );
  if( res_in == 0UL || res_out == 0UL ) tsdk_revert( ERR_EMPTY_POOL );

  /* x * y = k, with the whole fee taken off the input before it touches the
     curve. The LP part stays in the pool for liquidity providers; the creator
     part is booked to the creator. The total is rounded UP (by flooring what
     reaches the curve) and the creator part DOWN, so every rounding unit goes
     to the pool, never to the swapper, and the creator part can never exceed
     the fee actually withheld. */
  ulong lp_bps      = (ulong)pool->fee_bps;
  ulong creator_bps = creator_bps_of( ext );
  if( lp_bps + creator_bps > TOTAL_FEE_BPS_MAX && creator_bps > 0UL ) tsdk_revert( ERR_ABOVE_CAP );
  ulong in_less_fee = mul_div( amount_in, BPS_DENOM - lp_bps - creator_bps, BPS_DENOM );
  if( in_less_fee == 0UL ) tsdk_revert( ERR_DUST );
  ulong creator_cut = mul_div( amount_in, creator_bps, BPS_DENOM );

  if( res_in > 0xFFFFFFFFFFFFFFFFUL - in_less_fee ) tsdk_revert( ERR_OVERFLOW );
  ulong amount_out = mul_div( res_out, in_less_fee, res_in + in_less_fee );
  if( amount_out == 0UL )      tsdk_revert( ERR_DUST );
  if( amount_out >= res_out )  tsdk_revert( ERR_EMPTY_POOL );
  if( amount_out < min_out )   tsdk_revert( ERR_SLIPPAGE );

  if( creator_cut ) {
    if( in_is_a ) {
      if( ext->accrued_a > 0xFFFFFFFFFFFFFFFFUL - creator_cut ) tsdk_revert( ERR_OVERFLOW );
      ext->accrued_a += creator_cut;
    } else {
      if( ext->accrued_b > 0xFFFFFFFFFFFFFFFFUL - creator_cut ) tsdk_revert( ERR_OVERFLOW );
      ext->accrued_b += creator_cut;
    }
  }

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
    case OP_CREATE_SEEDED:      do_create_seeded     ( data, instruction_data_sz ); break;
    case OP_SET_CREATOR_FEE:    do_set_creator_fee   ( data, instruction_data_sz ); break;
    case OP_CLAIM_CREATOR_FEES: do_claim_creator_fees( data, instruction_data_sz ); break;
    case OP_EXTEND:             do_extend            ( data, instruction_data_sz ); break;
    case OP_OPT_IN_CREATOR_FEE: do_opt_in_creator_fee( data, instruction_data_sz ); break;
    default:        tsdk_revert( ERR_BAD_OPCODE );
  }

  tsdk_return( 0UL );
}
