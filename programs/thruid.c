/* thruid - the username registry
 *
 * One place where a name is claimed, so a name means the same thing in every
 * game rather than each one keeping its own list. Games store only the eight
 * byte player id; the site reads this account to put a name against it.
 *
 * A name is public and a claim is permanent-ish: it belongs to whoever
 * registered it until they change it. The player id remains the credential.
 * That split matters — names appear on leaderboards, so if a name alone could
 * claim an identity, anyone reading the board could take someone else's.
 *
 * Names are lowercase a-z, 0-9 and underscore, three to twenty-four
 * characters. Restricting the alphabet is what makes uniqueness meaningful:
 * without it "pgreyy" and "PGREYY" and "pgreyy " are three different names
 * that look identical to a reader.
 *
 * Instructions:
 *
 *   INIT      [0x00][seed: 32][slots: u16][state proof: rest]
 *   REGISTER  [0x01][player_id: 8][name_len: u8][name]
 *             Claims a name, or renames if this id already holds one.
 *
 * Account index 2 is the registry.
 */

#include <thru-sdk/c/tn_sdk.h>
#include <thru-sdk/c/tn_sdk_syscall.h>

#define OP_INIT     (0x00)
#define OP_REGISTER (0x01)

#define REG_ACC_IDX ((ushort)2)
#define REG_VERSION ((uchar)1)

#define NAME_MAX  (24UL)
#define NAME_MIN  (3UL)
#define ID_LEN    (8UL)
#define SLOTS_MAX (1024UL)

#define ERR_BAD_INSTR     (1UL)
#define ERR_BAD_OPCODE    (2UL)
#define ERR_NO_ACCOUNT    (3UL)
#define ERR_NOT_OURS      (4UL)
#define ERR_CREATE_FAILED (7UL)
#define ERR_RESIZE_FAILED (8UL)
#define ERR_WRITE_DENIED  (9UL)
#define ERR_NOT_READY     (10UL)
#define ERR_BAD_SLOTS     (11UL)
#define ERR_NAME_LENGTH   (12UL)
#define ERR_NAME_CHARS    (13UL)
#define ERR_NAME_TAKEN    (14UL)
#define ERR_REGISTRY_FULL (15UL)

struct __attribute__(( packed )) reg_hdr {
  uchar       version;
  uint        next_idx;
  uint        count;
  tn_pubkey_t sponsor;
};
typedef struct reg_hdr reg_hdr_t;

struct __attribute__(( packed )) name_slot {
  uchar id[ ID_LEN ];   /* all zero means unused */
  uchar name_len;
  uchar name[ NAME_MAX ];
  ulong claimed_at;
};
typedef struct name_slot name_slot_t;

static ulong
registry_capacity( ulong data_sz ) {
  if( data_sz < sizeof( reg_hdr_t ) + sizeof( name_slot_t ) ) return 0UL;
  return ( data_sz - sizeof( reg_hdr_t ) ) / sizeof( name_slot_t );
}

static void
copy_bytes( uchar * dst, uchar const * src, ulong n ) {
  for( ulong i=0UL; i<n; i++ ) dst[ i ] = src[ i ];
}

static void
zero_bytes( uchar * dst, ulong n ) {
  for( ulong i=0UL; i<n; i++ ) dst[ i ] = (uchar)0;
}

static int
same_bytes( uchar const * a, uchar const * b, ulong n ) {
  for( ulong i=0UL; i<n; i++ ) if( a[ i ] != b[ i ] ) return 0;
  return 1;
}

static int
is_blank( uchar const * bytes, ulong n ) {
  for( ulong i=0UL; i<n; i++ ) if( bytes[ i ] != (uchar)0 ) return 0;
  return 1;
}

/* Rejecting rather than normalising is deliberate: silently lowercasing
   someone's chosen name would mean the thing they registered is not the thing
   they typed, and they would find out from a leaderboard. */
static void
require_valid_name( uchar const * name, ulong len ) {
  if( len < NAME_MIN || len > NAME_MAX ) tsdk_revert( ERR_NAME_LENGTH );

  for( ulong i=0UL; i<len; i++ ) {
    uchar c = name[ i ];
    int ok = ( c >= (uchar)'a' && c <= (uchar)'z' )
          || ( c >= (uchar)'0' && c <= (uchar)'9' )
          || ( c == (uchar)'_' );
    if( !ok ) tsdk_revert( ERR_NAME_CHARS );
  }
}

static uchar *
open_registry_for_writing( void ) {
  if( !tsdk_is_account_idx_valid( REG_ACC_IDX ) ) tsdk_revert( ERR_NO_ACCOUNT );
  if( !tsdk_account_exists( REG_ACC_IDX ) )       tsdk_revert( ERR_NOT_READY );

  if( !tsdk_is_account_owned_by_current_program( REG_ACC_IDX ) ) tsdk_revert( ERR_NOT_OURS );

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( REG_ACC_IDX );
  if( registry_capacity( (ulong)meta->data_sz ) == 0UL ) tsdk_revert( ERR_NOT_READY );

  if( tsys_set_account_data_writable( (ulong)REG_ACC_IDX ) != 0UL ) tsdk_revert( ERR_WRITE_DENIED );

  return (uchar *)tsdk_get_account_data_ptr( REG_ACC_IDX );
}

static void
do_init( uchar const * data, ulong data_sz ) {
  if( data_sz < 1UL + TN_SEED_SIZE + 2UL ) tsdk_revert( ERR_BAD_INSTR );
  if( !tsdk_is_account_idx_valid( REG_ACC_IDX ) ) tsdk_revert( ERR_NO_ACCOUNT );

  uchar const * seed = data + 1UL;

  ulong slots = (ulong)data[ 1UL + TN_SEED_SIZE ]
              | ( (ulong)data[ 2UL + TN_SEED_SIZE ] << 8 );
  if( slots == 0UL || slots > SLOTS_MAX ) tsdk_revert( ERR_BAD_SLOTS );

  ulong size = sizeof( reg_hdr_t ) + slots * sizeof( name_slot_t );

  void  const * proof    = (void const *)( data + 3UL + TN_SEED_SIZE );
  ulong         proof_sz = data_sz - 3UL - TN_SEED_SIZE;

  if( !tsdk_account_exists( REG_ACC_IDX ) ) {
    if( tsys_account_create( (ulong)REG_ACC_IDX, seed, proof, proof_sz ) != 0UL ) {
      tsdk_revert( ERR_CREATE_FAILED );
    }
  }

  if( !tsdk_is_account_owned_by_current_program( REG_ACC_IDX ) ) tsdk_revert( ERR_NOT_OURS );

  /* Writable before resize; the other order fails at every size. */
  if( tsys_set_account_data_writable( (ulong)REG_ACC_IDX ) != 0UL ) tsdk_revert( ERR_WRITE_DENIED );
  if( tsys_account_resize( (ulong)REG_ACC_IDX, size ) != 0UL )      tsdk_revert( ERR_RESIZE_FAILED );

  uchar * raw = (uchar *)tsdk_get_account_data_ptr( REG_ACC_IDX );
  zero_bytes( raw, size );

  reg_hdr_t * hdr = (reg_hdr_t *)tsdk_type_pun( raw );
  hdr->version  = REG_VERSION;
  hdr->next_idx = 0U;
  hdr->count    = 0U;

  tn_pubkey_t const * addrs = tsdk_txn_get_acct_addrs( tsdk_get_txn() );
  copy_bytes( (uchar *)tsdk_type_pun( &hdr->sponsor ),
              (uchar const *)tsdk_type_pun_const( &addrs[ 0 ] ),
              sizeof( tn_pubkey_t ) );

  tsdk_return( 0UL );
}

static void
do_register( uchar const * data, ulong data_sz ) {
  ulong cursor = 1UL;
  if( data_sz < cursor + ID_LEN + 1UL ) tsdk_revert( ERR_BAD_INSTR );

  uchar const * player_id = data + cursor;
  cursor += ID_LEN;
  if( is_blank( player_id, ID_LEN ) ) tsdk_revert( ERR_BAD_INSTR );

  ulong name_len = (ulong)data[ cursor++ ];
  if( cursor + name_len > data_sz ) tsdk_revert( ERR_BAD_INSTR );

  uchar const * name = data + cursor;
  require_valid_name( name, name_len );

  uchar * raw = open_registry_for_writing();
  reg_hdr_t * hdr = (reg_hdr_t *)tsdk_type_pun( raw );
  if( hdr->version != REG_VERSION ) tsdk_revert( ERR_NOT_READY );

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( REG_ACC_IDX );
  ulong slots = registry_capacity( (ulong)meta->data_sz );
  uchar * base = raw + sizeof( reg_hdr_t );

  /* One pass finds both answers: whether this id already has a slot, and
     whether anyone else is holding the name being claimed. */
  name_slot_t * mine = (name_slot_t *)0;

  for( ulong i=0UL; i<slots; i++ ) {
    name_slot_t * slot = (name_slot_t *)tsdk_type_pun( base + i * sizeof( name_slot_t ) );
    if( is_blank( slot->id, ID_LEN ) ) continue;

    if( same_bytes( slot->id, player_id, ID_LEN ) ) { mine = slot; continue; }

    if( (ulong)slot->name_len == name_len && same_bytes( slot->name, name, name_len ) ) {
      tsdk_revert( ERR_NAME_TAKEN );
    }
  }

  tsdk_block_ctx_t const * blk = tsdk_get_current_block_ctx();

  if( mine ) {
    /* Renaming. The old name is released by being overwritten, so it becomes
       claimable again by anyone. */
    zero_bytes( mine->name, NAME_MAX );
    mine->name_len = (uchar)name_len;
    copy_bytes( mine->name, name, name_len );
    tsdk_return( 0UL );
  }

  /* A new claim needs a free slot. Unlike the game boards this does NOT wrap:
     overwriting the oldest registration would silently take away a name
     somebody still uses. */
  ulong idx = (ulong)hdr->next_idx;
  if( idx >= slots ) tsdk_revert( ERR_REGISTRY_FULL );

  name_slot_t * slot = (name_slot_t *)tsdk_type_pun( base + idx * sizeof( name_slot_t ) );
  if( !is_blank( slot->id, ID_LEN ) ) tsdk_revert( ERR_REGISTRY_FULL );

  zero_bytes( (uchar *)tsdk_type_pun( slot ), sizeof( name_slot_t ) );
  copy_bytes( slot->id, player_id, ID_LEN );
  slot->name_len = (uchar)name_len;
  copy_bytes( slot->name, name, name_len );
  slot->claimed_at = blk->block_time;

  hdr->next_idx = (uint)( idx + 1UL );
  hdr->count    = hdr->count + 1U;

  tsdk_return( 0UL );
}

TSDK_ENTRYPOINT_FN void
start( void const * instruction_data, ulong instruction_data_sz ) {
  uchar const * data = (uchar const *)instruction_data;

  if( instruction_data_sz < 1UL ) tsdk_revert( ERR_BAD_INSTR );

  switch( data[ 0 ] ) {
    case OP_INIT:     do_init(     data, instruction_data_sz ); break;
    case OP_REGISTER: do_register( data, instruction_data_sz ); break;
    default:          tsdk_revert( ERR_BAD_OPCODE );
  }

  tsdk_return( 0UL );
}
