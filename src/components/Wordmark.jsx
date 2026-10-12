// src/components/Wordmark.jsx
//
// The ThruScan mark, "Passage": a rounded block with a T-shaped channel cut
// through it and out of the bottom edge. The tile and channel colours come from
// --brand-tile and --brand-channel, so the tile turns light on a dark theme on
// its own. Never rotate it, close the channel at the base, outline it, or put a
// status colour in the channel.
//
// At 16px and below the small cut is used: a wider channel and a tighter
// radius, so the amber stays at least three pixels wide.

export function Symbol({ size = 24, className }) {
  const small = size <= 16
  return (
    <svg
      className={className} width={size} height={size} viewBox="0 0 32 32"
      aria-hidden="true" focusable="false" style={{ flex: 'none', display: 'block' }}
    >
      <rect width="32" height="32" rx={small ? 6 : 7} fill="var(--brand-tile)" />
      <path d={small ? 'M5 7H27V14H19.5V32H12.5V14H5Z' : 'M6 8H26V14H19V32H13V14H6Z'} fill="var(--brand-channel)" />
    </svg>
  )
}

/** Symbol plus "ThruScan". The symbol is about 1.1x the wordmark's cap box:
 *  the header lockup is a 24px symbol beside an 18px wordmark, 8px apart. */
export function Wordmark({ size = 'md' }) {
  return (
    <span className={`wordmark wordmark-${size}`}>
      <Symbol size={size === 'lg' ? 34 : 24} />
      <span className="wordmark-name">ThruScan</span>
    </span>
  )
}

export default Wordmark
