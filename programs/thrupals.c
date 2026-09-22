/* thrupals - Pixel Pals: a fixed-supply NFT collection with a paid public mint
 * and its own market.
 *
 * Thru's NFT program (taVRt8dNq3B1IGXWpYx17GWEfFcpmU8LF9uWy75XIIcA03) lets the
 * COLLECTION'S AUTHORITY mint and move NFTs; a holder cannot move their own NFT
 * directly (checked on alphanet). So this program is that authority. Everything
 * that touches a Pal goes through it, which is what makes the rules below
 * enforceable rather than promised:
 *
 *   - exactly `supply` Pals, numbered 0..supply-1
 *   - each public mint gets a RANDOM number among those still free, drawn on
 *     chain from the previous block's hash, the current state root, the slot
 *     and the minting wallet; nobody knows those when they sign, so nobody can
 *     aim for a number
 *   - one mint per wallet, ever
 *   - only wallets on the allowlist can mint (ThruScan's server adds a wallet
 *     after its per-IP weekly cap check; the program keeps the list)
 *   - each mint pays `price` of the payment token (WTHRU, one base unit per
 *     native THRU) straight to the treasury account fixed at INIT; this
 *     program never holds mint money, so nobody can withdraw it from here
 *   - numbers marked reserved are never drawn for the public; GIFT mints them
 *     to the reserve wallet fixed at INIT, free, in any order
 *   - a Pal moves only when the wallet holding it signs (SEND, LIST, DELIST)
 *     or when someone buys it at the price its seller listed it for (BUY);
 *     the seller is paid in the same transaction, less the market fee, which
 *     goes to the treasury
 *   - a Pal's prize, if it has one, is paid only to the wallet holding it,
 *     signing for itself (CLAIM), once
 *
 * Pal numbers and NFT ids are different things. The NFT program numbers NFTs
 * 0, 1, 2... in mint order and derives each NFT account from (mint, NFT id);
 * the Pal number is in the NFT's uri and is what everyone sees. The config
 * records both directions (nft_of, order).
 *
 * Current holders are tracked here, not read from NFT accounts passed in: every
 * transfer goes through this program, so its own record is authoritative and a
 * forged account can never impersonate a holder.
 *
 * The admin (the INIT fee payer) can add wallets to the allowlist, name a
 * second key (the "allower", ThruScan's server) that may also add them and
 * GIFT reserved numbers, set prizes before they are locked, lock them, create
 * the market and set its fee (at most 10%). The admin cannot change the price,
 * the supply or the treasury, cannot move anyone's Pal and cannot take prize
 * money back out.
 *
 * Every program this one calls is checked by address before the call: the
 * token program and the NFT program are fixed constants, never whatever the
 * caller names. Otherwise a caller could name a program of their own that
 * accepts the "payment" and does nothing.
 *
 * An account is only ever marked writable when it is about to change: on
 * alphanet an account marked writable and left as it was fails the RPC node's
 * consistency check until its next real write, so reads of it break.
 *
 * ---------------------------------------------------------------------------
 * ACCOUNTS
 *
 * The config, owned by this program (n = supply, B = (n+7)/8):
 *
 *   header (struct cfg_hdr)
 *   owners   [n][32]   current holder of each Pal number (zero = not minted)
 *   minters  [n][32]   wallet that minted each Pal number
 *   prizes   [n] u64   prize in payment-token base units, 0 = none
 *   claimed  [B]       bitmap by number
 *   reserved [B]       bitmap by number: kept for the reserve wallet
 *   minted   [B]       bitmap by number
 *   nft_of   [n] u16   NFT id of each minted number
 *   order    [n] u16   Pal number of each NFT id, in mint order
 *   allow    [max_allow] { wallet[32], tag u64, slot u64 }   a ring
 *
 * The market, owned by this program, made by MARKET:
 *
 *   header (struct mkt_hdr)
 *   listings [n] { seller[32], payout[32], price u64, slot u64 }   by number
 *   sales    [SALES_RING] { number u32, price u64, buyer[32], seller[32], slot u64 }
 *
 * A listed Pal is held by this program (its NFT account's owner and owners[]
 * both say so), so it cannot be sent, claimed against or sold twice while
 * listed, and a listing can never outlive the seller's ownership.
 *
 * ---------------------------------------------------------------------------
 * INSTRUCTIONS (u16 fields are indices into the transaction's account list;
 * `num` is a Pal number)
 *
 *   INIT    [0x00][seed 32][nft_mint u16][treasury u16][pay_mint u16]
 *           [allower u16][reserve u16][supply u32][max_allow u32][price u64][uri_len u8]
 *           [uri][proof]              Config is the only read-write account: index 2.
 *   ALLOW   [0x01][cfg][wallet][tag u64]                      admin or allower
 *   MINT    [0x02][cfg][nft_prog][nft_mint][nft_acct][token_prog][pay_from][treasury]
 *           [proof]   nft_acct is the NFT account for the next NFT id; the
 *           proof is its creation proof. The number is drawn here.
 *   SEND    [0x03][cfg][nft_prog][nft_mint][nft_acct][dest][num u32]   holder
 *   PRIZES  [0x04][cfg][count u16] then count x { num u32, amount u64 }  admin, before LOCK
 *   LOCK    [0x05][cfg][prize_vault]                           admin
 *   CLAIM   [0x06][cfg][token_prog][prize_vault][dest][num u32]         holder
 *   ALLOWER [0x07][cfg][allower]                               admin
 *   RESERVE   [0x08][cfg][count u16] then count x num u32      admin, unminted only
 *   UNRESERVE [0x09][cfg][count u16] then count x num u32      admin, unminted only
 *   GIFT    [0x0A][cfg][nft_prog][nft_mint][nft_acct][reserve][num u32][proof]
 *           admin or allower; num must be reserved and not minted
 *   MARKET  [0x0B][seed 32][cfg][fee_bps u16][proof]           admin; market is index 2
 *   FEE     [0x0C][market][cfg][fee_bps u16]                   admin
 *   LIST    [0x0D][cfg][market][nft_prog][nft_mint][nft_acct][escrow][payout][num u32][price u64]
 *           holder; listing a Pal already listed by the same seller changes its price
 *   DELIST  [0x0E][cfg][market][nft_prog][nft_mint][nft_acct][num u32]  seller
 *   BUY     [0x0F][cfg][market][nft_prog][nft_mint][token_prog][pay_from][fee_to][count u8]
 *           then count x { nft_acct u16, payout u16, num u32, max_price u64 }
 *           all or nothing
 *   MIGRATE [0x10][cfg]   admin; turns a version 2 config (numbers minted in
 *           order) into this layout in place. Every number minted so far is
 *           its own NFT id, so the maps are filled with number = id.
 *
 * Thru NFT program instructions used (from its on-chain ABI, checked live):
 *   mint_to   [u32 1][mint u16][nft u16][owner u16][flags u64][uri 256][proof]
 *   transfer  [u32 2][nft u16][new_owner u16][mint u16]
 */

#include <thru-sdk/c/tn_sdk.h>
#include <thru-sdk/c/tn_sdk_syscall.h>
#include <thru-sdk/c/tn_sdk_sha256.h>

#include "thru_token.h"

#define OP_INIT      (0x00)
#define OP_ALLOW     (0x01)
#define OP_MINT      (0x02)
#define OP_SEND      (0x03)
#define OP_PRIZES    (0x04)
#define OP_LOCK      (0x05)
#define OP_CLAIM     (0x06)
#define OP_ALLOWER   (0x07)
#define OP_RESERVE   (0x08)
#define OP_UNRESERVE (0x09)
#define OP_GIFT      (0x0A)
#define OP_MARKET    (0x0B)
#define OP_FEE       (0x0C)
#define OP_LIST      (0x0D)
#define OP_DELIST    (0x0E)
#define OP_BUY       (0x0F)
#define OP_MIGRATE   (0x10)

#define CFG_VERSION  ((uchar)3)

/* Thru's NFT program, taVRt8dNq3B1IGXWpYx17GWEfFcpmU8LF9uWy75XIIcA03. */
static uchar const NFT_PROGRAM[ 32 ] = {
  0x55,0x1b,0x7c,0x74,0xda,0xb7,0x07,0x52,0x06,0x5d,0x6a,0x58,0xc7,0x5e,0xc6,0x58,
  0x47,0xc5,0x72,0x99,0x94,0xf0,0xb1,0x7d,0xb9,0x6c,0xbb,0xe5,0x72,0x08,0x70,0x0d };
#define INIT_IDX ((ushort)2)

#define SUPPLY_MAX    (10000U)
#define ALLOW_MAX     (20000U)
#define URI_BASE_MAX  (200UL)
#define NFT_URI_SZ    (256UL)
#define NFT_MINT_SZ   (48UL)    /* mint_authority[32] supply u64 next_id u64 */
#define NFT_ACCT_SZ   (336UL)   /* mint[32] owner[32] id u64 flags u64 uri[256] */
#define PROOF_MAX     (1024UL)    /* a creation proof is about 200 bytes */

#define NFT_OP_MINT_TO  (1U)
#define NFT_OP_TRANSFER (2U)

#define ERR_BAD_INSTR      (1UL)
#define ERR_BAD_OPCODE     (2UL)
#define ERR_NO_ACCOUNT     (3UL)
#define ERR_NOT_OURS       (4UL)
#define ERR_NOT_READY      (5UL)
#define ERR_CREATE_FAILED  (7UL)
#define ERR_WRITE_DENIED   (8UL)
#define ERR_RANGE          (9UL)
#define ERR_BAD_IDX        (11UL)
#define ERR_WRONG_ACCOUNT  (12UL)
#define ERR_NOT_ADMIN      (13UL)
#define ERR_SOLD_OUT       (14UL)
#define ERR_NOT_ALLOWED    (15UL)
#define ERR_ALREADY_MINTED (16UL)
#define ERR_NOT_HOLDER     (17UL)
#define ERR_LOCKED         (18UL)
#define ERR_NOT_LOCKED     (19UL)
#define ERR_NO_PRIZE       (20UL)
#define ERR_CLAIMED        (21UL)
#define ERR_OUT_OF_SYNC    (23UL)
#define ERR_BAD_TOKEN_ACC  (24UL)
#define ERR_SELF           (25UL)
#define ERR_WRONG_PROGRAM  (26UL)  /* a named program is not the expected one */
#define ERR_NOT_RESERVED   (29UL)  /* GIFT only mints reserved, unminted numbers */
#define ERR_NOT_LISTED     (30UL)  /* that Pal is not for sale */
#define ERR_PRICE          (31UL)  /* the price is above what the buyer agreed to */
#define ERR_BAD_MARKET     (32UL)  /* not this collection's market account */
#define ERR_PAYMENT        (0x0300UL)  /* | low byte of the token CPI's code */
#define ERR_NFT_CPI        (0x0400UL)  /* | low byte of the NFT CPI's code   */

/* --------------------------------------------------------------- storage */

struct __attribute__(( packed )) cfg_hdr {
  uchar       version;
  uchar       prizes_locked;
  tn_pubkey_t admin;
  tn_pubkey_t nft_mint;
  tn_pubkey_t treasury;
  tn_pubkey_t pay_mint;
  tn_pubkey_t prize_vault;
  tn_pubkey_t allower;
  ulong       price;
  uint        supply;
  uint        minted;        /* all mints, public and gifted; = the NFT program's next id */
  uint        max_allow;
  uint        allow_cnt;     /* total ever added; the ring slot is this % max_allow */
  uchar       uri_len;
  uchar       uri[ URI_BASE_MAX ];
  tn_pubkey_t reserve_wallet;
  uint        reserved_cnt;  /* numbers marked reserved (minted or not) */
  uint        gifted;        /* reserved numbers minted by GIFT */
};
typedef struct cfg_hdr cfg_hdr_t;

struct __attribute__(( packed )) allow_rec {
  tn_pubkey_t wallet;
  ulong       tag;
  ulong       slot;
};
typedef struct allow_rec allow_rec_t;

#define HDR_SZ   (sizeof( cfg_hdr_t ))
#define ALLOW_SZ (sizeof( allow_rec_t ))

FD_STATIC_ASSERT( HDR_SZ   == 459UL, cfg_hdr_size );
FD_STATIC_ASSERT( ALLOW_SZ == 48UL,  allow_rec_size );

static inline ulong bits_sz    ( ulong n ) { return ( n + 7UL ) / 8UL; }
static inline ulong off_owners ( void )    { return HDR_SZ; }
static inline ulong off_minters( ulong n ) { return HDR_SZ + n * 32UL; }
static inline ulong off_prizes ( ulong n ) { return HDR_SZ + n * 64UL; }
static inline ulong off_claimed( ulong n ) { return HDR_SZ + n * 72UL; }
static inline ulong off_reserved( ulong n ){ return off_claimed( n ) + bits_sz( n ); }
static inline ulong off_mintedb( ulong n ) { return off_reserved( n ) + bits_sz( n ); }
static inline ulong off_nft_of ( ulong n ) { return off_mintedb( n ) + bits_sz( n ); }
static inline ulong off_order  ( ulong n ) { return off_nft_of( n ) + n * 2UL; }
static inline ulong off_allow  ( ulong n ) { return off_order( n ) + n * 2UL; }
static inline ulong cfg_size   ( ulong n, ulong a ) { return off_allow( n ) + a * ALLOW_SZ; }

#define MKT_VERSION  ((uchar)0x4D)   /* 'M': never equal to CFG_VERSION */
#define SALES_RING   (64UL)
#define FEE_BPS_MAX  (1000U)         /* 10% */
#define PRICE_MAX    (1000000000000000UL)
#define BUY_MAX      (16U)

struct __attribute__(( packed )) mkt_hdr {
  uchar       version;
  uchar       pad;
  ushort      fee_bps;
  tn_pubkey_t cfg;
  uint        supply;
  uint        listed;
  uint        sales;
  ulong       volume;
};
typedef struct mkt_hdr mkt_hdr_t;

struct __attribute__(( packed )) listing {
  tn_pubkey_t seller;
  tn_pubkey_t payout;
  ulong       price;
  ulong       slot;
};
typedef struct listing listing_t;

struct __attribute__(( packed )) sale_rec {
  uint        num;
  ulong       price;
  tn_pubkey_t buyer;
  tn_pubkey_t seller;
  ulong       slot;
};
typedef struct sale_rec sale_rec_t;

#define MKT_HDR_SZ (sizeof( mkt_hdr_t ))
#define LISTING_SZ (sizeof( listing_t ))
#define SALE_SZ    (sizeof( sale_rec_t ))
FD_STATIC_ASSERT( MKT_HDR_SZ == 56UL, mkt_hdr_size );
FD_STATIC_ASSERT( LISTING_SZ == 80UL, listing_size );
FD_STATIC_ASSERT( SALE_SZ    == 84UL, sale_size );

static inline ulong mkt_off_sales( ulong n ) { return MKT_HDR_SZ + n * LISTING_SZ; }
static inline ulong mkt_size     ( ulong n ) { return mkt_off_sales( n ) + SALES_RING * SALE_SZ; }

/* ---------------------------------------------------------- account helpers */

static tn_pubkey_t const *
account_addr( ushort idx ) {
  tsdk_txn_t const * txn = tsdk_get_txn();
  if( idx >= tsdk_txn_account_cnt( txn ) ) tsdk_revert( ERR_BAD_IDX );
  return &tsdk_txn_get_acct_addrs( txn )[ idx ];
}

static int
same( tn_pubkey_t const * a, tn_pubkey_t const * b ) {
  return memcmp( a->key, b->key, 32UL ) == 0;
}

static void
require_addr( ushort idx, tn_pubkey_t const * expected ) {
  if( !same( account_addr( idx ), expected ) ) tsdk_revert( ERR_WRONG_ACCOUNT );
}

static void
require_nft_program( ushort idx ) {
  if( memcmp( account_addr( idx )->key, NFT_PROGRAM, 32UL ) != 0 ) tsdk_revert( ERR_WRONG_PROGRAM );
}

static void
require_token_program( ushort idx ) {
  if( !tn_token_is_program( idx ) ) tsdk_revert( ERR_WRONG_PROGRAM );
}

/* An account must be owned (in the runtime's sense) by the given program. */
static void
require_owned_by( ushort idx, uchar const * prog ) {
  if( !tsdk_is_account_idx_valid( idx ) ) tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_account_exists( idx ) )       tsdk_revert( ERR_NO_ACCOUNT );
  if( memcmp( tsdk_get_account_meta( idx )->owner.key, prog, 32UL ) != 0 ) tsdk_revert( ERR_WRONG_ACCOUNT );
}

static int
is_zero( uchar const * p ) {
  for( ulong i=0UL; i<32UL; i++ ) if( p[ i ] ) return 0;
  return 1;
}

static int
bit( uchar const * bits, ulong i ) { return ( bits[ i >> 3 ] >> ( i & 7UL ) ) & 1; }

static void
set_bit( uchar * bits, ulong i ) { bits[ i >> 3 ] = (uchar)( bits[ i >> 3 ] | ( 1U << ( i & 7UL ) ) ); }

static void
clear_bit( uchar * bits, ulong i ) { bits[ i >> 3 ] = (uchar)( bits[ i >> 3 ] & ~( 1U << ( i & 7UL ) ) ); }

static ushort
get_u16( uchar const * p ) { ushort v; memcpy( &v, p, 2UL ); return v; }

static void
put_u16( uchar * p, ushort v ) { memcpy( p, &v, 2UL ); }

/* Reads the config without asking to write it, checking that it is ours,
   initialised, and exactly the size its header says. */
static uchar const *
read_cfg( ushort idx, cfg_hdr_t * hdr ) {
  if( !tsdk_is_account_idx_valid( idx ) ) tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_account_exists( idx ) )       tsdk_revert( ERR_NOT_READY );
  if( !tsdk_is_account_owned_by_current_program( idx ) ) tsdk_revert( ERR_NOT_OURS );
  uchar const * base = (uchar const *)tsdk_get_account_data_ptr( idx );
  tsdk_account_meta_t const * meta = tsdk_get_account_meta( idx );
  if( (ulong)meta->data_sz < HDR_SZ ) tsdk_revert( ERR_NOT_READY );
  memcpy( hdr, base, HDR_SZ );
  if( hdr->version != CFG_VERSION ) tsdk_revert( ERR_NOT_READY );
  if( (ulong)meta->data_sz != cfg_size( (ulong)hdr->supply, (ulong)hdr->max_allow ) ) tsdk_revert( ERR_NOT_READY );
  return base;
}

/* The same, then marked writable. Only call this when the data will change. */
static uchar *
open_cfg( ushort idx, cfg_hdr_t * hdr ) {
  (void)read_cfg( idx, hdr );
  if( tsys_set_account_data_writable( idx ) != TSDK_SUCCESS ) tsdk_revert( ERR_WRITE_DENIED );
  return (uchar *)tsdk_get_account_data_ptr( idx );
}

/* Checks the market without asking to write it: ours, a market (not a
   config), made for this config, and exactly the size its supply says. */
static uchar const *
check_mkt( ushort idx, ushort cfg_idx, cfg_hdr_t const * hdr, mkt_hdr_t * m ) {
  if( !tsdk_is_account_idx_valid( idx ) ) tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_account_exists( idx ) )       tsdk_revert( ERR_BAD_MARKET );
  if( !tsdk_is_account_owned_by_current_program( idx ) ) tsdk_revert( ERR_BAD_MARKET );
  uchar const * base = (uchar const *)tsdk_get_account_data_ptr( idx );
  tsdk_account_meta_t const * meta = tsdk_get_account_meta( idx );
  if( (ulong)meta->data_sz < MKT_HDR_SZ ) tsdk_revert( ERR_BAD_MARKET );
  memcpy( m, base, MKT_HDR_SZ );
  if( m->version != MKT_VERSION ) tsdk_revert( ERR_BAD_MARKET );
  if( m->supply != hdr->supply )  tsdk_revert( ERR_BAD_MARKET );
  if( (ulong)meta->data_sz != mkt_size( (ulong)m->supply ) ) tsdk_revert( ERR_BAD_MARKET );
  if( !same( &m->cfg, account_addr( cfg_idx ) ) ) tsdk_revert( ERR_BAD_MARKET );
  return base;
}

static uchar *
open_mkt( ushort idx, ushort cfg_idx, cfg_hdr_t const * hdr, mkt_hdr_t * m ) {
  (void)check_mkt( idx, cfg_idx, hdr, m );
  if( tsys_set_account_data_writable( idx ) != TSDK_SUCCESS ) tsdk_revert( ERR_WRITE_DENIED );
  return (uchar *)tsdk_get_account_data_ptr( idx );
}

static void
require_admin( cfg_hdr_t const * hdr ) {
  if( !same( account_addr( 0 ), &hdr->admin ) ) tsdk_revert( ERR_NOT_ADMIN );
}

static void
require_admin_or_allower( cfg_hdr_t const * hdr ) {
  tn_pubkey_t const * payer = account_addr( 0 );
  if( !same( payer, &hdr->admin ) && !same( payer, &hdr->allower ) ) tsdk_revert( ERR_NOT_ADMIN );
}

static int
is_token_program_key( uchar const * k ) {
  for( ulong i=0UL; i<31UL; i++ ) if( k[ i ] ) return 0;
  return k[ 31 ] == (uchar)0xaa;
}

/* A token account for the payment mint owned by `owner`. The token program
   enforces all of this again during a transfer; checking here gives a clear
   error code instead of a bare CPI failure. */
static void
require_token_acc( ushort idx, tn_pubkey_t const * mint, tn_pubkey_t const * owner ) {
  if( !tsdk_is_account_idx_valid( idx ) ) tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_account_exists( idx ) )       tsdk_revert( ERR_NO_ACCOUNT );
  tsdk_account_meta_t const * meta = tsdk_get_account_meta( idx );
  if( (ulong)meta->data_sz != TN_TOKEN_TOKEN_ACCOUNT_SZ ) tsdk_revert( ERR_BAD_TOKEN_ACC );
  if( !is_token_program_key( meta->owner.key ) ) tsdk_revert( ERR_BAD_TOKEN_ACC );
  uchar const * d = (uchar const *)tsdk_get_account_data_ptr( idx );
  if( memcmp( d, mint->key, 32UL ) != 0 )       tsdk_revert( ERR_BAD_TOKEN_ACC );
  if( memcmp( d + 32, owner->key, 32UL ) != 0 ) tsdk_revert( ERR_BAD_TOKEN_ACC );
}

static ulong
nft_next_id( ushort mint_idx ) {
  if( !tsdk_account_exists( mint_idx ) ) tsdk_revert( ERR_NO_ACCOUNT );
  tsdk_account_meta_t const * meta = tsdk_get_account_meta( mint_idx );
  if( (ulong)meta->data_sz != NFT_MINT_SZ ) tsdk_revert( ERR_WRONG_ACCOUNT );
  uchar const * d = (uchar const *)tsdk_get_account_data_ptr( mint_idx );
  ulong next = 0UL;
  memcpy( &next, d + 40, 8UL );
  return next;
}

/* Calls the NFT program. A callee revert does not return (its code becomes the
   transaction's); a rejected invocation returns here and is reported as
   ERR_NFT_CPI with the syscall's code in the low byte. */
static void
nft_invoke( void const * ix, ulong ix_sz, ushort nft_prog_idx ) {
  ulong callee_err = 0UL;
  ulong rc = tsys_invoke( ix, ix_sz, nft_prog_idx, (tsdk_invoke_auth_t const *)0, &callee_err );
  if( rc != TSDK_SUCCESS ) tsdk_revert( ERR_NFT_CPI | ( rc & 0xFFUL ) );
  if( callee_err != 0UL )  tsdk_revert( ERR_NFT_CPI | ( callee_err & 0xFFUL ) );
}

static ulong
write_decimal( uchar * out, ulong v ) {
  uchar tmp[ 20 ];
  ulong n = 0UL;
  do { tmp[ n++ ] = (uchar)( '0' + ( v % 10UL ) ); v /= 10UL; } while( v && n < 20UL );
  for( ulong i=0UL; i<n; i++ ) out[ i ] = tmp[ n - 1UL - i ];
  return n;
}

static void
pay( ushort token_prog_idx, ushort from_idx, ushort to_idx, ulong amount ) {
  if( amount == 0UL ) return;
  ulong rc = tn_token_transfer( token_prog_idx, from_idx, to_idx, amount, (tsdk_invoke_auth_t const *)0 );
  if( rc != 0UL ) tsdk_revert( ERR_PAYMENT | ( rc & 0xFFUL ) );
}

/* ------------------------------------------------------- minting a Pal */

/* The NFT program's mint_to, built here: this collection, the next NFT
   account, the given owner, no flags, uri = base + Pal number, then the
   caller's creation proof for that NFT account. */
struct __attribute__(( packed )) nft_mint_to_hdr {
  uint   op;
  ushort mint_idx;
  ushort nft_idx;
  ushort owner_idx;
  ulong  flags;
  uchar  uri[ NFT_URI_SZ ];
};
FD_STATIC_ASSERT( sizeof( struct nft_mint_to_hdr ) == 274UL, nft_mint_to_hdr_size );

/* Mints NFT id `hdr->minted` as Pal `num` to the account at `owner_idx` and
   records it. `base` is the config, open for writing. */
static void
mint_pal( uchar * base, cfg_hdr_t * hdr, ushort nft_prog_idx, ushort nft_mint_idx, ushort nft_acct_idx,
          ushort owner_idx, ulong num, uchar const * proof, ulong proof_sz ) {
  ulong n  = (ulong)hdr->supply;
  ulong id = (ulong)hdr->minted;
  if( proof_sz == 0UL || proof_sz > PROOF_MAX ) tsdk_revert( ERR_BAD_INSTR );
  if( nft_next_id( nft_mint_idx ) != id ) tsdk_revert( ERR_OUT_OF_SYNC );

  uchar mint_ix_buf[ sizeof( struct nft_mint_to_hdr ) + PROOF_MAX ];
  struct nft_mint_to_hdr h;
  memset( &h, 0, sizeof( h ) );
  h.op        = NFT_OP_MINT_TO;
  h.mint_idx  = nft_mint_idx;
  h.nft_idx   = nft_acct_idx;
  h.owner_idx = owner_idx;
  h.flags     = 0UL;
  memcpy( h.uri, hdr->uri, (ulong)hdr->uri_len );
  (void)write_decimal( h.uri + hdr->uri_len, num );
  memcpy( mint_ix_buf, &h, sizeof( h ) );
  memcpy( mint_ix_buf + sizeof( h ), proof, proof_sz );
  nft_invoke( mint_ix_buf, sizeof( h ) + proof_sz, nft_prog_idx );

  /* The NFT program must have counted it; if it did not, nothing here moves. */
  if( nft_next_id( nft_mint_idx ) != id + 1UL ) tsdk_revert( ERR_OUT_OF_SYNC );

  tn_pubkey_t const * owner = account_addr( owner_idx );
  memcpy( base + off_owners()     + num * 32UL, owner->key, 32UL );
  memcpy( base + off_minters( n ) + num * 32UL, owner->key, 32UL );
  set_bit( base + off_mintedb( n ), num );
  put_u16( base + off_nft_of( n ) + num * 2UL, (ushort)id );
  put_u16( base + off_order( n )  + id  * 2UL, (ushort)num );
  hdr->minted += 1U;
}

/* A minted Pal number, in range. */
static void
require_minted( uchar const * base, cfg_hdr_t const * hdr, uint num ) {
  if( num >= hdr->supply ) tsdk_revert( ERR_RANGE );
  if( !bit( base + off_mintedb( (ulong)hdr->supply ), num ) ) tsdk_revert( ERR_RANGE );
}

struct __attribute__(( packed )) nft_transfer_ix {
  uint   op;
  ushort nft_idx;
  ushort dest_idx;
  ushort mint_idx;
};

/* Moves Pal `num` to the account at `dest_idx`, checking that the NFT account
   is the NFT program's, of this collection, with that Pal's NFT id, and that
   it really moved. This program is the collection's authority, so the NFT
   program accepts the call. */
static void
move_pal( uchar const * base, cfg_hdr_t const * hdr, ushort nft_prog_idx, ushort nft_mint_idx,
          ushort nft_acct_idx, ushort dest_idx, uint num ) {
  require_nft_program( nft_prog_idx );
  require_addr( nft_mint_idx, &hdr->nft_mint );
  require_owned_by( nft_acct_idx, NFT_PROGRAM );
  if( (ulong)tsdk_get_account_meta( nft_acct_idx )->data_sz != NFT_ACCT_SZ ) tsdk_revert( ERR_WRONG_ACCOUNT );
  uchar const * nd = (uchar const *)tsdk_get_account_data_ptr( nft_acct_idx );
  ulong nid = 0UL;
  memcpy( &nid, nd + 64, 8UL );
  ulong want = (ulong)get_u16( base + off_nft_of( (ulong)hdr->supply ) + (ulong)num * 2UL );
  if( nid != want || memcmp( nd, hdr->nft_mint.key, 32UL ) != 0 ) tsdk_revert( ERR_WRONG_ACCOUNT );

  struct nft_transfer_ix ix;
  ix.op       = NFT_OP_TRANSFER;
  ix.nft_idx  = nft_acct_idx;
  ix.dest_idx = dest_idx;
  ix.mint_idx = nft_mint_idx;
  nft_invoke( &ix, sizeof( ix ), nft_prog_idx );
  if( memcmp( nd + 32, account_addr( dest_idx )->key, 32UL ) != 0 ) tsdk_revert( ERR_NFT_CPI );
}

/* ------------------------------------------------------------------- INIT */

struct __attribute__(( packed )) init_args {
  uchar  op;
  uchar  seed[ 32 ];
  ushort nft_mint_idx;
  ushort treasury_idx;
  ushort pay_mint_idx;
  ushort allower_idx;
  ushort reserve_idx;
  uint   supply;
  uint   max_allow;
  ulong  price;
  uchar  uri_len;
};

static void
do_init( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct init_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct init_args a;
  memcpy( &a, data, sizeof( a ) );

  if( a.supply == 0U || a.supply > SUPPLY_MAX )       tsdk_revert( ERR_RANGE );
  if( a.max_allow == 0U || a.max_allow > ALLOW_MAX )  tsdk_revert( ERR_RANGE );
  if( a.price == 0UL )                                tsdk_revert( ERR_RANGE );
  if( a.uri_len == 0U || (ulong)a.uri_len > URI_BASE_MAX ) tsdk_revert( ERR_RANGE );
  ulong fixed = sizeof( struct init_args ) + (ulong)a.uri_len;
  if( data_sz < fixed ) tsdk_revert( ERR_BAD_INSTR );
  uchar const * uri      = data + sizeof( struct init_args );
  uchar const * proof    = data + fixed;
  ulong         proof_sz = data_sz - fixed;

  /* The collection must be a real NFT-program mint, with this program as its
     authority and nothing minted, so NFT ids and this program's count start
     together. */
  require_owned_by( a.nft_mint_idx, NFT_PROGRAM );
  if( nft_next_id( a.nft_mint_idx ) != 0UL ) tsdk_revert( ERR_OUT_OF_SYNC );
  uchar const * nm = (uchar const *)tsdk_get_account_data_ptr( a.nft_mint_idx );
  if( memcmp( nm, tsdk_get_current_program_acc_addr()->key, 32UL ) != 0 ) tsdk_revert( ERR_NOT_OURS );

  tn_pubkey_t const * pay_mint = account_addr( a.pay_mint_idx );
  if( !tsdk_account_exists( a.pay_mint_idx ) ) tsdk_revert( ERR_NO_ACCOUNT );
  tsdk_account_meta_t const * pm = tsdk_get_account_meta( a.pay_mint_idx );
  if( (ulong)pm->data_sz != TN_TOKEN_MINT_ACCOUNT_SZ || !is_token_program_key( pm->owner.key ) ) {
    tsdk_revert( ERR_WRONG_ACCOUNT );
  }
  if( !tsdk_is_account_idx_valid( a.treasury_idx ) ) tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_account_exists( a.treasury_idx ) ) tsdk_revert( ERR_NO_ACCOUNT );
  tsdk_account_meta_t const * tm = tsdk_get_account_meta( a.treasury_idx );
  if( (ulong)tm->data_sz != TN_TOKEN_TOKEN_ACCOUNT_SZ || !is_token_program_key( tm->owner.key ) ) {
    tsdk_revert( ERR_BAD_TOKEN_ACC );
  }
  uchar const * td = (uchar const *)tsdk_get_account_data_ptr( a.treasury_idx );
  if( memcmp( td, pay_mint->key, 32UL ) != 0 ) tsdk_revert( ERR_BAD_TOKEN_ACC );

  tn_pubkey_t const * allower = account_addr( a.allower_idx );
  tn_pubkey_t const * reserve = account_addr( a.reserve_idx );
  if( is_zero( reserve->key ) ) tsdk_revert( ERR_WRONG_ACCOUNT );

  if( !tsdk_is_account_idx_valid( INIT_IDX ) ) tsdk_revert( ERR_NO_ACCOUNT );
  if( tsdk_account_exists( INIT_IDX ) ) tsdk_revert( ERR_WRONG_ACCOUNT );
  if( tsys_account_create( INIT_IDX, a.seed, proof, proof_sz ) != TSDK_SUCCESS ) tsdk_revert( ERR_CREATE_FAILED );
  if( !tsdk_is_account_owned_by_current_program( INIT_IDX ) ) tsdk_revert( ERR_NOT_OURS );

  /* Writable before resize. The other order fails at every size. */
  if( tsys_set_account_data_writable( INIT_IDX ) != TSDK_SUCCESS ) tsdk_revert( ERR_WRITE_DENIED );
  ulong want = cfg_size( (ulong)a.supply, (ulong)a.max_allow );
  ulong rc = tsys_account_resize( INIT_IDX, want );
  if( rc != TSDK_SUCCESS ) tsdk_revert( 0x8000UL | ( rc & 0xFFUL ) );

  uchar * base = (uchar *)tsdk_get_account_data_ptr( INIT_IDX );
  memset( base, 0, want );

  cfg_hdr_t hdr;
  memset( &hdr, 0, sizeof( hdr ) );
  hdr.version   = CFG_VERSION;
  hdr.price     = a.price;
  hdr.supply    = a.supply;
  hdr.max_allow = a.max_allow;
  hdr.uri_len   = a.uri_len;
  memcpy( hdr.uri, uri, (ulong)a.uri_len );
  memcpy( hdr.admin.key,    account_addr( 0 )->key,              32UL );
  memcpy( hdr.nft_mint.key, account_addr( a.nft_mint_idx )->key, 32UL );
  memcpy( hdr.treasury.key, account_addr( a.treasury_idx )->key, 32UL );
  memcpy( hdr.pay_mint.key, pay_mint->key,                       32UL );
  memcpy( hdr.allower.key,  allower->key,                        32UL );
  memcpy( hdr.reserve_wallet.key, reserve->key,                  32UL );
  memcpy( base, &hdr, HDR_SZ );
}

/* ------------------------------------------------------------------ ALLOW */

struct __attribute__(( packed )) allow_args {
  uchar  op;
  ushort cfg_idx;
  ushort wallet_idx;
  ulong  tag;
};

static void
do_allow( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct allow_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct allow_args a;
  memcpy( &a, data, sizeof( a ) );

  /* Look first, write only if something changes. */
  cfg_hdr_t hdr;
  uchar const * ro = read_cfg( a.cfg_idx, &hdr );
  require_admin_or_allower( &hdr );
  tn_pubkey_t const * w = account_addr( a.wallet_idx );
  if( is_zero( w->key ) ) tsdk_revert( ERR_WRONG_ACCOUNT );
  uint live = hdr.allow_cnt < hdr.max_allow ? hdr.allow_cnt : hdr.max_allow;
  for( uint i=0U; i<live; i++ ) {
    if( memcmp( ro + off_allow( (ulong)hdr.supply ) + (ulong)i * ALLOW_SZ, w->key, 32UL ) == 0 ) return;
  }
  if( hdr.allow_cnt == 0xFFFFFFFFU ) tsdk_revert( ERR_RANGE );

  uchar * base = open_cfg( a.cfg_idx, &hdr );
  allow_rec_t r;
  memcpy( r.wallet.key, w->key, 32UL );
  r.tag  = a.tag;
  r.slot = tsdk_get_current_block_ctx()->slot;
  memcpy( base + off_allow( (ulong)hdr.supply ) + (ulong)( hdr.allow_cnt % hdr.max_allow ) * ALLOW_SZ, &r, ALLOW_SZ );
  hdr.allow_cnt += 1U;
  memcpy( base, &hdr, HDR_SZ );
}

/* ---------------------------------------------------------------- ALLOWER */

struct __attribute__(( packed )) allower_args {
  uchar  op;
  ushort cfg_idx;
  ushort allower_idx;
};

static void
do_allower( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct allower_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct allower_args a;
  memcpy( &a, data, sizeof( a ) );
  cfg_hdr_t hdr;
  (void)read_cfg( a.cfg_idx, &hdr );
  require_admin( &hdr );
  if( same( &hdr.allower, account_addr( a.allower_idx ) ) ) return;
  uchar * base = open_cfg( a.cfg_idx, &hdr );
  memcpy( hdr.allower.key, account_addr( a.allower_idx )->key, 32UL );
  memcpy( base, &hdr, HDR_SZ );
}

/* ------------------------------------------------------------------- MINT */

struct __attribute__(( packed )) mint_args {
  uchar  op;
  ushort cfg_idx;
  ushort nft_prog_idx;
  ushort nft_mint_idx;
  ushort nft_acct_idx;
  ushort token_prog_idx;
  ushort pay_from_idx;
  ushort treasury_idx;
};

/* A number between 0 and `span`-1 that nobody could know when signing: the
   previous block's hash and the state root at execution, the slot and time,
   the payer and the running count, through SHA-256. */
static ulong
draw( tn_pubkey_t const * payer, uint minted, ulong span ) {
  uchar buf[ 32 + 32 + 8 + 8 + 32 + 4 ];
  tsdk_block_ctx_t const * cur  = tsdk_get_current_block_ctx();
  tsdk_block_ctx_t const * prev = tsdk_get_past_block_ctx( 1UL );
  ulong o = 0UL;
  memcpy( buf + o, prev->cur_block_hash.hash, 32UL ); o += 32UL;
  memcpy( buf + o, cur->state_root.hash,      32UL ); o += 32UL;
  memcpy( buf + o, &cur->slot,                 8UL ); o += 8UL;
  memcpy( buf + o, &cur->block_time,           8UL ); o += 8UL;
  memcpy( buf + o, payer->key,                32UL ); o += 32UL;
  memcpy( buf + o, &minted,                    4UL ); o += 4UL;
  uchar h[ 32 ];
  tsdk_sha256_hash( buf, o, h );
  ulong r = 0UL;
  memcpy( &r, h, 8UL );
  return r % span;
}

static void
do_mint( uchar const * data, ulong data_sz ) {
  if( data_sz <= sizeof( struct mint_args ) ) tsdk_revert( ERR_BAD_INSTR );   /* needs a proof */
  struct mint_args a;
  memcpy( &a, data, sizeof( a ) );
  uchar const * proof    = data + sizeof( a );
  ulong         proof_sz = data_sz - sizeof( a );

  require_nft_program( a.nft_prog_idx );
  require_token_program( a.token_prog_idx );

  cfg_hdr_t hdr;
  uchar const * ro = read_cfg( a.cfg_idx, &hdr );
  ulong n = (ulong)hdr.supply;
  uint public_minted = hdr.minted - hdr.gifted;

  tn_pubkey_t const * me = account_addr( 0 );

  /* On the allowlist. */
  uchar const * list = ro + off_allow( n );
  uint live = hdr.allow_cnt < hdr.max_allow ? hdr.allow_cnt : hdr.max_allow;
  int allowed = 0;
  for( uint i=0U; i<live; i++ ) {
    if( memcmp( list + (ulong)i * ALLOW_SZ, me->key, 32UL ) == 0 ) { allowed = 1; break; }
  }
  if( !allowed ) tsdk_revert( ERR_NOT_ALLOWED );

  /* One per wallet, ever: checked against who minted, not who holds now. */
  for( uint k=0U; k<hdr.minted; k++ ) {
    ulong num = (ulong)get_u16( ro + off_order( n ) + (ulong)k * 2UL );
    if( memcmp( ro + off_minters( n ) + num * 32UL, me->key, 32UL ) == 0 ) tsdk_revert( ERR_ALREADY_MINTED );
  }

  if( hdr.reserved_cnt + public_minted >= hdr.supply ) tsdk_revert( ERR_SOLD_OUT );
  ulong left = (ulong)( hdr.supply - hdr.reserved_cnt - public_minted );

  require_addr( a.nft_mint_idx, &hdr.nft_mint );
  require_addr( a.treasury_idx, &hdr.treasury );

  /* The number: the r-th one that is neither minted nor reserved. */
  ulong r = draw( me, hdr.minted, left );
  uchar const * mb = ro + off_mintedb( n );
  uchar const * rb = ro + off_reserved( n );
  ulong num = n;
  for( ulong i=0UL; i<n; i++ ) {
    if( bit( mb, i ) || bit( rb, i ) ) continue;
    if( r == 0UL ) { num = i; break; }
    r--;
  }
  if( num >= n ) tsdk_revert( ERR_SOLD_OUT );

  /* Payment first. The payer's account must be theirs and of the payment mint,
     and the money goes straight to the treasury fixed at INIT. */
  require_token_acc( a.pay_from_idx, &hdr.pay_mint, me );
  pay( a.token_prog_idx, a.pay_from_idx, a.treasury_idx, hdr.price );

  uchar * base = open_cfg( a.cfg_idx, &hdr );
  mint_pal( base, &hdr, a.nft_prog_idx, a.nft_mint_idx, a.nft_acct_idx, (ushort)0, num, proof, proof_sz );
  memcpy( base, &hdr, HDR_SZ );
}

/* ------------------------------------------------------------------- GIFT */

struct __attribute__(( packed )) gift_args {
  uchar  op;
  ushort cfg_idx;
  ushort nft_prog_idx;
  ushort nft_mint_idx;
  ushort nft_acct_idx;
  ushort reserve_idx;
  uint   num;
};

/* Mints a reserved number to the reserve wallet, free. Admin or allower. */
static void
do_gift( uchar const * data, ulong data_sz ) {
  if( data_sz <= sizeof( struct gift_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct gift_args a;
  memcpy( &a, data, sizeof( a ) );
  uchar const * proof    = data + sizeof( a );
  ulong         proof_sz = data_sz - sizeof( a );
  require_nft_program( a.nft_prog_idx );

  cfg_hdr_t hdr;
  uchar const * ro = read_cfg( a.cfg_idx, &hdr );
  require_admin_or_allower( &hdr );
  ulong n = (ulong)hdr.supply;
  if( a.num >= hdr.supply ) tsdk_revert( ERR_RANGE );
  if( !bit( ro + off_reserved( n ), a.num ) || bit( ro + off_mintedb( n ), a.num ) ) tsdk_revert( ERR_NOT_RESERVED );
  require_addr( a.nft_mint_idx, &hdr.nft_mint );
  require_addr( a.reserve_idx, &hdr.reserve_wallet );

  uchar * base = open_cfg( a.cfg_idx, &hdr );
  mint_pal( base, &hdr, a.nft_prog_idx, a.nft_mint_idx, a.nft_acct_idx, a.reserve_idx, (ulong)a.num, proof, proof_sz );
  hdr.gifted += 1U;
  memcpy( base, &hdr, HDR_SZ );
}

/* ------------------------------------------------------------------- SEND */

struct __attribute__(( packed )) send_args {
  uchar  op;
  ushort cfg_idx;
  ushort nft_prog_idx;
  ushort nft_mint_idx;
  ushort nft_acct_idx;
  ushort dest_idx;
  uint   num;
};

static void
do_send( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct send_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct send_args a;
  memcpy( &a, data, sizeof( a ) );

  cfg_hdr_t hdr;
  uchar const * ro = read_cfg( a.cfg_idx, &hdr );
  require_minted( ro, &hdr, a.num );
  tn_pubkey_t const * me   = account_addr( 0 );
  tn_pubkey_t const * dest = account_addr( a.dest_idx );
  if( memcmp( ro + off_owners() + (ulong)a.num * 32UL, me->key, 32UL ) != 0 ) tsdk_revert( ERR_NOT_HOLDER );
  if( same( dest, me ) || is_zero( dest->key ) ) tsdk_revert( ERR_SELF );

  uchar * base = open_cfg( a.cfg_idx, &hdr );
  move_pal( base, &hdr, a.nft_prog_idx, a.nft_mint_idx, a.nft_acct_idx, a.dest_idx, a.num );
  memcpy( base + off_owners() + (ulong)a.num * 32UL, dest->key, 32UL );
}

/* ----------------------------------------------------------------- PRIZES */

struct __attribute__(( packed )) prizes_args {
  uchar  op;
  ushort cfg_idx;
  ushort count;
};

struct __attribute__(( packed )) prize_entry {
  uint  num;
  ulong amount;
};

static void
do_prizes( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct prizes_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct prizes_args a;
  memcpy( &a, data, sizeof( a ) );
  ulong need = sizeof( struct prizes_args ) + (ulong)a.count * sizeof( struct prize_entry );
  if( a.count == 0U || data_sz < need ) tsdk_revert( ERR_BAD_INSTR );

  cfg_hdr_t hdr;
  (void)read_cfg( a.cfg_idx, &hdr );
  require_admin( &hdr );
  if( hdr.prizes_locked ) tsdk_revert( ERR_LOCKED );

  uchar * base = open_cfg( a.cfg_idx, &hdr );
  uchar * prizes = base + off_prizes( (ulong)hdr.supply );
  for( ulong i=0UL; i<(ulong)a.count; i++ ) {
    struct prize_entry e;
    memcpy( &e, data + sizeof( struct prizes_args ) + i * sizeof( e ), sizeof( e ) );
    if( e.num >= hdr.supply ) tsdk_revert( ERR_RANGE );
    memcpy( prizes + (ulong)e.num * 8UL, &e.amount, 8UL );
  }
}

/* ------------------------------------------------------------------- LOCK */

struct __attribute__(( packed )) lock_args {
  uchar  op;
  ushort cfg_idx;
  ushort vault_idx;
};

static void
do_lock( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct lock_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct lock_args a;
  memcpy( &a, data, sizeof( a ) );

  cfg_hdr_t hdr;
  (void)read_cfg( a.cfg_idx, &hdr );
  require_admin( &hdr );
  if( hdr.prizes_locked ) tsdk_revert( ERR_LOCKED );
  /* The prize vault is a payment-token account owned by this program, so only
     CLAIM can ever spend from it. */
  require_token_acc( a.vault_idx, &hdr.pay_mint, tsdk_get_current_program_acc_addr() );

  uchar * base = open_cfg( a.cfg_idx, &hdr );
  memcpy( hdr.prize_vault.key, account_addr( a.vault_idx )->key, 32UL );
  hdr.prizes_locked = 1U;
  memcpy( base, &hdr, HDR_SZ );
}

/* ------------------------------------------------------------------ CLAIM */

struct __attribute__(( packed )) claim_args {
  uchar  op;
  ushort cfg_idx;
  ushort token_prog_idx;
  ushort vault_idx;
  ushort dest_idx;
  uint   num;
};

static void
do_claim( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct claim_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct claim_args a;
  memcpy( &a, data, sizeof( a ) );
  require_token_program( a.token_prog_idx );

  cfg_hdr_t hdr;
  uchar const * ro = read_cfg( a.cfg_idx, &hdr );
  if( !hdr.prizes_locked ) tsdk_revert( ERR_NOT_LOCKED );
  require_minted( ro, &hdr, a.num );
  ulong n = (ulong)hdr.supply;

  /* Only the wallet holding this Pal right now, signing for itself. */
  tn_pubkey_t const * me = account_addr( 0 );
  if( memcmp( ro + off_owners() + (ulong)a.num * 32UL, me->key, 32UL ) != 0 ) tsdk_revert( ERR_NOT_HOLDER );
  if( bit( ro + off_claimed( n ), a.num ) ) tsdk_revert( ERR_CLAIMED );
  ulong amount = 0UL;
  memcpy( &amount, ro + off_prizes( n ) + (ulong)a.num * 8UL, 8UL );
  if( amount == 0UL ) tsdk_revert( ERR_NO_PRIZE );
  require_addr( a.vault_idx, &hdr.prize_vault );
  require_token_acc( a.dest_idx, &hdr.pay_mint, me );

  /* Marked first; if the transfer fails the whole transaction reverts. */
  uchar * base = open_cfg( a.cfg_idx, &hdr );
  set_bit( base + off_claimed( n ), a.num );
  pay( a.token_prog_idx, a.vault_idx, a.dest_idx, amount );
}

/* ------------------------------------------------ RESERVE / UNRESERVE */

struct __attribute__(( packed )) reserve_args {
  uchar  op;
  ushort cfg_idx;
  ushort count;
};

/* Marks (or unmarks) Pal numbers as reserved for the reserve wallet. Only
   numbers not minted yet can change, so nobody's Pal is ever affected. A
   reserved number is never drawn for the public; GIFT mints it. */
static void
do_reserve( uchar const * data, ulong data_sz, int set ) {
  if( data_sz < sizeof( struct reserve_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct reserve_args a;
  memcpy( &a, data, sizeof( a ) );
  if( data_sz < sizeof( a ) + (ulong)a.count * 4UL ) tsdk_revert( ERR_BAD_INSTR );

  cfg_hdr_t hdr;
  uchar const * ro = read_cfg( a.cfg_idx, &hdr );
  require_admin( &hdr );
  ulong n = (ulong)hdr.supply;
  int changes = 0;
  for( ulong i=0UL; i<(ulong)a.count; i++ ) {
    uint num = 0U;
    memcpy( &num, data + sizeof( a ) + i * 4UL, 4UL );
    if( num >= hdr.supply || bit( ro + off_mintedb( n ), num ) ) tsdk_revert( ERR_RANGE );
    if( bit( ro + off_reserved( n ), num ) != set ) changes = 1;
  }
  if( !changes ) return;

  uchar * base = open_cfg( a.cfg_idx, &hdr );
  uchar * bits = base + off_reserved( n );
  for( ulong i=0UL; i<(ulong)a.count; i++ ) {
    uint num = 0U;
    memcpy( &num, data + sizeof( a ) + i * 4UL, 4UL );
    int was = bit( bits, num );
    if( set && !was ) { set_bit( bits, num );   hdr.reserved_cnt += 1U; }
    if( !set && was ) { clear_bit( bits, num ); hdr.reserved_cnt -= 1U; }
  }
  /* The public must never be left with fewer free numbers than it has used. */
  if( hdr.reserved_cnt + ( hdr.minted - hdr.gifted ) > hdr.supply ) tsdk_revert( ERR_RANGE );
  memcpy( base, &hdr, HDR_SZ );
}

/* ----------------------------------------------------------------- MARKET */

struct __attribute__(( packed )) market_args {
  uchar  op;
  uchar  seed[ 32 ];
  ushort cfg_idx;
  ushort fee_bps;
};

static void
do_market( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct market_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct market_args a;
  memcpy( &a, data, sizeof( a ) );
  uchar const * proof    = data + sizeof( a );
  ulong         proof_sz = data_sz - sizeof( a );

  cfg_hdr_t hdr;
  (void)read_cfg( a.cfg_idx, &hdr );
  require_admin( &hdr );
  if( a.fee_bps > FEE_BPS_MAX ) tsdk_revert( ERR_RANGE );

  if( !tsdk_is_account_idx_valid( INIT_IDX ) ) tsdk_revert( ERR_NO_ACCOUNT );
  if( tsdk_account_exists( INIT_IDX ) ) tsdk_revert( ERR_WRONG_ACCOUNT );
  if( tsys_account_create( INIT_IDX, a.seed, proof, proof_sz ) != TSDK_SUCCESS ) tsdk_revert( ERR_CREATE_FAILED );
  if( !tsdk_is_account_owned_by_current_program( INIT_IDX ) ) tsdk_revert( ERR_NOT_OURS );
  if( tsys_set_account_data_writable( INIT_IDX ) != TSDK_SUCCESS ) tsdk_revert( ERR_WRITE_DENIED );
  ulong want = mkt_size( (ulong)hdr.supply );
  ulong rc = tsys_account_resize( INIT_IDX, want );
  if( rc != TSDK_SUCCESS ) tsdk_revert( 0x8000UL | ( rc & 0xFFUL ) );

  uchar * base = (uchar *)tsdk_get_account_data_ptr( INIT_IDX );
  memset( base, 0, want );
  mkt_hdr_t m;
  memset( &m, 0, sizeof( m ) );
  m.version = MKT_VERSION;
  m.fee_bps = a.fee_bps;
  m.supply  = hdr.supply;
  memcpy( m.cfg.key, account_addr( a.cfg_idx )->key, 32UL );
  memcpy( base, &m, MKT_HDR_SZ );
}

/* -------------------------------------------------------------------- FEE */

struct __attribute__(( packed )) fee_args {
  uchar  op;
  ushort mkt_idx;
  ushort cfg_idx;
  ushort fee_bps;
};

static void
do_fee( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct fee_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct fee_args a;
  memcpy( &a, data, sizeof( a ) );
  cfg_hdr_t hdr;
  (void)read_cfg( a.cfg_idx, &hdr );
  require_admin( &hdr );
  if( a.fee_bps > FEE_BPS_MAX ) tsdk_revert( ERR_RANGE );
  mkt_hdr_t m;
  (void)check_mkt( a.mkt_idx, a.cfg_idx, &hdr, &m );
  if( m.fee_bps == a.fee_bps ) return;
  uchar * mb = open_mkt( a.mkt_idx, a.cfg_idx, &hdr, &m );
  m.fee_bps = a.fee_bps;
  memcpy( mb, &m, MKT_HDR_SZ );
}

/* ------------------------------------------------------------------- LIST */

struct __attribute__(( packed )) list_args {
  uchar  op;
  ushort cfg_idx;
  ushort mkt_idx;
  ushort nft_prog_idx;
  ushort nft_mint_idx;
  ushort nft_acct_idx;
  ushort escrow_idx;
  ushort payout_idx;
  uint   num;
  ulong  price;
};

static void
do_list( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct list_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct list_args a;
  memcpy( &a, data, sizeof( a ) );
  if( a.price == 0UL || a.price > PRICE_MAX ) tsdk_revert( ERR_RANGE );

  /* The config changes only for a new listing (its holder becomes this
     program); a price change touches the market alone. */
  cfg_hdr_t hdr;
  uchar const * ro = read_cfg( a.cfg_idx, &hdr );
  require_minted( ro, &hdr, a.num );
  mkt_hdr_t m;
  uchar * mb = open_mkt( a.mkt_idx, a.cfg_idx, &hdr, &m );

  tn_pubkey_t const * me   = account_addr( 0 );
  tn_pubkey_t const * self = tsdk_get_current_program_acc_addr();
  ulong own_off = off_owners() + (ulong)a.num * 32UL;
  listing_t * l = (listing_t *)( mb + MKT_HDR_SZ + (ulong)a.num * LISTING_SZ );
  require_token_acc( a.payout_idx, &hdr.pay_mint, me );

  if( memcmp( ro + own_off, me->key, 32UL ) == 0 ) {
    /* A new listing: the Pal goes into this program's keeping. */
    if( !same( account_addr( a.escrow_idx ), self ) ) tsdk_revert( ERR_WRONG_ACCOUNT );
    uchar * base = open_cfg( a.cfg_idx, &hdr );
    move_pal( base, &hdr, a.nft_prog_idx, a.nft_mint_idx, a.nft_acct_idx, a.escrow_idx, a.num );
    memcpy( base + own_off, self->key, 32UL );
    m.listed += 1U;
  } else if( memcmp( ro + own_off, self->key, 32UL ) != 0 || !same( &l->seller, me ) ) {
    tsdk_revert( ERR_NOT_HOLDER );
  }
  /* else: already listed by this seller, so this is a new price. */

  listing_t nl;
  memcpy( nl.seller.key, me->key, 32UL );
  memcpy( nl.payout.key, account_addr( a.payout_idx )->key, 32UL );
  nl.price = a.price;
  nl.slot  = tsdk_get_current_block_ctx()->slot;
  memcpy( l, &nl, LISTING_SZ );
  memcpy( mb, &m, MKT_HDR_SZ );
}

/* ----------------------------------------------------------------- DELIST */

struct __attribute__(( packed )) delist_args {
  uchar  op;
  ushort cfg_idx;
  ushort mkt_idx;
  ushort nft_prog_idx;
  ushort nft_mint_idx;
  ushort nft_acct_idx;
  uint   num;
};

static void
do_delist( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct delist_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct delist_args a;
  memcpy( &a, data, sizeof( a ) );

  cfg_hdr_t hdr;
  uchar const * ro = read_cfg( a.cfg_idx, &hdr );
  require_minted( ro, &hdr, a.num );
  mkt_hdr_t m;
  uchar const * mro = check_mkt( a.mkt_idx, a.cfg_idx, &hdr, &m );
  tn_pubkey_t const * me = account_addr( 0 );
  ulong own_off = off_owners() + (ulong)a.num * 32UL;
  listing_t const * lr = (listing_t const *)( mro + MKT_HDR_SZ + (ulong)a.num * LISTING_SZ );
  if( memcmp( ro + own_off, tsdk_get_current_program_acc_addr()->key, 32UL ) != 0 ) tsdk_revert( ERR_NOT_LISTED );
  if( !same( &lr->seller, me ) ) tsdk_revert( ERR_NOT_HOLDER );

  uchar * base = open_cfg( a.cfg_idx, &hdr );
  uchar * mb   = open_mkt( a.mkt_idx, a.cfg_idx, &hdr, &m );
  move_pal( base, &hdr, a.nft_prog_idx, a.nft_mint_idx, a.nft_acct_idx, (ushort)0, a.num );
  memcpy( base + own_off, me->key, 32UL );
  memset( mb + MKT_HDR_SZ + (ulong)a.num * LISTING_SZ, 0, LISTING_SZ );
  m.listed -= 1U;
  memcpy( mb, &m, MKT_HDR_SZ );
}

/* -------------------------------------------------------------------- BUY */

struct __attribute__(( packed )) buy_args {
  uchar  op;
  ushort cfg_idx;
  ushort mkt_idx;
  ushort nft_prog_idx;
  ushort nft_mint_idx;
  ushort token_prog_idx;
  ushort pay_from_idx;
  ushort fee_to_idx;
  uchar  count;
};

struct __attribute__(( packed )) buy_item {
  ushort nft_acct_idx;
  ushort payout_idx;
  uint   num;
  ulong  max_price;
};

static void
do_buy( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct buy_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct buy_args a;
  memcpy( &a, data, sizeof( a ) );
  if( a.count == 0U || a.count > BUY_MAX ) tsdk_revert( ERR_RANGE );
  if( data_sz < sizeof( a ) + (ulong)a.count * sizeof( struct buy_item ) ) tsdk_revert( ERR_BAD_INSTR );
  require_token_program( a.token_prog_idx );

  cfg_hdr_t hdr;
  (void)read_cfg( a.cfg_idx, &hdr );
  mkt_hdr_t m;
  (void)check_mkt( a.mkt_idx, a.cfg_idx, &hdr, &m );
  tn_pubkey_t const * me   = account_addr( 0 );
  tn_pubkey_t const * self = tsdk_get_current_program_acc_addr();
  require_token_acc( a.pay_from_idx, &hdr.pay_mint, me );
  require_addr( a.fee_to_idx, &hdr.treasury );

  uchar * base = open_cfg( a.cfg_idx, &hdr );
  uchar * mb   = open_mkt( a.mkt_idx, a.cfg_idx, &hdr, &m );

  for( ulong i=0UL; i<(ulong)a.count; i++ ) {
    struct buy_item it;
    memcpy( &it, data + sizeof( a ) + i * sizeof( it ), sizeof( it ) );
    require_minted( base, &hdr, it.num );
    uchar * owner = base + off_owners() + (ulong)it.num * 32UL;
    listing_t * l = (listing_t *)( mb + MKT_HDR_SZ + (ulong)it.num * LISTING_SZ );
    if( memcmp( owner, self->key, 32UL ) != 0 || is_zero( l->seller.key ) ) tsdk_revert( ERR_NOT_LISTED );
    if( same( &l->seller, me ) ) tsdk_revert( ERR_SELF );
    if( l->price > it.max_price ) tsdk_revert( ERR_PRICE );
    require_addr( it.payout_idx, &l->payout );
    require_token_acc( it.payout_idx, &hdr.pay_mint, &l->seller );

    ulong price = l->price;
    ulong fee   = price * (ulong)m.fee_bps / 10000UL;   /* price <= PRICE_MAX, no overflow */
    pay( a.token_prog_idx, a.pay_from_idx, it.payout_idx, price - fee );
    pay( a.token_prog_idx, a.pay_from_idx, a.fee_to_idx, fee );

    move_pal( base, &hdr, a.nft_prog_idx, a.nft_mint_idx, it.nft_acct_idx, (ushort)0, it.num );
    memcpy( owner, me->key, 32UL );

    sale_rec_t r;
    r.num   = it.num;
    r.price = price;
    memcpy( r.buyer.key,  me->key,       32UL );
    memcpy( r.seller.key, l->seller.key, 32UL );
    r.slot  = tsdk_get_current_block_ctx()->slot;
    memcpy( mb + mkt_off_sales( (ulong)m.supply ) + ( (ulong)m.sales % SALES_RING ) * SALE_SZ, &r, SALE_SZ );

    memset( l, 0, LISTING_SZ );
    m.listed -= 1U;
    m.sales  += 1U;
    m.volume += price;
  }
  memcpy( mb, &m, MKT_HDR_SZ );
}

/* ---------------------------------------------------------------- MIGRATE */

/* Version 2 kept a 455-byte header and no maps, and minted numbers in order,
   so NFT id k was Pal number k. */
#define V2_HDR_SZ (455UL)
static inline ulong v2_off_allow( ulong n ) { return V2_HDR_SZ + n * 72UL + 2UL * bits_sz( n ); }

/* Copies from the end, for moves to a higher address that overlap. */
static void
move_up( uchar * base, ulong dst, ulong src, ulong len ) {
  for( ulong i=len; i>0UL; i-- ) base[ dst + i - 1UL ] = base[ src + i - 1UL ];
}

struct __attribute__(( packed )) migrate_args {
  uchar  op;
  ushort cfg_idx;
};

static void
do_migrate( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct migrate_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct migrate_args a;
  memcpy( &a, data, sizeof( a ) );
  ushort idx = a.cfg_idx;
  if( !tsdk_is_account_idx_valid( idx ) ) tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_account_exists( idx ) )       tsdk_revert( ERR_NOT_READY );
  if( !tsdk_is_account_owned_by_current_program( idx ) ) tsdk_revert( ERR_NOT_OURS );

  uchar const * ro = (uchar const *)tsdk_get_account_data_ptr( idx );
  ulong sz = (ulong)tsdk_get_account_meta( idx )->data_sz;
  if( sz < V2_HDR_SZ || ro[ 0 ] != (uchar)2 ) tsdk_revert( ERR_NOT_READY );
  if( memcmp( ro + 2, account_addr( 0 )->key, 32UL ) != 0 ) tsdk_revert( ERR_NOT_ADMIN );
  uint supply = 0U, minted = 0U, max_allow = 0U;
  memcpy( &supply,    ro + 202, 4UL );
  memcpy( &minted,    ro + 206, 4UL );
  memcpy( &max_allow, ro + 210, 4UL );
  ulong n = (ulong)supply, al = (ulong)max_allow;
  if( n == 0UL || n > SUPPLY_MAX || minted > supply ) tsdk_revert( ERR_NOT_READY );
  if( sz != v2_off_allow( n ) + al * ALLOW_SZ ) tsdk_revert( ERR_NOT_READY );

  /* Writable before resize. */
  if( tsys_set_account_data_writable( idx ) != TSDK_SUCCESS ) tsdk_revert( ERR_WRITE_DENIED );
  ulong rc = tsys_account_resize( idx, cfg_size( n, al ) );
  if( rc != TSDK_SUCCESS ) tsdk_revert( 0x8000UL | ( rc & 0xFFUL ) );
  uchar * base = (uchar *)tsdk_get_account_data_ptr( idx );

  /* The allowlist first (it is last, and the arrays before it grow into its
     old place), then owners .. reserved, 4 bytes up for the larger header. */
  move_up( base, off_allow( n ), v2_off_allow( n ), al * ALLOW_SZ );
  move_up( base, off_owners(), V2_HDR_SZ, n * 72UL + 2UL * bits_sz( n ) );

  /* The new maps: number = NFT id for everything minted in order so far. */
  memset( base + off_mintedb( n ), 0, bits_sz( n ) + n * 4UL );
  uint gifted = 0U;
  for( ulong k=0UL; k<(ulong)minted; k++ ) {
    set_bit( base + off_mintedb( n ), k );
    put_u16( base + off_nft_of( n ) + k * 2UL, (ushort)k );
    put_u16( base + off_order( n )  + k * 2UL, (ushort)k );
    if( bit( base + off_reserved( n ), k ) ) gifted++;
  }
  memcpy( base + V2_HDR_SZ, &gifted, 4UL );   /* the new header field */
  base[ 0 ] = CFG_VERSION;
}

/* ------------------------------------------------------------- entrypoint */

TSDK_ENTRYPOINT_FN void
start( void const * instruction_data,
       ulong        instruction_data_sz ) {
  uchar const * data = (uchar const *)instruction_data;
  if( instruction_data_sz < 1UL ) tsdk_revert( ERR_BAD_INSTR );

  switch( data[ 0 ] ) {
    case OP_INIT:      do_init   ( data, instruction_data_sz ); break;
    case OP_ALLOW:     do_allow  ( data, instruction_data_sz ); break;
    case OP_MINT:      do_mint   ( data, instruction_data_sz ); break;
    case OP_SEND:      do_send   ( data, instruction_data_sz ); break;
    case OP_PRIZES:    do_prizes ( data, instruction_data_sz ); break;
    case OP_LOCK:      do_lock   ( data, instruction_data_sz ); break;
    case OP_CLAIM:     do_claim  ( data, instruction_data_sz ); break;
    case OP_ALLOWER:   do_allower( data, instruction_data_sz ); break;
    case OP_RESERVE:   do_reserve( data, instruction_data_sz, 1 ); break;
    case OP_UNRESERVE: do_reserve( data, instruction_data_sz, 0 ); break;
    case OP_GIFT:      do_gift   ( data, instruction_data_sz ); break;
    case OP_MARKET:    do_market ( data, instruction_data_sz ); break;
    case OP_FEE:       do_fee    ( data, instruction_data_sz ); break;
    case OP_LIST:      do_list   ( data, instruction_data_sz ); break;
    case OP_DELIST:    do_delist ( data, instruction_data_sz ); break;
    case OP_BUY:       do_buy    ( data, instruction_data_sz ); break;
    case OP_MIGRATE:   do_migrate( data, instruction_data_sz ); break;
    default:           tsdk_revert( ERR_BAD_OPCODE );
  }

  tsdk_return( 0UL );
}
