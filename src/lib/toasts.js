// src/lib/toasts.js
//
// Raise a toast from anywhere. The shell's ToastHost listens for this event,
// so a page does not need to sit under a React context to say something
// happened, and a transaction that lands after its dialog was closed can still
// say so.
//
//   toast({ kind: 'confirmed', title: 'Swap confirmed', sub: '…', signature })
//
// kind: 'submitted' | 'confirmed' | 'failed' | 'rejected'

export function toast(detail) {
  window.dispatchEvent(new CustomEvent('thruscan-toast', { detail }))
}

export function onToast(fn) {
  const on = (e) => fn(e.detail)
  window.addEventListener('thruscan-toast', on)
  return () => window.removeEventListener('thruscan-toast', on)
}
