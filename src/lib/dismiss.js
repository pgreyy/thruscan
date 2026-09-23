// src/lib/dismiss.js
//
// One rule for every menu on the site: a click anywhere else closes it, and so
// does Escape.
//
// This existed three times, slightly differently, and the fourth menu did not
// have it at all. A menu that only closes by pressing the thing that opened it
// is a trap, and it is worse on a phone, where that thing is now under a thumb.
// Rather than remember to add the handler each time, every menu takes it from
// here.
//
//   const box = useRef(null)
//   useDismiss(box, open, () => setOpen(false))
//   ...
//   <div ref={box}>…</div>
//
// The listener is on mousedown rather than click, so a menu closes as the press
// lands rather than when it is released; and it is in the capture phase, so a
// page that stops propagation on its own elements cannot swallow it.
//
// `box` may hold either one element or an array of them, because a menu that is
// drawn somewhere else in the document (a portal, or a summary and a panel that
// are siblings) is still one menu as far as this is concerned.

import { useEffect } from 'react'

const inside = (ref, target) => {
  const boxes = Array.isArray(ref.current) ? ref.current : [ref.current]
  return boxes.some((el) => el && el.contains(target))
}

export function useDismiss(ref, open, onClose) {
  useEffect(() => {
    if (!open) return undefined
    const away = (e) => { if (!inside(ref, e.target)) onClose() }
    const key = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', away, true)
    document.addEventListener('touchstart', away, true)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('touchstart', away, true)
      document.removeEventListener('keydown', key)
    }
  }, [ref, open, onClose])
}

/**
 * The same, for a native <details> menu, which has no state of its own.
 *
 * <details> is the right element for a disclosure: it is keyboard accessible
 * and works before React has hydrated. What it does not do is close when you
 * look somewhere else, because the element has no idea anywhere else exists.
 */
export function useDismissDetails(ref) {
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const close = () => { if (el.open) el.open = false }
    const away = (e) => { if (!el.contains(e.target)) close() }
    const key = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', away, true)
    document.addEventListener('touchstart', away, true)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('touchstart', away, true)
      document.removeEventListener('keydown', key)
    }
  }, [ref])
}
