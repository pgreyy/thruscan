// src/components/Confirm.jsx
//
// "Are you sure?", in two tempers.
//
// For something that cannot be taken back, it is deliberately awkward: the
// confirm button is the quiet one and the cancel button is the loud one,
// because the default answer to an irreversible question should be no.
//
// For something a person actually came here to do, such as buying, that would
// be wrong. Passing `tone: 'go'` puts the weight on the confirm button and
// leaves cancel as the quiet one. It is still a stop: nothing is signed until
// it is answered, and it shows exactly what is about to happen, which is the
// point of asking at all.
//
// Escape and a click outside both cancel, either way.
//
// Usage:
//
//   const confirm = useConfirm()
//   ...
//   if (!(await confirm.ask({ title, body, detail, confirmLabel, tone: 'go' }))) return
//   ...
//   {confirm.modal}

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

function Dialog({ title, body, detail, confirmLabel, cancelLabel, tone, onYes, onNo }) {
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
          {tone === 'go' ? (
            <>
              <button className="btn ghost" onClick={onNo}>{cancelLabel ?? 'Cancel'}</button>
              <button className="btn" onClick={onYes} style={{ flex: 1 }}>{confirmLabel}</button>
            </>
          ) : (
            <>
              <button className="btn" onClick={onNo} style={{ flex: 1 }}>{cancelLabel ?? 'Keep it'}</button>
              <button className="btn ghost danger" onClick={onYes}>{confirmLabel}</button>
            </>
          )}
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
        cancelLabel={pending.cancelLabel}
        tone={pending.tone}
        onYes={() => { pending.resolve(true); setPending(null) }}
        onNo={() => { pending.resolve(false); setPending(null) }}
      />
    )
    : null

  return { ask, modal }
}

export default useConfirm
