/* thrupad - a bonding curve launchpad on Thru.
 *
 * Anyone creates a token, its entire supply goes onto a curve, and people buy
 * and sell against that curve rather than against each other. No listing, no
 * counterparty, no initial liquidity to raise. The price is a function of how
 * much has been bought, and it is computed on chain rather than reported by a
 * client.
 *
 * The shape is Pons and pump.fun: a constant product curve with VIRTUAL
 * reserves. Virtual reserves are what stop the first buyer getting the supply
 * for nothing. A pure x*y=k curve seeded with real tokens and zero quote has an
 * opening price of zero; seeding it with a virtual quote reserve instead means
 * the curve opens at a real price and the whole supply is never quite sold,
 * which is also what leaves something behind to seed a pool at graduation.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS STORED AND WHAT IS READ
 *
 * The curve's state (vq, vt) is stored, because it is the program's own
 * bookkeeping and has no on-chain source. Actual balances are NOT stored: they
 * are read live from the vaults, the same way thruswap does it, so the program
 * can never pay out against a balance that is not there. Creator fees are
 * stored, because the quote vault holds fees and curve backing in one pot and
 * only the program knows where the line is.
 *
 * ---------------------------------------------------------------------------
 * FEES
 *
 * Two, and they are different things.
 *
 * The creator fee is set once at launch, capped at 10% to match Pons, and
 * accrues to the creator on every buy and sell. It is the reason to launch
 * something and keep it alive.
 *
 * The anti-snipe tax is temporary and belongs to nobody. It starts high and
 * decays to zero over the opening slots, so being first in the block is worth
 * nothing. It is not paid to the creator, deliberately: a creator who earns
 * from the snipe window has every reason to snipe their own launch. It stays in
 * the quote vault, backing the curve, which means early haste subsidises
 * everyone who comes later.
 *
 * ---------------------------------------------------------------------------
 * INSTRUCTIONS
 *
 *   INIT     [0x00][seed 32][slots u16][grad_threshold u64][state proof]
 *            Creates the launch registry. Accounts: the registry read-write,
 *            the quote mint read-only, so they land at index 2 and 3.
 *
 *   LAUNCH   [0x01][...][supply u64][virt_quote u64][name][symbol]
 *            Records a launch and mints its entire supply onto the curve. The
 *            mint's authority must already be this program, which is what makes
 *            the supply fixed: there is no instruction here that mints again.
 *
 *   BUY      [0x02][...][quote_in u64][min_tokens_out u64]
 *   SELL     [0x03][...][tokens_in u64][min_quote_out u64]
 *
 *   CLAIM    [0x04][...]
 *            Pays accrued creator fees out to an account of the creator's
 *            choosing. Anyone may call it; the money only ever goes to the
 *            recorded creator's destination.
 *
 *   GRADUATE [0x05][...]
 *            Once enough quote has been collected, freezes the curve. After
 *            this the reserves are ready to seed a thruswap pool.
 *
 * Every u16 index is a position in the transaction's account list, which Thru
 * sorts ascending by raw public key bytes. Indices are passed in and validated
 * against the pubkeys recorded in the launch, never assumed.
 */

#include <thru-sdk/c/tn_sdk.h>
#include <thru-sdk/c/tn_sdk_syscall.h>

#include "thru_token.h"

#define OP_INIT     (0x00)
#define OP_LAUNCH   (0x01)
#define OP_BUY      (0x02)
#define OP_SELL     (0x03)
#define OP_CLAIM    (0x04)
#define OP_GRADUATE (0x05)

#define PAD_VERSION  ((uchar)2)
#define REG_ACC_IDX  ((ushort)2)   /* INIT declares one read-write account */
#define QUOTE_MINT_IDX ((ushort)3) /* and one read-only: the quote mint */
#define LAUNCHES_MAX (256UL)

#define STATE_EMPTY     ((uchar)0)
#define STATE_LIVE      ((uchar)1)
#define STATE_GRADUATED ((uchar)2)

#define NAME_MAX   (32UL)
#define SYMBOL_MAX (8UL)

#define BPS_DENOM      (10000UL)
#define CREATOR_BPS_MAX (1000U)   /* 10%, the same ceiling Pons uses */

/* The snipe tax starts here and decays linearly to zero across SNIPE_SLOTS.
   Slots rather than seconds because a slot is what a program can read, and
   because the thing being defended against is block ordering, not wall clock. */
#define SNIPE_BPS_START (9000UL)
#define SNIPE_SLOTS     (25UL)

#define ERR_BAD_INSTR      (1UL)
#define ERR_BAD_OPCODE     (2UL)
#define ERR_NO_ACCOUNT     (3UL)
#define ERR_NOT_OURS       (4UL)
#define ERR_NOT_READY      (5UL)
#define ERR_BAD_SLOTS      (6UL)
#define ERR_CREATE_FAILED  (7UL)
#define ERR_WRITE_DENIED   (8UL)
#define ERR_RANGE          (9UL)
#define ERR_EXISTS        (10UL)
#define ERR_BAD_IDX       (11UL)
#define ERR_WRONG_ACCOUNT (12UL)
#define ERR_NOT_TOKEN_ACC (13UL)
#define ERR_VAULT_OWNER   (14UL)
#define ERR_MINT_MISMATCH (15UL)
#define ERR_ZERO_AMOUNT   (16UL)
#define ERR_DUST          (18UL)
#define ERR_SLIPPAGE      (19UL)
#define ERR_FEE_RANGE     (20UL)
#define ERR_OVERFLOW      (21UL)
#define ERR_NAME          (23UL)
#define ERR_NOT_LIVE      (24UL)
#define ERR_GRADUATED     (25UL)
#define ERR_NOT_FUNDED    (26UL)
#define ERR_TOO_SOON      (27UL)
#define ERR_NO_FEES       (28UL)
#define ERR_SUPPLY        (29UL)

/* --------------------------------------------------------------- storage */

struct __attribute__(( packed )) pad_hdr {
  uchar       version;
  uint        launch_count;
  tn_pubkey_t sponsor;
  tn_pubkey_t quote_mint;
  ulong       grad_threshold;
};
typedef struct pad_hdr pad_hdr_t;

struct __attribute__(( packed )) launch_rec {
  uchar       state;
  ushort      fee_bps;
  uchar       name_len;
  uchar       name[ NAME_MAX ];
  uchar       symbol_len;
  uchar       symbol[ SYMBOL_MAX ];
  tn_pubkey_t creator;
  tn_pubkey_t mint;
  tn_pubkey_t token_vault;
  tn_pubkey_t quote_vault;
  /* v2: the quote asset is chosen per launch rather than fixed for the whole
     registry, so one pad can price some curves in tUSD and others in WTHRU.
     The header still carries a quote mint, which is now only the default a
     front end offers first. */
  tn_pubkey_t quote_mint;
  ulong       vq;            /* virtual quote reserve */
  ulong       vt;            /* virtual token reserve */
  ulong       creator_fees;  /* accrued, sitting in the quote vault */
  ulong       tokens_sold;
  ulong       trade_count;
  ulong       start_slot;
};
typedef struct launch_rec launch_rec_t;

#define HDR_SZ    (sizeof( pad_hdr_t ))
#define LAUNCH_SZ (sizeof( launch_rec_t ))

FD_STATIC_ASSERT( HDR_SZ    == 77UL,  pad_hdr_size );
FD_STATIC_ASSERT( LAUNCH_SZ == 253UL, launch_rec_size );

static inline ulong
registry_capacity( ulong data_sz ) {
  if( data_sz < HDR_SZ ) return 0UL;
  return ( data_sz - HDR_SZ ) / LAUNCH_SZ;
}

/* ------------------------------------------------------------- arithmetic */

__extension__ typedef unsigned __int128 uint128;

static inline ulong
mul_div( ulong a, ulong b, ulong d ) {
  if( d == 0UL ) tsdk_revert( ERR_OVERFLOW );
  uint128 r = ( (uint128)a * (uint128)b ) / (uint128)d;
  if( r > (uint128)0xFFFFFFFFFFFFFFFFULL ) tsdk_revert( ERR_OVERFLOW );
  return (ulong)r;
}

/* snipe_bps decays from SNIPE_BPS_START to zero over SNIPE_SLOTS. Linear
   rather than exponential because it is simpler to reason about and the
   difference over 25 slots is not worth the arithmetic. */
static ulong
snipe_bps( ulong start_slot ) {
  tsdk_block_ctx_t const * ctx = tsdk_get_current_block_ctx();
  ulong now = ctx->slot;
  if( now <= start_slot ) return SNIPE_BPS_START;
  ulong elapsed = now - start_slot;
  if( elapsed >= SNIPE_SLOTS ) return 0UL;
  return SNIPE_BPS_START - ( SNIPE_BPS_START * elapsed ) / SNIPE_SLOTS;
}

/* ---------------------------------------------------------- account checks */

static tn_pubkey_t const *
account_addr( ushort idx ) {
  tsdk_txn_t const * txn = tsdk_get_txn();
  if( idx >= tsdk_txn_account_cnt( txn ) ) tsdk_revert( ERR_BAD_IDX );
  return &tsdk_txn_get_acct_addrs( txn )[ idx ];
}

static void
require_addr( ushort idx, tn_pubkey_t const * expected ) {
  if( memcmp( account_addr( idx )->key, expected->key, 32UL ) != 0 ) {
    tsdk_revert( ERR_WRONG_ACCOUNT );
  }
}

/* A vault has to be a token account, of the expected mint, owned by this
   program. The mint check is the one that matters most: a vault holding the
   wrong asset would let someone pay in something worthless and take out
   something real at the curve's price. */
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

static uchar *
open_registry_raw( ushort reg_idx ) {
  if( !tsdk_is_account_idx_valid( reg_idx ) ) tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_account_exists( reg_idx ) )       tsdk_revert( ERR_NOT_READY );
  if( !tsdk_is_account_owned_by_current_program( reg_idx ) ) tsdk_revert( ERR_NOT_OURS );
  if( tsys_set_account_data_writable( reg_idx ) != TSDK_SUCCESS ) {
    tsdk_revert( ERR_WRITE_DENIED );
  }
  uchar * base = (uchar *)tsdk_get_account_data_ptr( reg_idx );
  pad_hdr_t const * hdr = (pad_hdr_t const *)base;
  if( hdr->version != PAD_VERSION ) tsdk_revert( ERR_NOT_READY );
  return base;
}

static launch_rec_t *
open_launch( ushort reg_idx, ushort launch_id, uchar ** out_base ) {
  uchar * base = open_registry_raw( reg_idx );
  tsdk_account_meta_t const * meta = tsdk_get_account_meta( reg_idx );
  ulong cap = registry_capacity( (ulong)meta->data_sz );
  if( cap == 0UL )                  tsdk_revert( ERR_NOT_READY );
  if( (ulong)launch_id >= cap )     tsdk_revert( ERR_RANGE );
  if( out_base ) *out_base = base;
  return (launch_rec_t *)( base + HDR_SZ + (ulong)launch_id * LAUNCH_SZ );
}

/* ------------------------------------------------------------------- INIT */

struct __attribute__(( packed )) init_args {
  uchar  op;
  uchar  seed[ 32 ];
  ushort slots;
  ulong  grad_threshold;
};

static void
do_init( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct init_args ) ) tsdk_revert( ERR_BAD_INSTR );

  struct init_args a;
  memcpy( &a, data, sizeof( a ) );

  ulong slots = (ulong)a.slots;
  if( slots == 0UL || slots > LAUNCHES_MAX ) tsdk_revert( ERR_BAD_SLOTS );
  if( !tsdk_is_account_idx_valid( REG_ACC_IDX ) )   tsdk_revert( ERR_NO_ACCOUNT );
  if( !tsdk_is_account_idx_valid( QUOTE_MINT_IDX ) ) tsdk_revert( ERR_NO_ACCOUNT );

  ulong want = HDR_SZ + slots * LAUNCH_SZ;
  uchar const * proof    = data + sizeof( struct init_args );
  ulong         proof_sz = data_sz - sizeof( struct init_args );

  if( !tsdk_account_exists( REG_ACC_IDX ) ) {
    if( tsys_account_create( REG_ACC_IDX, a.seed, proof, proof_sz ) != TSDK_SUCCESS ) {
      tsdk_revert( ERR_CREATE_FAILED );
    }
  }
  if( !tsdk_is_account_owned_by_current_program( REG_ACC_IDX ) ) tsdk_revert( ERR_NOT_OURS );

  /* Writable before resize. The other order fails at every size and the
     failure looks like a size limit, which it is not. */
  if( tsys_set_account_data_writable( REG_ACC_IDX ) != TSDK_SUCCESS ) {
    tsdk_revert( ERR_WRITE_DENIED );
  }

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( REG_ACC_IDX );
  if( (ulong)meta->data_sz != want ) {
    ulong rc = tsys_account_resize( REG_ACC_IDX, want );
    if( rc != TSDK_SUCCESS ) tsdk_revert( 0x8000UL | ( rc & 0xFFUL ) );
  }

  uchar * base = (uchar *)tsdk_get_account_data_ptr( REG_ACC_IDX );
  memset( base, 0, want );

  pad_hdr_t hdr;
  memset( &hdr, 0, sizeof( hdr ) );
  hdr.version        = PAD_VERSION;
  hdr.launch_count   = 0U;
  hdr.grad_threshold = a.grad_threshold;
  memcpy( hdr.sponsor.key,    account_addr( 0 )->key,              32UL );
  memcpy( hdr.quote_mint.key, account_addr( QUOTE_MINT_IDX )->key, 32UL );
  memcpy( base, &hdr, HDR_SZ );
}

/* ----------------------------------------------------------------- LAUNCH */

struct __attribute__(( packed )) launch_args {
  uchar  op;
  ushort token_prog_idx;
  ushort reg_idx;
  ushort launch_id;
  ushort mint_idx;
  ushort token_vault_idx;
  ushort quote_vault_idx;
  ushort quote_mint_idx;
  ushort fee_bps;
  ulong  supply;
  ulong  virt_quote;
  uchar  name_len;
  uchar  symbol_len;
  /* name bytes then symbol bytes follow */
};

static void
do_launch( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct launch_args ) ) tsdk_revert( ERR_BAD_INSTR );

  struct launch_args a;
  memcpy( &a, data, sizeof( a ) );

  if( a.fee_bps > CREATOR_BPS_MAX )            tsdk_revert( ERR_FEE_RANGE );
  if( a.supply == 0UL || a.virt_quote == 0UL ) tsdk_revert( ERR_ZERO_AMOUNT );
  if( a.name_len == 0U || (ulong)a.name_len > NAME_MAX )     tsdk_revert( ERR_NAME );
  if( a.symbol_len == 0U || (ulong)a.symbol_len > SYMBOL_MAX ) tsdk_revert( ERR_NAME );

  ulong text = (ulong)a.name_len + (ulong)a.symbol_len;
  if( data_sz < sizeof( struct launch_args ) + text ) tsdk_revert( ERR_BAD_INSTR );
  uchar const * name   = data + sizeof( struct launch_args );
  uchar const * symbol = name + a.name_len;

  uchar * base = (uchar *)0;
  launch_rec_t * rec = open_launch( a.reg_idx, a.launch_id, &base );
  if( rec->state != STATE_EMPTY ) tsdk_revert( ERR_EXISTS );

  pad_hdr_t hdr;
  memcpy( &hdr, base, HDR_SZ );

  tn_pubkey_t const * mint = account_addr( a.mint_idx );
  require_vault( a.token_vault_idx, mint );

  /* The creator names the quote asset. Index 0 is the fee payer and can never
     be a mint, so it is the sentinel for "use the registry default" and keeps
     a v1-shaped caller working. */
  tn_pubkey_t quote_mint;
  if( a.quote_mint_idx == (ushort)0 ) {
    memcpy( quote_mint.key, hdr.quote_mint.key, 32UL );
  } else {
    if( !tsdk_is_account_idx_valid( a.quote_mint_idx ) ) tsdk_revert( ERR_NO_ACCOUNT );
    memcpy( quote_mint.key, account_addr( a.quote_mint_idx )->key, 32UL );
  }
  require_vault( a.quote_vault_idx, &quote_mint );

  /* The curve must start empty of real tokens, otherwise the reserves and the
     curve state disagree from the first trade. */
  if( vault_balance( a.token_vault_idx ) != 0UL ) tsdk_revert( ERR_SUPPLY );

  launch_rec_t r;
  memset( &r, 0, sizeof( r ) );
  r.state      = STATE_LIVE;
  r.fee_bps    = a.fee_bps;
  r.name_len   = a.name_len;
  r.symbol_len = a.symbol_len;
  memcpy( r.name,   name,   (ulong)a.name_len );
  memcpy( r.symbol, symbol, (ulong)a.symbol_len );
  memcpy( r.creator.key,     account_addr( 0 )->key,             32UL );
  memcpy( r.mint.key,        mint->key,                          32UL );
  memcpy( r.token_vault.key, account_addr( a.token_vault_idx )->key, 32UL );
  memcpy( r.quote_vault.key, account_addr( a.quote_vault_idx )->key, 32UL );
  memcpy( r.quote_mint.key,  quote_mint.key,                          32UL );
  r.vq         = a.virt_quote;
  r.vt         = a.supply;
  r.start_slot = tsdk_get_current_block_ctx()->slot;

  /* The whole supply onto the curve, in one call, by a program that has no
     instruction to mint again. That is what makes the supply fixed. */
  tn_token_mint_to( a.token_prog_idx, a.mint_idx, a.token_vault_idx,
                    tsdk_get_current_program_acc_idx(), a.supply,
                    (tsdk_invoke_auth_t const *)0 );

  memcpy( rec, &r, LAUNCH_SZ );

  hdr.launch_count += 1U;
  memcpy( base, &hdr, HDR_SZ );
}

/* ------------------------------------------------------------- BUY / SELL */

struct __attribute__(( packed )) trade_args {
  uchar  op;
  ushort token_prog_idx;
  ushort reg_idx;
  ushort launch_id;
  ushort token_vault_idx;
  ushort quote_vault_idx;
  ushort user_token_idx;
  ushort user_quote_idx;
  ulong  amount_in;
  ulong  min_out;
};

static launch_rec_t *
load_live( struct trade_args const * a ) {
  launch_rec_t * rec = open_launch( a->reg_idx, a->launch_id, (uchar **)0 );
  if( rec->state == STATE_EMPTY )     tsdk_revert( ERR_NOT_READY );
  if( rec->state == STATE_GRADUATED ) tsdk_revert( ERR_GRADUATED );

  /* The caller says where the vaults are; the record says where they must be.
     Disagreement means the transaction is lying about which accounts it
     touches, which is the entire attack surface of passing indices. */
  require_addr( a->token_vault_idx, &rec->token_vault );
  require_addr( a->quote_vault_idx, &rec->quote_vault );
  return rec;
}

static void
do_buy( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct trade_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct trade_args a;
  memcpy( &a, data, sizeof( a ) );
  if( a.amount_in == 0UL ) tsdk_revert( ERR_ZERO_AMOUNT );

  launch_rec_t * rec = load_live( &a );

  ulong fee   = mul_div( a.amount_in, (ulong)rec->fee_bps, BPS_DENOM );
  ulong snipe = mul_div( a.amount_in, snipe_bps( rec->start_slot ), BPS_DENOM );
  if( fee + snipe >= a.amount_in ) tsdk_revert( ERR_DUST );
  ulong net = a.amount_in - fee - snipe;

  /* x*y=k on the virtual reserves. The snipe tax is excluded from net, so it
     buys nothing and simply stays in the vault backing the curve. */
  ulong new_vq = rec->vq + net;
  if( new_vq < rec->vq ) tsdk_revert( ERR_OVERFLOW );
  ulong new_vt = mul_div( rec->vq, rec->vt, new_vq );
  if( new_vt >= rec->vt ) tsdk_revert( ERR_DUST );

  ulong tokens_out = rec->vt - new_vt;
  if( tokens_out == 0UL )      tsdk_revert( ERR_DUST );
  if( tokens_out < a.min_out ) tsdk_revert( ERR_SLIPPAGE );

  /* Never promise more than the curve actually holds. */
  if( tokens_out > vault_balance( a.token_vault_idx ) ) tsdk_revert( ERR_NOT_FUNDED );

  tn_token_transfer( a.token_prog_idx, a.user_quote_idx, a.quote_vault_idx,
                     a.amount_in, (tsdk_invoke_auth_t const *)0 );
  tn_token_transfer( a.token_prog_idx, a.token_vault_idx, a.user_token_idx,
                     tokens_out, (tsdk_invoke_auth_t const *)0 );

  rec->vq            = new_vq;
  rec->vt            = new_vt;
  rec->creator_fees += fee;
  rec->tokens_sold  += tokens_out;
  rec->trade_count  += 1UL;
}

static void
do_sell( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct trade_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct trade_args a;
  memcpy( &a, data, sizeof( a ) );
  if( a.amount_in == 0UL ) tsdk_revert( ERR_ZERO_AMOUNT );

  launch_rec_t * rec = load_live( &a );

  ulong new_vt = rec->vt + a.amount_in;
  if( new_vt < rec->vt ) tsdk_revert( ERR_OVERFLOW );
  ulong new_vq = mul_div( rec->vq, rec->vt, new_vt );
  if( new_vq >= rec->vq ) tsdk_revert( ERR_DUST );

  ulong gross = rec->vq - new_vq;
  ulong fee   = mul_div( gross, (ulong)rec->fee_bps, BPS_DENOM );
  if( fee >= gross ) tsdk_revert( ERR_DUST );
  ulong out = gross - fee;
  if( out == 0UL )      tsdk_revert( ERR_DUST );
  if( out < a.min_out ) tsdk_revert( ERR_SLIPPAGE );

  /* The quote vault holds curve backing and unclaimed creator fees in one pot.
     Only what is above the fees may be paid out, or a seller would be spending
     money the creator is already owed. */
  ulong held = vault_balance( a.quote_vault_idx );
  if( held < rec->creator_fees ) tsdk_revert( ERR_NOT_FUNDED );
  if( out > held - rec->creator_fees ) tsdk_revert( ERR_NOT_FUNDED );

  tn_token_transfer( a.token_prog_idx, a.user_token_idx, a.token_vault_idx,
                     a.amount_in, (tsdk_invoke_auth_t const *)0 );
  tn_token_transfer( a.token_prog_idx, a.quote_vault_idx, a.user_quote_idx,
                     out, (tsdk_invoke_auth_t const *)0 );

  rec->vq            = new_vq;
  rec->vt            = new_vt;
  rec->creator_fees += fee;
  if( rec->tokens_sold >= a.amount_in ) rec->tokens_sold -= a.amount_in;
  rec->trade_count += 1UL;
}

/* ------------------------------------------------------------------ CLAIM */

struct __attribute__(( packed )) claim_args {
  uchar  op;
  ushort token_prog_idx;
  ushort reg_idx;
  ushort launch_id;
  ushort quote_vault_idx;
  ushort dest_idx;
};

/* Anyone may call this. The money only ever moves to an account owned by the
   recorded creator, so a third party paying the fee to settle someone else's
   earnings is a convenience, not a hole. */
static void
do_claim( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct claim_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct claim_args a;
  memcpy( &a, data, sizeof( a ) );

  launch_rec_t * rec = open_launch( a.reg_idx, a.launch_id, (uchar **)0 );
  if( rec->state == STATE_EMPTY ) tsdk_revert( ERR_NOT_READY );
  require_addr( a.quote_vault_idx, &rec->quote_vault );

  ulong owed = rec->creator_fees;
  if( owed == 0UL ) tsdk_revert( ERR_NO_FEES );

  if( !tsdk_is_account_idx_valid( a.dest_idx ) ) tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_account_exists( a.dest_idx ) )       tsdk_revert( ERR_NO_ACCOUNT );
  tsdk_account_meta_t const * dm = tsdk_get_account_meta( a.dest_idx );
  if( dm->data_sz != (uint)TN_TOKEN_TOKEN_ACCOUNT_SZ ) tsdk_revert( ERR_NOT_TOKEN_ACC );

  uchar const * d = (uchar const *)tsdk_get_account_data_ptr( a.dest_idx );
  if( memcmp( d + 32, rec->creator.key, 32UL ) != 0 ) tsdk_revert( ERR_WRONG_ACCOUNT );

  if( vault_balance( a.quote_vault_idx ) < owed ) tsdk_revert( ERR_NOT_FUNDED );

  /* Zero the balance before paying it. A transfer that fails reverts the whole
     transaction anyway, but the order means there is no window in which the
     fees are recorded as still owed after they have left. */
  rec->creator_fees = 0UL;

  tn_token_transfer( a.token_prog_idx, a.quote_vault_idx, a.dest_idx, owed,
                     (tsdk_invoke_auth_t const *)0 );
}

/* --------------------------------------------------------------- GRADUATE */

struct __attribute__(( packed )) grad_args {
  uchar  op;
  ushort reg_idx;
  ushort launch_id;
  ushort quote_vault_idx;
};

static void
do_graduate( uchar const * data, ulong data_sz ) {
  if( data_sz < sizeof( struct grad_args ) ) tsdk_revert( ERR_BAD_INSTR );
  struct grad_args a;
  memcpy( &a, data, sizeof( a ) );

  uchar * base = (uchar *)0;
  launch_rec_t * rec = open_launch( a.reg_idx, a.launch_id, &base );
  if( rec->state != STATE_LIVE ) tsdk_revert( ERR_NOT_LIVE );
  require_addr( a.quote_vault_idx, &rec->quote_vault );

  pad_hdr_t hdr;
  memcpy( &hdr, base, HDR_SZ );

  /* Raised means real quote backing the curve, not including fees the creator
     is owed. Counting those would let a launch graduate on money that is about
     to leave. */
  ulong held = vault_balance( a.quote_vault_idx );
  ulong raised = held > rec->creator_fees ? held - rec->creator_fees : 0UL;
  if( raised < hdr.grad_threshold ) tsdk_revert( ERR_TOO_SOON );

  /* Freezing the curve is the whole of graduation here. The reserves stay
     where they are, owned by this program, ready to seed a thruswap pool. */
  rec->state = STATE_GRADUATED;
}

/* ------------------------------------------------------------- entrypoint */

TSDK_ENTRYPOINT_FN void
start( void const * instruction_data,
       ulong        instruction_data_sz ) {
  uchar const * data = (uchar const *)instruction_data;

  if( instruction_data_sz < 1UL ) tsdk_revert( ERR_BAD_INSTR );

  switch( data[ 0 ] ) {
    case OP_INIT:     do_init    ( data, instruction_data_sz ); break;
    case OP_LAUNCH:   do_launch  ( data, instruction_data_sz ); break;
    case OP_BUY:      do_buy     ( data, instruction_data_sz ); break;
    case OP_SELL:     do_sell    ( data, instruction_data_sz ); break;
    case OP_CLAIM:    do_claim   ( data, instruction_data_sz ); break;
    case OP_GRADUATE: do_graduate( data, instruction_data_sz ); break;
    default:          tsdk_revert( ERR_BAD_OPCODE );
  }

  tsdk_return( 0UL );
}
