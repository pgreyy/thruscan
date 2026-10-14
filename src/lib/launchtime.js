// src/lib/launchtime.js
//
// When a launch happened, worked out one way for every place that shows it.
//
// The registry records the slot a launch started in, but only while it is on
// the curve: once a launch graduates into a pool, thrupad reuses that field for
// the pool id. Ages computed from it then counted from slot 1 or 2, the start
// of the chain, which is why every graduated token showed the same date. So
// the launch time comes from the chain itself: the block of the LAUNCH
// transaction, read once through /api/rpc?action=launchtime and kept.

const known = new Map()      // tokenVault -> ms, once read
const asked = new Set()
const listeners = new Set()

/** Read a launch's time if it has not been read yet. Calls back when it has. */
export function loadLaunchTime(tokenVault) {
  if (!tokenVault || known.has(tokenVault) || asked.has(tokenVault)) return
  asked.add(tokenVault)
  fetch(`/api/rpc?action=launchtime&tokenVault=${encodeURIComponent(tokenVault)}`)
    .then((r) => r.json())
    .then((j) => {
      if (j?.ok && Number.isFinite(j.time)) {
        known.set(tokenVault, j.time)
        listeners.forEach((fn) => fn())
      } else {
        asked.delete(tokenVault)   // partial or unknown: try again later
      }
    })
    .catch(() => { asked.delete(tokenVault) })
}

export function onLaunchTime(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const launchTimes = () => known

/**
 * How long ago a launch happened, in ms, or null when it cannot be said yet.
 *
 * The LAUNCH transaction's time when it has been read. Before that, for a
 * launch still on the curve, its start slot against the chain's block time,
 * which is right for a live launch. A pooled launch's start slot is its pool
 * id, so it gets null (shown as "–") rather than the date the chain began.
 */
export function launchAgeMs(l, { overview, times = known, now = Date.now() } = {}) {
  const t = times?.get?.(l.tokenVault) ?? null
  if (Number.isFinite(t)) return Math.max(0, now - t)
  if (l.pooled || l.state === 3) return null
  if (!overview?.finalized || !overview?.blockTimeMs || !l.startSlot) return null
  return Math.max(0, Number(overview.finalized) - Number(l.startSlot)) * overview.blockTimeMs
}
