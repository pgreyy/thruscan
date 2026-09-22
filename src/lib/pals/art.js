// src/lib/pals/art.js
//
// Pixel Pals: the art. A pure function of (Pal number, the wallet that minted
// it), so the same Pal always draws the same way, on the site, in the wallet,
// and in the metadata the chain points at.
//
// Why the minting wallet is part of the seed: mints are numbered in order, so
// if the art depended on the number alone anyone could look ahead, see which
// number is a legendary, and time their mint for it. Tying it to the wallet
// that actually minted means nobody knows what they will get until they have
// it, and the wallet list is capped per IP, so grinding wallets does not help.
//
// Every Pal is also checked for being unique: its exact pixels are compared
// with every Pal minted before it, and on a match it is redrawn with the next
// variation. Earlier Pals never change, because the check only looks back.
//
// Nothing here uses the DOM, so the same file runs in the browser and in the
// serverless API.

export const GRID = 24

// ------------------------------------------------------------ randomness

function hash32(str) {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  h ^= h >>> 16
  return h >>> 0
}

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (r, list) => list[Math.floor(r() * list.length)]

/** Weighted pick from [[value, weight], ...]. */
function weighted(r, list) {
  const total = list.reduce((n, [, w]) => n + w, 0)
  let x = r() * total
  for (const [v, w] of list) { if ((x -= w) < 0) return v }
  return list[list.length - 1][0]
}

// --------------------------------------------------------------- colour

function hexOf(h, s, l) {
  s /= 100; l /= 100
  const k = (n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')
}

/** A body colour family: light, base, shade, outline. */
function family(h, s, l) {
  return {
    light: hexOf(h, s, Math.min(92, l + 16)),
    base: hexOf(h, s, l),
    shade: hexOf(h + 8, Math.min(100, s + 6), Math.max(8, l - 16)),
    line: hexOf(h + 10, Math.min(100, s * 0.7), Math.max(6, l * 0.28)),
  }
}

const HUE_NAMES = [
  'Cherry', 'Coral', 'Tangerine', 'Amber', 'Honey', 'Lemon', 'Lime', 'Moss', 'Clover', 'Mint',
  'Jade', 'Teal', 'Lagoon', 'Sky', 'Denim', 'Cobalt', 'Indigo', 'Violet', 'Grape', 'Orchid',
  'Magenta', 'Bubblegum', 'Rose', 'Ruby',
]

const SPECIAL_SKINS = {
  Gold: { light: '#fff2a8', base: '#f2c230', shade: '#c28a12', line: '#5a3a06' },
  Silver: { light: '#ffffff', base: '#cfd6de', shade: '#8e98a6', line: '#2e343d' },
  Void: { light: '#3a3d48', base: '#1e2027', shade: '#101116', line: '#000000' },
  Ghost: { light: '#ffffff', base: '#eef1f7', shade: '#c9cfdc', line: '#8c93a6' },
  Lava: { light: '#ffd166', base: '#ff5e1a', shade: '#b0220c', line: '#3a0a02' },
}

// ------------------------------------------------------------ traits

const BODIES = [['Blob', 18], ['Tall', 12], ['Wide', 12], ['Pear', 12], ['Bean', 10], ['Box', 10], ['Drop', 9], ['Mushroom', 7], ['Twin', 4], ['Long', 6]]
const EARS = [['None', 16], ['Cat', 12], ['Bunny', 9], ['Bear', 11], ['Antenna', 10], ['Horns', 8], ['Sprout', 8], ['Spikes', 7], ['Fins', 6], ['Unicorn', 3], ['Antlers', 3], ['Flame', 2]]
const EYES = [['Dots', 16], ['Big', 16], ['Round', 14], ['Sleepy', 9], ['Wink', 7], ['Cyclops', 7], ['Three', 4], ['Visor', 5], ['Angry', 7], ['Heart', 3], ['Star', 3], ['X', 2], ['Laser', 1]]
const MOUTHS = [['Smile', 18], ['Flat', 10], ['Oh', 10], ['Fang', 10], ['Fangs', 6], ['Tongue', 9], ['Grin', 8], ['Beak', 7], ['Frown', 6], ['Whiskers', 6], ['Zigzag', 5], ['Gold tooth', 2]]
const PATTERNS = [['Plain', 30], ['Belly', 22], ['Spots', 12], ['Stripes', 11], ['Patch', 8], ['Freckles', 9], ['Split', 5], ['Checker', 3]]
const HATS = [['None', 46], ['Beanie', 8], ['Cap', 8], ['Party', 7], ['Bow', 6], ['Flower', 6], ['Top hat', 5], ['Headphones', 5], ['Bandana', 5], ['Crown', 2], ['Halo', 2], ['Wizard', 2]]
const FACEWEAR = [['None', 70], ['Glasses', 9], ['Shades', 9], ['Monocle', 4], ['Blush', 14], ['Band-aid', 4], ['Mask', 3]]
const LIMBS = [['Feet', 34], ['Arms and feet', 30], ['Waving', 12], ['Nubs', 12], ['Tail', 8], ['Wings', 4]]
const SKY = [['Plain', 28], ['Dots', 14], ['Grid', 10], ['Stripes', 10], ['Ground', 16], ['Stars', 10], ['Sunburst', 8], ['Night', 4]]
const SKINS = [['Hue', 1880], ['Gold', 20], ['Silver', 30], ['Void', 25], ['Ghost', 25], ['Lava', 20], ['Rainbow', 10]]

// A barcode on the Pal. Some are just decoration. Read them anyway.
const BARCODE_ODDS = 0.06

// --------------------------------------------------------------- canvas

function blank() {
  return Array.from({ length: GRID }, () => Array(GRID).fill(null))
}

const inside = (x, y) => x >= 0 && y >= 0 && x < GRID && y < GRID

function set(g, x, y, c) { if (inside(x, y)) g[y][x] = c }

/** Set a pixel and its mirror across the vertical centre line. */
function mset(g, x, y, c) { set(g, x, y, c); set(g, GRID - 1 - x, y, c) }

// ----------------------------------------------------------- silhouette

/**
 * The body as a boolean mask. Built on the left half and mirrored, then
 * roughened slightly at the edge so no two blobs are exactly alike.
 */
function silhouette(r, kind) {
  const m = Array.from({ length: GRID }, () => Array(GRID).fill(false))
  const cx = GRID / 2 - 0.5
  const fillEllipse = (ex, ey, rx, ry) => {
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      const dx = (x - ex) / rx, dy = (y - ey) / ry
      if (dx * dx + dy * dy <= 1) m[y][x] = true
    }
  }
  const fillRect = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inside(x, y)) m[y][x] = true }

  const top = 7 + Math.floor(r() * 3)            // where the head starts
  const bottom = 19 + Math.floor(r() * 2)        // where the body ends
  const h = bottom - top
  if (kind === 'Blob') fillEllipse(cx, top + h / 2, 5.2 + r() * 1.6, h / 2 + 0.4)
  if (kind === 'Tall') fillEllipse(cx, top + h / 2 - 1, 3.8 + r() * 0.9, h / 2 + 1.4)
  if (kind === 'Wide') fillEllipse(cx, top + h / 2 + 1, 7 + r() * 1.3, h / 2 - 0.6)
  if (kind === 'Long') { fillEllipse(cx, top + 3, 4.2, 3.4); fillRect(Math.round(cx - 3), top + 3, Math.round(cx + 3), bottom) }
  if (kind === 'Pear') {
    for (let y = top; y <= bottom; y++) {
      const t = (y - top) / h
      const w = 2.6 + t * (4.2 + r() * 0.3) - (t > 0.9 ? (t - 0.9) * 14 : 0)
      for (let x = 0; x < GRID; x++) if (Math.abs(x - cx) <= w) m[y][x] = true
    }
  }
  if (kind === 'Bean') { fillEllipse(cx, top + h * 0.34, 4.4, h * 0.36); fillEllipse(cx, top + h * 0.7, 5.8 + r(), h * 0.36) }
  if (kind === 'Box') {
    fillRect(Math.round(cx - 5), top, Math.round(cx + 5), bottom)
    for (const [x, y] of [[cx - 5, top], [cx + 5, top], [cx - 5, bottom], [cx + 5, bottom]]) m[y][Math.round(x)] = false
  }
  if (kind === 'Drop') {
    for (let y = top - 2; y <= bottom; y++) {
      const t = (y - (top - 2)) / (h + 2)
      const w = t < 0.55 ? t * 11 : 6 * Math.sqrt(Math.max(0, 1 - ((t - 0.55) / 0.47) ** 2)) + 0.4
      for (let x = 0; x < GRID; x++) if (Math.abs(x - cx) <= w) m[y][x] = true
    }
  }
  if (kind === 'Mushroom') { fillEllipse(cx, top + 2.5, 7.2, 3.8); fillRect(Math.round(cx - 3), top + 4, Math.round(cx + 3), bottom) }
  if (kind === 'Twin') { fillEllipse(cx - 3.2, top + h / 2, 3.6, h / 2); fillEllipse(cx + 3.2, top + h / 2, 3.6, h / 2) }

  // Roughen: nibble or grow a few edge pixels on the left, mirror to the right.
  for (let i = 0; i < 5; i++) {
    const y = top + 1 + Math.floor(r() * (h - 1))
    let x = 0
    while (x < GRID / 2 && !m[y][x]) x++
    if (x >= GRID / 2 - 1) continue
    if (r() < 0.5) m[y][x] = false
    else if (x > 1) m[y][x - 1] = true
  }
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID / 2; x++) m[y][GRID - 1 - x] = m[y][x]
  return { m, top, bottom }
}

function bounds(m) {
  let top = GRID, bottom = -1
  const rows = []
  for (let y = 0; y < GRID; y++) {
    let l = -1, rr = -1
    for (let x = 0; x < GRID; x++) if (m[y][x]) { if (l < 0) l = x; rr = x }
    rows[y] = l < 0 ? null : [l, rr]
    if (l >= 0) { top = Math.min(top, y); bottom = Math.max(bottom, y) }
  }
  return { top, bottom, rows }
}

// ---------------------------------------------------------------- draw

function drawSky(g, r, kind, bg) {
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) g[y][x] = bg.base
  if (kind === 'Dots') for (let y = 1; y < GRID; y += 4) for (let x = (y % 8 === 1 ? 1 : 3); x < GRID; x += 4) g[y][x] = bg.soft
  if (kind === 'Grid') for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) if (x % 6 === 0 || y % 6 === 0) g[y][x] = bg.soft
  if (kind === 'Stripes') for (let y = 0; y < GRID; y++) if (Math.floor(y / 3) % 2) for (let x = 0; x < GRID; x++) g[y][x] = bg.soft
  if (kind === 'Ground') for (let y = 20; y < GRID; y++) for (let x = 0; x < GRID; x++) g[y][x] = y === 20 ? bg.deep : bg.soft
  if (kind === 'Stars') for (let i = 0; i < 12; i++) { const x = Math.floor(r() * GRID), y = Math.floor(r() * GRID); g[y][x] = bg.deep }
  if (kind === 'Sunburst') {
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      const a = Math.atan2(y - 13, x - 11.5)
      if (Math.floor((a + Math.PI) / (Math.PI / 8)) % 2) g[y][x] = bg.soft
    }
  }
  if (kind === 'Night') {
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) g[y][x] = '#141726'
    for (let i = 0; i < 16; i++) g[Math.floor(r() * GRID)][Math.floor(r() * GRID)] = '#f5f1d0'
    for (const [x, y] of [[19, 2], [20, 2], [18, 3], [19, 3], [18, 4], [19, 4], [19, 5], [20, 5]]) g[y][x] = '#f7e38a'
  }
}

function outlineOf(m) {
  const o = Array.from({ length: GRID }, () => Array(GRID).fill(false))
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
    if (m[y][x]) continue
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy
      if (inside(nx, ny) && m[ny][nx]) { o[y][x] = true; break }
    }
  }
  return o
}

/** Paint a mask onto the grid: outline first, then the body with shading. */
function paintBody(g, m, skin, rainbow, r) {
  const o = outlineOf(m)
  const b = bounds(m)
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
    if (o[y][x]) g[y][x] = rainbow ? rainbow[y].line : skin.line
    if (!m[y][x]) continue
    const s = rainbow ? rainbow[y] : skin
    const belowEmpty = y + 1 >= GRID || !m[y + 1][x]
    const twoBelowEmpty = y + 2 >= GRID || !m[y + 2][x]
    g[y][x] = belowEmpty || twoBelowEmpty ? s.shade : s.base
  }
  // A highlight at the top left, the one thing that is not mirrored, so the
  // light has a direction.
  if (b.top < GRID) {
    const row = b.rows[b.top + 1]
    if (row) {
      const hx = row[0] + 1 + Math.floor(r() * 2), hy = b.top + 1
      const s = rainbow ? rainbow[hy] : skin
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) if (m[hy + dy]?.[hx + dx]) g[hy + dy][hx + dx] = s.light
    }
  }
  return b
}

function drawPattern(g, m, r, kind, skin, b) {
  const cx = GRID / 2
  const on = (x, y) => inside(x, y) && m[y][x] && g[y][x] !== skin.light
  if (kind === 'Belly') {
    const top = b.top + Math.floor((b.bottom - b.top) * 0.5), bot = b.bottom - 1
    for (let y = top; y <= bot; y++) {
      const t = (y - top) / Math.max(1, bot - top)
      const w = Math.round(2 + Math.sin(t * Math.PI) * 1.4)
      for (let x = cx - w; x < cx + w; x++) if (on(x, y)) g[y][x] = skin.light
    }
  }
  if (kind === 'Spots') for (let i = 0; i < 5; i++) {
    const x = Math.floor(r() * GRID / 2), y = b.top + 2 + Math.floor(r() * (b.bottom - b.top - 3))
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (on(x + dx, y + dy)) mset(g, x + dx, y + dy, skin.shade)
  }
  if (kind === 'Stripes') for (let y = b.top + 3; y < b.bottom - 1; y += 3) for (let x = 0; x < GRID; x++) if (on(x, y)) g[y][x] = skin.shade
  if (kind === 'Patch') {
    const x0 = 4 + Math.floor(r() * 4), y0 = b.top + 1
    for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) if (on(x, y)) g[y][x] = skin.shade
  }
  if (kind === 'Freckles') for (let i = 0; i < 4; i++) {
    const x = Math.floor(cx - 5 + r() * 4), y = b.top + 5 + Math.floor(r() * 3)
    if (on(x, y)) mset(g, x, y, skin.shade)
  }
  if (kind === 'Split') for (let y = 0; y < GRID; y++) for (let x = cx; x < GRID; x++) if (on(x, y) && g[y][x] === skin.base) g[y][x] = skin.shade
  if (kind === 'Checker') for (let y = b.top; y <= b.bottom; y++) for (let x = 0; x < GRID; x++) if (on(x, y) && (Math.floor(x / 2) + Math.floor(y / 2)) % 2 && g[y][x] === skin.base) g[y][x] = skin.shade
}

function drawEars(g, r, kind, skin, b, accent) {
  const t = b.top, L = skin.line, B = skin.base, row = b.rows[t + 1] ?? b.rows[t]
  const edge = row ? row[0] : 8
  const ex = Math.max(edge + 1, 7)
  const px = (x, y, c) => mset(g, x, y, c)
  if (kind === 'Cat') { px(ex, t - 1, B); px(ex, t - 2, B); px(ex + 1, t - 1, B); px(ex - 1, t - 1, L); px(ex - 1, t - 2, L); px(ex, t - 3, L); px(ex + 1, t - 2, L); px(ex + 2, t - 1, L) }
  if (kind === 'Bunny') for (let y = t - 6; y < t; y++) { px(ex, y, B); px(ex + 1, y, y > t - 5 ? accent : B); px(ex - 1, y, L); px(ex + 2, y, L); if (y === t - 6) { px(ex, y - 1, L); px(ex + 1, y - 1, L) } }
  if (kind === 'Bear') { for (const [dx, dy] of [[0, -1], [1, -1], [0, -2], [1, -2]]) px(ex - 1 + dx, t + dy, B); for (const [dx, dy] of [[-1, -1], [-1, -2], [0, -3], [1, -3], [2, -2]]) px(ex - 1 + dx, t + dy, L) }
  if (kind === 'Antenna') { for (let y = t - 4; y < t; y++) px(ex + 1, y, L); px(ex, t - 5, accent); px(ex + 1, t - 5, accent); px(ex, t - 6, accent); px(ex + 1, t - 6, accent) }
  if (kind === 'Horns') { px(ex, t - 1, '#f4ead2'); px(ex - 1, t - 2, '#f4ead2'); px(ex - 1, t - 3, '#f4ead2'); px(ex - 2, t - 3, L); px(ex - 2, t - 2, L); px(ex - 1, t - 1, L); px(ex + 1, t - 1, L); px(ex, t - 2, L); px(ex - 1, t - 4, L) }
  if (kind === 'Sprout') { set(g, 11, t - 1, '#3c8f3e'); set(g, 11, t - 2, '#3c8f3e'); set(g, 10, t - 3, '#58c05a'); set(g, 9, t - 3, '#58c05a'); set(g, 12, t - 3, '#58c05a'); set(g, 13, t - 4, '#58c05a'); set(g, 12, t - 4, '#3c8f3e') }
  if (kind === 'Spikes') for (let x = ex; x <= 11; x += 2) { px(x, t - 1, accent); px(x, t - 2, accent); px(x - 1, t - 1, L); px(x + 1, t - 1, L); px(x, t - 3, L) }
  if (kind === 'Fins') { for (let y = t + 2; y < t + 6; y++) { px(edge - 1, y, accent); px(edge - 2, y, L) } px(edge - 1, t + 1, L); px(edge - 1, t + 6, L) }
  if (kind === 'Unicorn') { const c = ['#ffe07a', '#ff9ecf', '#9fd8ff', '#ffe07a']; for (let i = 0; i < 4; i++) { set(g, 11, t - 1 - i, c[i]); set(g, 12, t - 1 - i, i < 3 ? c[i] : L) } set(g, 11, t - 5, L); set(g, 10, t - 2, L); set(g, 13, t - 2, L) }
  if (kind === 'Antlers') { const c = '#b98b58'; for (let y = t - 5; y < t; y++) px(ex, y, c); px(ex - 1, t - 3, c); px(ex - 2, t - 4, c); px(ex + 1, t - 4, c); px(ex + 2, t - 5, c) }
  if (kind === 'Flame') { const c = ['#ff3b1f', '#ff8a1f', '#ffd23f']; for (let i = 0; i < 5; i++) for (let x = 9 + (i > 2 ? 1 : 0); x <= 14 - (i > 2 ? 1 : 0); x++) if ((x + i) % 3 !== 2 || i < 2) set(g, x, t - 1 - i, c[Math.min(2, Math.floor(i / 2))]) }
}

function drawEyes(g, r, kind, skin, eyeY, gap) {
  const ink = skin === SPECIAL_SKINS.Void ? '#ffffff' : '#16181d'
  const white = '#ffffff'
  const L = 11 - gap, R = 12 + gap
  const both = (fn) => { fn(L, 1); fn(R, -1) }
  if (kind === 'Dots') both((x) => set(g, x, eyeY, ink))
  if (kind === 'Big') both((x, s) => { set(g, x, eyeY, ink); set(g, x, eyeY + 1, ink); set(g, x - s, eyeY, ink); set(g, x - s, eyeY + 1, ink); set(g, x, eyeY, white) })
  if (kind === 'Round') both((x, s) => { for (const [dx, dy] of [[0, -1], [-s, 0], [0, 1], [-s, -1], [-s, 1]]) set(g, x + dx, eyeY + dy, white); set(g, x, eyeY, ink); set(g, x - s, eyeY, ink) })
  if (kind === 'Sleepy') both((x, s) => { set(g, x, eyeY, ink); set(g, x - s, eyeY, ink) })
  if (kind === 'Wink') { set(g, L, eyeY, ink); set(g, L, eyeY + 1, ink); set(g, R, eyeY + 1, ink); set(g, R - 1, eyeY + 1, ink); set(g, R + 1, eyeY, ink) }
  if (kind === 'Angry') both((x, s) => { set(g, x, eyeY, ink); set(g, x, eyeY + 1, ink); set(g, x + s, eyeY - 1, ink); set(g, x, eyeY - 1, ink) })
  if (kind === 'Cyclops') { for (let dx = -1; dx <= 2; dx++) for (let dy = -1; dy <= 1; dy++) set(g, 11 + dx - 0, eyeY + dy, white); set(g, 11, eyeY, ink); set(g, 12, eyeY, ink); set(g, 11, eyeY + 1, ink); set(g, 12, eyeY + 1, ink); set(g, 11, eyeY, white) }
  if (kind === 'Three') { both((x) => set(g, x, eyeY + 1, ink)); set(g, 11, eyeY - 1, ink); set(g, 12, eyeY - 1, ink) }
  if (kind === 'Visor') for (let x = L - 1; x <= R + 1; x++) { set(g, x, eyeY, '#16181d'); set(g, x, eyeY + 1, x % 2 ? '#ff3b5c' : '#16181d') }
  if (kind === 'Heart') both((x, s) => { const c = '#ff3b6b'; set(g, x, eyeY, c); set(g, x - s, eyeY, c); set(g, x, eyeY + 1, c); set(g, x - s, eyeY + 1, c); set(g, x + s, eyeY, c); set(g, x - s, eyeY + 2, c) })
  if (kind === 'Star') both((x) => { const c = '#ffd23f'; set(g, x, eyeY, c); set(g, x, eyeY - 1, c); set(g, x, eyeY + 1, c); set(g, x - 1, eyeY, c); set(g, x + 1, eyeY, c) })
  if (kind === 'X') both((x) => { set(g, x - 1, eyeY - 1, ink); set(g, x + 1, eyeY - 1, ink); set(g, x, eyeY, ink); set(g, x - 1, eyeY + 1, ink); set(g, x + 1, eyeY + 1, ink) })
  if (kind === 'Laser') {
    both((x) => { set(g, x, eyeY, '#ff2d2d'); set(g, x, eyeY + 1, '#ff2d2d') })
    for (let x = R + 1; x < GRID; x++) { set(g, x, eyeY, '#ff2d2d'); if (x % 2) set(g, x, eyeY + 1, '#ff8a8a') }
    for (let x = 0; x < L; x++) { set(g, x, eyeY, '#ff2d2d'); if (x % 2) set(g, x, eyeY + 1, '#ff8a8a') }
  }
}

function drawMouth(g, r, kind, skin, y) {
  const ink = skin === SPECIAL_SKINS.Void ? '#ffffff' : '#16181d'
  const m = (x, c = ink) => mset(g, x, y, c)
  if (kind === 'Smile') { m(10); m(11); set(g, 9, y - 1, ink); set(g, 14, y - 1, ink) }
  if (kind === 'Flat') { m(10); m(11) }
  if (kind === 'Oh') { set(g, 11, y, ink); set(g, 12, y, ink); set(g, 11, y + 1, ink); set(g, 12, y + 1, ink) }
  if (kind === 'Fang') { m(10); m(11); set(g, 10, y + 1, '#ffffff') }
  if (kind === 'Fangs') { m(10); m(11); mset(g, 10, y + 1, '#ffffff') }
  if (kind === 'Tongue') { m(10); m(11); set(g, 11, y + 1, '#ff6f91'); set(g, 12, y + 1, '#ff6f91') }
  if (kind === 'Grin') { for (let x = 9; x <= 14; x++) { set(g, x, y, ink); set(g, x, y + 1, x === 9 || x === 14 ? ink : '#ffffff') } for (let x = 10; x <= 13; x++) set(g, x, y + 2, ink) }
  if (kind === 'Beak') { set(g, 11, y - 1, '#ff9f1c'); set(g, 12, y - 1, '#ff9f1c'); set(g, 11, y, '#e07b00'); set(g, 12, y, '#e07b00') }
  if (kind === 'Frown') { m(10); m(11); set(g, 9, y + 1, ink); set(g, 14, y + 1, ink) }
  if (kind === 'Whiskers') { set(g, 11, y, ink); set(g, 12, y, ink); mset(g, 7, y - 1, ink); mset(g, 8, y - 1, ink); mset(g, 7, y + 1, ink); mset(g, 8, y + 1, ink) }
  if (kind === 'Zigzag') { for (let x = 9; x <= 14; x++) set(g, x, y + (x % 2), ink) }
  if (kind === 'Gold tooth') { for (let x = 9; x <= 14; x++) set(g, x, y, ink); set(g, 12, y + 1, '#f2c230'); set(g, 11, y + 1, '#ffffff') }
}

function drawHat(g, r, kind, b, accent, line) {
  const t = b.top
  const row = b.rows[t] ?? [9, 14]
  const x0 = Math.max(row[0] - 1, 4), x1 = Math.min(row[1] + 1, 19)
  const band = (y, c, a = x0, z = x1) => { for (let x = a; x <= z; x++) set(g, x, y, c) }
  if (kind === 'Beanie') { band(t - 1, accent); band(t - 2, accent, x0 + 1, x1 - 1); band(t - 3, accent, x0 + 2, x1 - 2); set(g, 11, t - 4, '#ffffff'); set(g, 12, t - 4, '#ffffff'); for (let x = x0; x <= x1; x += 2) set(g, x, t - 1, line) }
  if (kind === 'Cap') { band(t - 1, accent, x0 + 1, x1 - 1); band(t - 2, accent, x0 + 2, x1 - 2); band(t - 1, line, x1 - 1, Math.min(22, x1 + 3)) }
  if (kind === 'Party') { for (let i = 0; i < 5; i++) band(t - 1 - i, i % 2 ? '#ffffff' : accent, 11 - Math.max(0, 2 - Math.floor(i / 2)), 12 + Math.max(0, 2 - Math.floor(i / 2))); set(g, 11, t - 6, '#ffd23f'); set(g, 12, t - 6, '#ffd23f') }
  if (kind === 'Bow') { for (const [x, y] of [[8, 0], [9, 0], [8, 1], [9, 1], [10, 0], [11, 0], [12, 0], [13, 0], [14, 0], [14, 1], [15, 0], [15, 1]]) set(g, x, t - 1 - y, x === 11 || x === 12 ? line : accent) }
  if (kind === 'Flower') { const c = pick(r, ['#ff6f91', '#ffd23f', '#ffffff', '#b28dff']); for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) set(g, 15 + dx, t - 1 + dy, c); set(g, 15, t - 1, '#ffb400') }
  if (kind === 'Top hat') { band(t - 1, '#16181d', x0, x1); for (let y = t - 6; y < t - 1; y++) band(y, y === t - 3 ? accent : '#16181d', x0 + 2, x1 - 2) }
  if (kind === 'Headphones') { band(t - 1, '#2b2d42', x0 + 1, x1 - 1); for (let y = t; y < t + 4; y++) { set(g, x0 - 1, y + 2, accent); set(g, x0, y + 2, accent); set(g, x1, y + 2, accent); set(g, x1 + 1, y + 2, accent) } }
  if (kind === 'Bandana') { band(t + 1, accent, x0, x1); for (let x = x0; x <= x1; x += 3) set(g, x, t + 1, '#ffffff'); set(g, x1 + 1, t + 2, accent); set(g, x1 + 2, t + 3, accent) }
  if (kind === 'Crown') { band(t - 1, '#f2c230', 8, 15); for (const x of [8, 11, 12, 15]) set(g, x, t - 2, '#f2c230'); for (const x of [8, 15]) set(g, x, t - 3, '#f2c230'); set(g, 10, t - 1, '#e8553d'); set(g, 13, t - 1, '#2f6fdd'); band(t, '#c28a12', 8, 15) }
  if (kind === 'Halo') { band(t - 3, '#ffe066', 8, 15); set(g, 7, t - 2, '#ffe066'); set(g, 16, t - 2, '#ffe066') }
  if (kind === 'Wizard') { for (let i = 0; i < 7; i++) band(t - 1 - i, '#3d3b8e', 11 - Math.max(0, 4 - i), 12 + Math.max(0, 4 - i) - (i > 4 ? 1 : 0)); set(g, 10, t - 3, '#ffd23f'); set(g, 13, t - 5, '#ffd23f'); set(g, 12, t - 2, '#ffd23f') }
}

function drawFace(g, kind, eyeY, gap, cheekY) {
  const L = 11 - gap, R = 12 + gap
  if (kind === 'Glasses') { for (const x of [L, R]) for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) set(g, x + dx, eyeY + dy, '#16181d'); for (let x = L + 2; x < R - 1; x++) set(g, x, eyeY - 1, '#16181d') }
  if (kind === 'Shades') { for (let x = L - 1; x <= R + 1; x++) { set(g, x, eyeY, '#101114'); set(g, x, eyeY - 1, '#101114'); if (x !== 11 && x !== 12) set(g, x, eyeY + 1, '#101114') } set(g, L - 1, eyeY - 1, '#6d7489'); set(g, R - 1, eyeY - 1, '#6d7489') }
  if (kind === 'Monocle') { for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) set(g, R + dx, eyeY + dy, '#f2c230'); for (let y = eyeY + 2; y < eyeY + 6; y++) set(g, R + 1, y, '#f2c230') }
  if (kind === 'Blush') { mset(g, L - 1, cheekY, '#ff8fab'); mset(g, L - 2, cheekY, '#ff8fab') }
  if (kind === 'Band-aid') { set(g, R, cheekY, '#f1c27d'); set(g, R + 1, cheekY, '#e0a96d'); set(g, R + 2, cheekY, '#f1c27d') }
  if (kind === 'Mask') { for (let x = L - 1; x <= R + 1; x++) { set(g, x, cheekY, '#e9ecf2'); set(g, x, cheekY + 1, '#e9ecf2'); set(g, x, cheekY + 2, x === L - 1 || x === R + 1 ? null : '#e9ecf2') } set(g, L - 2, cheekY, '#9aa3b5'); set(g, R + 2, cheekY, '#9aa3b5') }
}

function drawLimbs(g, r, kind, skin, b) {
  const L = skin.line, B = skin.base
  const feetY = b.bottom + 1
  const rowMid = b.rows[b.top + Math.floor((b.bottom - b.top) * 0.62)] ?? [6, 17]
  const armY = b.top + Math.floor((b.bottom - b.top) * 0.62)
  const feet = () => { for (const x of [8, 9]) { mset(g, x, feetY, L); mset(g, x, feetY - 1, skin.shade) } }
  if (kind === 'Feet' || kind === 'Arms and feet') feet()
  if (kind === 'Arms and feet' || kind === 'Nubs') { mset(g, rowMid[0] - 1, armY, B); mset(g, rowMid[0] - 2, armY, L); mset(g, rowMid[0] - 1, armY - 1, L); mset(g, rowMid[0] - 1, armY + 1, L) }
  if (kind === 'Waving') {
    feet()
    const x = rowMid[0] - 1
    set(g, x, armY, B); set(g, x - 1, armY - 1, B); set(g, x - 2, armY - 2, B); set(g, x - 2, armY - 3, B)
    set(g, x - 3, armY - 3, L); set(g, x - 2, armY - 4, L); set(g, x - 1, armY - 3, L); set(g, x - 3, armY - 2, L)
    const xr = GRID - 1 - x
    set(g, xr, armY, B); set(g, xr + 1, armY, L); set(g, xr, armY + 1, L)
  }
  if (kind === 'Tail') { feet(); const y = b.bottom - 2, x = (b.rows[y] ?? [5, 18])[1] + 1; for (let i = 0; i < 4; i++) set(g, x + i, y - i, i === 3 ? skin.light : B); set(g, x + 4, y - 4, L) }
  if (kind === 'Wings') { feet(); const x = rowMid[0] - 1, y = armY - 3; for (const [dx, dy] of [[0, 0], [-1, 0], [-2, -1], [-1, -1], [-3, -2], [-2, -2], [-1, 1]]) mset(g, x + dx, y + dy, '#ffffff'); mset(g, x - 4, y - 2, '#c9cfdc'); mset(g, x - 3, y - 3, '#c9cfdc') }
}

/** A little label in the bottom corner, eight bars wide. Some mean something. */
function drawBarcode(g, bits) {
  for (let x = 15; x < GRID; x++) for (let y = 21; y < GRID; y++) set(g, x, y, '#ffffff')
  for (let i = 0; i < 8; i++) {
    const on = (bits >> (7 - i)) & 1
    set(g, 16 + i, 22, '#16181d')
    set(g, 16 + i, 23, on ? '#16181d' : '#ffffff')
  }
}

// ---------------------------------------------------------------- Pal

function build(seedText, force = null) {
  const r = rng(hash32(seedText))

  const skinKind = force?.skin ?? weighted(r, SKINS)
  let skin, colour
  let rainbow = null
  const hueIdx = Math.floor(r() * HUE_NAMES.length)
  const hue = hueIdx * 15 + r() * 8
  if (skinKind === 'Hue') {
    const sat = 55 + r() * 35, lig = 52 + r() * 14
    skin = family(hue, sat, lig)
    colour = (sat < 65 ? 'Dusty ' : lig > 60 ? 'Pastel ' : '') + HUE_NAMES[hueIdx]
  } else if (skinKind === 'Rainbow') {
    skin = family(0, 80, 60)
    rainbow = Array.from({ length: GRID }, (_, y) => family(y * 17 + hue, 80, 60))
    colour = 'Rainbow'
  } else {
    skin = SPECIAL_SKINS[skinKind]
    colour = skinKind
  }

  const bgHue = hue + 150 + r() * 60
  const bg = { base: hexOf(bgHue, 40 + r() * 30, 86 + r() * 6), soft: hexOf(bgHue, 45, 78), deep: hexOf(bgHue, 45, 62) }
  const accent = hexOf(hue + 180 + (r() - 0.5) * 60, 75, 55)

  const traits = {
    Body: weighted(r, BODIES),
    Colour: colour,
    Pattern: weighted(r, PATTERNS),
    Top: weighted(r, EARS),
    Eyes: weighted(r, EYES),
    Mouth: weighted(r, MOUTHS),
    Headwear: weighted(r, HATS),
    Face: weighted(r, FACEWEAR),
    Limbs: weighted(r, LIMBS),
    Background: weighted(r, SKY),
  }
  if (force?.traits) Object.assign(traits, force.traits)
  // Headwear sits where the ears would; one or the other.
  if (traits.Headwear !== 'None' && traits.Headwear !== 'Headphones' && traits.Headwear !== 'Bandana' && traits.Top !== 'Fins') traits.Top = 'None'
  if (traits.Eyes === 'Visor' || traits.Eyes === 'Laser') { if (['Glasses', 'Shades', 'Monocle'].includes(traits.Face)) traits.Face = 'None' }
  const barcode = r() < BARCODE_ODDS ? 1 + Math.floor(r() * 254) : 0

  const g = blank()
  drawSky(g, r, traits.Background, bg)
  const { m } = silhouette(r, traits.Body)
  const b = paintBody(g, m, skin, rainbow, r)
  if (skinKind === 'Hue' || skinKind === 'Rainbow') drawPattern(g, m, r, traits.Pattern, rainbow ? rainbow[14] : skin, b)
  else traits.Pattern = 'Plain'
  drawLimbs(g, r, traits.Limbs, skin, b)
  drawEars(g, r, traits.Top, skin, b, accent)

  const faceH = Math.min(6, b.bottom - b.top - 4)
  const eyeY = b.top + 2 + Math.floor(r() * 2) + (traits.Body === 'Mushroom' ? 3 : 0)
  const rowAtEyes = b.rows[eyeY] ?? [7, 16]
  const maxGap = Math.max(1, Math.min(4, 11 - rowAtEyes[0] - 2))
  const gap = Math.max(1, Math.min(maxGap, 1 + Math.floor(r() * 3)))
  drawEyes(g, r, traits.Eyes, skin, eyeY, gap)
  const mouthY = Math.min(eyeY + 3 + Math.floor(r() * 2), b.top + 2 + faceH + 1)
  drawMouth(g, r, traits.Mouth, skin, mouthY)
  drawFace(g, traits.Face, eyeY, gap, mouthY - 1)
  drawHat(g, r, traits.Headwear, b, accent, skin.line)
  if (barcode) drawBarcode(g, barcode)

  return { grid: g, traits, barcode }
}

// ------------------------------------------------------------- rarity

const RARE = {
  Colour: ['Gold', 'Silver', 'Void', 'Ghost', 'Lava', 'Rainbow'],
  Top: ['Unicorn', 'Antlers', 'Flame'],
  Eyes: ['Heart', 'Star', 'X', 'Laser'],
  Mouth: ['Gold tooth'],
  Headwear: ['Crown', 'Halo', 'Wizard'],
  Background: ['Night'],
  Limbs: ['Wings'],
  Pattern: ['Checker'],
}

export function rarityOf(traits) {
  let n = 0
  for (const [k, list] of Object.entries(RARE)) if (list.includes(traits[k])) n++
  if (traits.Colour === 'Rainbow' || traits.Colour === 'Gold') n++
  return ['Common', 'Uncommon', 'Rare', 'Epic'][n] ?? 'Legendary'
}

// --------------------------------------------------------------- output

const signature = (grid) => grid.map((row) => row.map((c) => c ?? '-').join(',')).join('|')

/**
 * The Pal for a number and its minting wallet. `taken` is the set of
 * signatures of every Pal minted before this one, used to guarantee no two
 * Pals are pixel-identical. Returns { grid, traits, barcode, signature }.
 */
/**
 * The one Genesis Pal: a 1 of 1 that outranks every other Pal. It exists only
 * at this number AND only if that number went to the reserve wallet, which
 * the program guarantees by never selling a reserved number.
 */
export const GENESIS = { id: 1945, wallet: 'tagWn12LBr2e9FLpclutAjsHqLmoKKaf2pEnYPG9czijFX' }
const GENESIS_LOOK = {
  skin: 'Rainbow',
  traits: { Body: 'Blob', Pattern: 'Plain', Top: 'None', Eyes: 'Star', Mouth: 'Gold tooth', Headwear: 'Crown', Face: 'None', Limbs: 'Wings', Background: 'Night' },
}

export function palFor(id, minter, taken = null) {
  const genesis = id === GENESIS.id && minter === GENESIS.wallet
  for (let v = 0; v < 64; v++) {
    const p = build(`pixelpals:v1:${id}:${minter}:${v}`, genesis ? GENESIS_LOOK : null)
    if (genesis) { p.barcode = 0; p.traits.Edition = 'Genesis 1 of 1' }
    const sig = signature(p.grid)
    if (!taken || !taken.has(sig)) {
      p.signature = sig
      p.variation = v
      p.score = genesis ? Infinity : scoreOf(p.traits)
      p.traits.Rarity = genesis ? '1 of 1' : tierOf(p.score)
      return p
    }
  }
  throw new Error('no unique variation found')
}

/**
 * Every minted Pal, in order, each checked against all the ones before it.
 * `minters` is the list of minting wallets from the chain, index = Pal number.
 */
export function allPals(minters) {
  const taken = new Set()
  const pals = minters.map((w, id) => {
    const p = palFor(id, w, taken)
    taken.add(p.signature)
    return p
  })
  // Rank 1 is the rarest. Ties go to the lower number.
  const order = pals.map((p, id) => id).sort((a, b) => (pals[b].score - pals[a].score) || (a - b))
  order.forEach((id, i) => { pals[id].rank = i + 1 })
  return pals
}

/**
 * Every minted Pal, from the chain's mint order. `list` is [{ num, minter }]
 * in the order they were minted (earlier Pals are never changed by later
 * ones). Returns a Map from Pal number to Pal, each with its rank (1 is the
 * rarest) and its place in the mint order (`nftId`).
 */
export function palsInOrder(list) {
  const taken = new Set()
  const out = new Map()
  list.forEach(({ num, minter }, nftId) => {
    const p = palFor(num, minter, taken)
    taken.add(p.signature)
    p.nftId = nftId
    out.set(num, p)
  })
  const nums = [...out.keys()].sort((a, b) => (out.get(b).score - out.get(a).score) || (a - b))
  nums.forEach((num, i) => { out.get(num).rank = i + 1 })
  return out
}

/* Rarity score: how unlikely each trait is, added up (in bits). */
const ODDS = {}
for (const [k, list] of Object.entries({ Body: BODIES, Pattern: PATTERNS, Top: EARS, Eyes: EYES, Mouth: MOUTHS, Headwear: HATS, Face: FACEWEAR, Limbs: LIMBS, Background: SKY })) {
  const total = list.reduce((n, [, w]) => n + w, 0)
  ODDS[k] = Object.fromEntries(list.map(([v, w]) => [v, w / total]))
}
const SKIN_TOTAL = SKINS.reduce((n, [, w]) => n + w, 0)
/* Tiers by score, set from the spread of 10,000 simulated Pals: roughly the
   top 0.5% Legendary, next 2% Epic, next 7.5% Rare, next 25% Uncommon. */
function tierOf(score) {
  return score >= 39.4 ? 'Legendary' : score >= 37.6 ? 'Epic' : score >= 35.4 ? 'Rare' : score >= 32.75 ? 'Uncommon' : 'Common'
}

function scoreOf(traits) {
  let bits = 0
  for (const [k, table] of Object.entries(ODDS)) bits += -Math.log2(table[traits[k]] ?? 0.5)
  const special = SKINS.find(([v]) => v === traits.Colour)
  const colourOdds = special ? special[1] / SKIN_TOTAL : (SKINS[0][1] / SKIN_TOTAL) / (HUE_NAMES.length * 3)
  return bits - Math.log2(colourOdds)
}

/** An SVG of the grid, with horizontal runs merged so it stays small. */
export function toSvg(grid, size = 480) {
  let body = ''
  for (let y = 0; y < GRID; y++) {
    let x = 0
    while (x < GRID) {
      const c = grid[y][x]
      let w = 1
      while (x + w < GRID && grid[y][x + w] === c) w++
      if (c) body += `<rect x="${x}" y="${y}" width="${w}" height="1" fill="${c}"/>`
      x += w
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" width="${size}" height="${size}" shape-rendering="crispEdges">${body}</svg>`
}

export const PAL_SUPPLY = 2026
