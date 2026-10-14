/* Syscalls for the stand-in SDK. See tn_sdk.h and sim.c. */

#ifndef HEADER_sim_tn_sdk_syscall_h
#define HEADER_sim_tn_sdk_syscall_h

#include "tn_sdk.h"

ulong tsys_set_account_data_writable( ulong idx );
ulong tsys_account_create( ulong idx, uchar const seed[ 32 ], void const * proof, ulong proof_sz );
ulong tsys_account_resize( ulong idx, ulong new_size );
ulong tsys_invoke( void const * instr_data, ulong instr_data_sz, ushort program_account_idx,
                   tsdk_invoke_auth_t const * auth, ulong * invoke_err_code );

#endif
