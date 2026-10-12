// src/pages/GetWallet.jsx
//
// Two ways to hold a key on Thru, side by side: ThruScan Wallet, the browser
// extension, installed from a zip; or a wallet made right here, encrypted in
// this browser. Nothing here claims a store listing: a Web Store button only
// appears when VITE_EXTENSION_URL points at one.

import { Link } from 'react-router-dom'
import { Icon } from '../components/Icon.jsx'
import { Symbol } from '../components/Wordmark.jsx'
import { EXTENSION_URL, EXTENSION_IS_EXTERNAL } from '../lib/external.js'
import { hasWallet } from '../lib/wallet.js'

const ZIP = '/downloads/thruscan-wallet.zip'

/* Typed once, here, and typed again in the manifest is how a page ends up
   offering "0.4.1" while the file behind the link is something else. The
   manifest is the source; npm run pack:extension prints what it packed. */
import manifest from '../../extension/public/manifest.json'
const VERSION = manifest.version

export function GetWalletPage() {
  return (
    <div className="page gw">
      <div className="gw-head">
        <h1 className="h1">Get a wallet</h1>
        <p className="lede">Every launch, trade and swap on ThruScan is signed by your wallet. Pick one of two: the extension, or a wallet made in this browser. Either way the key stays with you.</p>
      </div>

      <div className="gw-paths">
        <section className="gw-path">
          <div className="gw-path-head">
            <span className="gw-mark"><Symbol size={28} /></span>
            <div>
              <h2 className="h3">ThruScan Wallet</h2>
              <p className="sub">Browser extension · version <span className="mono">{VERSION}</span></p>
            </div>
          </div>
          <p className="gw-text">Keys stay in the extension, and any Thru site can ask it to sign. Installed from a zip with developer mode.</p>
          <div className="gw-actions">
            <a className="btn lg" href={ZIP} download="thruscan-wallet.zip">Download the zip</a>
            {EXTENSION_IS_EXTERNAL && (
              <a className="btn secondary lg" href={EXTENSION_URL} target="_blank" rel="noreferrer">Chrome Web Store<Icon name="external" size={16} /></a>
            )}
          </div>

          <h3 className="gw-sub">On a computer (Chrome, Brave, Edge)</h3>
          <ol className="gw-steps">
            <li><span className="mono">1</span><span>Download the zip and unzip it.</span></li>
            <li><span className="mono">2</span><span>Open <span className="mono">chrome://extensions</span> and turn on <b>Developer mode</b>.</span></li>
            <li><span className="mono">3</span><span>Press <b>Load unpacked</b> and pick the unzipped folder.</span></li>
          </ol>

          <h3 className="gw-sub">On a phone (Mises browser)</h3>
          <ol className="gw-steps">
            <li><span className="mono">1</span><span>Open this page in <b>Mises</b> and tap <b>Download the zip</b>.</span></li>
            <li><span className="mono">2</span><span>Menu → <b>Extensions</b> → turn on <b>Developer mode</b>.</span></li>
            <li><span className="mono">3</span><span>Tap <b>+ (from .zip/.crx/.user.js)</b> and pick <span className="mono">thruscan-wallet.zip</span>.</span></li>
          </ol>
          <p className="why">Already installed? <Link to="/wallet">Connect it on the Wallet page</Link>.</p>
        </section>

        <section className="gw-path">
          <div className="gw-path-head">
            <span className="gw-mark"><Icon name="wallet" size={22} /></span>
            <div>
              <h2 className="h3">Browser wallet</h2>
              <p className="sub">Made here, no install</p>
            </div>
          </div>
          <p className="gw-text">Create a wallet on this page. The key is encrypted with your password and kept in this browser only, with a twelve-word phrase you can write down to restore it anywhere.</p>
          <div className="gw-actions">
            <Link className="btn secondary lg" to="/wallet">{hasWallet() ? 'Open your wallet' : 'Create one here'}</Link>
          </div>
          <div className="notice">
            <Icon name="warning" size={18} />
            <span>A key in browser storage can be reached by anything running on the page, so the extension is the safer choice for anything you would mind losing. This is a test network either way.</span>
          </div>
        </section>
      </div>
    </div>
  )
}

export default GetWalletPage
