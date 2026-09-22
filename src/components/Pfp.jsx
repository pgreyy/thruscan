// src/components/Pfp.jsx
//
// One picture component for the whole site.
//
// Three shapes, and the shape is the information:
//
//   circle    a picture, or the four-square identicon when there is none. The
//             identicon is derived from the address, so everyone has one and
//             nobody has to make a decision before they appear anywhere.
//
//   hexagon   an NFT the person owns, checked against the collection at the
//             moment of drawing. See lib/pfp.js for why that check is done
//             every time rather than stored.
//
// Sizes are passed in pixels rather than chosen from a set, because the same
// picture appears at 22 pixels in a leaderboard row and 112 on a profile, and
// anything in between is fair game.

import { useEffect, useMemo, useState } from 'react'
import { toSvg } from '../lib/pals/art.js'
import { pfpForName, EMPTY_PFP } from '../lib/pfp.js'

/** Four squares from the address. Deterministic, so it is the same everywhere. */
export function Identicon({ address, size = 40 }) {
  const cells = useMemo(() => {
    let h = 0
    for (let i = 0; i < (address?.length ?? 0); i++) h = (h * 31 + address.charCodeAt(i)) >>> 0
    return [0, 1, 2, 3].map((i) => `hsl(${(h >> (i * 7)) % 360} 62% 55%)`)
  }, [address])

  return (
    <span className="pfp-cells" aria-hidden="true" style={{ width: size, height: size }}>
      {cells.map((c, i) => <span key={i} style={{ background: c }} />)}
    </span>
  )
}

/**
 * Draw a resolved picture. `pfp` comes from lib/pfp.js; passing nothing is the
 * normal case while a page is still loading and gets the identicon, so rows do
 * not jump about when the answer arrives.
 */
export function Pfp({ pfp, address, size = 40, className = '', title }) {
  const [broken, setBroken] = useState(false)
  const kind = pfp?.kind ?? 'none'
  useEffect(() => { setBroken(false) }, [pfp?.url])

  const art = useMemo(
    () => (kind === 'nft' && pfp?.pal ? toSvg(pfp.pal.grid, size) : null),
    [kind, pfp?.pal, size],
  )

  const label = title ?? (kind === 'nft' ? `Pixel Pal #${pfp.num}, owned by this wallet` : undefined)
  const shape = kind === 'nft' ? 'hex' : 'round'

  return (
    <span
      className={`pfp pfp-${shape} ${className}`}
      style={{ width: size, height: size, flex: `0 0 ${size}px` }}
      title={label}
    >
      {kind === 'nft' && art
        ? <span className="pfp-art" dangerouslySetInnerHTML={{ __html: art }} />
        : kind === 'image' && pfp?.url && !broken
          ? <img src={pfp.url} alt="" onError={() => setBroken(true)} />
          : <Identicon address={address} size={size} />}
    </span>
  )
}

/** Resolve and draw in one go, for lists where only a name is known. */
export function usePfp(name) {
  const [pfp, setPfp] = useState(EMPTY_PFP)
  useEffect(() => {
    let alive = true
    if (!name) { setPfp(EMPTY_PFP); return undefined }
    pfpForName(name).then((p) => { if (alive) setPfp(p) })
    return () => { alive = false }
  }, [name])
  return pfp
}

export function NamePfp({ name, address, size = 40, className = '', title }) {
  const pfp = usePfp(name)
  // Once the name resolves, its owner seeds the identicon, so the same person
  // has the same colours on a leaderboard as on their profile. Until then, and
  // for players with no name, whatever the caller passed does the job.
  return <Pfp pfp={pfp} address={pfp.owner ?? address} size={size} className={className} title={title} />
}

export default Pfp
