/* thruwall - a public wall on Thru
 *
 * Anyone can post a short message. Messages are stored on chain in a single
 * account laid out as a ring of fixed-size slots: when the last slot fills,
 * writing wraps back to the first and the oldest message is overwritten. The
 * account never grows, so its size is decided once and never changes.
 *
 * Two instructions:
 *
 *   INIT  [0x00][seed: 32 bytes][slots: u16][state proof: rest]
 *         Creates the wall account if it does not exist, sizes it for the
 *         requested number of slots, and writes a fresh header. Run once.
 *         Running it again wipes the wall, so the client should not expose it.
 *
 *         The slot count is a parameter rather than a constant because the
 *         chain enforces a maximum account size that is not documented
 *         anywhere. Passing it in means the limit can be found by trying,
 *         without rebuilding and redeploying the program each time.
 *
 *   POST  [0x01][name_len][name][handle_len][handle][msg_len][msg]
 *         Appends one message to the next slot.
 *
 * Every post records the transaction's fee payer as the poster, taken from the
 * transaction itself rather than from anything the user typed. INIT stores its
 * own fee payer in the header as the sponsor. A post is marked verified when
 * the poster is NOT the sponsor, which means the user signed it themselves
 * from the CLI instead of the website paying on their behalf. Storing the
 * sponsor in the header rather than hardcoding it means the sponsor key can
 * change without redeploying the program.
 *
 * Account index 2 is the wall. Index 0 is the fee payer and index 1 is this
 * program, so the first account the transaction declares writable lands at 2.
 */

#include <thru-sdk/c/tn_sdk.h>
#include <thru-sdk/c/tn_sdk_syscall.h>

#define OP_INIT (0x00)
#define OP_POST (0x01)

#define WALL_ACC_IDX ((ushort)2)
#define WALL_VERSION ((uchar)1)

/* Upper bound only. The real capacity is whatever INIT was given, and is
   recovered afterwards from the account's own size. */
#define WALL_SLOTS_MAX (512UL)
#define NAME_MAX   (24UL)
#define HANDLE_MAX (16UL)
/* 176 bytes rather than 140 because the client limits by character, and one
   emoji can take four bytes in UTF-8. This leaves room so a message never
   gets cut in the middle of one. */
#define MSG_MAX (176UL)

/* Error codes surface in the transaction lookup as the program error code, so
   keep them stable and meaningful. */
#define ERR_BAD_INSTR     (1UL)
#define ERR_BAD_OPCODE    (2UL)
#define ERR_NO_ACCOUNT    (3UL)
#define ERR_NOT_OURS      (4UL)
#define ERR_TOO_LONG      (5UL)
#define ERR_EMPTY_MSG     (6UL)
#define ERR_CREATE_FAILED (7UL)
#define ERR_RESIZE_FAILED (8UL)
#define ERR_WRITE_DENIED  (9UL)
#define ERR_NOT_READY     (10UL)
#define ERR_BAD_SLOTS     (11UL)

struct __attribute__(( packed )) wall_hdr {
  uchar       version;      /* bytes: [0,1)   - layout version, currently 1 */
  uint        next_idx;     /* bytes: [1,5)   - slot the next message goes into */
  uint        total_posted; /* bytes: [5,9)   - every message ever, including overwritten */
  tn_pubkey_t sponsor;      /* bytes: [9,41)  - whoever ran INIT; posts from this key are sponsored */
};
typedef struct wall_hdr wall_hdr_t;

struct __attribute__(( packed )) wall_slot {
  uchar name_len;
  uchar name[ NAME_MAX ];
  uchar handle_len;
  uchar handle[ HANDLE_MAX ];
  uchar       msg_len;
  uchar       msg[ MSG_MAX ];
  ulong       posted_at; /* block time, Unix epoch in nanoseconds */
  tn_pubkey_t poster;    /* the transaction's fee payer, proven not typed */
  uchar       verified;  /* 1 when the poster signed for themselves */
};
typedef struct wall_slot wall_slot_t;

/* Capacity is derived from the account rather than assumed, so the program
   keeps working whatever size INIT chose. */
static ulong
wall_capacity( ulong data_sz ) {
  if( data_sz < sizeof( wall_hdr_t ) + sizeof( wall_slot_t ) ) return 0UL;
  return ( data_sz - sizeof( wall_hdr_t ) ) / sizeof( wall_slot_t );
}

static void
copy_bytes( uchar * dst, uchar const * src, ulong n ) {
  for( ulong i=0UL; i<n; i++ ) dst[ i ] = src[ i ];
}

static void
zero_bytes( uchar * dst, ulong n ) {
  for( ulong i=0UL; i<n; i++ ) dst[ i ] = (uchar)0;
}

/* Reads one length-prefixed field and advances the cursor. Reverts rather
   than returning an error, because a malformed instruction is never
   recoverable and reverting keeps the wall untouched. */
static ulong
read_field( uchar const *  data,
            ulong          data_sz,
            ulong *        cursor,
            uchar const ** out,
            ulong          max_len ) {
  if( *cursor >= data_sz ) tsdk_revert( ERR_BAD_INSTR );

  ulong len = (ulong)data[ *cursor ];
  *cursor += 1UL;

  if( len > max_len ) tsdk_revert( ERR_TOO_LONG );
  if( *cursor + len > data_sz ) tsdk_revert( ERR_BAD_INSTR );

  *out = data + *cursor;
  *cursor += len;
  return len;
}

static uchar *
open_wall_for_writing( void ) {
  if( !tsdk_is_account_idx_valid( WALL_ACC_IDX ) ) tsdk_revert( ERR_NO_ACCOUNT );
  if( !tsdk_account_exists( WALL_ACC_IDX ) )       tsdk_revert( ERR_NOT_READY );

  /* Only this program may change the wall. Without this check anyone could
     pass a different account they control and have us write into it. */
  if( !tsdk_is_account_owned_by_current_program( WALL_ACC_IDX ) ) {
    tsdk_revert( ERR_NOT_OURS );
  }

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( WALL_ACC_IDX );
  if( wall_capacity( (ulong)meta->data_sz ) == 0UL ) tsdk_revert( ERR_NOT_READY );

  if( tsys_set_account_data_writable( (ulong)WALL_ACC_IDX ) != 0UL ) {
    tsdk_revert( ERR_WRITE_DENIED );
  }

  return (uchar *)tsdk_get_account_data_ptr( WALL_ACC_IDX );
}

static void
do_init( uchar const * data, ulong data_sz ) {
  if( data_sz < 1UL + TN_SEED_SIZE + 2UL ) tsdk_revert( ERR_BAD_INSTR );

  if( !tsdk_is_account_idx_valid( WALL_ACC_IDX ) ) tsdk_revert( ERR_NO_ACCOUNT );

  uchar const * seed = data + 1UL;

  /* Little endian u16, matching every other integer in this layout. */
  ulong slots = (ulong)data[ 1UL + TN_SEED_SIZE ]
              | ( (ulong)data[ 2UL + TN_SEED_SIZE ] << 8 );
  if( slots == 0UL || slots > WALL_SLOTS_MAX ) tsdk_revert( ERR_BAD_SLOTS );

  ulong wall_size = sizeof( wall_hdr_t ) + slots * sizeof( wall_slot_t );

  void  const * proof    = (void const *)( data + 3UL + TN_SEED_SIZE );
  ulong         proof_sz = data_sz - 3UL - TN_SEED_SIZE;

  /* Creating is skipped when the account already exists, so re-running INIT
     after a failed attempt picks up where it left off instead of erroring. */
  if( !tsdk_account_exists( WALL_ACC_IDX ) ) {
    if( tsys_account_create( (ulong)WALL_ACC_IDX, seed, proof, proof_sz ) != 0UL ) {
      tsdk_revert( ERR_CREATE_FAILED );
    }
  }

  if( !tsdk_is_account_owned_by_current_program( WALL_ACC_IDX ) ) {
    tsdk_revert( ERR_NOT_OURS );
  }

  /* Writable first, then resize. The other order failed at every size, right
     down to 2KB, which ruled out an account size cap and pointed at the
     account simply not being open for modification yet. */
  if( tsys_set_account_data_writable( (ulong)WALL_ACC_IDX ) != 0UL ) {
    tsdk_revert( ERR_WRITE_DENIED );
  }

  ulong rc = tsys_account_resize( (ulong)WALL_ACC_IDX, wall_size );
  if( rc != 0UL ) {
    /* Report the syscall's own return value rather than flattening it into a
       generic code. The header does not document what resize returns, so if
       zero does not mean success this makes that visible: a revert code of
       0x8000 plus a value says resize returned that value. */
    tsdk_revert( 0x8000UL | ( rc & 0xFFUL ) );
  }

  uchar * raw = (uchar *)tsdk_get_account_data_ptr( WALL_ACC_IDX );
  zero_bytes( raw, wall_size );

  wall_hdr_t * hdr = (wall_hdr_t *)tsdk_type_pun( raw );
  hdr->version      = WALL_VERSION;
  hdr->next_idx     = 0U;
  hdr->total_posted = 0U;

  /* Account index 0 is always the fee payer, so whoever ran INIT becomes the
     sponsor that later posts are compared against. */
  tn_pubkey_t const * addrs = tsdk_txn_get_acct_addrs( tsdk_get_txn() );
  copy_bytes( (uchar *)tsdk_type_pun( &hdr->sponsor ),
              (uchar const *)tsdk_type_pun_const( &addrs[ 0 ] ),
              sizeof( tn_pubkey_t ) );

  tsdk_return( 0UL );
}

static void
do_post( uchar const * data, ulong data_sz ) {
  uchar * raw = open_wall_for_writing();

  wall_hdr_t * hdr = (wall_hdr_t *)tsdk_type_pun( raw );
  if( hdr->version != WALL_VERSION ) tsdk_revert( ERR_NOT_READY );

  ulong         cursor = 1UL; /* skip the opcode */
  uchar const * name   = (uchar const *)0;
  uchar const * handle = (uchar const *)0;
  uchar const * msg    = (uchar const *)0;

  ulong name_len   = read_field( data, data_sz, &cursor, &name,   NAME_MAX );
  ulong handle_len = read_field( data, data_sz, &cursor, &handle, HANDLE_MAX );
  ulong msg_len    = read_field( data, data_sz, &cursor, &msg,    MSG_MAX );

  /* An empty message would occupy a slot and show nothing, so reject it.
     Name and handle are allowed to be empty and render as anonymous. */
  if( msg_len == 0UL ) tsdk_revert( ERR_EMPTY_MSG );

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( WALL_ACC_IDX );
  ulong slots = wall_capacity( (ulong)meta->data_sz );
  ulong idx   = (ulong)hdr->next_idx % slots;

  wall_slot_t * slot = (wall_slot_t *)tsdk_type_pun(
      raw + sizeof( wall_hdr_t ) + idx * sizeof( wall_slot_t ) );

  /* Clear first: this slot may hold a longer message from an earlier lap
     around the ring, and leftover bytes past the new length would otherwise
     stay behind in the account. */
  zero_bytes( (uchar *)tsdk_type_pun( slot ), sizeof( wall_slot_t ) );

  slot->name_len = (uchar)name_len;
  copy_bytes( slot->name, name, name_len );

  slot->handle_len = (uchar)handle_len;
  copy_bytes( slot->handle, handle, handle_len );

  slot->msg_len = (uchar)msg_len;
  copy_bytes( slot->msg, msg, msg_len );

  tsdk_block_ctx_t const * blk = tsdk_get_current_block_ctx();
  slot->posted_at = blk->block_time;

  /* The fee payer signed this transaction, so this address is proven. A user
     posting from the CLI pays their own fee and lands here as themselves; a
     post made through the website arrives with the sponsor as fee payer. */
  tn_pubkey_t const * addrs  = tsdk_txn_get_acct_addrs( tsdk_get_txn() );
  uchar const *       poster = (uchar const *)tsdk_type_pun_const( &addrs[ 0 ] );

  copy_bytes( (uchar *)tsdk_type_pun( &slot->poster ), poster,
              sizeof( tn_pubkey_t ) );

  slot->verified = (uchar)( memcmp( poster,
                                    (uchar const *)tsdk_type_pun_const( &hdr->sponsor ),
                                    sizeof( tn_pubkey_t ) ) != 0 ? 1 : 0 );

  hdr->next_idx = (uint)( ( idx + 1UL ) % slots );
  /* Wraps after about 4 billion posts, which alphanet will not see. */
  hdr->total_posted = hdr->total_posted + 1U;

  /* Emitting the slot index gives the transaction a visible event and lets a
     client find its own message without re-reading the whole wall. */
  uint event = (uint)idx;
  (void)tsys_emit_event( (void const *)&event, sizeof( event ) );

  tsdk_return( 0UL );
}

TSDK_ENTRYPOINT_FN void
start( void const * instruction_data, ulong instruction_data_sz ) {
  uchar const * data = (uchar const *)instruction_data;

  if( instruction_data_sz < 1UL ) tsdk_revert( ERR_BAD_INSTR );

  switch( data[ 0 ] ) {
    case OP_INIT: do_init( data, instruction_data_sz ); break;
    case OP_POST: do_post( data, instruction_data_sz ); break;
    default:      tsdk_revert( ERR_BAD_OPCODE );
  }

  tsdk_return( 0UL );
}
