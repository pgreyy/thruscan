/* thrucpi - does a Thru program have custody?
 *
 * Everything downstream of this file assumes one thing: that a program can move
 * tokens it does not personally sign for. An AMM pool is worthless otherwise,
 * because holding reserves means the program, and nothing else, decides when
 * they leave. This program exists only to settle that question before a line of
 * the AMM gets written.
 *
 * It is a probe rather than a fixed test. The interesting unknown is not
 * whether tsys_invoke works, it is WHICH account the token program will accept
 * as an authority when the caller is a program rather than a keyholder. There
 * are a few plausible answers and no documentation, so instead of guessing one
 * and rebuilding on each wrong guess, every index is passed in from outside.
 * One deployment, many experiments, and the answer arrives in an afternoon
 * rather than over several build cycles.
 *
 *   MINT  [0x01][token_program_idx u16][mint_idx u16][dest_idx u16]
 *         [authority_idx u16][auth_acc_idx u16][amount u64]
 *
 *         Asks the token program to mint `amount` into `dest_idx`.
 *         auth_acc_idx is the account named in the invoke authorization
 *         descriptor, or 0xFFFF to pass no descriptor at all.
 *
 *   MOVE  [0x02][token_program_idx u16][source_idx u16][dest_idx u16]
 *         [auth_acc_idx u16][amount u64]
 *
 *         The question that actually matters for an AMM: can this program move
 *         tokens out of an account it owns? TRANSFER carries no authority
 *         field, so the token program must be checking the source account's
 *         recorded owner against the call frame, and the descriptor is the only
 *         lever we have over that.
 *
 *   WHOAMI [0x03]
 *
 *         Reverts with the program's own account index in the error code. Worth
 *         having because the authority arrangements below are all phrased in
 *         terms of that index, and confirming it costs one transaction rather
 *         than an afternoon of misreading.
 *
 * Error codes are chosen so a failed transaction says where it failed without
 * anyone reading logs. 0x01xx means the invocation was refused before the token
 * program ran; 0x02xx means the token program ran and rejected it. The Thru
 * docs warn specifically against collapsing those two, since they point at
 * completely different mistakes.
 */

#include <thru-sdk/c/tn_sdk.h>
#include <thru-sdk/c/tn_sdk_syscall.h>

#include "thru_token.h"

#define OP_MINT   (0x01)
#define OP_MOVE   (0x02)
#define OP_WHOAMI (0x03)

#define ERR_BAD_INSTR  (1UL)
#define ERR_BAD_OPCODE (2UL)
#define ERR_BAD_IDX    (3UL)

#define NO_AUTH ((ushort)0xFFFFU)

struct __attribute__(( packed )) mint_args {
  uchar  op;
  ushort token_program_idx;
  ushort mint_idx;
  ushort dest_idx;
  ushort authority_idx;
  ushort auth_acc_idx;
  ulong  amount;
};
typedef struct mint_args mint_args_t;

struct __attribute__(( packed )) move_args {
  uchar  op;
  ushort token_program_idx;
  ushort source_idx;
  ushort dest_idx;
  ushort auth_acc_idx;
  ulong  amount;
};
typedef struct move_args move_args_t;

FD_STATIC_ASSERT( sizeof( mint_args_t ) == 19UL, mint_args_sz );
FD_STATIC_ASSERT( sizeof( move_args_t ) == 17UL, move_args_sz );

/* build_auth turns the probe's auth_acc_idx into a descriptor, or into nothing
   when the caller asked for no descriptor. The storage lives in the caller's
   frame because tsys_invoke reads it during the call. */
static tsdk_invoke_auth_t const *
build_auth( tn_token_auth_t * storage,
            ushort            auth_acc_idx ) {
  if( auth_acc_idx == NO_AUTH ) return (tsdk_invoke_auth_t const *)0;
  ushort one[ 1 ] = { auth_acc_idx };
  return tn_token_auth_init( storage, one, 1U );
}

static void
do_mint( uchar const * data,
         ulong         data_sz ) {
  if( data_sz < sizeof( mint_args_t ) ) tsdk_revert( ERR_BAD_INSTR );

  mint_args_t a;
  memcpy( &a, data, sizeof( a ) );

  if( !tsdk_is_account_idx_valid( a.token_program_idx ) ) tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_is_account_idx_valid( a.mint_idx ) )          tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_is_account_idx_valid( a.dest_idx ) )          tsdk_revert( ERR_BAD_IDX );

  tn_token_auth_t storage;
  tsdk_invoke_auth_t const * auth = build_auth( &storage, a.auth_acc_idx );

  ulong rc = tn_token_mint_to( a.token_program_idx,
                               a.mint_idx,
                               a.dest_idx,
                               a.authority_idx,
                               a.amount,
                               auth );
  if( rc != 0UL ) tsdk_revert( rc );
}

static void
do_move( uchar const * data,
         ulong         data_sz ) {
  if( data_sz < sizeof( move_args_t ) ) tsdk_revert( ERR_BAD_INSTR );

  move_args_t a;
  memcpy( &a, data, sizeof( a ) );

  if( !tsdk_is_account_idx_valid( a.token_program_idx ) ) tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_is_account_idx_valid( a.source_idx ) )        tsdk_revert( ERR_BAD_IDX );
  if( !tsdk_is_account_idx_valid( a.dest_idx ) )          tsdk_revert( ERR_BAD_IDX );

  tn_token_auth_t storage;
  tsdk_invoke_auth_t const * auth = build_auth( &storage, a.auth_acc_idx );

  ulong rc = tn_token_transfer( a.token_program_idx,
                                a.source_idx,
                                a.dest_idx,
                                a.amount,
                                auth );
  if( rc != 0UL ) tsdk_revert( rc );
}

/* Reverting is the only channel a program has for returning a value that shows
   up in a transaction lookup, so the answer is deliberately delivered as a
   failure. 0x9000 | idx keeps it unmistakable against a real error. */
static void
do_whoami( void ) {
  ushort me = tsdk_get_current_program_acc_idx();
  tsdk_revert( 0x9000UL | (ulong)me );
}

TSDK_ENTRYPOINT_FN void
start( void const * instruction_data,
       ulong        instruction_data_sz ) {
  uchar const * data = (uchar const *)instruction_data;

  if( instruction_data_sz < 1UL ) tsdk_revert( ERR_BAD_INSTR );

  switch( data[ 0 ] ) {
    case OP_MINT:   do_mint( data, instruction_data_sz ); break;
    case OP_MOVE:   do_move( data, instruction_data_sz ); break;
    case OP_WHOAMI: do_whoami();                          break;
    default:        tsdk_revert( ERR_BAD_OPCODE );
  }

  tsdk_return( 0UL );
}
