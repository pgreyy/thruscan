import { useState, useEffect, useRef } from 'react'
import { useWallet } from '@thru/react-sdk'
import { createThruClient } from '@thru/thru-sdk'

const RPC_URL = 'https://grpc-web.alphanet.thruput.org'
const STORAGE_KEY = 'thru_dev_account_pubkey'

const steps = [
  { number: 1, title: 'Install Rust', description: 'Rust is required to install the Thru CLI. Download and run the installer from rustup.rs. When prompted, press Enter to accept defaults. After installing, close and reopen your terminal. IMPORTANT: When the installer asks which toolchain to use, make sure to select the MSVC variant (x86_64-pc-windows-msvc), not GNU. The Thru CLI requires MSVC to compile correctly on Windows.', note: 'Already have Rust installed? Run this to make sure you are on the correct toolchain:', noteCommand: 'rustup default stable-x86_64-pc-windows-msvc', linkLabel: 'Download Rust (rustup.rs)', linkUrl: 'https://rustup.rs', command: null, verify: 'rustc --version' },
  { number: 2, title: 'Install Buf CLI', description: 'Buf is required for building gRPC clients used by Thru. You can install it directly from your terminal using winget (recommended) or scoop. No need to visit the site unless you want to.', note: null, noteCommand: null, linkLabel: 'Buf CLI Docs', linkUrl: 'https://buf.build/docs/cli/installation', command: 'winget install bufbuild.buf', verify: 'buf --version' },
  { number: 3, title: 'Install the Thru CLI', description: 'Once Rust is installed, run this command in your terminal to install the Thru CLI. This may take a few minutes as it compiles from source.', note: null, noteCommand: null, linkLabel: null, linkUrl: null, command: 'cargo install thru', verify: 'thru --help' },
  { number: 4, title: 'Generate a Keypair', description: 'This creates a new cryptographic key pair stored locally on your machine. The name default is just a label — you can use any name you like. Never share your private key with anyone.', note: 'Already have a keypair and want to retrieve your private key? Run:', noteCommand: 'thru keys get default', linkLabel: null, linkUrl: null, command: 'thru keys generate default', verify: null },
  { number: 5, title: 'Create Your On-Chain Account', description: 'This registers your keypair as a real account on the Thru alphanet. Note: if you already deployed something on Thru, an account may have been created automatically. Run the verify command below to confirm.', note: null, noteCommand: null, linkLabel: null, linkUrl: null, command: 'thru account create default', verify: 'thru getaccountinfo default' },
  { number: 6, title: 'Get Faucet Tokens', description: 'Once your account is created, withdraw test tokens from the faucet to fund your wallet. The faucet gives up to 10,000 THRU per wallet. Replace "default" with your wallet name if you used a different label.', note: null, noteCommand: null, linkLabel: null, linkUrl: null, command: 'thru.exe faucet withdraw default 50', verify: 'thru getaccountinfo default' },
]

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }
  return <button onClick={handleCopy} style={{ padding: '3px 10px', fontSize: '11px', backgroundColor: copied ? '#38a169' : '#4a5568', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', marginLeft: '8px', whiteSpace: 'nowrap' }}>{copied ? 'Copied!' : 'Copy'}</button>
}

function CodeBlock({ code, color }) {
  return <div style={{ background: '#1a202c', borderRadius: '4px', padding: '8px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px', overflowX: 'auto' }}><code style={{ fontSize: '12px', color: color || '#68d391', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{code}</code><CopyButton text={code} /></div>
}

function ExternalLink({ url, label }) {
  return <p style={{ margin: '0 0 8px' }}><a href={url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '12px', color: '#3182ce', textDecoration: 'underline' }}>{label} ↗</a></p>
}

function WalletLink() {
  return <a href="https://wallet.thru.org" target="_blank" rel="noopener noreferrer" style={{ color: '#3182ce', textDecoration: 'underline' }}>Create an embedded wallet</a>
}

function Badge({ value }) {
  const yes = value === true
  return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, backgroundColor: yes ? '#c6f6d5' : '#fed7d7', color: yes ? '#276749' : '#9b2c2c' }}>{yes ? 'Yes' : 'No'}</span>
}

function useThruClient() {
  const clientRef = useRef(null)
  useEffect(() => {
    try { clientRef.current = createThruClient({ url: RPC_URL }) } catch (e) { console.error(e) }
  }, [])
  return clientRef
}

function DevAccountCard({ onLookup }) {
  const [savedKey, setSavedKey] = useState(() => localStorage.getItem(STORAGE_KEY) || '')
  const [input, setInput] = useState('')
  const [editing, setEditing] = useState(!localStorage.getItem(STORAGE_KEY))
  const [account, setAccount] = useState(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const clientRef = useThruClient()

  const fetchAccount = async (key, isRefresh = false) => {
    if (!key) return
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const ctx = clientRef.current || createThruClient({ url: RPC_URL })
      const result = await ctx.accounts.get(key)
      if (!result) throw new Error('Account not found')
      setAccount(result)
      setLastUpdated(new Date().toLocaleTimeString())
    } catch (err) {
      setError('Could not fetch account. Check the public key and try again.')
      setAccount(null)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => { if (savedKey) fetchAccount(savedKey) }, [])

  const handleSave = async () => {
    const key = input.trim()
    if (!key) return
    const ctx = clientRef.current || createThruClient({ url: RPC_URL })
    setLoading(true)
    setError(null)
    try {
      const result = await ctx.accounts.get(key)
      if (!result) throw new Error('Account not found')
      setAccount(result)
      setLastUpdated(new Date().toLocaleTimeString())
      localStorage.setItem(STORAGE_KEY, key)
      setSavedKey(key)
      setEditing(false)
      setInput('')
    } catch (err) {
      setError('Could not fetch account. Check the public key and try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleChange = () => { setEditing(true); setInput(savedKey); setAccount(null); setError(null) }
  const handleClear = () => { localStorage.removeItem(STORAGE_KEY); setSavedKey(''); setInput(''); setEditing(true); setAccount(null); setError(null); setLastUpdated(null) }

  const meta = account?.meta
  const flags = meta?.flags

  return (
    <div style={{ background: '#f7fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px', marginTop: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
        <p style={{ margin: 0 }}><strong>My Dev Account (CLI Generated)</strong></p>
        {savedKey && !editing && (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <button onClick={() => fetchAccount(savedKey, true)} disabled={refreshing} style={{ fontSize: '12px', color: '#38a169', background: 'none', border: '1px solid #38a169', borderRadius: '4px', cursor: 'pointer', padding: '2px 8px' }}>{refreshing ? '↻ Refreshing...' : '↻ Refresh'}</button>
            <button onClick={handleChange} style={{ fontSize: '12px', color: '#3182ce', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>Edit</button>
            <button onClick={handleClear} style={{ fontSize: '12px', color: '#e53e3e', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>Clear</button>
          </div>
        )}
      </div>

      {editing ? (
        <div>
          <p style={{ fontSize: '13px', color: '#718096', margin: '0 0 10px' }}>Enter your CLI-generated public key. It will be saved in your browser for future visits.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSave()} placeholder="ta..." style={{ width: '100%', padding: '8px 12px', fontSize: '13px', border: '1px solid #cbd5e0', borderRadius: '6px', fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box' }} />
            <button onClick={handleSave} disabled={loading || !input.trim()} style={{ padding: '10px 16px', fontSize: '13px', backgroundColor: '#38a169', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', opacity: (!input.trim() || loading) ? 0.6 : 1 }}>{loading ? 'Saving...' : 'Save Account'}</button>
          </div>
          {error && <p style={{ fontSize: '13px', color: '#e53e3e', margin: '8px 0 0', background: '#fff5f5', padding: '8px', borderRadius: '6px' }}>❌ {error}</p>}
        </div>
      ) : (
        <div>
          {loading && <p style={{ fontSize: '13px', color: '#718096', margin: '4px 0' }}>Loading account data...</p>}
          {account && meta && (
            <div>
              {lastUpdated && <p style={{ fontSize: '11px', color: '#a0aec0', margin: '0 0 8px' }}>Last updated: {lastUpdated}</p>}
              <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '10px 12px' }}>
                {[['Public Key', <span style={{ fontSize: '11px', fontFamily: 'monospace', wordBreak: 'break-all' }}>{savedKey}</span>], ['Balance', <span style={{ color: '#38a169', fontWeight: 600 }}>{meta.balance?.toString()} THRU</span>], ['Nonce', meta.nonce?.toString()], ['Seq', meta.seq?.toString()]].map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f0f0f0', gap: '8px' }}>
                    <span style={{ fontSize: '13px', color: '#4a5568', fontWeight: 500, flexShrink: 0 }}>{label}</span>
                    <span style={{ fontSize: '13px', color: '#1a202c', textAlign: 'right' }}>{value}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <span style={{ fontSize: '13px', color: '#4a5568', fontWeight: 500 }}>Is New</span>
                  <Badge value={flags?.isNew} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' }}>
                  <span style={{ fontSize: '13px', color: '#4a5568', fontWeight: 500 }}>Is Program</span>
                  <Badge value={flags?.isProgram} />
                </div>
              </div>
              <button onClick={() => onLookup(savedKey)} style={{ marginTop: '10px', fontSize: '12px', color: '#3182ce', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>View full details in Account Lookup ↓</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AccountLookup({ prefillKey, onPrefillUsed }) {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [account, setAccount] = useState(null)
  const [error, setError] = useState(null)
  const clientRef = useThruClient()

  useEffect(() => {
    if (prefillKey) { setInput(prefillKey); lookup(prefillKey); onPrefillUsed() }
  }, [prefillKey])

  const handleInputChange = (e) => { setInput(e.target.value); setAccount(null); setError(null) }
  const handleClear = () => { setInput(''); setAccount(null); setError(null) }

  const lookup = async (key) => {
    const target = (key || input).trim()
    if (!target) return
    setLoading(true)
    setError(null)
    setAccount(null)
    try {
      const ctx = clientRef.current || createThruClient({ url: RPC_URL })
      const result = await ctx.accounts.get(target)
      if (!result) throw new Error('No account data returned')
      setAccount(result)
    } catch (err) {
      setError(err.message || 'Could not fetch account. Make sure the public key is correct and the account exists on Thru alphanet.')
    } finally {
      setLoading(false)
    }
  }

  const meta = account?.meta
  const flags = meta?.flags

  const row = (label, value) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #e2e8f0', gap: '8px' }}>
      <span style={{ fontSize: '13px', color: '#4a5568', fontWeight: 500, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '13px', color: '#1a202c', textAlign: 'right', wordBreak: 'break-all' }}>{value ?? '—'}</span>
    </div>
  )

  const boolRow = (label, value) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #e2e8f0' }}>
      <span style={{ fontSize: '13px', color: '#4a5568', fontWeight: 500 }}>{label}</span>
      <Badge value={value} />
    </div>
  )

  return (
    <div style={{ background: '#f7fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px', marginTop: '16px' }}>
      <p style={{ margin: '0 0 4px' }}><strong>Account Lookup</strong></p>
      <p style={{ fontSize: '13px', color: '#718096', margin: '0 0 12px' }}>Paste any Thru public key to see full live on-chain account details.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '6px' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input value={input} onChange={handleInputChange} onKeyDown={(e) => e.key === 'Enter' && lookup()} placeholder="ta..." style={{ flex: 1, padding: '8px 12px', fontSize: '13px', border: '1px solid #cbd5e0', borderRadius: '6px', fontFamily: 'monospace', outline: 'none', minWidth: 0 }} />
          {input && <button onClick={handleClear} style={{ padding: '8px 12px', fontSize: '13px', backgroundColor: '#e2e8f0', color: '#4a5568', border: 'none', borderRadius: '6px', cursor: 'pointer', flexShrink: 0 }}>✕</button>}
        </div>
        <button onClick={() => lookup()} disabled={loading || !input.trim()} style={{ padding: '10px 16px', fontSize: '13px', backgroundColor: '#3182ce', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', opacity: (!input.trim() || loading) ? 0.6 : 1 }}>{loading ? 'Loading...' : 'Look Up'}</button>
      </div>

      {error && <p style={{ fontSize: '13px', color: '#e53e3e', margin: '8px 0 0', background: '#fff5f5', padding: '10px', borderRadius: '6px' }}>❌ {error}</p>}

      {account && meta && (
        <div style={{ marginTop: '12px', background: 'white', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '12px' }}>
          <p style={{ margin: '0 0 8px', fontSize: '13px', fontWeight: 700, color: '#2d3748' }}>✅ Account Found</p>
          {row('Public Key', input.trim())}
          {row('Balance', `${meta.balance?.toString()} THRU`)}
          {row('Data Size', meta.dataSize?.toString())}
          {row('Nonce', meta.nonce?.toString())}
          {row('Seq', meta.seq?.toString())}
          {row('Version', meta.version?.toString())}
          {flags && boolRow('Is Program', flags.isProgram)}
          {flags && boolRow('Is New', flags.isNew)}
          {flags && boolRow('Is Ephemeral', flags.isEphemeral)}
          {flags && boolRow('Is Deleted', flags.isDeleted)}
          {flags && boolRow('Is Privileged', flags.isPrivileged)}
          {flags && boolRow('Is Compressed', flags.isCompressed)}
        </div>
      )}
    </div>
  )
}

function GuidePanel() {
  const [open, setOpen] = useState(false)
  const [openStep, setOpenStep] = useState(null)
  return (
    <div style={{ background: 'linear-gradient(135deg, #1a202c 0%, #2d3748 100%)', border: '1px solid #4a5568', borderRadius: '12px', padding: '20px', marginTop: '16px' }}>
      <button onClick={() => setOpen(!open)} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 0 }}>
        <span style={{ fontWeight: 700, fontSize: '15px', color: '#90cdf4' }}>How to Create a CLI Wallet</span>
        <span style={{ fontSize: '16px', color: '#90cdf4' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ marginTop: '14px' }}>
          <p style={{ fontSize: '12px', color: '#a0aec0', margin: '0 0 12px' }}>Windows guide — macOS coming soon</p>
          {steps.map((step) => (
            <div key={step.number} style={{ marginBottom: '8px', border: '1px solid #4a5568', borderRadius: '6px', overflow: 'hidden', background: '#2d3748' }}>
              <button onClick={() => setOpenStep(openStep === step.number ? null : step.number)} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                  <span style={{ display: 'inline-block', width: '20px', height: '20px', background: '#3182ce', color: 'white', borderRadius: '50%', fontSize: '11px', textAlign: 'center', lineHeight: '20px', marginRight: '8px' }}>{step.number}</span>
                  {step.title}
                </span>
                <span style={{ fontSize: '12px', color: '#a0aec0' }}>{openStep === step.number ? '▲' : '▼'}</span>
              </button>
              {openStep === step.number && (
                <div style={{ padding: '0 12px 12px', borderTop: '1px solid #4a5568' }}>
                  <p style={{ fontSize: '12px', color: '#cbd5e0', margin: '10px 0 8px', lineHeight: 1.6 }}>{step.description}</p>
                  {step.linkUrl && <ExternalLink url={step.linkUrl} label={step.linkLabel} />}
                  {step.note && (
                    <div style={{ marginBottom: '8px', background: '#744210', border: '1px solid #f6e05e', borderRadius: '4px', padding: '8px 10px' }}>
                      <p style={{ fontSize: '11px', color: '#fefcbf', margin: '0 0 6px' }}>⚠️ {step.note}</p>
                      <CodeBlock code={step.noteCommand} />
                    </div>
                  )}
                  {step.command && <div style={{ marginBottom: '8px' }}><p style={{ fontSize: '11px', color: '#a0aec0', margin: '0 0 4px' }}>Run in terminal:</p><CodeBlock code={step.command} /></div>}
                  {step.verify && <div><p style={{ fontSize: '11px', color: '#a0aec0', margin: '0 0 4px' }}>Verify with:</p><CodeBlock code={step.verify} color="#fbd38d" /></div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function App() {
  const { connect, disconnect, isConnected, isConnecting, wallet } = useWallet()
  const [signingContext, setSigningContext] = useState(null)
  const [loadingContext, setLoadingContext] = useState(false)
  const [lookupPrefill, setLookupPrefill] = useState(null)

  const handleGetSigningContext = async () => { try { setLoadingContext(true); const context = await wallet.getSigningContext(); setSigningContext(context) } catch (err) { console.error(err) } finally { setLoadingContext(false) } }
  const cardStyle = { background: '#f7fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px', marginTop: '16px' }
  const btnStyle = (color) => ({ padding: '10px 20px', fontSize: '15px', backgroundColor: color, color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', marginTop: '12px', marginRight: '10px' })

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '680px', margin: '0 auto', boxSizing: 'border-box' }}>
      <h1 style={{ marginBottom: '4px', fontSize: 'clamp(24px, 5vw, 32px)' }}>ThruScan</h1>
      <p style={{ color: '#718096', marginTop: 0, fontSize: '14px' }}>Connected to Thru Alphanet</p>

      <DevAccountCard onLookup={(key) => setLookupPrefill(key)} />

      <div style={cardStyle}>
        <p style={{ margin: '0 0 8px' }}><strong>Embedded Wallet (Browser)</strong></p>
        {isConnected ? (
          <div>
            <p style={{ color: '#38a169', margin: '0 0 12px' }}>✅ Connected</p>
            {signingContext ? (
              <div style={{ fontSize: '13px', lineHeight: 1.8 }}>
                <p style={{ margin: 0 }}><strong>Fee Payer:</strong></p>
                <p style={{ fontSize: '11px', wordBreak: 'break-all', background: '#edf2f7', padding: '8px', borderRadius: '4px', margin: '4px 0 8px', fontFamily: 'monospace' }}>{signingContext.feePayerPublicKey}</p>
                <p style={{ margin: 0 }}><strong>Mode:</strong> {signingContext.mode}</p>
              </div>
            ) : (
              <button onClick={handleGetSigningContext} disabled={loadingContext} style={btnStyle('#38a169')}>{loadingContext ? 'Loading...' : 'Load Wallet Details'}</button>
            )}
            <br />
            <button onClick={disconnect} style={btnStyle('#e53e3e')}>Disconnect</button>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: '13px', color: '#555', margin: '0 0 4px' }}>Connect to interact with the Thru network from your browser.</p>
            <p style={{ fontSize: '13px', color: '#555', margin: '0 0 8px' }}>{"Don't have a wallet yet? "}<WalletLink /></p>
            <button onClick={() => connect({ metadata: { appId: window.location.origin, appName: 'ThruScan', appUrl: window.location.origin } })} disabled={isConnecting} style={{ ...btnStyle('#3182ce'), marginRight: 0, width: '100%' }}>{isConnecting ? 'Connecting...' : 'Connect Thru Wallet'}</button>
          </div>
        )}
      </div>

      <AccountLookup prefillKey={lookupPrefill} onPrefillUsed={() => setLookupPrefill(null)} />

      <GuidePanel />
    </div>
  )
}

export default App
