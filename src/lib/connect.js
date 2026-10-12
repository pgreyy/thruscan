// src/lib/connect.js
//
// Open the wallet menu in the bar from anywhere on the page: the two ways in
// when there is no wallet, the unlock prompt when there is a locked one. There
// is one place a wallet is chosen, and every "Connect wallet" button leads to
// it.

export function connectWallet() {
  window.scrollTo({ top: 0 })
  window.dispatchEvent(new Event('thruscan-connect'))
}
