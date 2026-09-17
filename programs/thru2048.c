/* thru2048 - 2048 played entirely on chain
 *
 * Every swipe is its own transaction. The board lives in an account between
 * moves, and this program does the sliding, merging, scoring and spawning, so
 * the score is not something a client reports — it is something the chain
 * computed. That is the point: a game that is genuinely played on chain rather
 * than played elsewhere and recorded here.
 *
 * It is also deliberately heavy. A finished game runs a few hundred moves, so
 * a few hundred transactions, which is the sort of load a real application
 * would put on a chain.
 *
 * Tiles are stored as exponents, not values: 0 is empty, 1 is a 2, 2 is a 4,
 * and so on up to 17, which is 131072. One byte per cell, sixteen cells.
 *
 * Instructions:
 *
 *   INIT   [0x00][seed: 32][slots: u16][state proof: rest]
 *   NEW    [0x01][player_id: 8][name_len: u8][name]
 *          Clears the board and drops two starting tiles.
 *   MOVE   [0x02][player_id: 8][direction: u8]
 *          0 left, 1 right, 2 up, 3 down.
 *
 * Account index 2 is the board account. Index 0 is the fee payer, index 1 is
 * this program.
 */

#include <thru-sdk/c/tn_sdk.h>
#include <thru-sdk/c/tn_sdk_syscall.h>

#define OP_INIT (0x00)
#define OP_NEW  (0x01)
#define OP_MOVE (0x02)

#define GAME_ACC_IDX ((ushort)2)
#define GAME_VERSION ((uchar)1)

#define GRID      (4UL)
#define CELLS     (16UL)
#define NAME_MAX  (24UL)
#define ID_LEN    (8UL)
#define SLOTS_MAX (512UL)
#define MAX_EXP   (17U)   /* 2^17 = 131072, past any realistic game */

#define STATE_EMPTY   ((uchar)0)
#define STATE_PLAYING ((uchar)1)
#define STATE_OVER    ((uchar)2)

#define ERR_BAD_INSTR     (1UL)
#define ERR_BAD_OPCODE    (2UL)
#define ERR_NO_ACCOUNT    (3UL)
#define ERR_NOT_OURS      (4UL)
#define ERR_TOO_LONG      (5UL)
#define ERR_CREATE_FAILED (7UL)
#define ERR_RESIZE_FAILED (8UL)
#define ERR_WRITE_DENIED  (9UL)
#define ERR_NOT_READY     (10UL)
#define ERR_BAD_SLOTS     (11UL)
#define ERR_NO_GAME       (12UL)
#define ERR_GAME_OVER     (13UL)
#define ERR_BAD_DIR       (14UL)
#define ERR_NO_CHANGE     (15UL)  /* the swipe moved nothing, so it is not a move */

struct __attribute__(( packed )) game_hdr {
  uchar       version;
  uint        next_idx;
  uint        players;
  uint        moves;      /* every move by anyone, ever — the throughput number */
  tn_pubkey_t sponsor;
};
typedef struct game_hdr game_hdr_t;

struct __attribute__(( packed )) player_slot {
  uchar id[ ID_LEN ];
  uchar name_len;
  uchar name[ NAME_MAX ];
  uchar board[ CELLS ];
  uint  score;
  uint  best_score;
  uint  moves;        /* moves in the current game */
  uint  games;
  ulong rng;          /* xorshift state, so spawns are reproducible from chain data */
  ulong last_played;
  uchar status;
};
typedef struct player_slot player_slot_t;

static ulong
board_capacity( ulong data_sz ) {
  if( data_sz < sizeof( game_hdr_t ) + sizeof( player_slot_t ) ) return 0UL;
  return ( data_sz - sizeof( game_hdr_t ) ) / sizeof( player_slot_t );
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

/* xorshift64. Not cryptographic, and it does not need to be — it only decides
   where the next tile appears. Keeping the state in the account means anyone
   can replay the whole game from chain data and get the same board. */
static ulong
next_random( ulong * state ) {
  ulong x = *state;
  x ^= x << 13;
  x ^= x >> 7;
  x ^= x << 17;
  *state = x;
  return x;
}

/* ---------- board mechanics ---------- */

/* Cell indices for one line, in the direction the tiles travel. Reading the
   board through this means the slide logic is written once instead of four
   times with the indices shuffled. */
static void
line_indices( ulong dir, ulong line, ulong * out ) {
  for( ulong i=0UL; i<GRID; i++ ) {
    switch( dir ) {
      case 0UL: out[ i ] = line * GRID + i;                       break; /* left  */
      case 1UL: out[ i ] = line * GRID + ( GRID - 1UL - i );       break; /* right */
      case 2UL: out[ i ] = i * GRID + line;                        break; /* up    */
      default:  out[ i ] = ( GRID - 1UL - i ) * GRID + line;       break; /* down  */
    }
  }
}

/* Slide and merge one line toward index 0. Returns 1 if anything moved.
   Each tile may merge only once per move, which is what the single pass with
   the skip achieves — without it, 2 2 4 would collapse to 8 in one swipe. */
static int
slide_line( uchar * cells, uint * score ) {
  uchar packed[ GRID ];
  ulong n = 0UL;

  for( ulong i=0UL; i<GRID; i++ ) if( cells[ i ] ) packed[ n++ ] = cells[ i ];

  uchar result[ GRID ];
  for( ulong i=0UL; i<GRID; i++ ) result[ i ] = (uchar)0;

  ulong w = 0UL;
  for( ulong i=0UL; i<n; i++ ) {
    if( i + 1UL < n && packed[ i ] == packed[ i + 1UL ] && packed[ i ] < (uchar)MAX_EXP ) {
      uchar merged = (uchar)( packed[ i ] + (uchar)1 );
      result[ w++ ] = merged;
      *score = *score + ( (uint)1U << (uint)merged );
      i++; /* the partner is consumed, so it cannot merge again */
    } else {
      result[ w++ ] = packed[ i ];
    }
  }

  int changed = 0;
  for( ulong i=0UL; i<GRID; i++ ) {
    if( cells[ i ] != result[ i ] ) changed = 1;
    cells[ i ] = result[ i ];
  }
  return changed;
}

static int
apply_move( uchar * board, ulong dir, uint * score ) {
  int changed = 0;

  for( ulong line=0UL; line<GRID; line++ ) {
    ulong idx[ GRID ];
    line_indices( dir, line, idx );

    uchar cells[ GRID ];
    for( ulong i=0UL; i<GRID; i++ ) cells[ i ] = board[ idx[ i ] ];

    if( slide_line( cells, score ) ) changed = 1;

    for( ulong i=0UL; i<GRID; i++ ) board[ idx[ i ] ] = cells[ i ];
  }

  return changed;
}

static void
spawn_tile( uchar * board, ulong * rng ) {
  ulong empty[ CELLS ];
  ulong n = 0UL;
  for( ulong i=0UL; i<CELLS; i++ ) if( !board[ i ] ) empty[ n++ ] = i;
  if( n == 0UL ) return;

  ulong pick = next_random( rng ) % n;
  /* A four one time in ten, matching the original game. */
  board[ empty[ pick ] ] = ( next_random( rng ) % 10UL ) == 0UL ? (uchar)2 : (uchar)1;
}

/* The game ends only when the board is full AND no neighbours match. A full
   board with an available merge is still playable. */
static int
has_moves( uchar const * board ) {
  for( ulong i=0UL; i<CELLS; i++ ) if( !board[ i ] ) return 1;

  for( ulong r=0UL; r<GRID; r++ ) {
    for( ulong c=0UL; c<GRID; c++ ) {
      uchar here = board[ r * GRID + c ];
      if( c + 1UL < GRID && here == board[ r * GRID + c + 1UL ] ) return 1;
      if( r + 1UL < GRID && here == board[ ( r + 1UL ) * GRID + c ] ) return 1;
    }
  }
  return 0;
}

/* ---------- account plumbing ---------- */

static uchar *
open_game_for_writing( void ) {
  if( !tsdk_is_account_idx_valid( GAME_ACC_IDX ) ) tsdk_revert( ERR_NO_ACCOUNT );
  if( !tsdk_account_exists( GAME_ACC_IDX ) )       tsdk_revert( ERR_NOT_READY );

  if( !tsdk_is_account_owned_by_current_program( GAME_ACC_IDX ) ) tsdk_revert( ERR_NOT_OURS );

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( GAME_ACC_IDX );
  if( board_capacity( (ulong)meta->data_sz ) == 0UL ) tsdk_revert( ERR_NOT_READY );

  if( tsys_set_account_data_writable( (ulong)GAME_ACC_IDX ) != 0UL ) tsdk_revert( ERR_WRITE_DENIED );

  return (uchar *)tsdk_get_account_data_ptr( GAME_ACC_IDX );
}

/* Finds this player's slot, taking a fresh one if they are new. */
static player_slot_t *
find_or_claim( uchar * raw, ulong slots, uchar const * player_id, int claim ) {
  game_hdr_t * hdr = (game_hdr_t *)tsdk_type_pun( raw );
  uchar * base = raw + sizeof( game_hdr_t );

  for( ulong i=0UL; i<slots; i++ ) {
    player_slot_t * candidate =
      (player_slot_t *)tsdk_type_pun( base + i * sizeof( player_slot_t ) );
    if( same_bytes( candidate->id, player_id, ID_LEN ) ) return candidate;
  }

  if( !claim ) return (player_slot_t *)0;

  ulong idx = (ulong)hdr->next_idx % slots;
  player_slot_t * slot = (player_slot_t *)tsdk_type_pun( base + idx * sizeof( player_slot_t ) );

  if( is_blank( slot->id, ID_LEN ) ) hdr->players = hdr->players + 1U;

  zero_bytes( (uchar *)tsdk_type_pun( slot ), sizeof( player_slot_t ) );
  copy_bytes( slot->id, player_id, ID_LEN );
  hdr->next_idx = (uint)( ( idx + 1UL ) % slots );

  return slot;
}

static void
do_init( uchar const * data, ulong data_sz ) {
  if( data_sz < 1UL + TN_SEED_SIZE + 2UL ) tsdk_revert( ERR_BAD_INSTR );
  if( !tsdk_is_account_idx_valid( GAME_ACC_IDX ) ) tsdk_revert( ERR_NO_ACCOUNT );

  uchar const * seed = data + 1UL;

  ulong slots = (ulong)data[ 1UL + TN_SEED_SIZE ]
              | ( (ulong)data[ 2UL + TN_SEED_SIZE ] << 8 );
  if( slots == 0UL || slots > SLOTS_MAX ) tsdk_revert( ERR_BAD_SLOTS );

  ulong size = sizeof( game_hdr_t ) + slots * sizeof( player_slot_t );

  void  const * proof    = (void const *)( data + 3UL + TN_SEED_SIZE );
  ulong         proof_sz = data_sz - 3UL - TN_SEED_SIZE;

  if( !tsdk_account_exists( GAME_ACC_IDX ) ) {
    if( tsys_account_create( (ulong)GAME_ACC_IDX, seed, proof, proof_sz ) != 0UL ) {
      tsdk_revert( ERR_CREATE_FAILED );
    }
  }

  if( !tsdk_is_account_owned_by_current_program( GAME_ACC_IDX ) ) tsdk_revert( ERR_NOT_OURS );

  /* Writable first, then resize. The other order fails at every size. */
  if( tsys_set_account_data_writable( (ulong)GAME_ACC_IDX ) != 0UL ) tsdk_revert( ERR_WRITE_DENIED );
  if( tsys_account_resize( (ulong)GAME_ACC_IDX, size ) != 0UL )      tsdk_revert( ERR_RESIZE_FAILED );

  uchar * raw = (uchar *)tsdk_get_account_data_ptr( GAME_ACC_IDX );
  zero_bytes( raw, size );

  game_hdr_t * hdr = (game_hdr_t *)tsdk_type_pun( raw );
  hdr->version  = GAME_VERSION;
  hdr->next_idx = 0U;
  hdr->players  = 0U;
  hdr->moves    = 0U;

  tn_pubkey_t const * addrs = tsdk_txn_get_acct_addrs( tsdk_get_txn() );
  copy_bytes( (uchar *)tsdk_type_pun( &hdr->sponsor ),
              (uchar const *)tsdk_type_pun_const( &addrs[ 0 ] ),
              sizeof( tn_pubkey_t ) );

  tsdk_return( 0UL );
}

static void
do_new( uchar const * data, ulong data_sz ) {
  ulong cursor = 1UL;
  if( data_sz < cursor + ID_LEN + 1UL ) tsdk_revert( ERR_BAD_INSTR );

  uchar const * player_id = data + cursor;
  cursor += ID_LEN;
  if( is_blank( player_id, ID_LEN ) ) tsdk_revert( ERR_BAD_INSTR );

  ulong name_len = (ulong)data[ cursor++ ];
  if( name_len > NAME_MAX ) tsdk_revert( ERR_TOO_LONG );
  if( cursor + name_len > data_sz ) tsdk_revert( ERR_BAD_INSTR );
  uchar const * name = data + cursor;

  uchar * raw = open_game_for_writing();
  game_hdr_t * hdr = (game_hdr_t *)tsdk_type_pun( raw );
  if( hdr->version != GAME_VERSION ) tsdk_revert( ERR_NOT_READY );

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( GAME_ACC_IDX );
  ulong slots = board_capacity( (ulong)meta->data_sz );

  player_slot_t * slot = find_or_claim( raw, slots, player_id, 1 );

  tsdk_block_ctx_t const * blk = tsdk_get_current_block_ctx();

  /* Carry the best score and game count across; everything else restarts. */
  uint best  = slot->best_score;
  uint games = slot->games;

  zero_bytes( slot->board, CELLS );
  slot->score      = 0U;
  slot->moves      = 0U;
  slot->best_score = best;
  slot->games      = games + 1U;
  slot->status     = STATE_PLAYING;
  slot->last_played = blk->block_time;

  zero_bytes( slot->name, NAME_MAX );
  slot->name_len = (uchar)name_len;
  copy_bytes( slot->name, name, name_len );

  /* Seeding from block time plus the player id keeps two people starting in
     the same block from getting identical boards. */
  ulong seed_rng = blk->block_time;
  for( ulong i=0UL; i<ID_LEN; i++ ) seed_rng = seed_rng * 1099511628211UL + (ulong)player_id[ i ];
  if( seed_rng == 0UL ) seed_rng = 0x9E3779B97F4A7C15UL;

  /* The struct is packed, so a pointer to a member inside it may be unaligned
     and the compiler refuses to hand one out. Work through a local and write
     the result back. Same reason spawn_tile takes the state by pointer rather
     than reaching into the slot itself. */
  ulong rng = seed_rng;
  spawn_tile( slot->board, &rng );
  spawn_tile( slot->board, &rng );
  slot->rng = rng;

  tsdk_return( 0UL );
}

static void
do_move( uchar const * data, ulong data_sz ) {
  if( data_sz < 1UL + ID_LEN + 1UL ) tsdk_revert( ERR_BAD_INSTR );

  uchar const * player_id = data + 1UL;
  if( is_blank( player_id, ID_LEN ) ) tsdk_revert( ERR_BAD_INSTR );

  ulong dir = (ulong)data[ 1UL + ID_LEN ];
  if( dir > 3UL ) tsdk_revert( ERR_BAD_DIR );

  uchar * raw = open_game_for_writing();
  game_hdr_t * hdr = (game_hdr_t *)tsdk_type_pun( raw );
  if( hdr->version != GAME_VERSION ) tsdk_revert( ERR_NOT_READY );

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( GAME_ACC_IDX );
  ulong slots = board_capacity( (ulong)meta->data_sz );

  player_slot_t * slot = find_or_claim( raw, slots, player_id, 0 );
  if( !slot )                        tsdk_revert( ERR_NO_GAME );
  if( slot->status != STATE_PLAYING ) tsdk_revert( ERR_GAME_OVER );

  uint score = slot->score;
  if( !apply_move( slot->board, dir, &score ) ) {
    /* Nothing shifted, so no tile spawns and no move is counted. Rejecting
       rather than silently accepting keeps the move count honest. */
    tsdk_revert( ERR_NO_CHANGE );
  }

  slot->score = score;
  if( score > slot->best_score ) slot->best_score = score;

  ulong rng = slot->rng;
  spawn_tile( slot->board, &rng );
  slot->rng = rng;

  slot->moves = slot->moves + 1U;
  if( !has_moves( slot->board ) ) slot->status = STATE_OVER;

  tsdk_block_ctx_t const * blk = tsdk_get_current_block_ctx();
  slot->last_played = blk->block_time;

  hdr->moves = hdr->moves + 1U;

  uint event = slot->score;
  (void)tsys_emit_event( (void const *)&event, sizeof( event ) );

  tsdk_return( 0UL );
}

TSDK_ENTRYPOINT_FN void
start( void const * instruction_data, ulong instruction_data_sz ) {
  uchar const * data = (uchar const *)instruction_data;

  if( instruction_data_sz < 1UL ) tsdk_revert( ERR_BAD_INSTR );

  switch( data[ 0 ] ) {
    case OP_INIT: do_init( data, instruction_data_sz ); break;
    case OP_NEW:  do_new(  data, instruction_data_sz ); break;
    case OP_MOVE: do_move( data, instruction_data_sz ); break;
    default:      tsdk_revert( ERR_BAD_OPCODE );
  }

  tsdk_return( 0UL );
}
