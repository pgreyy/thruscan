/* thru_token.h - the Thru token program, as called from inside a program.
 *
 * Thru does not publish the token program's instruction encoding anywhere. The
 * layouts below were recovered from live alphanet transactions on 2026-09-17 by
 * issuing each instruction from the CLI with deliberately distinctive arguments
 * and reading the resulting instruction data back off the chain.
 *
 * The arguments were chosen so no two fields could be confused for one another:
 * 32-byte seeds made of one repeated byte, and u64 amounts whose little-endian
 * forms read as 08 07 06 05 04 03 02 01, 77 66 55 44 33 22 11 00 and
 * ff ee dd cc bb aa 00 00. Each layout was then checked a second way, against
 * the state-proof size rule in tn_sdk_txn.h: a proof occupies
 * 40 + (type + popcount(path_bitset)) * 32 bytes, and for all three observed
 * account-creating instructions the payload length minus the fixed prefix came
 * out exactly right. Sizes here are asserted at compile time for the same
 * reason: if a future runtime changes the encoding, the build should break
 * rather than the chain silently rejecting a malformed instruction.
 *
 * EVERY *_idx FIELD IS AN INDEX INTO THE CURRENT TRANSACTION'S ACCOUNT LIST,
 * not into some list private to the callee. Index 0 is the fee payer, index 1
 * is the executing program, then the read-write accounts in declared order,
 * then the read-only ones. Mismatched indices are the failure the Thru docs
 * single out as the most common CPI bug, so pass them through from the caller's
 * own instruction data rather than hardcoding them.
 *
 * Authority, and why TRANSFER has no authority field: MINT_TO and BURN each
 * name the account index holding the authority, but TRANSFER does not. The
 * token program instead checks that the source account's own recorded owner is
 * authorized in the current call frame. For a pool account owned by a program,
 * that authorization is what tsdk_invoke_auth exists to grant, and an auth
 * entry may only name an account the calling program owns.
 */

#ifndef HEADER_thru_token_h
#define HEADER_thru_token_h

#include <thru-sdk/c/tn_sdk.h>
#include <thru-sdk/c/tn_sdk_syscall.h>

/* taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq */
#define TN_TOKEN_OP_INITIALIZE_MINT    ((uchar)0x00)
#define TN_TOKEN_OP_INITIALIZE_ACCOUNT ((uchar)0x01)
#define TN_TOKEN_OP_TRANSFER           ((uchar)0x02)
#define TN_TOKEN_OP_MINT_TO            ((uchar)0x03)
#define TN_TOKEN_OP_BURN               ((uchar)0x04)
/* 0x05 close, 0x06 freeze, 0x07 thaw follow the CLI's own ordering but have
   not been observed on chain, so they are deliberately not defined here. */

/* Account data layouts, for reading balances without a CPI. A mint is 115
   bytes and a token account 73; the token program discriminates its account
   union by size alone, with no leading kind byte. */
#define TN_TOKEN_MINT_ACCOUNT_SZ  (115UL)
#define TN_TOKEN_TOKEN_ACCOUNT_SZ (73UL)

struct __attribute__(( packed )) tn_token_account {
  tn_pubkey_t mint;
  tn_pubkey_t owner;
  ulong       amount;
  uchar       is_frozen;
};
typedef struct tn_token_account tn_token_account_t;

struct __attribute__(( packed )) tn_token_mint {
  uchar       decimals;
  ulong       supply;
  tn_pubkey_t creator;
  tn_pubkey_t mint_authority;
  tn_pubkey_t freeze_authority;
  uchar       has_freeze_authority;
  uchar       ticker_len;
  uchar       ticker[ 8 ];
};
typedef struct tn_token_mint tn_token_mint_t;

FD_STATIC_ASSERT( sizeof( tn_token_account_t ) == TN_TOKEN_TOKEN_ACCOUNT_SZ,
                  tn_token_account_sz );
FD_STATIC_ASSERT( sizeof( tn_token_mint_t ) == TN_TOKEN_MINT_ACCOUNT_SZ,
                  tn_token_mint_sz );

/* ------------------------------------------------------------ instructions */

struct __attribute__(( packed )) tn_token_transfer_ix {
  uchar  op;          /* TN_TOKEN_OP_TRANSFER */
  ushort source_idx;
  ushort dest_idx;
  ulong  amount;
};
typedef struct tn_token_transfer_ix tn_token_transfer_ix_t;

struct __attribute__(( packed )) tn_token_mint_to_ix {
  uchar  op;          /* TN_TOKEN_OP_MINT_TO */
  ushort mint_idx;
  ushort dest_idx;
  ushort authority_idx;
  ulong  amount;
};
typedef struct tn_token_mint_to_ix tn_token_mint_to_ix_t;

struct __attribute__(( packed )) tn_token_burn_ix {
  uchar  op;          /* TN_TOKEN_OP_BURN */
  ushort account_idx;
  ushort mint_idx;
  ushort authority_idx;
  ulong  amount;
};
typedef struct tn_token_burn_ix tn_token_burn_ix_t;

/* Observed on chain as 13, 15 and 15 bytes respectively. */
FD_STATIC_ASSERT( sizeof( tn_token_transfer_ix_t ) == 13UL, tn_token_transfer_sz );
FD_STATIC_ASSERT( sizeof( tn_token_mint_to_ix_t  ) == 15UL, tn_token_mint_to_sz  );
FD_STATIC_ASSERT( sizeof( tn_token_burn_ix_t     ) == 15UL, tn_token_burn_sz     );

/* ----------------------------------------------------------- authorization */

/* tsdk_invoke_auth_t ends in a flexible array, which cannot be declared on the
   stack. This mirrors it with a fixed tail. It is deliberately NOT packed,
   because the SDK's own struct is not either, and a packed copy would lay its
   fields out differently from what the runtime reads. */
#define TN_TOKEN_AUTH_MAX (4U)

struct tn_token_auth {
  ulong  magic;
  ushort auth_cnt;
  ushort deauth_cnt;
  ushort acc_idxs[ TN_TOKEN_AUTH_MAX ];
};
typedef struct tn_token_auth tn_token_auth_t;

/* tn_token_auth_init prepares a descriptor authorizing `cnt` accounts, which
   must be accounts the calling program owns. Returns the pointer to pass to
   tn_token_invoke, or NULL when cnt is zero, since passing NULL is how you say
   "no extra authorization". */
static inline tsdk_invoke_auth_t const *
tn_token_auth_init( tn_token_auth_t * auth,
                    ushort const *    idxs,
                    ushort            cnt ) {
  if( cnt == 0U ) return (tsdk_invoke_auth_t const *)0;
  if( cnt > TN_TOKEN_AUTH_MAX ) cnt = TN_TOKEN_AUTH_MAX;
  auth->magic      = TSDK_INVOKE_AUTH_MAGIC;
  auth->auth_cnt   = cnt;
  auth->deauth_cnt = 0U;
  for( ushort i=0U; i<cnt; i++ ) auth->acc_idxs[ i ] = idxs[ i ];
  return (tsdk_invoke_auth_t const *)auth;
}

/* --------------------------------------------------------------- invoking */

/* tn_token_invoke forwards one built instruction to the token program.
 *
 * It returns 0 on success. On failure it returns a non-zero code that keeps the
 * two error channels apart, because they mean different things and the Thru
 * docs explicitly warn against collapsing them: a syscall error means the
 * invocation itself was rejected, while a callee error means the token program
 * ran and refused. The caller gets 0x0100|rc for the first and 0x0200|err for
 * the second, so the failing layer is visible in the transaction's user error
 * code without needing logs.
 */
static inline ulong
tn_token_invoke( void const *               ix,
                 ulong                      ix_sz,
                 ushort                     token_program_idx,
                 tsdk_invoke_auth_t const * auth ) {
  ulong callee_err = 0UL;
  ulong rc = tsys_invoke( ix, ix_sz, token_program_idx, auth, &callee_err );
  if( rc != TSDK_SUCCESS ) return 0x0100UL | ( rc & 0xFFUL );
  if( callee_err != 0UL )  return 0x0200UL | ( callee_err & 0xFFUL );
  return 0UL;
}

static inline ulong
tn_token_transfer( ushort                     token_program_idx,
                   ushort                     source_idx,
                   ushort                     dest_idx,
                   ulong                      amount,
                   tsdk_invoke_auth_t const * auth ) {
  tn_token_transfer_ix_t ix;
  ix.op         = TN_TOKEN_OP_TRANSFER;
  ix.source_idx = source_idx;
  ix.dest_idx   = dest_idx;
  ix.amount     = amount;
  return tn_token_invoke( &ix, sizeof( ix ), token_program_idx, auth );
}

static inline ulong
tn_token_mint_to( ushort                     token_program_idx,
                  ushort                     mint_idx,
                  ushort                     dest_idx,
                  ushort                     authority_idx,
                  ulong                      amount,
                  tsdk_invoke_auth_t const * auth ) {
  tn_token_mint_to_ix_t ix;
  ix.op            = TN_TOKEN_OP_MINT_TO;
  ix.mint_idx      = mint_idx;
  ix.dest_idx      = dest_idx;
  ix.authority_idx = authority_idx;
  ix.amount        = amount;
  return tn_token_invoke( &ix, sizeof( ix ), token_program_idx, auth );
}

static inline ulong
tn_token_burn( ushort                     token_program_idx,
               ushort                     account_idx,
               ushort                     mint_idx,
               ushort                     authority_idx,
               ulong                      amount,
               tsdk_invoke_auth_t const * auth ) {
  tn_token_burn_ix_t ix;
  ix.op            = TN_TOKEN_OP_BURN;
  ix.account_idx   = account_idx;
  ix.mint_idx      = mint_idx;
  ix.authority_idx = authority_idx;
  ix.amount        = amount;
  return tn_token_invoke( &ix, sizeof( ix ), token_program_idx, auth );
}

/* tn_token_read_amount reads a token account's balance straight from its data,
   which is cheaper than a CPI and is all an AMM needs in order to price a swap.
   Returns 0 and sets *ok to 0 when the account is not a token account. */
static inline ulong
tn_token_read_amount( ushort account_idx, int * ok ) {
  *ok = 0;
  if( !tsdk_is_account_idx_valid( account_idx ) ) return 0UL;
  if( !tsdk_account_exists( account_idx ) )       return 0UL;

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( account_idx );
  if( meta->data_sz != (uint)TN_TOKEN_TOKEN_ACCOUNT_SZ ) return 0UL;

  uchar const * d = (uchar const *)tsdk_get_account_data_ptr( account_idx );
  *ok = 1;
  return TSDK_LOAD( ulong, d + 64 );  /* mint[32] owner[32] then amount */
}

#endif /* HEADER_thru_token_h */
