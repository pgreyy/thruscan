// src/lib/features.js
//
// Build-time feature flags.

/** Creator fee sharing with holders (Update 02, 7b). Off unless the build sets
 *  VITE_FEE_SHARING=true, and it should stay off until the ThruPad program
 *  change in docs/fee-sharing-program.md is deployed. */
export const FEE_SHARING = import.meta.env.VITE_FEE_SHARING === 'true'
