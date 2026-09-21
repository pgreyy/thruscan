// extension/src/popup/qr.jsx
// The receive QR, drawn locally.

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

export function QRImage({ text, size = 200 }) {
  const [svg, setSvg] = useState(null)
  useEffect(() => {
    let alive = true
    QRCode.toString(text, { type: 'svg', margin: 1, width: size, errorCorrectionLevel: 'M' })
      .then((s) => { if (alive) setSvg(s) }).catch(() => {})
    return () => { alive = false }
  }, [text, size])
  return <div className="qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />
}
