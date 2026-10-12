// src/pages/GetWallet.jsx
//
// The product page for ThruScan Wallet, the Chrome extension. The one action
// is Add to Chrome, which opens the Chrome Web Store listing. A browser wallet
// made on the Wallet page is the alternative, and the zip install is kept,
// folded away, for browsers that can't reach the store.

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Icon } from '../components/Icon.jsx'
import { Symbol } from '../components/Wordmark.jsx'
import { StoreLink } from '../components/StoreLink.jsx'
import { hasProvider, connectExternal, externalConnected, onExternalChange } from '../lib/external.js'

const ZIP = '/downloads/thruscan-wallet.zip'

/* Typed once, here, and typed again in the manifest is how a page ends up
   offering "0.4.1" while the file behind the link is something else. The
   manifest is the source; npm run pack:extension prints what it packed. */
import manifest from '../../extension/public/manifest.json'
const VERSION = manifest.version

/* A phone or tablet. Web Store extensions need a desktop browser (or Mises on
   Android), so phones get a different note under the buttons. */
function isMobile() {
  if (typeof navigator === 'undefined') return false
  return navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')
}

/* The provider script runs at document start, but on some pages it lands a
   beat later, so look again for up to a second before deciding. */
function useProvider() {
  const [found, setFound] = useState(hasProvider)
  const [connected, setConnected] = useState(externalConnected)
  useEffect(() => {
    let tries = 0
    const t = setInterval(() => {
      if (hasProvider() || ++tries >= 10) { setFound(hasProvider()); clearInterval(t) }
    }, 100)
    const off = onExternalChange(() => setConnected(externalConnected()))
    return () => { clearInterval(t); off() }
  }, [])
  return { found, connected }
}

export function GetWalletPage() {
  const navigate = useNavigate()
  const { found, connected } = useProvider()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [phone] = useState(isMobile)

  const connect = async () => {
    setBusy(true); setError(null)
    try { await connectExternal(); navigate('/wallet') } catch (e) { setError(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  let primary
  if (found && connected) primary = <Link className="btn lg" to="/wallet">Open your wallet</Link>
  else if (found) primary = <button className="btn lg" onClick={connect} disabled={busy}>{busy ? 'Approve in the extension' : 'Connect'}</button>
  else primary = <StoreLink className="btn lg" iconSize={16}>Add to Chrome</StoreLink>

  return (
    <div className="page gw">
      {/* The hero is one centred column for now. The extension popup
          screenshot (public/store-1-wallet.png, 400px wide, about 400:600)
          goes in a second, right-hand column once it exists; see the
          /get-wallet spec in the design handoff. */}
      <section className="gw-hero">
        <div className="gw-copy">
          <Symbol size={64} />
          <h1 className="gw-title">ThruScan Wallet for Chrome</h1>
          <p className="gw-lead">A self-custody wallet for Thru&rsquo;s test network. Your key is encrypted on your device, and every site request needs your approval. Not audited.</p>
          <div className="gw-actions">
            {primary}
            <Link className="btn secondary lg" to="/wallet">Use a browser wallet instead</Link>
          </div>
          {found && <p className="gw-note">ThruScan Wallet is installed in this browser.</p>}
          <p className="gw-note">
            {phone
              ? 'Extensions install on desktop Chrome, Brave or Edge, or in Mises on Android.'
              : 'Free on the Chrome Web Store · works in Chrome, Brave, Edge and other Chromium browsers.'}
          </p>
          {error && <p className="notice bad">{error}</p>}
        </div>
      </section>

      <hr className="gw-rule" />

      <details className="gw-manual">
        <summary>
          <Icon name="expand" size={16} />
          Can&rsquo;t use the Chrome Web Store? Install manually (.zip)
        </summary>
        <div className="gw-manual-body">
          <h2 className="gw-sub">On a computer (Chrome, Brave, Edge)</h2>
          <ol className="gw-steps">
            <li><span className="mono">1</span><span>Download the zip and unzip it.</span></li>
            <li><span className="mono">2</span><span>Open <span className="mono">chrome://extensions</span> and turn on <b>Developer mode</b>.</span></li>
            <li><span className="mono">3</span><span>Press <b>Load unpacked</b> and pick the unzipped folder.</span></li>
          </ol>
          <div>
            <a className="btn secondary" href={ZIP} download="thruscan-wallet.zip">Download the zip<span className="mono gw-ver">v{VERSION}</span></a>
          </div>

          <h2 className="gw-sub">On a phone (Mises browser)</h2>
          <ol className="gw-steps">
            <li><span className="mono">1</span><span>Open this page in <b>Mises</b> and tap <b>Download the zip</b>.</span></li>
            <li><span className="mono">2</span><span>Menu → <b>Extensions</b> → turn on <b>Developer mode</b>.</span></li>
            <li><span className="mono">3</span><span>Tap <b>+ (from .zip/.crx/.user.js)</b> and pick <span className="mono">thruscan-wallet.zip</span>.</span></li>
          </ol>
          <p className="gw-note">Already installed? <Link to="/wallet">Connect it on the Wallet page</Link>.</p>
        </div>
      </details>

      <section className="gw-warn" aria-label="About the browser wallet">
        <Icon name="warning" size={18} />
        <span>A key in browser storage can be reached by anything running on the page, so the extension is the safer choice for anything you would mind losing. This is a test network either way.</span>
      </section>
    </div>
  )
}

export default GetWalletPage
