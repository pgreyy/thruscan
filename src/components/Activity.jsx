// src/components/Activity.jsx
//
// A list of an account's transactions, newest first, each one a link to its
// own page. Used on the wallet and on every account page in the explorer.

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchHistory, describe, timeAgo, fetchEvents, movements, formatDelta } from '../lib/activity.js'

const short = (s) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : '')

export function Activity({ addresses, me, title = 'Activity' }) {
  const key = (addresses ?? []).filter(Boolean).join(',')
  const [items, setItems] = useState([])
  const [next, setNext] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [extra, setExtra] = useState({ events: {}, accounts: {} })

  // Amounts come in a second step, so the list shows at once and fills in.
  useEffect(() => {
    if (!me || items.length === 0) return
    const missing = items.map((t) => t.signature).filter((s) => !(s in extra.events))
    if (missing.length === 0) return
    let alive = true
    fetchEvents(missing).then((r) => {
      if (!alive) return
      setExtra((old) => ({ events: { ...old.events, ...r.events }, accounts: { ...old.accounts, ...r.accounts } }))
    })
    return () => { alive = false }
  }, [items, me]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!key) return
    setLoading(true); setError(null)
    try {
      const r = await fetchHistory(key.split(','))
      setItems(r.items); setNext(r.next)
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setLoading(false)
    }
  }, [key])

  const more = async () => {
    if (!next) return
    setLoading(true); setError(null)
    try {
      const r = await fetchHistory(key.split(','), next)
      setItems((old) => {
        const seen = new Set(old.map((t) => t.signature))
        return [...old, ...r.items.filter((t) => !seen.has(t.signature))]
      })
      setNext(r.next)
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [load])

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="h2">{title}</h2>
        <button className="btn ghost" onClick={load} disabled={loading}>{loading ? 'Loading' : 'Refresh'}</button>
      </div>

      {error && <p className="notice bad" style={{ marginTop: 12 }}>{error}</p>}

      {!error && items.length === 0 && (
        <p className="fine" style={{ marginTop: 12 }}>{loading ? 'Reading the chain.' : 'No transactions yet.'}</p>
      )}

      {items.length > 0 && (
        <div className="activity">
          {items.map((t) => {
            const { label } = describe(t, me)
            const moves = t.ok === false ? [] : movements(t, extra, me)
            return (
              <Link className="activity-row" key={t.signature} to={`/tx/${t.signature}`}>
                <span className="activity-what">
                  <b>{label}</b>
                  {t.ok === false && <span className="activity-failed">failed</span>}
                  {moves.length > 0 && (
                    <span className="activity-moves">
                      {moves.map((m) => (
                        <span key={m.label} className={m.delta < 0 ? 'out' : 'in'}>{formatDelta(m)}</span>
                      ))}
                    </span>
                  )}
                </span>
                <span className="activity-when fine">{timeAgo(t.time)}</span>
                <span className="activity-sig mono fine">{short(t.signature)}</span>
              </Link>
            )
          })}
        </div>
      )}

      {next && (
        <button className="btn ghost" style={{ width: '100%', marginTop: 12 }} onClick={more} disabled={loading}>
          {loading ? 'Loading' : 'Show older'}
        </button>
      )}
    </section>
  )
}

export default Activity
