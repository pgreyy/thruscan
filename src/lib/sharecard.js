// src/lib/sharecard.js
//
// Draws a result card as a PNG in the browser.
//
// The design brief was "not bland". What stops a card like this being boring
// is not decoration, it is having something on it nobody else can produce: the
// actual grid you played and the actual transaction that recorded it. So the
// layout gives those the most room and treats everything else as supporting
// detail.
//
// 1200 x 630 is the standard link preview size, so the same image works as an
// attachment, an OG image, or a download.

const W = 1200
const H = 630

const INK = '#16181d'
const CANVAS_BG = '#f1f0ed'
const SIGNAL = '#2f55e0'
const MUTED = 'rgba(241, 240, 237, 0.55)'
const LINE = 'rgba(241, 240, 237, 0.13)'

const SANS = "'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace"

/** Rounded rectangle, since not every browser has roundRect yet. */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * The backdrop. A faint dot grid rather than a flat fill or a gradient — it
 * reads as a machine surface, ties to the mono type, and survives being
 * scaled down to a timeline thumbnail where a gradient would just look muddy.
 */
function drawBackdrop(ctx) {
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, W, H)

  ctx.fillStyle = 'rgba(241, 240, 237, 0.045)'
  for (let y = 34; y < H; y += 28) {
    for (let x = 34; x < W; x += 28) {
      ctx.beginPath()
      ctx.arc(x, y, 1.1, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // A single blue edge, the same one the site uses on decoded cards.
  ctx.fillStyle = SIGNAL
  ctx.fillRect(0, 0, 7, H)
}

function drawHeader(ctx, eyebrow) {
  ctx.fillStyle = CANVAS_BG
  roundRect(ctx, 56, 48, 44, 44, 13)
  ctx.fill()

  ctx.fillStyle = INK
  ctx.font = `700 24px ${MONO}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('T', 78, 71)

  ctx.textAlign = 'left'
  ctx.fillStyle = CANVAS_BG
  ctx.font = `600 25px ${SANS}`
  ctx.fillText('ThruScan', 114, 63)

  ctx.fillStyle = MUTED
  ctx.font = `500 13px ${MONO}`
  ctx.fillText(eyebrow.toUpperCase(), 114, 84)
}

function drawFooter(ctx, signature) {
  ctx.fillStyle = LINE
  ctx.fillRect(56, H - 92, W - 112, 1)

  ctx.fillStyle = MUTED
  ctx.font = `500 15px ${MONO}`
  ctx.textAlign = 'left'
  ctx.fillText('thruscan.vercel.app', 56, H - 58)

  if (signature) {
    ctx.textAlign = 'right'
    ctx.fillStyle = 'rgba(241, 240, 237, 0.42)'
    ctx.font = `400 14px ${MONO}`
    // Middle-truncated: the ends are what someone would check against an
    // explorer, and the middle carries no meaning to a reader.
    ctx.fillText(`${signature.slice(0, 20)}…${signature.slice(-14)}`, W - 56, H - 58)

    ctx.fillStyle = MUTED
    ctx.font = `500 12px ${MONO}`
    ctx.fillText('RECORDED ON THRU', W - 56, H - 80)
  }
}

function drawStat(ctx, x, y, value, label) {
  ctx.textAlign = 'left'
  ctx.fillStyle = CANVAS_BG
  ctx.font = `700 46px ${SANS}`
  ctx.fillText(value, x, y)

  ctx.fillStyle = MUTED
  ctx.font = `500 14px ${SANS}`
  ctx.fillText(label, x, y + 30)
}

/* ---------- wordle ---------- */

const MARK_FILL = { correct: SIGNAL, present: '#3d434f', absent: 'rgba(241, 240, 237, 0.10)' }
const MARK_TEXT = { correct: '#ffffff', present: '#f1f0ed', absent: 'rgba(241, 240, 237, 0.5)' }

/**
 * @param guesses  array of five-letter strings
 * @param marks    array of arrays of 'correct' | 'present' | 'absent'
 */
export async function renderWordleCard({ name, guesses, marks, solved, points, streak, signature }) {
  await document.fonts?.ready

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  drawBackdrop(ctx)
  drawHeader(ctx, 'Wordle on chain')

  // The grid is the hero and sits left, because it is the part a reader
  // recognises before they have read a single word.
  const cell = 62
  const gap = 9
  const gridX = 56
  const gridY = 150

  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 5; c++) {
      const x = gridX + c * (cell + gap)
      const y = gridY + r * (cell + gap)
      const mark = marks[r]?.[c]
      const letter = guesses[r]?.[c]

      ctx.fillStyle = mark ? MARK_FILL[mark] : 'rgba(241, 240, 237, 0.05)'
      roundRect(ctx, x, y, cell, cell, 10)
      ctx.fill()

      if (letter) {
        ctx.fillStyle = MARK_TEXT[mark] ?? CANVAS_BG
        ctx.font = `700 30px ${SANS}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(letter.toUpperCase(), x + cell / 2, y + cell / 2 + 1)
      }
    }
  }

  const textX = gridX + 5 * (cell + gap) + 56
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  ctx.fillStyle = solved ? SIGNAL : 'rgba(241, 240, 237, 0.55)'
  ctx.font = `700 17px ${MONO}`
  ctx.fillText(solved ? `SOLVED IN ${guesses.length}` : 'NOT SOLVED', textX, 176)

  ctx.fillStyle = CANVAS_BG
  ctx.font = `600 58px ${SANS}`
  ctx.fillText(name || 'anonymous', textX, 232)

  drawStat(ctx, textX, 330, String(points), points === 1 ? 'point' : 'points')
  drawStat(ctx, textX + 200, 330, String(streak), 'day streak')

  ctx.fillStyle = MUTED
  ctx.font = `400 17px ${SANS}`
  ctx.fillText('A program written in C scored this', textX, 430)
  ctx.fillText('game and wrote it to Thru.', textX, 456)

  drawFooter(ctx, signature)
  return canvas.toDataURL('image/png')
}

/* ---------- 2048 ---------- */

const TILE_COLOURS = {
  0: 'rgba(241, 240, 237, 0.05)',
  2: 'rgba(241, 240, 237, 0.12)',
  4: 'rgba(241, 240, 237, 0.18)',
  8: 'rgba(241, 240, 237, 0.26)',
  16: '#4a4f5c',
  32: '#565c6d',
  64: '#636a80',
  128: '#2a3568',
  256: '#26357e',
  512: '#2a44a6',
  1024: SIGNAL,
  2048: SIGNAL,
}

export async function render2048Card({ name, board, score, moves, best, signature }) {
  await document.fonts?.ready

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  drawBackdrop(ctx)
  drawHeader(ctx, '2048 on chain')

  const cell = 86
  const gap = 10
  const gridX = 56
  const gridY = 150

  for (let i = 0; i < 16; i++) {
    const r = Math.floor(i / 4)
    const c = i % 4
    const x = gridX + c * (cell + gap)
    const y = gridY + r * (cell + gap)
    const value = board[i] ? 2 ** board[i] : 0

    ctx.fillStyle = TILE_COLOURS[value] ?? SIGNAL
    roundRect(ctx, x, y, cell, cell, 12)
    ctx.fill()

    if (value) {
      ctx.fillStyle = value >= 16 ? '#ffffff' : CANVAS_BG
      ctx.font = `700 ${value >= 1024 ? 24 : value >= 128 ? 28 : 34}px ${SANS}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(value), x + cell / 2, y + cell / 2 + 1)
    }
  }

  const textX = gridX + 4 * (cell + gap) + 56
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  ctx.fillStyle = SIGNAL
  ctx.font = `700 17px ${MONO}`
  ctx.fillText(`${moves} MOVES, ${moves} TRANSACTIONS`, textX, 176)

  ctx.fillStyle = CANVAS_BG
  ctx.font = `600 58px ${SANS}`
  ctx.fillText(name || 'anonymous', textX, 232)

  drawStat(ctx, textX, 330, score.toLocaleString(), 'score')
  drawStat(ctx, textX + 230, 330, best.toLocaleString(), 'best')

  ctx.fillStyle = MUTED
  ctx.font = `400 17px ${SANS}`
  ctx.fillText('Every swipe was its own transaction.', textX, 430)
  ctx.fillText('The chain moved the tiles.', textX, 456)

  drawFooter(ctx, signature)
  return canvas.toDataURL('image/png')
}

/* ---------- text ---------- */

// Blue for the right place, white for the right letter in the wrong place,
// black for out. Brand blue rather than the familiar green, deliberately —
// the grid should read as this game rather than the original.
const EMOJI = { correct: '🟦', present: '⬜', absent: '⬛' }

/**
 * The emoji grid is what made the original game spread, precisely because it
 * needs no upload and survives being pasted anywhere. The image is the better
 * artefact; this is the one that travels.
 */
export function wordleShareText({ name, marks, solved, points, signature }) {
  const grid = marks.map((row) => row.map((m) => EMOJI[m]).join('')).join('\n')
  const headline = solved ? `Solved in ${marks.length}` : 'Did not solve'

  return [
    `Thru Wordle — ${headline}`,
    name ? `${name} · ${points} points` : `${points} points`,
    '',
    grid,
    '',
    'Scored by a C program running on Thru.',
    signature ? `thruscan.vercel.app/?tx=${signature}` : 'thruscan.vercel.app',
  ].join('\n')
}

export function share2048Text({ name, score, moves, signature }) {
  return [
    `Thru 2048 — ${score.toLocaleString()} points`,
    name ? `${name} · ${moves} moves, ${moves} transactions` : `${moves} moves, ${moves} transactions`,
    '',
    'Every swipe was its own transaction on Thru.',
    signature ? `thruscan.vercel.app/?tx=${signature}` : 'thruscan.vercel.app',
  ].join('\n')
}

/** Kick off a download without leaving the page. */
export function downloadCard(dataUrl, filename) {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
}
