/* thruwordle - an on-chain scoreboard for a word guessing game
 *
 * The game itself runs in the browser. When a game finishes, the whole game is
 * submitted in one transaction: the answer, every guess made, and whether it
 * was solved. This program recomputes the result from those bytes rather than
 * trusting the number it was handed, then folds it into a running record for
 * that player.
 *
 * What that does and does not prove: the recorded score is arithmetically
 * correct, because the program checks the final guess really does match the
 * answer and derives the points itself. It does not prove which word the
 * player was given, since nothing was committed before play started. Saying
 * so is better than implying a guarantee that is not there.
 *
 * Players are identified by an 8-byte id generated in their browser and kept
 * there. That is not an identity in any cryptographic sense — anyone can mint
 * a new one — but it removes every scrap of friction from a first game, which
 * matters more here than making a casual scoreboard unforgeable.
 *
 * Instructions:
 *
 *   INIT    [0x00][seed: 32][slots: u16][state proof: rest]
 *           Creates the scoreboard account and sizes it. Run once.
 *
 *   SUBMIT  [0x01][player_id: 8][name_len: u8][name][answer: 5]
 *           [guess_count: u8][guesses: guess_count * 5][solved: u8]
 *           Records one finished game.
 *
 * Account index 2 is the scoreboard. Index 0 is the fee payer, index 1 is this
 * program, so the first account declared writable lands at 2.
 */

#include <thru-sdk/c/tn_sdk.h>
#include <thru-sdk/c/tn_sdk_syscall.h>

#define OP_INIT   (0x00)
#define OP_SUBMIT (0x01)

#define BOARD_ACC_IDX ((ushort)2)
#define BOARD_VERSION ((uchar)1)

#define WORD_LEN    (5UL)
#define MAX_GUESSES (6UL)
#define NAME_MAX    (24UL)
#define ID_LEN      (8UL)
#define SLOTS_MAX   (512UL)

/* Winning on the first guess is worth 60, on the last worth 10. */
#define POINTS_PER_STEP (10U)

#define ERR_BAD_INSTR     (1UL)
#define ERR_BAD_OPCODE    (2UL)
#define ERR_NO_ACCOUNT    (3UL)
#define ERR_NOT_OURS      (4UL)
#define ERR_TOO_LONG      (5UL)
#define ERR_BAD_GUESSES   (6UL)
#define ERR_CREATE_FAILED (7UL)
#define ERR_RESIZE_FAILED (8UL)
#define ERR_WRITE_DENIED  (9UL)
#define ERR_NOT_READY     (10UL)
#define ERR_BAD_SLOTS     (11UL)
#define ERR_BAD_LETTER    (12UL)
#define ERR_NOT_SOLVED    (13UL)

struct __attribute__(( packed )) board_hdr {
  uchar       version;      /* [0,1)    layout version */
  uint        next_idx;     /* [1,5)    next slot to hand out */
  uint        players;      /* [5,9)    distinct players seen */
  uint        games;        /* [9,13)   games recorded, ever */
  tn_pubkey_t sponsor;      /* [13,45)  whoever ran INIT */
};
typedef struct board_hdr board_hdr_t;

struct __attribute__(( packed )) player_slot {
  uchar id[ ID_LEN ];       /* zero means the slot has never been used */
  uchar name_len;
  uchar name[ NAME_MAX ];
  uint  played;
  uint  won;
  uint  points;
  uint  streak;             /* current run of wins, reset by a loss */
  uint  best_streak;
  ulong last_played;        /* block time, nanoseconds */
  uchar last_answer[ WORD_LEN ];
  uchar last_guesses;
};
typedef struct player_slot player_slot_t;

static ulong
board_capacity( ulong data_sz ) {
  if( data_sz < sizeof( board_hdr_t ) + sizeof( player_slot_t ) ) return 0UL;
  return ( data_sz - sizeof( board_hdr_t ) ) / sizeof( player_slot_t );
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

/* Letters are stored lowercase so comparisons stay simple. Anything outside
   a-z is rejected rather than coerced, because a stray byte here would mean
   the browser and the program disagree about what was played. */
static void
require_letters( uchar const * bytes, ulong n ) {
  for( ulong i=0UL; i<n; i++ ) {
    if( bytes[ i ] < (uchar)'a' || bytes[ i ] > (uchar)'z' ) tsdk_revert( ERR_BAD_LETTER );
  }
}

static uchar *
open_board_for_writing( void ) {
  if( !tsdk_is_account_idx_valid( BOARD_ACC_IDX ) ) tsdk_revert( ERR_NO_ACCOUNT );
  if( !tsdk_account_exists( BOARD_ACC_IDX ) )       tsdk_revert( ERR_NOT_READY );

  if( !tsdk_is_account_owned_by_current_program( BOARD_ACC_IDX ) ) {
    tsdk_revert( ERR_NOT_OURS );
  }

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( BOARD_ACC_IDX );
  if( board_capacity( (ulong)meta->data_sz ) == 0UL ) tsdk_revert( ERR_NOT_READY );

  if( tsys_set_account_data_writable( (ulong)BOARD_ACC_IDX ) != 0UL ) {
    tsdk_revert( ERR_WRITE_DENIED );
  }

  return (uchar *)tsdk_get_account_data_ptr( BOARD_ACC_IDX );
}

static void
do_init( uchar const * data, ulong data_sz ) {
  if( data_sz < 1UL + TN_SEED_SIZE + 2UL ) tsdk_revert( ERR_BAD_INSTR );
  if( !tsdk_is_account_idx_valid( BOARD_ACC_IDX ) ) tsdk_revert( ERR_NO_ACCOUNT );

  uchar const * seed = data + 1UL;

  ulong slots = (ulong)data[ 1UL + TN_SEED_SIZE ]
              | ( (ulong)data[ 2UL + TN_SEED_SIZE ] << 8 );
  if( slots == 0UL || slots > SLOTS_MAX ) tsdk_revert( ERR_BAD_SLOTS );

  ulong board_size = sizeof( board_hdr_t ) + slots * sizeof( player_slot_t );

  void  const * proof    = (void const *)( data + 3UL + TN_SEED_SIZE );
  ulong         proof_sz = data_sz - 3UL - TN_SEED_SIZE;

  if( !tsdk_account_exists( BOARD_ACC_IDX ) ) {
    if( tsys_account_create( (ulong)BOARD_ACC_IDX, seed, proof, proof_sz ) != 0UL ) {
      tsdk_revert( ERR_CREATE_FAILED );
    }
  }

  if( !tsdk_is_account_owned_by_current_program( BOARD_ACC_IDX ) ) {
    tsdk_revert( ERR_NOT_OURS );
  }

  /* Writable before resize. The other order fails at every size, which is a
     confusing thing to debug — it looks exactly like a size limit. */
  if( tsys_set_account_data_writable( (ulong)BOARD_ACC_IDX ) != 0UL ) {
    tsdk_revert( ERR_WRITE_DENIED );
  }

  if( tsys_account_resize( (ulong)BOARD_ACC_IDX, board_size ) != 0UL ) {
    tsdk_revert( ERR_RESIZE_FAILED );
  }

  uchar * raw = (uchar *)tsdk_get_account_data_ptr( BOARD_ACC_IDX );
  zero_bytes( raw, board_size );

  board_hdr_t * hdr = (board_hdr_t *)tsdk_type_pun( raw );
  hdr->version  = BOARD_VERSION;
  hdr->next_idx = 0U;
  hdr->players  = 0U;
  hdr->games    = 0U;

  tn_pubkey_t const * addrs = tsdk_txn_get_acct_addrs( tsdk_get_txn() );
  copy_bytes( (uchar *)tsdk_type_pun( &hdr->sponsor ),
              (uchar const *)tsdk_type_pun_const( &addrs[ 0 ] ),
              sizeof( tn_pubkey_t ) );

  tsdk_return( 0UL );
}

static void
do_submit( uchar const * data, ulong data_sz ) {
  ulong cursor = 1UL;

  if( data_sz < cursor + ID_LEN + 1UL ) tsdk_revert( ERR_BAD_INSTR );

  uchar const * player_id = data + cursor;
  cursor += ID_LEN;

  /* An all-zero id would collide with unused slots, so it is not a valid
     player. The browser generates ids randomly, making this vanishingly
     unlikely, but a check costs nothing. */
  if( is_blank( player_id, ID_LEN ) ) tsdk_revert( ERR_BAD_INSTR );

  ulong name_len = (ulong)data[ cursor++ ];
  if( name_len > NAME_MAX ) tsdk_revert( ERR_TOO_LONG );
  if( cursor + name_len > data_sz ) tsdk_revert( ERR_BAD_INSTR );
  uchar const * name = data + cursor;
  cursor += name_len;

  if( cursor + WORD_LEN + 1UL > data_sz ) tsdk_revert( ERR_BAD_INSTR );
  uchar const * answer = data + cursor;
  cursor += WORD_LEN;
  require_letters( answer, WORD_LEN );

  ulong guess_count = (ulong)data[ cursor++ ];
  if( guess_count == 0UL || guess_count > MAX_GUESSES ) tsdk_revert( ERR_BAD_GUESSES );

  if( cursor + guess_count * WORD_LEN + 1UL > data_sz ) tsdk_revert( ERR_BAD_INSTR );
  uchar const * guesses = data + cursor;
  cursor += guess_count * WORD_LEN;
  require_letters( guesses, guess_count * WORD_LEN );

  uchar solved = data[ cursor ];

  /* The claimed outcome has to match the guesses. A win means the last guess
     is the answer; a loss means none of them were. Without this the points
     below would just be whatever the caller asked for. */
  uchar const * final_guess = guesses + ( guess_count - 1UL ) * WORD_LEN;
  if( solved ) {
    if( !same_bytes( final_guess, answer, WORD_LEN ) ) tsdk_revert( ERR_NOT_SOLVED );
  } else {
    for( ulong i=0UL; i<guess_count; i++ ) {
      if( same_bytes( guesses + i * WORD_LEN, answer, WORD_LEN ) ) tsdk_revert( ERR_NOT_SOLVED );
    }
    /* A loss only makes sense once every guess is spent. */
    if( guess_count != MAX_GUESSES ) tsdk_revert( ERR_BAD_GUESSES );
  }

  uint points = solved
    ? (uint)( ( MAX_GUESSES + 1UL - guess_count ) * (ulong)POINTS_PER_STEP )
    : 0U;

  uchar * raw = open_board_for_writing();
  board_hdr_t * hdr = (board_hdr_t *)tsdk_type_pun( raw );
  if( hdr->version != BOARD_VERSION ) tsdk_revert( ERR_NOT_READY );

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( BOARD_ACC_IDX );
  ulong slots = board_capacity( (ulong)meta->data_sz );

  uchar * slot_base = raw + sizeof( board_hdr_t );

  /* Look for this player first. A linear scan is fine at a few hundred slots
     and keeps the layout free of index structures. */
  player_slot_t * slot = (player_slot_t *)0;
  for( ulong i=0UL; i<slots; i++ ) {
    player_slot_t * candidate =
      (player_slot_t *)tsdk_type_pun( slot_base + i * sizeof( player_slot_t ) );
    if( same_bytes( candidate->id, player_id, ID_LEN ) ) { slot = candidate; break; }
  }

  if( !slot ) {
    /* New player. Slots wrap, so a full board displaces the oldest entry
       rather than refusing to record the game. */
    ulong idx = (ulong)hdr->next_idx % slots;
    slot = (player_slot_t *)tsdk_type_pun( slot_base + idx * sizeof( player_slot_t ) );

    if( is_blank( slot->id, ID_LEN ) ) hdr->players = hdr->players + 1U;

    zero_bytes( (uchar *)tsdk_type_pun( slot ), sizeof( player_slot_t ) );
    copy_bytes( slot->id, player_id, ID_LEN );

    hdr->next_idx = (uint)( ( idx + 1UL ) % slots );
  }

  /* Name is refreshed every game, so renaming yourself just works. */
  zero_bytes( slot->name, NAME_MAX );
  slot->name_len = (uchar)name_len;
  copy_bytes( slot->name, name, name_len );

  slot->played = slot->played + 1U;
  slot->points = slot->points + points;

  if( solved ) {
    slot->won    = slot->won + 1U;
    slot->streak = slot->streak + 1U;
    if( slot->streak > slot->best_streak ) slot->best_streak = slot->streak;
  } else {
    slot->streak = 0U;
  }

  tsdk_block_ctx_t const * blk = tsdk_get_current_block_ctx();
  slot->last_played = blk->block_time;

  copy_bytes( slot->last_answer, answer, WORD_LEN );
  slot->last_guesses = (uchar)guess_count;

  hdr->games = hdr->games + 1U;

  uint event = points;
  (void)tsys_emit_event( (void const *)&event, sizeof( event ) );

  tsdk_return( 0UL );
}

TSDK_ENTRYPOINT_FN void
start( void const * instruction_data, ulong instruction_data_sz ) {
  uchar const * data = (uchar const *)instruction_data;

  if( instruction_data_sz < 1UL ) tsdk_revert( ERR_BAD_INSTR );

  switch( data[ 0 ] ) {
    case OP_INIT:   do_init(   data, instruction_data_sz ); break;
    case OP_SUBMIT: do_submit( data, instruction_data_sz ); break;
    default:        tsdk_revert( ERR_BAD_OPCODE );
  }

  tsdk_return( 0UL );
}
