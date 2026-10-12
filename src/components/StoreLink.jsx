// src/components/StoreLink.jsx
//
// Every "get the wallet" action opens ThruScan Wallet's Chrome Web Store
// listing in a new tab, with the external-link icon after the label. Buttons
// say "Add to Chrome"; links inside a sentence say "Get ThruScan Wallet".

import { Icon } from './Icon.jsx'
import { EXTENSION_URL } from '../lib/external.js'

export function StoreLink({ className = 'ext-link', children = 'Get ThruScan Wallet', iconSize = 14, ...rest }) {
  return (
    <a className={className} href={EXTENSION_URL} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}<Icon name="external" size={iconSize} />
    </a>
  )
}

export default StoreLink
