/* vm.h - the stand-in Thru VM shared by sim.c and sim_fees.c: accounts,
 * frames with revert rollback, a token program model, and txn(). What it
 * models and what it does not is written at the top of sim.c. Include it
 * once, after state.h. */

void pad_start ( void const * data, ulong sz );
void swap_start( void const * data, ulong sz );

__extension__ typedef unsigned __int128 u128;

/* ---------------------------------------------------------------- accounts */

#define ACC_MAX  32
#define DATA_MAX 65536

typedef struct {
  tn_pubkey_t         key;
  int                 exists;
  int                 rw;          /* in the transaction's read-write list */
  int                 touched;     /* marked writable by its owning program */
  tsdk_account_meta_t meta;
  uchar               data[ DATA_MAX ];
} acct_t;

static acct_t acc[ ACC_MAX ];
static ushort nacc;
static ushort payer_idx;
static tsdk_block_ctx_t ctx;
static uchar const token_key[ 32 ] = TSDK_TOKEN_PROGRAM_ADDR_BYTES;

static ushort
add( uchar const key[ 32 ], uchar const owner[ 32 ], uchar const * data, ulong sz, int rw ) {
  acct_t * a = &acc[ nacc ];
  memset( a, 0, sizeof( *a ) );
  memcpy( a->key.key, key, 32 );
  a->exists = 1;
  a->rw = rw;
  if( owner ) memcpy( a->meta.owner.key, owner, 32 );
  a->meta.data_sz = (uint)sz;
  if( data ) memcpy( a->data, data, sz );
  return nacc++;
}

static void
fake_key( uchar out[ 32 ], uchar tag ) { memset( out, tag, 32 ); out[ 0 ] = 0xEE; }

static ushort
add_token_acct( uchar tag, uchar const mint[ 32 ], uchar const owner[ 32 ], ulong amount ) {
  uchar k[ 32 ], d[ 73 ];
  fake_key( k, tag );
  memset( d, 0, sizeof( d ) );
  memcpy( d, mint, 32 ); memcpy( d + 32, owner, 32 ); memcpy( d + 64, &amount, 8 );
  return add( k, token_key, d, 73, 1 );
}

__attribute__(( unused )) static ushort
add_lp_mint( uchar tag, uchar const authority[ 32 ] ) {
  uchar k[ 32 ], d[ 115 ];
  fake_key( k, tag );
  memset( d, 0, sizeof( d ) );
  d[ 0 ] = 6;                       /* decimals; supply 0 */
  memcpy( d + 41, authority, 32 );  /* mint_authority */
  return add( k, token_key, d, 115, 1 );
}

static ulong bal( ushort i ) { ulong v; memcpy( &v, acc[ i ].data + 64, 8 ); return v; }
static void  set_bal( ushort i, ulong v ) { memcpy( acc[ i ].data + 64, &v, 8 ); }

/* ------------------------------------------------------------------ frames */

typedef struct { ushort prog; jmp_buf jb; } frame_t;
static frame_t frames[ 8 ];
static int     depth;
static ulong   exit_code;
static int     exit_reverted;
static int     illegal;

struct tsdk_txn { int unused; };
static struct tsdk_txn the_txn;

tsdk_txn_t const * tsdk_get_txn( void ) { return &the_txn; }
ushort tsdk_txn_account_cnt( tsdk_txn_t const * t ) { (void)t; return nacc; }
tn_pubkey_t const * tsdk_txn_get_acct_addrs( tsdk_txn_t const * t ) {
  (void)t;
  static tn_pubkey_t keys[ ACC_MAX ];
  for( ushort i=0; i<nacc; i++ ) keys[ i ] = acc[ i ].key;
  return keys;
}
tsdk_account_meta_t const * tsdk_get_account_meta( ushort i ) { return &acc[ i ].meta; }
void * tsdk_get_account_data_ptr( ushort i ) { return acc[ i ].data; }
int tsdk_account_exists( ushort i ) { return i < nacc && acc[ i ].exists; }
int tsdk_is_account_idx_valid( ushort i ) { return i < nacc; }
ushort tsdk_get_current_program_acc_idx( void ) { return frames[ depth - 1 ].prog; }
tn_pubkey_t const * tsdk_get_current_program_acc_addr( void ) { return &acc[ frames[ depth - 1 ].prog ].key; }
int tsdk_is_account_owned_by_current_program( ushort i ) {
  return !memcmp( acc[ i ].meta.owner.key, tsdk_get_current_program_acc_addr()->key, 32 );
}
tsdk_block_ctx_t const * tsdk_get_current_block_ctx( void ) { return &ctx; }

void tsdk_revert( ulong code ) { exit_code = code; exit_reverted = 1; longjmp( frames[ depth - 1 ].jb, 1 ); }
void tsdk_return( ulong code ) { exit_code = code; exit_reverted = 0; longjmp( frames[ depth - 1 ].jb, 1 ); }

ulong tsys_set_account_data_writable( ulong i ) {
  if( i >= nacc || !acc[ i ].rw || !tsdk_is_account_owned_by_current_program( (ushort)i ) ) return 1UL;
  acc[ i ].touched = 1;
  return 0UL;
}
ulong tsys_account_create( ulong i, uchar const s[ 32 ], void const * p, ulong n ) { (void)i; (void)s; (void)p; (void)n; return 1UL; }
/* Resize: only the owning program, only once it marked the account writable
   (the order thruswap.c's INIT comment insists on), new bytes zeroed. */
ulong tsys_account_resize( ulong i, ulong n ) {
  if( i >= nacc || n > DATA_MAX || !acc[ i ].touched || !tsdk_is_account_owned_by_current_program( (ushort)i ) ) return 1UL;
  if( n > acc[ i ].meta.data_sz ) memset( acc[ i ].data + acc[ i ].meta.data_sz, 0, n - acc[ i ].meta.data_sz );
  acc[ i ].meta.data_sz = (uint)n;
  return 0UL;
}

static acct_t snap_stack[ 8 ][ ACC_MAX ];

/* Run one program frame. Returns 0 on success, else the revert code (with the
   frame's writes rolled back). */
static ulong
run( ushort prog, void const * ix, ulong sz ) {
  memcpy( snap_stack[ depth ], acc, sizeof( acct_t ) * nacc );
  frames[ depth ].prog = prog;
  depth++;
  if( !setjmp( frames[ depth - 1 ].jb ) ) {
    if(      !memcmp( acc[ prog ].key.key, K_PAD_PROGRAM,  32 ) ) pad_start ( ix, sz );
    else if( !memcmp( acc[ prog ].key.key, K_SWAP_PROGRAM, 32 ) ) swap_start( ix, sz );
    else { exit_code = 0xDEADUL; exit_reverted = 1; }
  }
  depth--;
  if( exit_reverted ) {
    memcpy( acc, snap_stack[ depth ], sizeof( acct_t ) * nacc );
    return exit_code ? exit_code : 0xFFFFUL;
  }
  return 0UL;
}

/* ------------------------------------------------------------ token model */

static int
authorized( ushort owner_of, ushort caller ) {
  uchar const * owner = acc[ owner_of ].data + 32;
  return !memcmp( owner, acc[ payer_idx ].key.key, 32 ) || !memcmp( owner, acc[ caller ].key.key, 32 );
}

static ulong
token_exec( uchar const * ix, ulong sz, ushort caller ) {
  if( sz < 1 ) return 1;
  if( ix[ 0 ] == 0x02 && sz >= 13 ) {
    ushort s, d; ulong amt;
    memcpy( &s, ix + 1, 2 ); memcpy( &d, ix + 3, 2 ); memcpy( &amt, ix + 5, 8 );
    if( s >= nacc || d >= nacc || acc[ s ].meta.data_sz != 73 || acc[ d ].meta.data_sz != 73 ) return 2;
    if( memcmp( acc[ s ].data, acc[ d ].data, 32 ) ) return 3;       /* mint mismatch */
    if( !authorized( s, caller ) ) return 4;
    if( bal( s ) < amt ) return 5;
    set_bal( s, bal( s ) - amt ); set_bal( d, bal( d ) + amt );
    return 0;
  }
  if( ix[ 0 ] == 0x03 && sz >= 15 ) {
    ushort m, d, au; ulong amt, supply;
    memcpy( &m, ix + 1, 2 ); memcpy( &d, ix + 3, 2 ); memcpy( &au, ix + 5, 2 ); memcpy( &amt, ix + 7, 8 );
    if( m >= nacc || d >= nacc || au >= nacc ) return 2;
    if( memcmp( acc[ m ].data + 41, acc[ au ].key.key, 32 ) ) return 4;
    if( au != payer_idx && au != caller ) return 4;
    memcpy( &supply, acc[ m ].data + 1, 8 ); supply += amt; memcpy( acc[ m ].data + 1, &supply, 8 );
    set_bal( d, bal( d ) + amt );
    return 0;
  }
  return 9;
}

ulong
tsys_invoke( void const * ix, ulong sz, ushort prog, tsdk_invoke_auth_t const * auth, ulong * err ) {
  (void)auth;
  *err = 0;
  if( prog >= nacc ) return 1UL;
  ushort caller = frames[ depth - 1 ].prog;
  if( !memcmp( acc[ prog ].key.key, token_key, 32 ) ) { *err = token_exec( ix, sz, caller ); return 0UL; }
  if( !memcmp( acc[ prog ].key.key, K_SWAP_PROGRAM, 32 ) || !memcmp( acc[ prog ].key.key, K_PAD_PROGRAM, 32 ) ) {
    *err = run( prog, ix, sz );
    return 0UL;
  }
  return 2UL;
}

/* A whole transaction: one top-level program, all or nothing, then the write
   check. Returns 0 on success or the revert code. */
static ulong
txn( ushort payer, ushort prog, void const * ix, ulong sz ) {
  static acct_t before[ ACC_MAX ];
  memcpy( before, acc, sizeof( acct_t ) * nacc );
  for( ushort i=0; i<nacc; i++ ) acc[ i ].touched = 0;
  payer_idx = payer;
  /* On chain the fee payer IS account 0; programs read the signer there. */
  tn_pubkey_t slot0 = acc[ 0 ].key;
  acc[ 0 ].key = acc[ payer ].key;
  ulong rc = run( prog, ix, sz );
  acc[ 0 ].key = slot0;
  for( ushort i=0; i<nacc; i++ ) {
    if( !memcmp( before[ i ].data, acc[ i ].data, DATA_MAX ) ) continue;
    int token_acct = !memcmp( acc[ i ].meta.owner.key, token_key, 32 );
    if( !token_acct && !acc[ i ].touched ) { printf( "  ILLEGAL WRITE to account %u\n", i ); illegal = 1; }
  }
  return rc;
}

