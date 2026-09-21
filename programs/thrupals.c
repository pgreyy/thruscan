/* thrupals - Pixel Pals: a fixed-supply NFT collection with a paid public mint
 *
 * Thru's NFT program (taVRt8dNq3B1IGXWpYx17GWEfFcpmU8LF9uWy75XIIcA03) lets the
 * COLLECTION'S AUTHORITY mint and move NFTs; a holder cannot move their own NFT
 * directly (checked on alphanet). So this program is that authority. Everything
 * that touches a Pal goes through it, which is what makes the rules below
 * enforceable rather than promised:
 *
 *   - exactly `supply` Pals, numbered 0..supply-1, in order
 *   - one mint per wallet, ever
 *   - only wallets on the allowlist can mint (ThruScan's server adds a wallet
 *     after its per-IP weekly cap check; the program keeps the list)
 *   - each mint pays `price` of the payment token (WTHRU, one base unit per
 *     native THRU) straight to the treasury account fixed at INIT; this
 *     program never holds mint money, so nobody can withdraw it from here
 *   - a Pal moves only when the wallet holding it signs (SEND, LIST, DELIST)
 *     or when someone buys it at the price its seller listed it for (BUY);
 *     the seller is paid in the same transaction, less the market fee, which
 *     goes to the treasury
 *   - a Pal's prize, if it has one, is paid only to the wallet holding it,
 *     signing for itself (CLAIM), once
 *
 * Current holders are tracked here, not read from NFT accounts passed in: every
 * transfer goes through this program, so this program's own record is authoritative and
 * a forged account can never impersonate a holder.
 *
 * The admin (the INIT fee payer) can add wallets to the allowlist, name a
 * second key (the "allower", ThruScan's server) that may also add them, set
 * prizes before they are locked, and lock them. The admin cannot change the
 * price, the supply or the treasury, cannot move anyone's Pal and cannot take
 * prize money back out.
 *
 * Every program this one calls is checked by address before the call: the
 * token program and the NFT program are fixed constants, never whatever the
 * caller names. Otherwise a caller could name a program of their own that
 * accepts the "payment" and does nothing.
 *
 * ---------------------------------------------------------------------------
 * ACCOUNTS
 *
 * One config account, owned by this program:
 *
 *   header (see struct cfg_hdr)
 *   owners   [supply][32]   current holder of each Pal (zero = not minted)
 *   minters  [supply][32]   wallet that minted each Pal (for one-per-wallet)
 *   prizes   [supply] u64   prize in payment-token base units, 0 = none
 *   claimed  [(supply+7)/8] bitmap
 *   reserved [(supply+7)/8] bitmap: numbers kept for the reserve wallet
 *   allow    [max_allow] { wallet[32], tag u64, slot u64 }   a ring: once it
 *            is full, each new entry replaces the oldest. A wallet is added
 *            seconds before it mints, so only a flood of more than max_allow
 *            additions in those seconds could push it out, and the server's
 *            per-network cap makes that impossible. Filling the list can
 *            therefore never stop the mint.
 *
 * The NFT collection's mint account is created beforehand (by the admin, with
 * the NFT program's initialize_mint) with its mint authority set to this
 * program's own address.
 *
 * ---------------------------------------------------------------------------
 * INSTRUCTIONS (u16 fields are indices into the transaction's account list)
 *
 *   INIT    [0x00][seed 32][nft_mint u16][treasury u16][pay_mint u16]
 *           [allower u16][reserve u16][supply u32][max_allow u32][price u64][uri_len u8]
 *           [uri][proof]
 *           Config is the only read-write account, so it is index 2.
 *   ALLOW   [0x01][cfg u16][wallet u16][tag u64]        admin or allower
 *   MINT    [0x02][cfg u16][nft_prog u16][nft_mint u16][nft_acct u16]
 *           [token_prog u16][pay_from u16][treasury u16]
 *           then the complete NFT mint_to instruction to forward (below).
 *           It is checked field by field (mint, owner = the payer, flags 0,
 *           uri = base + this Pal's number) and then passed on as is, so the
 *           state proof it carries never has to be copied.
 *   SEND    [0x03][cfg u16][nft_prog u16][nft_mint u16][nft_acct u16]
 *           [dest u16][id u32]                                   holder only
 *   PRIZES  [0x04][cfg u16][count u16] then count x { id u32, amount u64 }
 *                                                     admin, before LOCK
 *   LOCK    [0x05][cfg u16][prize_vault u16]                     admin only
 *   CLAIM   [0x06][cfg u16][token_prog u16][prize_vault u16][dest u16][id u32]
 *                                                                holder only
 *   ALLOWER [0x07][cfg u16][allower u16]                         admin only
 *   RESERVE   [0x08][cfg u16][count u16] then count x id u32     admin only
 *   UNRESERVE [0x09][cfg u16][count u16] then count x id u32     admin only
 *             Only numbers not yet minted can be (un)reserved.
 *   GIFT    [0x0A][cfg u16][nft_prog u16][nft_mint u16][nft_acct u16]
 *           [reserve u16] then the forwarded mint_to, owner = reserve.
 *           Admin or allower. Mints the next Pal, free, to the reserve
 *           wallet fixed at INIT, only when its number is reserved. MINT
 *           refuses a reserved number, so the public can never buy one.
 *
 *
 *   MARKET  [0x0B][seed 32][cfg u16][fee_bps u16][proof]         admin only
 *           Creates the market account (index 2, the only read-write one).
 *   FEE     [0x0C][market u16][cfg u16][fee_bps u16]             admin only
 *   LIST    [0x0D][cfg u16][market u16][nft_prog u16][nft_mint u16][nft_acct u16]
 *           [escrow u16][payout u16][id u32][price u64]          holder only
 *           Moves the Pal into this program's keeping until it sells or is
 *           delisted. Listing a Pal that is already listed by the same
 *           seller changes its price.
 *   DELIST  [0x0E][cfg u16][market u16][nft_prog u16][nft_mint u16][nft_acct u16]
 *           [id u32]                                             seller only
 *   BUY     [0x0F][cfg u16][market u16][nft_prog u16][nft_mint u16][token_prog u16]
 *           [pay_from u16][fee_to u16][count u8] then count x
 *           { nft_acct u16, payout u16, id u32, max_price u64 }
 *           Pays each seller (less the fee, which goes to the treasury) and
 *           moves each Pal to the buyer. All or nothing.
 *
 * Thru NFT program instructions used (from its on-chain ABI, checked live):
 *   mint_to   [u32 1][mint u16][nft u16][owner u16][flags u64][uri 256][proof]
 *   transfer  [u32 2][nft u16][new_owner u16][mint u16]
 * The NFT account's address is derived by the NFT program from (mint, id).
 */

#include <thru-sdk/c/tn_sdk.h>
#include <thru-sdk/c/tn_sdk_syscall.h>

#include "thru_token.h"

#define OP_INIT   (0x00)
#define OP_ALLOW  (0x01)
#define OP_MINT   (0x02)
#define OP_SEND   (0x03)
#define OP_PRIZES (0x04)
#define OP_LOCK   (0x05)
#define OP_CLAIM  (0x06)
#define OP_ALLOWER (0x07)
#define OP_RESERVE (0x08)
#define OP_UNRESERVE (0x09)
#define OP_GIFT    (0x0A)
#define OP_MARKET  (0x0B)
#define OP_FEE     (0x0C)
#define OP_LIST    (0x0D)
#define OP_DELIST  (0x0E)
#define OP_BUY     (0x0F)

#define CFG_VERSION  ((uchar)2)

/* Thru's NFT program, taVRt8dNq3B1IGXWpYx17GWEfFcpmU8LF9uWy75XIIcA03. */
static uchar const NFT_PROGRAM[ 32 ] = {
  0x55,0x1b,0x7c,0x74,0xda,0xb7,0x07,0x52,0x06,0x5d,0x6a,0x58,0xc7,0x5e,0xc6,0x58,
  0x47,0xc5,0x72,0x99,0x94,0xf0,0xb1,0x7d,0xb9,0x6c,0xbb,0xe5,0x72,0x08,0x70,0x0d };
#define CFG_INIT_IDX ((ushort)2)

#define SUPPLY_MAX    (10000U)
#define ALLOW_MAX     (20000U)
#define URI_BASE_MAX  (200UL)
#define NFT_URI_SZ    (256UL)
#define NFT_MINT_SZ   (48UL)    /* mint_authority[32] supply u64 next_id u64 */
#define NFT_ACCT_SZ   (336UL)   /* mint[32] owner[32] id u64 flags u64 uri[256] */

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
#define ERR_BAD_FORWARD    (27UL)  /* the forwarded mint_to is not the right one */
#define ERR_RESERVED       (28UL)  /* the next number is reserved; GIFT it first */
#define ERR_NOT_RESERVED   (29UL)  /* GIFT only mints reserved numbers */
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
  uint        minted;
  uint        max_allow;
  uint        allow_cnt;     /* total ever added; the ring slot is this % max_allow */
  uchar       uri_len;
  uchar       uri[ URI_BASE_MAX ];
  tn_pubkey_t reserve_wallet; /* where reserved Pals go (see RESERVE, GIFT) */
  uint        reserved_cnt;   /* numbers currently marked reserved */
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

FD_STATIC_ASSERT( HDR_SZ   == 455UL, cfg_hdr_size );
FD_STATIC_ASSERT( ALLOW_SZ == 48UL,  allow_rec_size );

/* Offsets of each array, from the start of the account. */
static inline ulong off_owners ( void )     { return HDR_SZ; }
static inline ulong off_minters( ulong n )  { return HDR_SZ + n * 32UL; }
static inline ulong off_prizes ( ulong n )  { return HDR_SZ + n * 64UL; }
static inline ulong off_claimed( ulong n )  { return HDR_SZ + n * 72UL; }
static inline ulong off_reserved( ulong n ) { return HDR_SZ + n * 72UL + ( n + 7UL ) / 8UL; }
static inline ulong off_allow  ( ulong n )  { return HDR_SZ + n * 72UL + 2UL * ( ( n + 7UL ) / 8UL ); }
static inline ulong cfg_size   ( ulong n, ulong a ) { return off_allow( n ) + a * ALLOW_SZ; }

/* The market: one account per collection, owned by this program.

     header (struct mkt_hdr)
     listings [supply] { seller[32], payout[32], price u64, slot u64 }
     sales    [SALES_RING] { id u32, price u64, buyer[32], seller[32], slot u64 }

   A listed Pal is held by this program (its NFT account's owner and the
   config's owners[] both say so), so it cannot be sent, claimed against or
   sold twice while listed, and a listing can never outlive the seller's
   ownership. */

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
  uint        id;
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

/* Opens the config for writing and returns its base, checking that it is
   ours, initialised, and exactly the size its header says. Only call this
   when the data will change (see open_mkt). */
static uchar *
open_cfg( ushort idx, cfg_hdr_t * hdr ) {
  if( !tsdk_is_account_idx_valid( idx ) ) tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_account_exists( idx ) )       tsdk_revert( ERR_NOT_READY );
  if( !tsdk_is_account_owned_by_current_program( idx ) ) tsdk_revert( ERR_NOT_OURS );
  if( tsys_set_account_data_writable( idx ) != TSDK_SUCCESS ) tsdk_revert( ERR_WRITE_DENIED );
  uchar * base = (uchar *)tsdk_get_account_data_ptr( idx );
  tsdk_account_meta_t const * meta = tsdk_get_account_meta( idx );
  if( (ulong)meta->data_sz < HDR_SZ ) tsdk_revert( ERR_NOT_READY );
  memcpy( hdr, base, HDR_SZ );
  if( hdr->version != CFG_VERSION ) tsdk_revert( ERR_NOT_READY );
  if( (ulong)meta->data_sz != cfg_size( (ulong)hdr->supply, (ulong)hdr->max_allow ) ) {
    tsdk_revert( ERR_NOT_READY );
  }
  return base;
}

/* Reads the config without asking to write it. */
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

/* Opens the market for writing. Only call this when the data will change:
   an account marked writable and left as it was fails the RPC node's
   consistency check until its next real write. */
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
  /* The uri base plus the longest Pal number must fit the NFT's uri field. */
  if( a.uri_len == 0U || (ulong)a.uri_len > URI_BASE_MAX ) tsdk_revert( ERR_RANGE );
  ulong fixed = sizeof( struct init_args ) + (ulong)a.uri_len;
  if( data_sz < fixed ) tsdk_revert( ERR_BAD_INSTR );
  uchar const * uri      = data + sizeof( struct init_args );
  uchar const * proof    = data + fixed;
  ulong         proof_sz = data_sz - fixed;

  /* The collection must be a real NFT-program mint, with this program as its
     authority and nothing minted, so Pal numbers and this program's count
     start together. */
  require_owned_by( a.nft_mint_idx, NFT_PROGRAM );
  if( nft_next_id( a.nft_mint_idx ) != 0UL ) tsdk_revert( ERR_OUT_OF_SYNC );
  uchar const * nm = (uchar const *)tsdk_get_account_data_ptr( a.nft_mint_idx );
  if( memcmp( nm, tsdk_get_current_program_acc_addr()->key, 32UL ) != 0 ) tsdk_revert( ERR_NOT_OURS );

  /* The payment mint and the treasury must both be real token-program
     accounts, and the treasury must hold the payment mint. Whose treasury it
     is was the admin's choice at INIT and can never change afterwards. */
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

  if( !tsdk_is_account_idx_valid( CFG_INIT_IDX ) ) tsdk_revert( ERR_NO_ACCOUNT );
  if( tsdk_account_exists( CFG_INIT_IDX ) ) tsdk_revert( ERR_WRONG_ACCOUNT );
  if( tsys_account_create( CFG_INIT_IDX, a.seed, proof, proof_sz ) != TSDK_SUCCESS ) {
    tsdk_revert( ERR_CREATE_FAILED );
  }
  if( !tsdk_is_account_owned_by_current_program( CFG_INIT_IDX ) ) tsdk_revert( ERR_NOT_OURS );

  /* Writable before resize. The other order fails at every size. */
  if( tsys_set_account_data_writable( CFG_INIT_IDX ) != TSDK_SUCCESS ) tsdk_revert( ERR_WRITE_DENIED );
  ulong want = cfg_size( (ulong)a.supply, (ulong)a.max_allow );
  ulong rc = tsys_account_resize( CFG_INIT_IDX, want );
  if( rc != TSDK_SUCCESS ) tsdk_revert( 0x8000UL | ( rc & 0xFFUL ) );

  uchar * base = (uchar *)tsdk_get_account_data_ptr( CFG_INIT_IDX );
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

  /* Look first, write only if something changes. Marking an account
     writable and leaving its data as it was makes the RPC node's copy fail
     its own consistency check until the next real write (seen on alphanet),
     so a repeated ALLOW must not touch the account at all. */
  cfg_hdr_t hdr;
  uchar const * ro = read_cfg( a.cfg_idx, &hdr );
  tn_pubkey_t const * payer = account_addr( 0 );
  if( !same( payer, &hdr.admin ) && !same( payer, &hdr.allower ) ) tsdk_revert( ERR_NOT_ADMIN );

  tn_pubkey_t const * w = account_addr( a.wallet_idx );
  if( is_zero( w->key ) ) tsdk_revert( ERR_WRONG_ACCOUNT );
  uint live = hdr.allow_cnt < hdr.max_allow ? hdr.allow_cnt : hdr.max_allow;
  for( uint i=0U; i<live; i++ ) {
    if( memcmp( ro + off_allow( (ulong)hdr.supply ) + (ulong)i * ALLOW_SZ, w->key, 32UL ) == 0 ) return;   /* already allowed */
  }
  if( hdr.allow_cnt == 0xFFFFFFFFU ) tsdk_revert( ERR_RANGE );

  uchar * base = open_cfg( a.cfg_idx, &hdr );
  uchar * list = base + off_allow( (ulong)hdr.supply );
  allow_rec_t r;
  memcpy( r.wallet.key, w->key, 32UL );
  r.tag  = a.tag;
  r.slot = tsdk_get_current_block_ctx()->slot;
  memcpy( list + (ulong)( hdr.allow_cnt % hdr.max_allow ) * ALLOW_SZ, &r, ALLOW_SZ );

  hdr.allow_cnt += 1U;
  memcpy( base, &hdr, HDR_SZ );
}

/* ---------------------------------------------------------------- ALLOWER */

struct __attribute__(( packed )) allower_args {
  uchar  op;
  ushort cfg_idx;
  ushort allower_idx;
};

/* Lets the admin replace the server key that adds wallets, for when that key
   has to be rotated. It changes nothing else. */
static void
do_allower( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct allower_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct allower_args a;
  memcpy( &a, data, sizeof( a ) );

  cfg_hdr_t hdr;
  uchar * base = open_cfg( a.cfg_idx, &hdr );
  require_admin( &hdr );
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

struct __attribute__(( packed )) nft_mint_to_hdr {
  uint   op;
  ushort mint_idx;
  ushort nft_idx;
  ushort owner_idx;
  ulong  flags;
  uchar  uri[ NFT_URI_SZ ];
};

FD_STATIC_ASSERT( sizeof( struct nft_mint_to_hdr ) == 274UL, nft_mint_to_hdr_size );

static void
check_forward( uchar const * fwd, cfg_hdr_t const * hdr, ushort mint_idx, ushort nft_idx,
               ushort owner_idx, ulong id ) {
  struct nft_mint_to_hdr h;
  memcpy( &h, fwd, sizeof( h ) );
  uchar want_uri[ NFT_URI_SZ ];
  memset( want_uri, 0, NFT_URI_SZ );
  memcpy( want_uri, hdr->uri, (ulong)hdr->uri_len );
  (void)write_decimal( want_uri + hdr->uri_len, id );
  if( h.op != NFT_OP_MINT_TO || h.mint_idx != mint_idx || h.nft_idx != nft_idx
      || h.owner_idx != owner_idx || h.flags != 0UL
      || memcmp( h.uri, want_uri, NFT_URI_SZ ) != 0 ) {
    tsdk_revert( ERR_BAD_FORWARD );
  }
}

static int
is_reserved( uchar const * base, ulong n, ulong id ) {
  return ( base[ off_reserved( n ) + ( id >> 3 ) ] >> ( id & 7UL ) ) & 1;
}

static void
do_mint( uchar const * data, ulong data_sz ) {
  ulong fixed = sizeof( struct mint_args ) + sizeof( struct nft_mint_to_hdr );
  if( data_sz <= fixed ) tsdk_revert( ERR_BAD_INSTR );          /* needs a proof */
  struct mint_args a;
  memcpy( &a, data, sizeof( a ) );
  uchar const * fwd    = data + sizeof( struct mint_args );
  ulong         fwd_sz = data_sz - sizeof( struct mint_args );

  require_nft_program( a.nft_prog_idx );
  require_token_program( a.token_prog_idx );

  cfg_hdr_t hdr;
  uchar * base = open_cfg( a.cfg_idx, &hdr );
  ulong n = (ulong)hdr.supply;
  if( hdr.minted >= hdr.supply ) tsdk_revert( ERR_SOLD_OUT );

  tn_pubkey_t const * me = account_addr( 0 );

  /* On the allowlist. */
  uchar const * list = base + off_allow( n );
  uint live = hdr.allow_cnt < hdr.max_allow ? hdr.allow_cnt : hdr.max_allow;
  int allowed = 0;
  for( uint i=0U; i<live; i++ ) {
    if( memcmp( list + (ulong)i * ALLOW_SZ, me->key, 32UL ) == 0 ) { allowed = 1; break; }
  }
  if( !allowed ) tsdk_revert( ERR_NOT_ALLOWED );

  /* One per wallet, ever: checked against who minted, not who holds now. */
  uchar * minters = base + off_minters( n );
  for( uint i=0U; i<hdr.minted; i++ ) {
    if( memcmp( minters + (ulong)i * 32UL, me->key, 32UL ) == 0 ) tsdk_revert( ERR_ALREADY_MINTED );
  }

  require_addr( a.nft_mint_idx, &hdr.nft_mint );
  require_addr( a.treasury_idx, &hdr.treasury );
  ulong id = (ulong)hdr.minted;
  if( nft_next_id( a.nft_mint_idx ) != id ) tsdk_revert( ERR_OUT_OF_SYNC );

  /* The forwarded mint_to must be exactly the one this program would build:
     this collection, a new NFT account, owned by the payer, no flags, and
     the uri base followed by this Pal's number, zero-padded. */
  check_forward( fwd, &hdr, a.nft_mint_idx, a.nft_acct_idx, (ushort)0, id );
  if( is_reserved( base, n, id ) ) tsdk_revert( ERR_RESERVED );

  /* Payment first. The payer's account must be theirs and of the payment mint,
     and the money goes straight to the treasury fixed at INIT. */
  require_token_acc( a.pay_from_idx, &hdr.pay_mint, me );
  ulong prc = tn_token_transfer( a.token_prog_idx, a.pay_from_idx, a.treasury_idx,
                                 hdr.price, (tsdk_invoke_auth_t const *)0 );
  if( prc != 0UL ) tsdk_revert( ERR_PAYMENT | ( prc & 0xFFUL ) );

  /* Then the Pal. */
  nft_invoke( fwd, fwd_sz, a.nft_prog_idx );

  /* The NFT program must have counted it; if it did not, nothing here moves. */
  if( nft_next_id( a.nft_mint_idx ) != id + 1UL ) tsdk_revert( ERR_OUT_OF_SYNC );

  memcpy( base + off_owners() + id * 32UL, me->key, 32UL );
  memcpy( minters + id * 32UL,              me->key, 32UL );
  hdr.minted += 1U;
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
  uint   id;
};

struct __attribute__(( packed )) nft_transfer_ix {
  uint   op;
  ushort nft_idx;
  ushort dest_idx;
  ushort mint_idx;
};

/* Moves Pal `id` to the account at `dest_idx`, checking that the NFT account
   is the NFT program's, of this collection, with that number, and that it
   really moved. This program is the collection's authority, so the NFT
   program accepts the call. */
static void
move_pal( cfg_hdr_t const * hdr, ushort nft_prog_idx, ushort nft_mint_idx, ushort nft_acct_idx,
          ushort dest_idx, uint id ) {
  require_nft_program( nft_prog_idx );
  require_addr( nft_mint_idx, &hdr->nft_mint );
  require_owned_by( nft_acct_idx, NFT_PROGRAM );
  if( (ulong)tsdk_get_account_meta( nft_acct_idx )->data_sz != NFT_ACCT_SZ ) tsdk_revert( ERR_WRONG_ACCOUNT );
  uchar const * nd = (uchar const *)tsdk_get_account_data_ptr( nft_acct_idx );
  ulong nid = 0UL;
  memcpy( &nid, nd + 64, 8UL );
  if( nid != (ulong)id || memcmp( nd, hdr->nft_mint.key, 32UL ) != 0 ) tsdk_revert( ERR_WRONG_ACCOUNT );

  struct nft_transfer_ix ix;
  ix.op       = NFT_OP_TRANSFER;
  ix.nft_idx  = nft_acct_idx;
  ix.dest_idx = dest_idx;
  ix.mint_idx = nft_mint_idx;
  nft_invoke( &ix, sizeof( ix ), nft_prog_idx );
  if( memcmp( nd + 32, account_addr( dest_idx )->key, 32UL ) != 0 ) tsdk_revert( ERR_NFT_CPI );
}

static void
do_send( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct send_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct send_args a;
  memcpy( &a, data, sizeof( a ) );
  require_nft_program( a.nft_prog_idx );

  cfg_hdr_t hdr;
  uchar * base = open_cfg( a.cfg_idx, &hdr );
  if( a.id >= hdr.minted ) tsdk_revert( ERR_RANGE );

  tn_pubkey_t const * me   = account_addr( 0 );
  tn_pubkey_t const * dest = account_addr( a.dest_idx );
  uchar * owner = base + off_owners() + (ulong)a.id * 32UL;
  if( memcmp( owner, me->key, 32UL ) != 0 ) tsdk_revert( ERR_NOT_HOLDER );
  if( same( dest, me ) || is_zero( dest->key ) ) tsdk_revert( ERR_SELF );

  require_addr( a.nft_mint_idx, &hdr.nft_mint );
  /* The NFT account must be the NFT program's, for this collection, with the
     number named here. */
  require_owned_by( a.nft_acct_idx, NFT_PROGRAM );
  if( (ulong)tsdk_get_account_meta( a.nft_acct_idx )->data_sz != NFT_ACCT_SZ ) tsdk_revert( ERR_WRONG_ACCOUNT );
  uchar const * nd = (uchar const *)tsdk_get_account_data_ptr( a.nft_acct_idx );
  ulong nid = 0UL;
  memcpy( &nid, nd + 64, 8UL );
  if( nid != (ulong)a.id || memcmp( nd, hdr.nft_mint.key, 32UL ) != 0 ) tsdk_revert( ERR_WRONG_ACCOUNT );

  struct nft_transfer_ix ix;
  ix.op       = NFT_OP_TRANSFER;
  ix.nft_idx  = a.nft_acct_idx;
  ix.dest_idx = a.dest_idx;
  ix.mint_idx = a.nft_mint_idx;
  nft_invoke( &ix, sizeof( ix ), a.nft_prog_idx );

  /* And it must really have moved. */
  if( memcmp( nd + 32, dest->key, 32UL ) != 0 ) tsdk_revert( ERR_NFT_CPI );

  memcpy( owner, dest->key, 32UL );
}

/* ----------------------------------------------------------------- PRIZES */

struct __attribute__(( packed )) prizes_args {
  uchar  op;
  ushort cfg_idx;
  ushort count;
};

struct __attribute__(( packed )) prize_entry {
  uint  id;
  ulong amount;
};

static void
do_prizes( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct prizes_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct prizes_args a;
  memcpy( &a, data, sizeof( a ) );
  ulong need = sizeof( struct prizes_args ) + (ulong)a.count * sizeof( struct prize_entry );
  if( data_sz < need ) tsdk_revert( ERR_BAD_INSTR );

  cfg_hdr_t hdr;
  uchar * base = open_cfg( a.cfg_idx, &hdr );
  require_admin( &hdr );
  if( hdr.prizes_locked ) tsdk_revert( ERR_LOCKED );

  uchar * prizes = base + off_prizes( (ulong)hdr.supply );
  for( ulong i=0UL; i<(ulong)a.count; i++ ) {
    struct prize_entry e;
    memcpy( &e, data + sizeof( struct prizes_args ) + i * sizeof( e ), sizeof( e ) );
    if( e.id >= hdr.supply ) tsdk_revert( ERR_RANGE );
    memcpy( prizes + (ulong)e.id * 8UL, &e.amount, 8UL );
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
  uchar * base = open_cfg( a.cfg_idx, &hdr );
  require_admin( &hdr );
  if( hdr.prizes_locked ) tsdk_revert( ERR_LOCKED );

  /* The prize vault is a payment-token account owned by this program, so only
     CLAIM can ever spend from it. */
  require_token_acc( a.vault_idx, &hdr.pay_mint, tsdk_get_current_program_acc_addr() );
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
  uint   id;
};

static void
do_claim( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct claim_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct claim_args a;
  memcpy( &a, data, sizeof( a ) );
  require_token_program( a.token_prog_idx );

  cfg_hdr_t hdr;
  uchar * base = open_cfg( a.cfg_idx, &hdr );
  if( !hdr.prizes_locked ) tsdk_revert( ERR_NOT_LOCKED );
  if( a.id >= hdr.minted ) tsdk_revert( ERR_RANGE );
  ulong n = (ulong)hdr.supply;

  /* Only the wallet holding this Pal right now, signing for itself. */
  tn_pubkey_t const * me = account_addr( 0 );
  if( memcmp( base + off_owners() + (ulong)a.id * 32UL, me->key, 32UL ) != 0 ) tsdk_revert( ERR_NOT_HOLDER );

  uchar * claimed = base + off_claimed( n );
  ulong   byte    = (ulong)( a.id >> 3 );
  uchar   bit     = (uchar)( 1U << ( a.id & 7U ) );
  if( claimed[ byte ] & bit ) tsdk_revert( ERR_CLAIMED );

  ulong amount = 0UL;
  memcpy( &amount, base + off_prizes( n ) + (ulong)a.id * 8UL, 8UL );
  if( amount == 0UL ) tsdk_revert( ERR_NO_PRIZE );

  require_addr( a.vault_idx, &hdr.prize_vault );
  require_token_acc( a.dest_idx, &hdr.pay_mint, me );

  /* Marked first; if the transfer fails the whole transaction reverts, so the
     mark cannot outlive an unpaid prize. */
  claimed[ byte ] = (uchar)( claimed[ byte ] | bit );
  ulong rc = tn_token_transfer( a.token_prog_idx, a.vault_idx, a.dest_idx, amount,
                                (tsdk_invoke_auth_t const *)0 );
  if( rc != 0UL ) tsdk_revert( ERR_PAYMENT | ( rc & 0xFFUL ) );
}

/* ------------------------------------------------ RESERVE / UNRESERVE */

struct __attribute__(( packed )) reserve_args {
  uchar  op;
  ushort cfg_idx;
  ushort count;
  /* count x u32 id follow */
};

/* Marks (or unmarks) Pal numbers as reserved for the reserve wallet. Only
   numbers not minted yet can change, so nobody's Pal is ever affected. A
   reserved number cannot be bought: when the count reaches it, GIFT mints it
   to the reserve wallet and the public mint carries on after it. */
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
    uint id = 0U;
    memcpy( &id, data + sizeof( a ) + i * 4UL, 4UL );
    if( id >= hdr.supply || id < hdr.minted ) tsdk_revert( ERR_RANGE );
    int was = ( ro[ off_reserved( n ) + ( id >> 3 ) ] >> ( id & 7U ) ) & 1;
    if( was != set ) changes = 1;
  }
  if( !changes ) return;                               /* nothing to change */
  uchar * base = open_cfg( a.cfg_idx, &hdr );
  uchar * bits = base + off_reserved( n );
  for( ulong i=0UL; i<(ulong)a.count; i++ ) {
    uint id = 0U;
    memcpy( &id, data + sizeof( a ) + i * 4UL, 4UL );
    if( id >= hdr.supply || id < hdr.minted ) tsdk_revert( ERR_RANGE );
    uchar bit = (uchar)( 1U << ( id & 7U ) );
    int was = ( bits[ id >> 3 ] & bit ) != 0;
    if( set && !was )  { bits[ id >> 3 ] = (uchar)( bits[ id >> 3 ] | bit );  hdr.reserved_cnt += 1U; }
    if( !set && was )  { bits[ id >> 3 ] = (uchar)( bits[ id >> 3 ] & (uchar)~bit ); hdr.reserved_cnt -= 1U; }
  }
  memcpy( base, &hdr, HDR_SZ );
}

/* ------------------------------------------------------------------ GIFT */

struct __attribute__(( packed )) gift_args {
  uchar  op;
  ushort cfg_idx;
  ushort nft_prog_idx;
  ushort nft_mint_idx;
  ushort nft_acct_idx;
  ushort reserve_idx;
};

/* Mints the next Pal to the reserve wallet, free, if and only if its number
   is reserved. Signed by the admin or the allower (ThruScan's server does it
   when the count reaches a reserved number). The forwarded mint_to is checked
   exactly as in MINT, with the reserve wallet as owner. */
static void
do_gift( uchar const * data, ulong data_sz ) {
  ulong fixed = sizeof( struct gift_args ) + sizeof( struct nft_mint_to_hdr );
  if( data_sz <= fixed ) tsdk_revert( ERR_BAD_INSTR );
  struct gift_args a;
  memcpy( &a, data, sizeof( a ) );
  uchar const * fwd    = data + sizeof( struct gift_args );
  ulong         fwd_sz = data_sz - sizeof( struct gift_args );
  require_nft_program( a.nft_prog_idx );

  cfg_hdr_t hdr;
  uchar * base = open_cfg( a.cfg_idx, &hdr );
  tn_pubkey_t const * payer = account_addr( 0 );
  if( !same( payer, &hdr.admin ) && !same( payer, &hdr.allower ) ) tsdk_revert( ERR_NOT_ADMIN );
  ulong n = (ulong)hdr.supply;
  if( hdr.minted >= hdr.supply ) tsdk_revert( ERR_SOLD_OUT );
  ulong id = (ulong)hdr.minted;
  if( !is_reserved( base, n, id ) ) tsdk_revert( ERR_NOT_RESERVED );

  require_addr( a.nft_mint_idx, &hdr.nft_mint );
  require_addr( a.reserve_idx, &hdr.reserve_wallet );
  if( nft_next_id( a.nft_mint_idx ) != id ) tsdk_revert( ERR_OUT_OF_SYNC );
  check_forward( fwd, &hdr, a.nft_mint_idx, a.nft_acct_idx, a.reserve_idx, id );

  nft_invoke( fwd, fwd_sz, a.nft_prog_idx );
  if( nft_next_id( a.nft_mint_idx ) != id + 1UL ) tsdk_revert( ERR_OUT_OF_SYNC );

  memcpy( base + off_owners() + id * 32UL,      hdr.reserve_wallet.key, 32UL );
  memcpy( base + off_minters( n ) + id * 32UL,  hdr.reserve_wallet.key, 32UL );
  hdr.minted += 1U;
  memcpy( base, &hdr, HDR_SZ );
}

/* ----------------------------------------------------------------- MARKET */

struct __attribute__(( packed )) market_args {
  uchar  op;
  uchar  seed[ 32 ];
  ushort cfg_idx;
  ushort fee_bps;
};

#define MKT_INIT_IDX ((ushort)2)

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

  if( !tsdk_is_account_idx_valid( MKT_INIT_IDX ) ) tsdk_revert( ERR_NO_ACCOUNT );
  if( tsdk_account_exists( MKT_INIT_IDX ) ) tsdk_revert( ERR_WRONG_ACCOUNT );
  if( tsys_account_create( MKT_INIT_IDX, a.seed, proof, proof_sz ) != TSDK_SUCCESS ) tsdk_revert( ERR_CREATE_FAILED );
  if( !tsdk_is_account_owned_by_current_program( MKT_INIT_IDX ) ) tsdk_revert( ERR_NOT_OURS );
  if( tsys_set_account_data_writable( MKT_INIT_IDX ) != TSDK_SUCCESS ) tsdk_revert( ERR_WRITE_DENIED );
  ulong want = mkt_size( (ulong)hdr.supply );
  ulong rc = tsys_account_resize( MKT_INIT_IDX, want );
  if( rc != TSDK_SUCCESS ) tsdk_revert( 0x8000UL | ( rc & 0xFFUL ) );

  uchar * base = (uchar *)tsdk_get_account_data_ptr( MKT_INIT_IDX );
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
  if( m.fee_bps == a.fee_bps ) return;                 /* nothing to change */
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
  uint   id;
  ulong  price;
};

static void
do_list( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct list_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct list_args a;
  memcpy( &a, data, sizeof( a ) );
  if( a.price == 0UL || a.price > PRICE_MAX ) tsdk_revert( ERR_RANGE );

  /* The config changes only for a new listing (its holder becomes this
     program); a price change touches the market alone. See open_mkt. */
  cfg_hdr_t hdr;
  uchar const * ro = read_cfg( a.cfg_idx, &hdr );
  mkt_hdr_t m;
  uchar * mb = open_mkt( a.mkt_idx, a.cfg_idx, &hdr, &m );
  if( a.id >= hdr.minted ) tsdk_revert( ERR_RANGE );

  tn_pubkey_t const * me   = account_addr( 0 );
  tn_pubkey_t const * self = tsdk_get_current_program_acc_addr();
  ulong own_off = off_owners() + (ulong)a.id * 32UL;
  listing_t * l = (listing_t *)( mb + MKT_HDR_SZ + (ulong)a.id * LISTING_SZ );
  require_token_acc( a.payout_idx, &hdr.pay_mint, me );

  if( memcmp( ro + own_off, me->key, 32UL ) == 0 ) {
    /* A new listing: the Pal goes into this program's keeping. */
    if( !same( account_addr( a.escrow_idx ), self ) ) tsdk_revert( ERR_WRONG_ACCOUNT );
    uchar * base = open_cfg( a.cfg_idx, &hdr );
    move_pal( &hdr, a.nft_prog_idx, a.nft_mint_idx, a.nft_acct_idx, a.escrow_idx, a.id );
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
  uint   id;
};

static void
do_delist( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct delist_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct delist_args a;
  memcpy( &a, data, sizeof( a ) );

  cfg_hdr_t hdr;
  uchar * base = open_cfg( a.cfg_idx, &hdr );
  mkt_hdr_t m;
  uchar * mb = open_mkt( a.mkt_idx, a.cfg_idx, &hdr, &m );
  if( a.id >= hdr.minted ) tsdk_revert( ERR_RANGE );

  tn_pubkey_t const * me = account_addr( 0 );
  uchar * owner = base + off_owners() + (ulong)a.id * 32UL;
  listing_t * l = (listing_t *)( mb + MKT_HDR_SZ + (ulong)a.id * LISTING_SZ );
  if( memcmp( owner, tsdk_get_current_program_acc_addr()->key, 32UL ) != 0 ) tsdk_revert( ERR_NOT_LISTED );
  if( !same( &l->seller, me ) ) tsdk_revert( ERR_NOT_HOLDER );

  move_pal( &hdr, a.nft_prog_idx, a.nft_mint_idx, a.nft_acct_idx, (ushort)0, a.id );
  memcpy( owner, me->key, 32UL );
  memset( l, 0, LISTING_SZ );
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
  uint   id;
  ulong  max_price;
};

static void
pay( ushort token_prog_idx, ushort from_idx, ushort to_idx, ulong amount ) {
  if( amount == 0UL ) return;
  ulong rc = tn_token_transfer( token_prog_idx, from_idx, to_idx, amount, (tsdk_invoke_auth_t const *)0 );
  if( rc != 0UL ) tsdk_revert( ERR_PAYMENT | ( rc & 0xFFUL ) );
}

static void
do_buy( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct buy_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct buy_args a;
  memcpy( &a, data, sizeof( a ) );
  if( a.count == 0U || a.count > BUY_MAX ) tsdk_revert( ERR_RANGE );
  if( data_sz < sizeof( a ) + (ulong)a.count * sizeof( struct buy_item ) ) tsdk_revert( ERR_BAD_INSTR );
  require_token_program( a.token_prog_idx );

  cfg_hdr_t hdr;
  uchar * base = open_cfg( a.cfg_idx, &hdr );
  mkt_hdr_t m;
  uchar * mb = open_mkt( a.mkt_idx, a.cfg_idx, &hdr, &m );

  tn_pubkey_t const * me   = account_addr( 0 );
  tn_pubkey_t const * self = tsdk_get_current_program_acc_addr();
  require_token_acc( a.pay_from_idx, &hdr.pay_mint, me );
  require_addr( a.fee_to_idx, &hdr.treasury );

  for( ulong i=0UL; i<(ulong)a.count; i++ ) {
    struct buy_item it;
    memcpy( &it, data + sizeof( a ) + i * sizeof( it ), sizeof( it ) );
    if( it.id >= hdr.minted ) tsdk_revert( ERR_RANGE );
    uchar * owner = base + off_owners() + (ulong)it.id * 32UL;
    listing_t * l = (listing_t *)( mb + MKT_HDR_SZ + (ulong)it.id * LISTING_SZ );
    if( memcmp( owner, self->key, 32UL ) != 0 || is_zero( l->seller.key ) ) tsdk_revert( ERR_NOT_LISTED );
    if( same( &l->seller, me ) ) tsdk_revert( ERR_SELF );
    if( l->price > it.max_price ) tsdk_revert( ERR_PRICE );
    require_addr( it.payout_idx, &l->payout );
    require_token_acc( it.payout_idx, &hdr.pay_mint, &l->seller );

    ulong price = l->price;
    ulong fee   = price * (ulong)m.fee_bps / 10000UL;   /* price <= PRICE_MAX, no overflow */
    pay( a.token_prog_idx, a.pay_from_idx, it.payout_idx, price - fee );
    pay( a.token_prog_idx, a.pay_from_idx, a.fee_to_idx, fee );

    move_pal( &hdr, a.nft_prog_idx, a.nft_mint_idx, it.nft_acct_idx, (ushort)0, it.id );
    memcpy( owner, me->key, 32UL );

    sale_rec_t r;
    r.id    = it.id;
    r.price = price;
    memcpy( r.buyer.key,  me->key,        32UL );
    memcpy( r.seller.key, l->seller.key,  32UL );
    r.slot  = tsdk_get_current_block_ctx()->slot;
    memcpy( mb + mkt_off_sales( (ulong)m.supply ) + ( (ulong)m.sales % SALES_RING ) * SALE_SZ, &r, SALE_SZ );

    memset( l, 0, LISTING_SZ );
    m.listed -= 1U;
    m.sales  += 1U;
    m.volume += price;
  }
  memcpy( mb, &m, MKT_HDR_SZ );
}

/* ------------------------------------------------------------- entrypoint */

TSDK_ENTRYPOINT_FN void
start( void const * instruction_data,
       ulong        instruction_data_sz ) {
  uchar const * data = (uchar const *)instruction_data;
  if( instruction_data_sz < 1UL ) tsdk_revert( ERR_BAD_INSTR );

  switch( data[ 0 ] ) {
    case OP_INIT:    do_init   ( data, instruction_data_sz ); break;
    case OP_ALLOW:   do_allow  ( data, instruction_data_sz ); break;
    case OP_MINT:    do_mint   ( data, instruction_data_sz ); break;
    case OP_SEND:    do_send   ( data, instruction_data_sz ); break;
    case OP_PRIZES:  do_prizes ( data, instruction_data_sz ); break;
    case OP_LOCK:    do_lock   ( data, instruction_data_sz ); break;
    case OP_CLAIM:   do_claim  ( data, instruction_data_sz ); break;
    case OP_ALLOWER: do_allower( data, instruction_data_sz ); break;
    case OP_RESERVE:   do_reserve( data, instruction_data_sz, 1 ); break;
    case OP_UNRESERVE: do_reserve( data, instruction_data_sz, 0 ); break;
    case OP_GIFT:      do_gift   ( data, instruction_data_sz ); break;
    case OP_MARKET:    do_market ( data, instruction_data_sz ); break;
    case OP_FEE:       do_fee    ( data, instruction_data_sz ); break;
    case OP_LIST:      do_list   ( data, instruction_data_sz ); break;
    case OP_DELIST:    do_delist ( data, instruction_data_sz ); break;
    case OP_BUY:       do_buy    ( data, instruction_data_sz ); break;
    default:         tsdk_revert( ERR_BAD_OPCODE );
  }

  tsdk_return( 0UL );
}
