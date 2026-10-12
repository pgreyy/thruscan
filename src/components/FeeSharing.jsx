// src/components/FeeSharing.jsx
//
// "Share fees with holders" (Update 02, 7b, artboard 5h).
//
// The design is approved but the ThruPad program (programs/thrupad2.c) has no
// fee split and no distribution: its opcodes are INIT, LAUNCH, BUY, SELL,
// CLAIM and GRADUATE, and CLAIM pays every unclaimed fee to the creator. The
// site must never hold creator funds or keys, so this cannot be done from the
// website alone. The panel is built and hidden behind VITE_FEE_SHARING
// (off unless set to "true"), and Save stays disabled until the program
// change in docs/fee-sharing-program.md is deployed and wired here.

import { useState } from 'react'

const SHARES = [25, 50, 100]
const FREQ = [
  { key: 'daily', label: 'Daily', days: 1 },
  { key: 'weekly', label: 'Weekly', days: 7 },
  { key: 'monthly', label: 'Monthly', days: 30 },
]

export function FeeSharingPanel({ launch }) {
  const [on, setOn] = useState(false)
  const [share, setShare] = useState(50)
  const [customShare, setCustomShare] = useState('')
  const [freq, setFreq] = useState('weekly')
  const [customDays, setCustomDays] = useState('')
  const [minHolding, setMinHolding] = useState('')

  const pct = share === 'custom' ? Number(customShare) : share
  const days = freq === 'custom' ? Number(customDays) : FREQ.find((f) => f.key === freq).days
  const pctOk = Number.isInteger(pct) && pct >= 1 && pct <= 100
  const daysOk = Number.isInteger(days) && days >= 1 && days <= 90

  return (
    <div className="fs">
      <div className="fs-head">
        <div>
          <b>Share fees with holders</b>
          <p className="fine">Send part of your creator fees to {launch.symbol} holders on a schedule.</p>
        </div>
        <label className="fs-toggle">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
          <span className="sr-only">Share fees with holders</span>
          <span className="fs-switch" aria-hidden="true" />
        </label>
      </div>

      {on && (
        <>
          <div className="fs-field">
            <span className="label">Share of creator fees</span>
            <div className="chips" role="group" aria-label="Share of creator fees">
              {SHARES.map((n) => <button key={n} type="button" className="chip" aria-pressed={share === n} onClick={() => setShare(n)}>{n}%</button>)}
              <button type="button" className="chip" aria-pressed={share === 'custom'} onClick={() => setShare('custom')}>Custom</button>
            </div>
            {share === 'custom' && (
              <input className="field mono fs-small" inputMode="numeric" value={customShare} onChange={(e) => setCustomShare(e.target.value.replace(/\D/g, ''))} placeholder="1–100" aria-label="Custom share, percent" />
            )}
            <span className="fine">{pctOk ? `${pct}% to holders. You keep the rest.` : '1–100%. You keep the rest.'}</span>
          </div>

          <div className="fs-field">
            <span className="label">How often</span>
            <div className="chips" role="group" aria-label="How often">
              {FREQ.map((f) => <button key={f.key} type="button" className="chip" aria-pressed={freq === f.key} onClick={() => setFreq(f.key)}>{f.label}</button>)}
              <button type="button" className="chip" aria-pressed={freq === 'custom'} onClick={() => setFreq('custom')}>Custom</button>
            </div>
            {freq === 'custom' && (
              <input className="field mono fs-small" inputMode="numeric" value={customDays} onChange={(e) => setCustomDays(e.target.value.replace(/\D/g, ''))} placeholder="1–90 days" aria-label="Every how many days" />
            )}
          </div>

          <div className="fs-field">
            <label className="label" htmlFor="fs-min">Minimum holding to qualify</label>
            <input id="fs-min" className="field mono" inputMode="decimal" value={minHolding} onChange={(e) => setMinHolding(e.target.value)} placeholder={`0 ${launch.symbol}`} />
            <span className="fine">The curve, the pool and your own wallet are always excluded.</span>
          </div>

          <div className="fs-field">
            <span className="label">Split</span>
            <span>Pro rata to balance at the snapshot, taken at distribution time.</span>
          </div>

          <dl className="fs-preview">
            <div><dt>Next distribution</dt><dd className="mono">–</dd></div>
            <div><dt>Set aside so far</dt><dd className="mono">–</dd></div>
            <div><dt>Qualifying holders now</dt><dd className="mono">–</dd></div>
          </dl>
        </>
      )}

      <button type="button" className="btn secondary" disabled>Save settings</button>
      <p className="why">
        {on && (!pctOk || !daysOk)
          ? 'Pick a share of 1–100% and a schedule of 1–90 days.'
          : 'Saving needs the ThruPad fee-sharing update, which is not deployed on this network yet.'}
      </p>
    </div>
  )
}

export default FeeSharingPanel
