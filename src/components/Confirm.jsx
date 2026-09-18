// src/components/Confirm.jsx
//
// "Are you sure?", for the handful of things that cannot be taken back.
//
// Deliberately awkward. The confirm button is the quiet one and the cancel
// button is the loud one, because the default answer to an irreversible
// question should be no. Escape and a click outside both cancel.
//
// Usage:
//
//   const confirm = useConfirm()
//   ...
//   if (!(await confirm.ask({ title, body, confirmLabel }))) return
//   ...
//   {confirm.modal}

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

function Dialog({ title, body, detail, confirmLabel, onYes, onNo }) {
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') onNo() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onNo])

  return createPortal(
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onNo() }}>
      <div className="modal-card" role="alertdialog" aria-modal="true" aria-label={title}>
        <h2 className="h2">{title}</h2>
        <p className="fine" style={{ marginTop: 10, lineHeight: 1.65 }}>{body}</p>

        {detail && (
          <div className="rows" style={{ marginTop: 14 }}>
            {detail.map((d) => (
              <div className="row" key={d.label}>
                <span>{d.label}</span>
                <b className="mono">{d.value}</b>
              </div>
            ))}
          </div>
        )}

        <div className="inline" style={{ marginTop: 16 }}>
          <button className="btn" onClick={onNo} style={{ flex: 1 }}>Keep it</button>
          <button className="btn ghost danger" onClick={onYes}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function useConfirm() {
  const [pending, setPending] = useState(null)

  const ask = useCallback((options) => new Promise((resolve) => {
    setPending({ ...options, resolve })
  }), [])

  const modal = pending
    ? (
      <Dialog
        title={pending.title ?? 'Are you sure?'}
        body={pending.body}
        detail={pending.detail}
        confirmLabel={pending.confirmLabel ?? 'Yes, do it'}
        onYes={() => { pending.resolve(true); setPending(null) }}
        onNo={() => { pending.resolve(false); setPending(null) }}
      />
    )
    : null

  return { ask, modal }
}

export default useConfirm
