// src/components/QR.jsx
//
// Moving a wallet between devices without typing it.
//
// Showing a QR is easy and always works. Reading one needs a camera and a
// decoder, and the only decoder worth shipping is the one already in the
// browser: BarcodeDetector, which is native in Chrome and Android and in recent
// Safari. Bundling a WebAssembly decoder to cover the rest would add more
// weight than the whole wallet, so where BarcodeDetector is missing this says
// so and falls back to typing the twelve words, which is slower but never
// fails.
//
// Nothing here uploads anything. The QR is drawn locally and the camera frames
// are read locally; a seed phrase that reaches a network is not a seed phrase
// any more.

import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

export function QRImage({ text, size = 200, label }) {
  const [svg, setSvg] = useState(null)

  useEffect(() => {
    let alive = true
    if (!text) { setSvg(null); return }
    QRCode.toString(text, { type: 'svg', margin: 1, width: size, errorCorrectionLevel: 'M' })
      .then((s) => { if (alive) setSvg(s) })
      .catch(() => { if (alive) setSvg(null) })
    return () => { alive = false }
  }, [text, size])

  if (!svg) return null
  return (
    <div className="qr-wrap">
      <div className="qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />
      {label && <p className="fine" style={{ marginTop: 8 }}>{label}</p>}
    </div>
  )
}

export const canScan = () => typeof window !== 'undefined' && 'BarcodeDetector' in window

/**
 * A camera that reads one QR and then stops.
 *
 * It stops on the first result rather than continuing, because the only thing
 * anyone scans here is a wallet, and a camera left running on a page holding a
 * seed phrase is a bad idea even when nothing is wrong.
 */
export function QRScanner({ onResult, onCancel }) {
  const videoRef = useRef(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let stream = null
    let stop = false
    let detector = null

    async function run() {
      if (!canScan()) { setError('This browser cannot read QR codes. Type the phrase instead.'); return }
      try {
        // eslint-disable-next-line no-undef
        detector = new BarcodeDetector({ formats: ['qr_code'] })
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (stop) { stream.getTracks().forEach((t) => t.stop()); return }
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
      } catch (e) {
        setError(String(e?.message ?? e))
        return
      }

      const tick = async () => {
        if (stop || !videoRef.current) return
        try {
          const found = await detector.detect(videoRef.current)
          if (found?.length && found[0].rawValue) {
            stop = true
            stream?.getTracks().forEach((t) => t.stop())
            onResult(found[0].rawValue)
            return
          }
        } catch { /* a frame that will not decode is normal */ }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }

    run()
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()) }
  }, [onResult])

  return (
    <div className="stack">
      {error
        ? <p className="notice bad">{error}</p>
        : (
          <>
            <video ref={videoRef} className="qr-video" playsInline muted />
            <p className="fine">Point it at the code on your other device.</p>
          </>
        )}
      <button className="btn ghost" onClick={onCancel}>Cancel</button>
    </div>
  )
}
