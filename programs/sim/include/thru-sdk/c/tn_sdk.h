/* A stand-in for the Thru C SDK, for running thrupad2.c and thruswap.c as
 * ordinary native code in sim.c. It declares only what those two programs
 * use, with the same names and the same struct layouts as the real SDK
 * (sdks/c/thru-sdk/c/tn_sdk*.h at v0.4.0), and sim.c implements it.
 *
 * It is not the Thru VM. What it models, and how, is spelled out in sim.c. */

#ifndef HEADER_sim_tn_sdk_h
#define HEADER_sim_tn_sdk_h

#include <string.h>

typedef unsigned char  uchar;
typedef unsigned short ushort;
typedef unsigned int   uint;
typedef unsigned long  ulong;

#define FD_STATIC_ASSERT( c, name ) _Static_assert( c, #name )
#define TSDK_ENTRYPOINT_FN
#define TSDK_SUCCESS (0UL)
#define TSDK_LOAD( T, p ) ( __extension__ ({ T v_; memcpy( &v_, (p), sizeof( T ) ); v_; }) )

#define TSDK_TOKEN_PROGRAM_ADDR_BYTES { 0x4c, 0xe2, 0x84, 0x34, 0xa4, 0x60, 0x72, 0x5d, 0xef, 0x3b, 0x4c, 0x95, 0x85, 0xfb, 0x40, 0x4c, 0x36, 0xd7, 0xba, 0x18, 0x16, 0x71, 0xf6, 0x9a, 0xc6, 0xff, 0x71, 0xa4, 0x41, 0x1d, 0x31, 0xd5 }

typedef struct { uchar key[ 32 ]; } tn_pubkey_t;
typedef struct { uchar sig[ 64 ]; } tn_signature_t;

#define TSDK_INVOKE_AUTH_MAGIC (0xC3F7A1D9E5B20846UL)
struct tsdk_invoke_auth {
  ulong  magic;
  ushort auth_cnt;
  ushort deauth_cnt;
  ushort acc_idxs[];
};
typedef struct tsdk_invoke_auth tsdk_invoke_auth_t;

struct __attribute__(( packed )) tsdk_account_meta {
  uchar       version;
  uchar       flags;
  uint        data_sz;
  ulong       seq;
  tn_pubkey_t owner;
  ulong       balance;
  ulong       nonce;
};
typedef struct tsdk_account_meta tsdk_account_meta_t;

typedef struct { ulong slot; } tsdk_block_ctx_t;
typedef struct tsdk_txn tsdk_txn_t;

tsdk_txn_t const *        tsdk_get_txn( void );
ushort                    tsdk_txn_account_cnt( tsdk_txn_t const * txn );
tn_pubkey_t const *       tsdk_txn_get_acct_addrs( tsdk_txn_t const * txn );
tsdk_account_meta_t const * tsdk_get_account_meta( ushort idx );
void *                    tsdk_get_account_data_ptr( ushort idx );
int                       tsdk_account_exists( ushort idx );
int                       tsdk_is_account_idx_valid( ushort idx );
int                       tsdk_is_account_owned_by_current_program( ushort idx );
ushort                    tsdk_get_current_program_acc_idx( void );
tn_pubkey_t const *       tsdk_get_current_program_acc_addr( void );
tsdk_block_ctx_t const *  tsdk_get_current_block_ctx( void );
void __attribute__(( noreturn )) tsdk_revert( ulong code );
void __attribute__(( noreturn )) tsdk_return( ulong code );

#endif
