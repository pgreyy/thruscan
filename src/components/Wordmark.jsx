// src/components/Wordmark.jsx
//
// The mark and the name, as one thing. Used where there is room to say whose
// site this is: the top of the phone menu and the top of the home page. The
// phone bar has no room for it at 320px, so there the mark stands alone.

export function Wordmark({ size = 'md' }) {
  return (
    <span className={`wordmark wordmark-${size}`}>
      <span className="brand-mark" aria-hidden="true">T</span>
      <span className="wordmark-name">ThruScan</span>
    </span>
  )
}

export default Wordmark
