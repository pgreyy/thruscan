// src/pages/GetWallet.jsx
//
// Where to get ThruScan Wallet: one download for desktop and phone.

import { Link } from 'react-router-dom'

const ZIP = '/downloads/thruscan-wallet.zip'

export function GetWalletPage() {
  return (
    <div className="wrap">
      <h1 className="h1">ThruScan Wallet</h1>
      <p className="lede">Self-custody wallet for Thru. Your keys stay on your device.</p>

      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="h2">Download</h2>
            <p className="sub">Version 0.3.0 · zip</p>
          </div>
          <a className="btn" href={ZIP} download="thruscan-wallet.zip">Download</a>
        </div>
      </section>

      <section className="card">
        <h2 className="h2">On a phone (Mises browser)</h2>
        <ol className="steps-list">
          <li>Open this page in <b>Mises</b> and tap <b>Download</b>.</li>
          <li>Menu → <b>Extensions</b> → turn on <b>Developer mode</b>.</li>
          <li>Tap <b>+ (from .zip/.crx/.user.js)</b> and pick <span className="mono">thruscan-wallet.zip</span>.</li>
        </ol>
      </section>

      <section className="card">
        <h2 className="h2">On a computer (Chrome, Brave, Edge)</h2>
        <ol className="steps-list">
          <li>Download and unzip it.</li>
          <li>Open <span className="mono">chrome://extensions</span> and turn on <b>Developer mode</b>.</li>
          <li><b>Load unpacked</b> → pick the unzipped folder.</li>
        </ol>
        <p className="fine" style={{ marginTop: 10 }}>The Chrome Web Store listing is in review; once it is live, installing is one click.</p>
      </section>

      <p className="fine">Already installed? <Link to="/wallet">Connect it on the Wallet page</Link>.</p>
    </div>
  )
}

export default GetWalletPage
