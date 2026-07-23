import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { useWallet } from '@thru/react-sdk'
import { createThruClient } from '@thru/thru-sdk'

const RPC_ENDPOINTS = [
  'https://rpc.alphanet.thru.org',
  'https://grpc-web.alphanet.thru.org',
  'https://grpc-web.alphanet.thruput.org',
]

let cachedWorkingUrl = null

async function fetchAccountFromChain(address) {
  const ordered = cachedWorkingUrl
    ? [cachedWorkingUrl, ...RPC_ENDPOINTS.filter(u => u !== cachedWorkingUrl)]
    : RPC_ENDPOINTS
  let lastErr = null
  for (const url of ordered) {
    try {
      const ctx = createThruClient({ url })
      const result = await ctx.accounts.get(address)
      if (result) {
        cachedWorkingUrl = url
        return result
      }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('Could not reach any Thru RPC endpoint')
}

const STORAGE_KEY = 'thru_dev_account_pubkey'
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/Unto-Labs/thru/releases?per_page=10'

const steps = [
  { number: 1, title: 'Install Node.js', description: 'The Thru CLI now ships as an npm package, so Node.js is the only prerequisite. Download the LTS installer, run it, then close and reopen your terminal.', note: null, noteCommand: null, linkLabel: 'Download Node.js', linkUrl: 'https://nodejs.org', command: null, verify: 'node -v' },
  { number: 2, title: 'Install the Thru CLI', description: 'One command, no compiling. If you previously installed Thru with cargo, that older binary may still shadow this one in your PATH — check the version after installing and reinstall with cargo if it looks stale.', note: 'Already have an old cargo-built CLI? Update it directly instead:', noteCommand: 'cargo install thru', linkLabel: null, linkUrl: null, command: 'npm install -g thru', verify: 'thru --version' },
  { number: 3, title: 'Check Your Connection', description: 'The CLI auto-configures on first run and writes a config file to ~/.thru/cli/config.yaml. This command confirms you can reach the network. If it returns a DNS error, open that config file and set rpc_base_url to https://rpc.alphanet.thru.org', note: null, noteCommand: null, linkLabel: null, linkUrl: null, command: 'thru --json getversion', verify: null },
  { number: 4, title: 'Generate a Keypair', description: 'Creates a cryptographic key pair stored locally. The name is just a label, use anything you like. Your private key is written to the config file in plaintext, so treat that file like a seed phrase and never share or commit it.', note: 'Need to retrieve an existing private key? Run:', noteCommand: 'thru keys get default', linkLabel: null, linkUrl: null, command: 'thru keys generate default', verify: 'thru --json keys list' },
  { number: 5, title: 'Create Your On-Chain Account', description: 'Registers your keypair as a real account on alphanet. If the command times out, do not immediately retry — check with the verify command first, since the transaction often lands anyway.', note: null, noteCommand: null, linkLabel: null, linkUrl: null, command: 'thru --json account create default', verify: 'thru --json getaccountinfo default' },
  { number: 6, title: 'Get Faucet Tokens', description: 'Funds your account with test tokens. Max is 10,000 per call, and these tokens have no value outside alphanet. You can send them back with: thru faucet deposit default 1000', note: null, noteCommand: null, linkLabel: null, linkUrl: null, command: 'thru --json faucet withdraw default 10000', verify: 'thru --json getaccountinfo default' },
  { number: 7, title: 'Using a Non-Default Key', description: 'Most commands assume a key literally named "default" as the fee payer and signer. If you generated a key under any other name, you must pass it explicitly or you will hit a "creator must match the fee payer" error.', note: 'Example — minting a token with a key named newkey:', noteCommand: 'thru --json token initialize-mint PUBKEY CAT SEED --fee-payer newkey', linkLabel: null, linkUrl: null, command: null, verify: null },
  { number: 8, title: 'Beyond the Basics', description: 'Building and deploying C programs to ThruVM requires the RISC-V toolchain, which is Linux and macOS only. On Windows you will need WSL2 first. Token minting and name service registration both work fine from plain Windows PowerShell.', note: null, noteCommand: null, linkLabel: 'Thru Docs', linkUrl: 'https://docs.thru.org', command: null, verify: null },
]

const FEATURED_CONTENT = [
  {
    id: 1,
    type: 'Article',
    title: 'Introducing ThruScan: The First Community Explorer for Thru Alphanet',
    description: 'A deep dive into what Thru is building, why RISC-V matters, and how ThruScan was built on Thru alphanet SDK.',
    link: 'https://greyy.substack.com',
    author: 'pgreyy',
    twitter: 'pgreyy',
  },
]

function NavBar() {
  const location = useLocation()
  const path = location.pathname
  const links = [
    { to: '/', label: 'Explorer' },
    { to: '/updates', label: 'Network Updates' },
    { to: '/projects', label: 'Projects' },
    { to: '/community', label: 'Community' },
  ]
  return (
    <div style={{ background: '#0d1117', borderBottom: '1px solid #30363d', padding: '0 20px', position: 'sticky', top: 0, zIndex: 100 }}>
      <div style={{ maxWidth: '900px', margin: '0 auto', display: 'flex', alignItems: 'center', gap: '8px', height: '52px', overflowX: 'auto' }}>
        <Link to="/" style={{ textDecoration: 'none', marginRight: '12px', flexShrink: 0 }}>
          <span style={{ fontWeight: 800, fontSize: '16px', color: '#e6edf3', letterSpacing: '-0.3px' }}>ThruScan</span>
        </Link>
        {links.map(l => (
          <Link key={l.to} to={l.to} style={{ textDecoration: 'none', padding: '6px 12px', borderRadius: '6px', fontSize: '13px', fontWeight: 500, color: path === l.to ? '#e6edf3' : '#8b949e', background: path === l.to ? '#21262d' : 'none', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {l.label}
          </Link>
        ))}
      </div>
    </div>
  )
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }
  return <button onClick={handleCopy} style={{ padding: '3px 10px', fontSize: '11px', backgroundColor: copied ? '#38a169' : '#4a5568', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', marginLeft: '8px', whiteSpace: 'nowrap' }}>{copied ? 'Copied!' : 'Copy'}</button>
}

function CodeBlock({ code, color }) {
  return <div style={{ background: '#1a202c', borderRadius: '4px', padding: '8px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px', overflowX: 'auto' }}><code style={{ fontSize: '12px', color: color || '#68d391', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{code}</code><CopyButton text={code} /></div>
}

function ExternalLink({ url, label }) {
  return <p style={{ margin: '0 0 8px' }}><a href={url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '12px', color: '#3182ce', textDecoration: 'underline' }}>{label}</a></p>
}

function WalletLink() {
  return <a href="https://wallet.thru.org" target="_blank" rel="noopener noreferrer" style={{ color: '#3182ce', textDecoration: 'underline' }}>Create an embedded wallet</a>
}

function Badge({ value }) {
  const yes = value === true
  return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, backgroundColor: yes ? '#c6f6d5' : '#fed7d7', color: yes ? '#276749' : '#9b2c2c' }}>{yes ? 'Yes' : 'No'}</span>
}

function TagBadge({ label, color }) {
  const colors = {
    blue: { bg: '#dbeafe', text: '#1e40af' },
    green: { bg: '#d1fae5', text: '#065f46' },
    purple: { bg: '#ede9fe', text: '#5b21b6' },
    orange: { bg: '#ffedd5', text: '#9a3412' },
    gray: { bg: '#f3f4f6', text: '#374151' },
  }
  const c = colors[color] || colors.gray
  return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, backgroundColor: c.bg, color: c.text }}>{label}</span>
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return days + ' days ago'
  if (days < 30) return Math.floor(days / 7) + ' week(s) ago'
  return Math.floor(days / 30) + ' months ago'
}

function FormInput({ label, value, onChange, placeholder, required, type }) {
  return (
    <div style={{ marginBottom: '12px' }}>
      <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
        {label}{required && <span style={{ color: '#e53e3e' }}> *</span>}
      </label>
      {type === 'textarea' ? (
        <textarea value={value} onChange={onChange} placeholder={placeholder} rows={3} style={{ width: '100%', padding: '8px 12px', fontSize: '13px', border: '1px solid #cbd5e0', borderRadius: '6px', outline: 'none', boxSizing: 'border-box', fontFamily: 'sans-serif', resize: 'vertical' }} />
      ) : (
        <input type={type || 'text'} value={value} onChange={onChange} placeholder={placeholder} style={{ width: '100%', padding: '8px 12px', fontSize: '13px', border: '1px solid #cbd5e0', borderRadius: '6px', outline: 'none', boxSizing: 'border-box' }} />
      )}
    </div>
  )
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

  const load = async (key, isRefresh) => {
    if (!key) return
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const result = await fetchAccountFromChain(key)
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

  useEffect(() => { if (savedKey) load(savedKey) }, [])

  const handleSave = async () => {
    const key = input.trim()
    if (!key) return
    setLoading(true)
    setError(null)
    try {
      const result = await fetchAccountFromChain(key)
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
            <button onClick={() => load(savedKey, true)} disabled={refreshing} style={{ fontSize: '12px', color: '#38a169', background: 'none', border: '1px solid #38a169', borderRadius: '4px', cursor: 'pointer', padding: '2px 8px' }}>{refreshing ? 'Refreshing...' : 'Refresh'}</button>
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
          {error && <p style={{ fontSize: '13px', color: '#e53e3e', margin: '8px 0 0', background: '#fff5f5', padding: '8px', borderRadius: '6px' }}>{error}</p>}
        </div>
      ) : (
        <div>
          {loading && <p style={{ fontSize: '13px', color: '#718096', margin: '4px 0' }}>Loading account data...</p>}
          {error && !loading && <p style={{ fontSize: '13px', color: '#e53e3e', margin: '8px 0 0', background: '#fff5f5', padding: '8px', borderRadius: '6px' }}>{error}</p>}
          {account && meta && (
            <div>
              {lastUpdated && <p style={{ fontSize: '11px', color: '#a0aec0', margin: '0 0 8px' }}>Last updated: {lastUpdated}</p>}
              <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f0f0f0', gap: '8px' }}>
                  <span style={{ fontSize: '13px', color: '#4a5568', fontWeight: 500, flexShrink: 0 }}>Public Key</span>
                  <span style={{ fontSize: '11px', fontFamily: 'monospace', wordBreak: 'break-all', textAlign: 'right' }}>{savedKey}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <span style={{ fontSize: '13px', color: '#4a5568', fontWeight: 500 }}>Balance</span>
                  <span style={{ fontSize: '13px', color: '#38a169', fontWeight: 600 }}>{meta.balance?.toString()} THRU</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <span style={{ fontSize: '13px', color: '#4a5568', fontWeight: 500 }}>Nonce</span>
                  <span style={{ fontSize: '13px', color: '#1a202c' }}>{meta.nonce?.toString()}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <span style={{ fontSize: '13px', color: '#4a5568', fontWeight: 500 }}>Seq</span>
                  <span style={{ fontSize: '13px', color: '#1a202c' }}>{meta.seq?.toString()}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <span style={{ fontSize: '13px', color: '#4a5568', fontWeight: 500 }}>Is New</span>
                  <Badge value={flags?.isNew} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' }}>
                  <span style={{ fontSize: '13px', color: '#4a5568', fontWeight: 500 }}>Is Program</span>
                  <Badge value={flags?.isProgram} />
                </div>
              </div>
              <button onClick={() => onLookup(savedKey)} style={{ marginTop: '10px', fontSize: '12px', color: '#3182ce', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>View full details in Account Lookup</button>
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

  const lookup = async (key) => {
    const target = (key || input).trim()
    if (!target) return
    setLoading(true)
    setError(null)
    setAccount(null)
    try {
      const result = await fetchAccountFromChain(target)
      setAccount(result)
    } catch (err) {
      setError('Could not fetch account. Make sure the public key is correct and the account exists on Thru alphanet.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (prefillKey) { setInput(prefillKey); lookup(prefillKey); onPrefillUsed() }
  }, [prefillKey])

  const handleInputChange = (e) => { setInput(e.target.value); setAccount(null); setError(null) }
  const handleClear = () => { setInput(''); setAccount(null); setError(null) }

  const meta = account?.meta
  const flags = meta?.flags

  const row = (label, value) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #e2e8f0', gap: '8px' }}>
      <span style={{ fontSize: '13px', color: '#4a5568', fontWeight: 500, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '13px', color: '#1a202c', textAlign: 'right', wordBreak: 'break-all' }}>{value ?? '-'}</span>
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
          {input && <button onClick={handleClear} style={{ padding: '8px 12px', fontSize: '13px', backgroundColor: '#e2e8f0', color: '#4a5568', border: 'none', borderRadius: '6px', cursor: 'pointer', flexShrink: 0 }}>X</button>}
        </div>
        <button onClick={() => lookup()} disabled={loading || !input.trim()} style={{ padding: '10px 16px', fontSize: '13px', backgroundColor: '#3182ce', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', opacity: (!input.trim() || loading) ? 0.6 : 1 }}>{loading ? 'Loading...' : 'Look Up'}</button>
      </div>
      {error && <p style={{ fontSize: '13px', color: '#e53e3e', margin: '8px 0 0', background: '#fff5f5', padding: '10px', borderRadius: '6px' }}>{error}</p>}
      {account && meta && (
        <div style={{ marginTop: '12px', background: 'white', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '12px' }}>
          <p style={{ margin: '0 0 8px', fontSize: '13px', fontWeight: 700, color: '#2d3748' }}>Account Found</p>
          {row('Public Key', input.trim())}
          {row('Balance', meta.balance?.toString() + ' THRU')}
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
        <span style={{ fontSize: '16px', color: '#90cdf4' }}>{open ? '-' : '+'}</span>
      </button>
      {open && (
        <div style={{ marginTop: '14px' }}>
          <p style={{ fontSize: '12px', color: '#a0aec0', margin: '0 0 12px' }}>Works on Windows, macOS and Linux</p>
          {steps.map((step) => (
            <div key={step.number} style={{ marginBottom: '8px', border: '1px solid #4a5568', borderRadius: '6px', overflow: 'hidden', background: '#2d3748' }}>
              <button onClick={() => setOpenStep(openStep === step.number ? null : step.number)} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
                  <span style={{ display: 'inline-block', width: '20px', height: '20px', background: '#3182ce', color: 'white', borderRadius: '50%', fontSize: '11px', textAlign: 'center', lineHeight: '20px', marginRight: '8px' }}>{step.number}</span>
                  {step.title}
                </span>
                <span style={{ fontSize: '12px', color: '#a0aec0' }}>{openStep === step.number ? '-' : '+'}</span>
              </button>
              {openStep === step.number && (
                <div style={{ padding: '0 12px 12px', borderTop: '1px solid #4a5568' }}>
                  <p style={{ fontSize: '12px', color: '#cbd5e0', margin: '10px 0 8px', lineHeight: 1.6 }}>{step.description}</p>
                  {step.linkUrl && <ExternalLink url={step.linkUrl} label={step.linkLabel} />}
                  {step.note && (
                    <div style={{ marginBottom: '8px', background: '#744210', border: '1px solid #f6e05e', borderRadius: '4px', padding: '8px 10px' }}>
                      <p style={{ fontSize: '11px', color: '#fefcbf', margin: '0 0 6px' }}>{step.note}</p>
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

function UpdatesPage() {
  const [releases, setReleases] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [openRelease, setOpenRelease] = useState(null)
  const [summaries, setSummaries] = useState({})
  const [loadingSummary, setLoadingSummary] = useState({})
  const [refreshing, setRefreshing] = useState(false)

  const fetchReleases = async (isRefresh) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const r = await fetch(GITHUB_RELEASES_URL)
      if (!r.ok) throw new Error('Failed to fetch')
      const data = await r.json()
      setReleases(data)
    } catch (err) {
      setError('Could not load releases.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => { fetchReleases() }, [])

  const fetchSummary = async (release) => {
    if (summaries[release.id] || loadingSummary[release.id]) return
    setLoadingSummary(prev => ({ ...prev, [release.id]: true }))
    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagName: release.tag_name, publishedAt: release.published_at, releaseName: release.name }),
      })
      const data = await res.json()
      setSummaries(prev => ({ ...prev, [release.id]: data.summary || 'Summary unavailable.' }))
    } catch {
      setSummaries(prev => ({ ...prev, [release.id]: 'Could not generate summary.' }))
    } finally {
      setLoadingSummary(prev => ({ ...prev, [release.id]: false }))
    }
  }

  const handleToggle = (release) => {
    const isOpening = openRelease !== release.id
    setOpenRelease(isOpening ? release.id : null)
    if (isOpening) fetchSummary(release)
  }

  return (
    <div style={{ padding: '24px 20px', maxWidth: '680px', margin: '0 auto', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h1 style={{ margin: '0 0 4px', fontSize: 'clamp(20px, 5vw, 26px)' }}>Thru Network Updates</h1>
          <p style={{ margin: 0, fontSize: '13px', color: '#8b949e' }}>Live releases from Unto Labs GitHub, refreshed on every visit</p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => fetchReleases(true)} disabled={refreshing} style={{ fontSize: '12px', color: '#58a6ff', background: 'none', border: '1px solid #30363d', borderRadius: '6px', cursor: 'pointer', padding: '6px 12px' }}>{refreshing ? 'Refreshing...' : 'Refresh'}</button>
          <a href="https://github.com/Unto-Labs/thru/releases" target="_blank" rel="noopener noreferrer" style={{ fontSize: '12px', color: '#58a6ff', textDecoration: 'none', border: '1px solid #30363d', borderRadius: '6px', padding: '6px 12px' }}>GitHub</a>
        </div>
      </div>
      {loading && <p style={{ color: '#8b949e', fontSize: '13px', textAlign: 'center', padding: '40px 0' }}>Loading releases...</p>}
      {error && <p style={{ color: '#f85149', fontSize: '13px' }}>{error}</p>}
      {!loading && !error && releases.map((release, i) => (
        <div key={release.id} style={{ marginBottom: '10px', border: '1px solid #30363d', borderRadius: '8px', overflow: 'hidden', background: '#161b22' }}>
          <button onClick={() => handleToggle(release)} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              {i === 0 && <span style={{ fontSize: '10px', fontWeight: 700, backgroundColor: '#238636', color: 'white', padding: '2px 7px', borderRadius: '12px' }}>LATEST</span>}
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#58a6ff', fontFamily: 'monospace' }}>{release.tag_name}</span>
              <span style={{ fontSize: '12px', color: '#8b949e' }}>{timeAgo(release.published_at)}</span>
            </div>
            <span style={{ fontSize: '12px', color: '#8b949e', flexShrink: 0 }}>{openRelease === release.id ? '-' : '+'}</span>
          </button>
          {openRelease === release.id && (
            <div style={{ padding: '0 16px 16px', borderTop: '1px solid #30363d' }}>
              <div style={{ marginTop: '12px', background: '#0d1117', borderRadius: '6px', padding: '12px' }}>
                <p style={{ margin: '0 0 6px', fontSize: '11px', color: '#58a6ff', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>AI Summary</p>
                {loadingSummary[release.id] ? (
                  <p style={{ fontSize: '13px', color: '#8b949e', margin: 0 }}>Generating summary...</p>
                ) : (
                  <p style={{ fontSize: '13px', color: '#c9d1d9', margin: 0, lineHeight: 1.7 }}>{summaries[release.id] || 'Loading...'}</p>
                )}
              </div>
              <div style={{ marginTop: '10px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                <a href={release.html_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '12px', color: '#58a6ff', textDecoration: 'underline' }}>View on GitHub</a>
                <span style={{ fontSize: '12px', color: '#8b949e' }}>{new Date(release.published_at).toLocaleDateString()}</span>
              </div>
            </div>
          )}
        </div>
      ))}
      <div style={{ marginTop: '16px', textAlign: 'center' }}>
        <p style={{ fontSize: '11px', color: '#8b949e', margin: 0 }}>Summaries are AI-generated from version and release date. They may not reflect exact changes.</p>
      </div>
    </div>
  )
}

function ProjectsPage() {
  const PROJECTS = []
  const [form, setForm] = useState({ name: '', yourTwitter: '', projectName: '', projectTwitter: '', projectWebsite: '', founderDetails: '', yourRelationship: '' })
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState(null)
  const [showForm, setShowForm] = useState(false)

  const handleSubmit = async () => {
    if (!form.name || !form.projectName) { setError('Your name and project name are required.'); return }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/submit-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      const data = await res.json()
      if (data.success) { setSubmitted(true); setForm({ name: '', yourTwitter: '', projectName: '', projectTwitter: '', projectWebsite: '', founderDetails: '', yourRelationship: '' }) }
      else setError(data.error || 'Submission failed.')
    } catch (err) {
      setError('Something went wrong. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ padding: '24px 20px', maxWidth: '900px', margin: '0 auto', boxSizing: 'border-box' }}>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 'clamp(20px, 5vw, 26px)' }}>Projects on Thru</h1>
        <p style={{ margin: 0, fontSize: '13px', color: '#718096' }}>Teams and tools building on the Thru network. Know a project? Suggest it below.</p>
      </div>
      {PROJECTS.length === 0 && (
        <div style={{ background: '#f7fafc', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '48px 24px', textAlign: 'center', marginBottom: '24px' }}>
          <p style={{ fontWeight: 600, fontSize: '15px', color: '#2d3748', margin: '0 0 8px' }}>No projects listed yet</p>
          <p style={{ fontSize: '13px', color: '#718096', margin: '0 0 16px' }}>Thru is in alphanet, the ecosystem is just getting started. Know something being built? Suggest it below.</p>
          <button onClick={() => setShowForm(true)} style={{ padding: '10px 20px', fontSize: '13px', backgroundColor: '#3182ce', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>Suggest a Project</button>
        </div>
      )}
      <div style={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: '12px', padding: '20px' }}>
        <button onClick={() => setShowForm(!showForm)} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 0 }}>
          <span style={{ fontWeight: 700, fontSize: '15px', color: '#90cdf4' }}>Suggest a Project</span>
          <span style={{ fontSize: '16px', color: '#90cdf4' }}>{showForm ? '-' : '+'}</span>
        </button>
        <p style={{ fontSize: '12px', color: '#8b949e', margin: '6px 0 0' }}>Know a team or tool building on Thru? Submit it for review.</p>
        {showForm && (
          <div style={{ marginTop: '16px' }}>
            {submitted ? (
              <div style={{ background: '#1a4731', border: '1px solid #38a169', borderRadius: '8px', padding: '16px', textAlign: 'center' }}>
                <p style={{ color: '#68d391', fontWeight: 600, margin: '0 0 4px' }}>Suggestion submitted</p>
                <p style={{ color: '#9ae6b4', fontSize: '13px', margin: 0 }}>Thanks for the tip. We will review and add it if it checks out.</p>
                <button onClick={() => setSubmitted(false)} style={{ marginTop: '12px', fontSize: '12px', color: '#68d391', background: 'none', border: '1px solid #38a169', borderRadius: '4px', cursor: 'pointer', padding: '4px 12px' }}>Submit another</button>
              </div>
            ) : (
              <div>
                <FormInput label="Your Name" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Your name" required />
                <FormInput label="Your Twitter" value={form.yourTwitter} onChange={e => setForm(p => ({ ...p, yourTwitter: e.target.value }))} placeholder="handle without the at sign" />
                <FormInput label="Project Name" value={form.projectName} onChange={e => setForm(p => ({ ...p, projectName: e.target.value }))} placeholder="Project name" required />
                <FormInput label="Project Twitter" value={form.projectTwitter} onChange={e => setForm(p => ({ ...p, projectTwitter: e.target.value }))} placeholder="handle without the at sign" />
                <FormInput label="Project Website" value={form.projectWebsite} onChange={e => setForm(p => ({ ...p, projectWebsite: e.target.value }))} placeholder="https://" type="url" />
                <FormInput label="Founder Details" value={form.founderDetails} onChange={e => setForm(p => ({ ...p, founderDetails: e.target.value }))} placeholder="Founder names, Twitter, background" type="textarea" />
                <FormInput label="Your Relationship to the Project" value={form.yourRelationship} onChange={e => setForm(p => ({ ...p, yourRelationship: e.target.value }))} placeholder="Founder, community member, observer" />
                {error && <p style={{ fontSize: '13px', color: '#fc8181', margin: '0 0 12px', background: '#742a2a', padding: '8px', borderRadius: '6px' }}>{error}</p>}
                <button onClick={handleSubmit} disabled={submitting} style={{ width: '100%', padding: '10px', fontSize: '14px', backgroundColor: submitting ? '#4a5568' : '#3182ce', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>{submitting ? 'Submitting...' : 'Submit Suggestion'}</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function CommunityPage() {
  const [records, setRecords] = useState([])
  const [loadingRecords, setLoadingRecords] = useState(true)
  const [form, setForm] = useState({ name: '', yourTwitter: '', contentTitle: '', contentLink: '', description: '', contentType: 'Article' })
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [activeTab, setActiveTab] = useState('featured')

  useEffect(() => {
    fetch('/api/get-community').then(r => r.json()).then(data => { setRecords(data.records || []); setLoadingRecords(false) }).catch(() => setLoadingRecords(false))
  }, [])

  const handleSubmit = async () => {
    if (!form.name || !form.contentTitle || !form.contentLink) { setError('Name, title and link are required.'); return }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/submit-community', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      const data = await res.json()
      if (data.success) { setSubmitted(true); setForm({ name: '', yourTwitter: '', contentTitle: '', contentLink: '', description: '', contentType: 'Article' }) }
      else setError(data.error || 'Submission failed.')
    } catch (err) {
      setError('Something went wrong. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const typeColor = { Article: 'blue', Thread: 'purple', Video: 'green', Tool: 'orange', Other: 'gray' }

  const ContentCard = ({ item }) => (
    <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px', gap: '8px' }}>
        <a href={item.link} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 600, fontSize: '14px', color: '#1a202c', textDecoration: 'none', lineHeight: 1.4 }}>{item.title}</a>
        <TagBadge label={item.type} color={typeColor[item.type] || 'gray'} />
      </div>
      {item.description && <p style={{ fontSize: '13px', color: '#4a5568', margin: '0 0 10px', lineHeight: 1.5 }}>{item.description}</p>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <a href={'https://twitter.com/' + (item.twitter || item.author)} target="_blank" rel="noopener noreferrer" style={{ fontSize: '12px', color: '#718096', textDecoration: 'none' }}>{item.twitter || item.author}</a>
        <a href={item.link} target="_blank" rel="noopener noreferrer" style={{ fontSize: '12px', color: '#3182ce', textDecoration: 'none' }}>Read</a>
      </div>
    </div>
  )

  const tabStyle = (active) => ({ padding: '8px 16px', fontSize: '13px', fontWeight: 500, border: 'none', borderBottom: active ? '2px solid #3182ce' : '2px solid transparent', background: 'none', color: active ? '#3182ce' : '#718096', cursor: 'pointer' })

  return (
    <div style={{ padding: '24px 20px', maxWidth: '900px', margin: '0 auto', boxSizing: 'border-box' }}>
      <div style={{ marginBottom: '20px' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 'clamp(20px, 5vw, 26px)' }}>Community</h1>
        <p style={{ margin: 0, fontSize: '13px', color: '#718096' }}>Educational content, threads, tools, and community work around the Thru ecosystem.</p>
      </div>
      <div style={{ borderBottom: '1px solid #e2e8f0', marginBottom: '20px', display: 'flex', gap: '4px' }}>
        <button style={tabStyle(activeTab === 'featured')} onClick={() => setActiveTab('featured')}>Featured and Evergreen</button>
        <button style={tabStyle(activeTab === 'community')} onClick={() => setActiveTab('community')}>Community Picks</button>
      </div>
      {activeTab === 'featured' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
          {FEATURED_CONTENT.map(item => <ContentCard key={item.id} item={item} />)}
        </div>
      )}
      {activeTab === 'community' && (
        <div>
          {loadingRecords ? (
            <p style={{ fontSize: '13px', color: '#718096', textAlign: 'center', padding: '32px 0' }}>Loading...</p>
          ) : records.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
              {records.map(item => <ContentCard key={item.id} item={item} />)}
            </div>
          ) : (
            <div style={{ background: '#f7fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '32px', textAlign: 'center' }}>
              <p style={{ fontWeight: 600, fontSize: '14px', color: '#2d3748', margin: '0 0 8px' }}>No community picks yet</p>
              <p style={{ fontSize: '13px', color: '#718096', margin: '0 0 16px' }}>Be the first to submit something worth reading.</p>
              <button onClick={() => setShowForm(true)} style={{ padding: '8px 16px', fontSize: '13px', backgroundColor: '#3182ce', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>Submit Content</button>
            </div>
          )}
        </div>
      )}
      <div style={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: '12px', padding: '20px', marginTop: '24px' }}>
        <button onClick={() => setShowForm(!showForm)} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 0 }}>
          <span style={{ fontWeight: 700, fontSize: '15px', color: '#90cdf4' }}>Submit Content</span>
          <span style={{ fontSize: '16px', color: '#90cdf4' }}>{showForm ? '-' : '+'}</span>
        </button>
        <p style={{ fontSize: '12px', color: '#8b949e', margin: '6px 0 0' }}>Articles, threads, videos, tools. Reviewed weekly.</p>
        {showForm && (
          <div style={{ marginTop: '16px' }}>
            {submitted ? (
              <div style={{ background: '#1a4731', border: '1px solid #38a169', borderRadius: '8px', padding: '16px', textAlign: 'center' }}>
                <p style={{ color: '#68d391', fontWeight: 600, margin: '0 0 4px' }}>Submitted</p>
                <p style={{ color: '#9ae6b4', fontSize: '13px', margin: 0 }}>Thanks for contributing. We review weekly and feature the best ones.</p>
                <button onClick={() => setSubmitted(false)} style={{ marginTop: '12px', fontSize: '12px', color: '#68d391', background: 'none', border: '1px solid #38a169', borderRadius: '4px', cursor: 'pointer', padding: '4px 12px' }}>Submit another</button>
              </div>
            ) : (
              <div>
                <FormInput label="Your Name" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Your name" required />
                <FormInput label="Your Twitter" value={form.yourTwitter} onChange={e => setForm(p => ({ ...p, yourTwitter: e.target.value }))} placeholder="handle without the at sign" />
                <FormInput label="Content Title" value={form.contentTitle} onChange={e => setForm(p => ({ ...p, contentTitle: e.target.value }))} placeholder="Title of your article, thread or tool" required />
                <FormInput label="Content Link" value={form.contentLink} onChange={e => setForm(p => ({ ...p, contentLink: e.target.value }))} placeholder="https://" type="url" required />
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>Content Type</label>
                  <select value={form.contentType} onChange={e => setForm(p => ({ ...p, contentType: e.target.value }))} style={{ width: '100%', padding: '8px 12px', fontSize: '13px', border: '1px solid #cbd5e0', borderRadius: '6px', outline: 'none', boxSizing: 'border-box' }}>
                    <option value="Article">Article</option>
                    <option value="Thread">Thread</option>
                    <option value="Video">Video</option>
                    <option value="Tool">Tool</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                <FormInput label="Brief Description" value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder="What is this about and why should people read it" type="textarea" />
                {error && <p style={{ fontSize: '13px', color: '#fc8181', margin: '0 0 12px', background: '#742a2a', padding: '8px', borderRadius: '6px' }}>{error}</p>}
                <button onClick={handleSubmit} disabled={submitting} style={{ width: '100%', padding: '10px', fontSize: '14px', backgroundColor: submitting ? '#4a5568' : '#3182ce', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>{submitting ? 'Submitting...' : 'Submit'}</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ExplorerPage() {
  const { connect, disconnect, isConnected, isConnecting, wallet } = useWallet()
  const [signingContext, setSigningContext] = useState(null)
  const [loadingContext, setLoadingContext] = useState(false)
  const [lookupPrefill, setLookupPrefill] = useState(null)

  const handleGetSigningContext = async () => {
    try { setLoadingContext(true); const context = await wallet.getSigningContext(); setSigningContext(context) }
    catch (err) { console.error(err) }
    finally { setLoadingContext(false) }
  }

  const cardStyle = { background: '#f7fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px', marginTop: '16px' }
  const btnStyle = (color) => ({ padding: '10px 20px', fontSize: '15px', backgroundColor: color, color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', marginTop: '12px', marginRight: '10px' })

  return (
    <div style={{ padding: '20px', maxWidth: '680px', margin: '0 auto', boxSizing: 'border-box' }}>
      <h1 style={{ marginBottom: '4px', fontSize: 'clamp(22px, 5vw, 28px)' }}>ThruScan</h1>
      <p style={{ color: '#718096', marginTop: 0, fontSize: '14px' }}>Connected to Thru Alphanet</p>
      <DevAccountCard onLookup={(key) => setLookupPrefill(key)} />
      <div style={cardStyle}>
        <p style={{ margin: '0 0 8px' }}><strong>Embedded Wallet (Browser)</strong></p>
        {isConnected ? (
          <div>
            <p style={{ color: '#38a169', margin: '0 0 12px' }}>Connected</p>
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
      <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #e2e8f0', textAlign: 'center' }}>
        <p style={{ fontSize: '12px', color: '#a0aec0', margin: '0 0 4px' }}>Built by <a href="https://twitter.com/pgreyy" target="_blank" rel="noopener noreferrer" style={{ color: '#3182ce', textDecoration: 'none' }}>pgreyy</a> and open source on <a href="https://github.com/pgreyy/thruscan" target="_blank" rel="noopener noreferrer" style={{ color: '#3182ce', textDecoration: 'none' }}>GitHub</a></p>
        <p style={{ fontSize: '11px', color: '#cbd5e0', margin: 0 }}>ThruScan is a community explorer for Thru alphanet, not affiliated with Unto Labs</p>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <div style={{ minHeight: '100vh', background: '#ffffff' }}>
        <NavBar />
        <Routes>
          <Route path="/" element={<ExplorerPage />} />
          <Route path="/updates" element={<UpdatesPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/community" element={<CommunityPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}
