// src/pages/Wordle.jsx
//
// Thru Wordle: five letters, six tries, results recorded on chain. It used to
// share a page with 2048 under /games; 2048 is retired (Update 02) and Wordle
// keeps the same address.

import { useState, useEffect, useRef } from 'react'
import { NamePfp } from '../components/Pfp.jsx'
import { GameIdentity } from '../components/GameIdentity.jsx'
import { CopyId } from '../components/CopyId.jsx'
import { getAccount } from '../lib/rpcClient.js'
import { toast } from '../lib/toasts.js'
import { WORDLE_BOARD, ID_REGISTRY } from '../lib/addresses.js'
import {
  WORD_LEN, MAX_GUESSES, randomWord, scoreGuess, keyboardState, pointsFor,
  getPlayerId, setPlayerId, decodeBoard, rankByPoints, rankByStreak,
} from '../lib/wordle.js'
import { decodeRegistry, displayName } from '../lib/identity.js'
import { renderWordleCard, wordleShareText, downloadCard } from '../lib/sharecard.js'

/**
 * Renders a result card and offers the two ways people actually share things:
 * an image to attach, and text to paste. The image looks better; the text
 * travels further because it needs no upload and survives anywhere.
 */
function ShareResult({ render, text, filename }) {
  const [image, setImage] = useState(null)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  // The card is drawn once per result; callers remount this with a new key.
  const [draw] = useState(() => render)

  useEffect(() => {
    let alive = true
    draw()
      .then((url) => { if (alive) setImage(url) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [draw])

  const copy = () => {
    navigator.clipboard?.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const post = () => {
    window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank', 'noopener')
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="h2">Share it</h2>
          <p className="sub">Nobody else can produce this card</p>
        </div>
      </div>

      {image
        ? <img className="share-card" src={image} alt="Your result card" />
        : !failed && <p className="fine">Drawing your card</p>}

      <div className="share-actions">
        <button className="btn" onClick={post}>Post to X</button>
        <button className="btn ghost" onClick={copy}>{copied ? 'Copied' : 'Copy text'}</button>
        {image && (
          <button className="btn ghost" onClick={() => downloadCard(image, filename)}>Save image</button>
        )}
      </div>

      <p className="fine" style={{ marginBottom: 0 }}>
        Posting opens X with the text ready. Save the image and attach it there — X cannot take an image from a link.
      </p>
    </section>
  )
}



const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']

function WordleGame({ onFinished, registry }) {
  const [answer, setAnswer] = useState(randomWord)
  const [guesses, setGuesses] = useState([])
  const [current, setCurrent] = useState('')
  const [status, setStatus] = useState('playing')
  const [shake, setShake] = useState(false)
  const boardInput = useRef(null)
  // The name comes from the registry now, so there is nothing to type here.
  const myName = registry?.byId.get(getPlayerId()) ?? ''
  const [sending, setSending] = useState(false)
  const [signature, setSignature] = useState(null)
  const [error, setError] = useState(null)

  const finish = async (allGuesses, solved) => {
    setStatus(solved ? 'won' : 'lost')
    setSending(true)
    setError(null)
    try {
      const res = await fetch('/api/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'wordle',
          playerId: getPlayerId(),
          name: myName,
          answer,
          guesses: allGuesses,
          solved,
        }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.detail ? `${data.error} (${data.detail})` : data.error || 'Could not record that game.')
        return
      }
      setSignature(data.signature)
      toast({
        title: solved ? `Solved in ${allGuesses.length}` : 'Game recorded',
        sub: solved ? `${pointsFor(true, allGuesses.length)} points, written to Thru` : 'Written to Thru',
        signature: data.signature,
      })
      onFinished()
    } catch {
      setError('Could not reach the server. Your game still counts, it just was not recorded.')
    } finally {
      setSending(false)
    }
  }

  const submitGuess = () => {
    if (current.length !== WORD_LEN) {
      setShake(true)
      setTimeout(() => setShake(false), 400)
      return
    }
    const next = [...guesses, current]
    setGuesses(next)
    setCurrent('')

    if (current === answer) finish(next, true)
    else if (next.length === MAX_GUESSES) finish(next, false)
  }

  const press = (key) => {
    if (status !== 'playing') return
    if (key === 'enter') submitGuess()
    else if (key === 'back') setCurrent((c) => c.slice(0, -1))
    else if (/^[a-z]$/.test(key) && current.length < WORD_LEN) setCurrent((c) => c + key)
  }

  // Physical keyboard, because anyone playing on a laptop will type rather
  // than click, and a word game that ignores the keyboard feels broken.
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (document.activeElement?.tagName === 'INPUT') return
      if (e.key === 'Enter') press('enter')
      else if (e.key === 'Backspace') press('back')
      else if (/^[a-zA-Z]$/.test(e.key)) press(e.key.toLowerCase())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const newGame = () => {
    setAnswer(randomWord())
    setGuesses([])
    setCurrent('')
    setStatus('playing')
    setSignature(null)
    setError(null)
  }

  const keyState = keyboardState(guesses, answer)

  const rows = []
  for (let r = 0; r < MAX_GUESSES; r++) {
    const guess = guesses[r]
    const marks = guess ? scoreGuess(guess, answer) : null
    const letters = guess ?? (r === guesses.length ? current : '')

    rows.push(
      <div className="tile-row" key={r}>
        {Array.from({ length: WORD_LEN }, (_, c) => {
          const letter = letters[c] ?? ''
          const cls = marks ? marks[c] : letter ? 'filled' : ''
          return <div className={`tile ${cls}`} key={c}>{letter}</div>
        })}
      </div>
    )
  }

  const marks = guesses.map((g) => scoreGuess(g, answer))

  return (
    <>
    <section className="card wordle-card">
      <div className="card-head">
        <div>
          <h2 className="h2">Guess the word</h2>
          <p className="sub">Six tries. Blue means right place, black means right letter wrong place.</p>
        </div>
      </div>

      {!myName && (
        <p className="fine" style={{ marginTop: 0 }}>
          Playing as a guest.
        </p>
      )}

      <div className="tiles-wrap">
        <div className="tiles" style={shake ? { animation: 'none' } : undefined}>{rows}</div>

        {status === 'playing' && (
          <input
            ref={boardInput}
            className="board-input"
            value={current}
            onChange={(e) => setCurrent(e.target.value.toLowerCase().replace(/[^a-z]/g, '').slice(0, WORD_LEN))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitGuess() } }}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck="false"
            inputMode="text"
            aria-label="Type your guess"
          />
        )}
      </div>

      {status === 'playing' && (
        <p className="fine wordle-hint" style={{ textAlign: 'center', margin: '-8px 0 14px' }}>
          Tap the board to use your own keyboard, or use the one below.
        </p>
      )}

      {status === 'playing' ? (
        <div className="keys">
          {KEY_ROWS.map((row, i) => (
            <div className="key-row" key={i}>
              {i === 2 && <button className="key wide" onClick={() => press('enter')}>Enter</button>}
              {row.split('').map((letter) => (
                <button className={`key ${keyState[letter] ?? ''}`} key={letter} onClick={() => press(letter)}>
                  {letter}
                </button>
              ))}
              {i === 2 && <button className="key wide" onClick={() => press('back')}>Del</button>}
            </div>
          ))}
        </div>
      ) : (
        <div>
          <div className="hero">
            <p className="hero-eyebrow">{status === 'won' ? `Solved in ${guesses.length}` : 'Out of guesses'}</p>
            <p className="hero-value">
              {answer.toUpperCase()}
              {status === 'won' && <span className="unit">{pointsFor(true, guesses.length)} pts</span>}
            </p>
            <p className="hero-note">
              {sending ? 'Recording on chain' : signature ? 'Recorded on chain' : 'The word was scored by a program on Thru'}
            </p>
          </div>

          {error && <p className="notice bad" style={{ marginTop: 12, textAlign: 'left' }}>{error}</p>}

          {signature && <CopyId value={signature} to={`/tx/${signature}`} />}

          <button className="btn full" onClick={newGame} style={{ marginTop: 14 }} disabled={sending}>
            {sending ? 'Saving' : 'Play again'}
          </button>
        </div>
      )}
    </section>

    {status !== 'playing' && (
      <ShareResult
        key={signature ?? answer}
        filename={`thruwordle-${answer}.png`}
        render={() => renderWordleCard({
          name: myName,
          guesses,
          marks,
          solved: status === 'won',
          points: pointsFor(status === 'won', guesses.length),
          streak: 0,
          signature,
        })}
        text={wordleShareText({
          name: myName,
          marks,
          solved: status === 'won',
          points: pointsFor(status === 'won', guesses.length),
          signature,
        })}
      />
    )}
    </>
  )
}

/**
 * One line of a leaderboard.
 *
 * The picture comes from the .id name the player registered, which is also
 * where their name on the board comes from, so a hexagon here means the same
 * thing it means on a profile: that wallet owns that NFT, checked against the
 * collection rather than taken on trust. Players without a name still get an
 * identicon, seeded from their player code so it is theirs and stays theirs.
 */
function BoardRow({ rank, id, registry, fallbackName, you, detail, value, unit }) {
  const registered = registry?.byId?.get(id) ?? null
  return (
    <div className={`board-row${you ? ' you' : ''}`}>
      <span className="board-rank">{rank}</span>
      <NamePfp name={registered} address={id} size={22} />
      <span className="board-who">
        <strong>{displayName(registry, id, fallbackName)}{you && ' (you)'}</strong>
        <span>{detail}</span>
      </span>
      <span className="board-count">
        {value}
        <span>{unit}</span>
      </span>
    </div>
  )
}

function WordleBoard({ board, registry, refresh, loading }) {
  const [tab, setTab] = useState('points')
  const me = getPlayerId()

  const ranked = tab === 'points' ? rankByPoints(board.entries) : rankByStreak(board.entries)
  const solved = board.entries.reduce((n, p) => n + p.won, 0)

  return (
    <section className="card">
      <div className="card-head">
        <div className="tabs" role="tablist" style={{ marginBottom: 0, borderBottom: 0 }}>
          <button className="tab-btn" role="tab" aria-selected={tab === 'points'} onClick={() => setTab('points')}>Points</button>
          <button className="tab-btn" role="tab" aria-selected={tab === 'streak'} onClick={() => setTab('streak')}>Streaks</button>
        </div>
        <button className="btn ghost" onClick={refresh} disabled={loading}>{loading ? 'Loading' : 'Refresh'}</button>
      </div>

      {ranked.length === 0 ? (
        <p className="fine" style={{ marginBottom: 0 }}>Nobody has played yet. Solve one and the board is yours.</p>
      ) : (
        <div className="board">
          {ranked.slice(0, 50).map((p, i) => (
            <BoardRow
              key={p.id}
              rank={i + 1}
              id={p.id}
              registry={registry}
              fallbackName={p.name}
              you={p.id === me}
              detail={`${p.won} of ${p.played} solved`}
              value={tab === 'points' ? p.points.toLocaleString() : p.bestStreak}
              unit={tab === 'points' ? 'points' : `best streak, ${p.streak} now`}
            />
          ))}
        </div>
      )}

      {/* The totals were three cards above the board, which spent the best part
          of the panel on numbers nobody came for, and two of them track each
          other anyway: nearly every game that gets played gets solved. One line
          under the names, where a footnote belongs. */}
      <p className="board-foot fine">
        {board.games.toLocaleString()} {board.games === 1 ? 'game' : 'games'}
        {' · '}
        {board.entries.length} {board.entries.length === 1 ? 'player' : 'players'}
        {' · '}
        {solved.toLocaleString()} solved
      </p>
    </section>
  )
}

export function WordlePage() {
  const [board, setBoard] = useState(null)
  const [registry, setRegistry] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const loadRegistry = async () => {
    if (!ID_REGISTRY) return
    try {
      const account = await getAccount(ID_REGISTRY)
      setRegistry(decodeRegistry(account.data?.base64))
    } catch { /* names are decoration; a failure here should not break a game */ }
  }

  // A QR scan lands here with the code in the URL. Adopt it, then clean the
  // address bar so the secret is not left sitting in history or a shared link.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    if (code && setPlayerId(code)) {
      window.history.replaceState({}, '', window.location.pathname)
    }
    const t = setTimeout(loadRegistry, 0)
    return () => clearTimeout(t)
  }, [])

  const load = async () => {
    if (!WORDLE_BOARD) { setLoading(false); return }
    setLoading(true)
    setError(null)
    try {
      const account = await getAccount(WORDLE_BOARD)
      setBoard(decodeBoard(account.data?.base64))
    } catch {
      setError('Could not read the scoreboard right now.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const t = setTimeout(load, 0)
    return () => clearTimeout(t)
  }, [])

  if (!WORDLE_BOARD) {
    return (
      <div className="wrap">
        <h1 className="h1">Not live yet</h1>
        <p className="lede">The game is built and the program is deployed, but the scoreboard is still being wired up.</p>
      </div>
    )
  }

  const wordlePanel = (
    <div className="wrap wrap-top">
      <p className="lede" style={{ marginTop: 0 }}>
        Five letters, six tries. Results are recorded on Thru.
      </p>

      <div className="game-grid">
        <div className="game-main">
          <WordleGame onFinished={load} registry={registry} />
          {error && <p className="notice bad">{error}</p>}
        </div>

        <aside className="game-side">
          <GameIdentity registry={registry} onChanged={() => { loadRegistry(); load() }} />

          {/* Always something here. Rendering nothing while the board loads
              left a column-shaped hole beside the game, which reads as a
              broken page rather than as a page that is still reading. */}
          {board
            ? <WordleBoard board={board} registry={registry} refresh={load} loading={loading} />
            : (
              <section className="card">
                <div className="card-head">
                  <div>
                    <h2 className="h2">Leaderboard</h2>
                    <p className="sub">{loading ? 'Reading the chain' : 'Could not read it just now'}</p>
                  </div>
                  <button className="btn ghost" onClick={load} disabled={loading}>
                    {loading ? 'Reading' : 'Retry'}
                  </button>
                </div>
                {!loading && <p className="fine" style={{ marginTop: 12 }}>Your games still record.</p>}
              </section>
            )}
        </aside>
      </div>

      <footer className="foot">
        <p className="fine">Scores reset with the test network.</p>
      </footer>
    </div>
  )

  return wordlePanel
}

export default WordlePage
