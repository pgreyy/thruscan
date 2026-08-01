import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { getAccount, getBlockHeight } from './lib/rpcClient'
import { decodeNameServiceAccount, registrationDate } from './lib/nameservice'
import './styles.css'

// All chain reads go through /api/rpc, a serverless function that talks to the
// Thru node server to server. The node sends no CORS headers, so the browser
// can never call it directly.
async function fetchAccountFromChain(address) {
  return getAccount(address)
}

const STORAGE_KEY = 'thru_dev_account_pubkey'
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/Unto-Labs/thru/releases?per_page=10'

const NAV = [
  { to: '/', label: 'Explorer' },
  { to: '/updates', label: 'Updates' },
  { to: '/projects', label: 'Projects' },
  { to: '/community', label: 'Community' },
]

const steps = [
  { number: 1, title: 'Install Node.js', description: 'The Thru CLI now ships as an npm package, so Node.js is the only prerequisite. Download the LTS installer, run it, then close and reopen your terminal.', note: null, noteCommand: null, linkLabel: 'Download Node.js', linkUrl: 'https://nodejs.org', command: null, verify: 'node -v' },
  { number: 2, title: 'Install the Thru CLI', description: 'One command, no compiling. If you previously installed Thru with cargo, that older binary may still shadow this one in your PATH. Check the version after installing, and if it looks stale, run cargo uninstall thru to remove the old one.', note: 'Check which binary is actually running:', noteCommand: 'Get-Command thru -All', linkLabel: null, linkUrl: null, command: 'npm install -g thru', verify: 'thru --version' },
  { number: 3, title: 'Check your connection', description: 'The CLI auto-configures on first run and writes a config file to ~/.thru/cli/. This command confirms you can reach the network. If it returns a DNS error, pass the endpoint directly with --url https://rpc.alphanet.thru.org', note: null, noteCommand: null, linkLabel: null, linkUrl: null, command: 'thru --json getversion', verify: null },
  { number: 4, title: 'Generate a keypair', description: 'Creates a cryptographic key pair stored locally. The name is just a label, use anything you like. Your private key is written to the config file in plaintext, so treat that file like a seed phrase and never share or commit it.', note: 'Need to retrieve an existing private key? Run:', noteCommand: 'thru keys get default', linkLabel: null, linkUrl: null, command: 'thru keys generate default', verify: 'thru --json keys list' },
  { number: 5, title: 'Create your on-chain account', description: 'Registers your keypair as a real account on alphanet. If the command times out, check with the verify command before retrying, since the transaction often lands anyway.', note: null, noteCommand: null, linkLabel: null, linkUrl: null, command: 'thru --json account create default', verify: 'thru --json getaccountinfo default' },
  { number: 6, title: 'Get faucet tokens', description: 'Funds your account with test tokens. Max is 10,000 per call, and these tokens have no value outside alphanet. Send them back with: thru faucet deposit default 1000', note: null, noteCommand: null, linkLabel: null, linkUrl: null, command: 'thru --json faucet withdraw default 10000', verify: 'thru --json getaccountinfo default' },
  { number: 7, title: 'Using a non-default key', description: 'Most commands assume a key literally named "default" as the fee payer and signer. If you generated a key under any other name, pass it explicitly or you will hit a "creator must match the fee payer" error.', note: 'Example, minting a token with a key named newkey:', noteCommand: 'thru --json token initialize-mint PUBKEY CAT SEED --fee-payer newkey', linkLabel: null, linkUrl: null, command: null, verify: null },
  { number: 8, title: 'Register a name', description: 'The name service maps a readable name to an account. Claim a root, then register subdomains under it. Look the resulting account up in the Explorer to see its records decoded.', note: 'Then add records to it:', noteCommand: 'thru nameservice append-record DOMAIN_ACCOUNT url https://example.com --fee-payer newkey', linkLabel: null, linkUrl: null, command: 'thru nameservice init-root yourname --fee-payer newkey', verify: 'thru nameservice resolve DOMAIN_ACCOUNT --json' },
  { number: 9, title: 'Beyond the basics', description: 'Building and deploying C programs to ThruVM requires the RISC-V toolchain, which is Linux and macOS only. On Windows you will need WSL2 first. Token minting and name service registration both work from plain PowerShell.', note: null, noteCommand: null, linkLabel: 'Thru Docs', linkUrl: 'https://docs.thru.org', command: null, verify: null },
]

const FEATURED_CONTENT = [
  {
    id: 1,
    type: 'Article',
    title: 'Introducing ThruScan: The First Community Explorer for Thru Alphanet',
    description: 'A deep dive into what Thru is building, why RISC-V matters, and how ThruScan was built on the Thru alphanet SDK.',
    link: 'https://greyy.substack.com',
    author: 'pgreyy',
    twitter: 'pgreyy',
  },
]

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return days + ' days ago'
  if (days < 30) return Math.floor(days / 7) + ' weeks ago'
  return Math.floor(days / 30) + ' months ago'
}

/* ---------- primitives ---------- */

// The signature element. A Thru address is 46 characters of base64url behind a
// ta prefix, and it is the thing you spend the most time reading on this site,
// so it gets a real treatment instead of being dumped as plain text.
function Address({ value }) {
  const [copied, setCopied] = useState(false)
  if (!value) return <span className="row-v">-</span>

  const copy = () => {
    navigator.clipboard?.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <button className="addr" onClick={copy} title="Copy address">
      <span className="addr-body"><span className="addr-pre">{value.slice(0, 2)}</span>{value.slice(2)}</span>
      <span className="addr-note">{copied ? 'copied' : 'copy'}</span>
    </button>
  )
}

function Row({ k, v, mono }) {
  return (
    <div className="row">
      <span className="row-k">{k}</span>
      <span className={mono ? 'row-v num' : 'row-v'}>{v ?? '-'}</span>
    </div>
  )
}

function AddrRow({ k, v }) {
  return (
    <div className="row">
      <span className="row-k">{k}</span>
      <Address value={v} />
    </div>
  )
}

function FlagRow({ k, v }) {
  return (
    <div className="row">
      <span className="row-k">{k}</span>
      <span className={v === true ? 'pill on' : 'pill off'}>{v === true ? 'Yes' : 'No'}</span>
    </div>
  )
}

function Code({ code }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard?.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  return (
    <div className="code">
      <code>{code}</code>
      <button className="copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, required, type }) {
  return (
    <div className="form-row">
      <label className="label">{label}{required && <span className="req"> *</span>}</label>
      {type === 'textarea'
        ? <textarea className="field" value={value} onChange={onChange} placeholder={placeholder} />
        : <input className="field" type={type || 'text'} value={value} onChange={onChange} placeholder={placeholder} />}
    </div>
  )
}

/* ---------- shell ---------- */

// Live block height, read through the proxy. It is the one number that proves
// the site is talking to a real chain, so it lives in the chrome.
function NetworkStatus() {
  const [height, setHeight] = useState(null)

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const h = await getBlockHeight()
        // The exact response shape is not pinned down, so pull the first
        // number-like value out of whatever comes back rather than guessing.
        const n = (h && typeof h === 'object')
          ? Object.values(h).find((v) => typeof v === 'string' || typeof v === 'number')
          : h
        if (alive) setHeight(n == null ? null : String(n))
      } catch {
        if (alive) setHeight(null)
      }
    }
    tick()
    const id = setInterval(tick, 12000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const pretty = height && !Number.isNaN(Number(height)) ? Number(height).toLocaleString() : height

  return (
    <span className="status">
      <span className={height ? 'dot live' : 'dot'} />
      {height ? `alphanet ${pretty}` : 'connecting'}
    </span>
  )
}

function Shell({ children }) {
  const { pathname } = useLocation()
  const current = (to) => (pathname === to ? 'page' : undefined)

  return (
    <div className="shell">
      <nav className="rail">
        <Link to="/" className="brand">
          <span className="brand-mark">T</span>
          <span className="brand-name">ThruScan</span>
        </Link>
        {NAV.map((l) => (
          <Link key={l.to} to={l.to} className="rail-link" aria-current={current(l.to)}>{l.label}</Link>
        ))}
        <div className="rail-foot"><NetworkStatus /></div>
      </nav>

      <header className="topbar">
        <Link to="/" className="brand" style={{ margin: 0 }}>
          <span className="brand-mark">T</span>
          <span className="brand-name">ThruScan</span>
        </Link>
        <NetworkStatus />
      </header>

      <main className="main">{children}</main>

      <nav className="tabbar">
        {NAV.map((l) => (
          <Link key={l.to} to={l.to} className="tab" aria-current={current(l.to)}>{l.label}</Link>
        ))}
      </nav>
    </div>
  )
}

/* ---------- explorer ---------- */

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
    } catch {
      setError('No account at that key. Alphanet resets from genesis on network upgrades, so accounts can disappear.')
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
    } catch {
      setError('No account at that key. Check the public key and try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleChange = () => { setEditing(true); setInput(savedKey); setAccount(null); setError(null) }
  const handleClear = () => { localStorage.removeItem(STORAGE_KEY); setSavedKey(''); setInput(''); setEditing(true); setAccount(null); setError(null); setLastUpdated(null) }

  const meta = account?.meta
  const flags = meta?.flags

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="h2">Your account</h2>
          <p className="sub">Saved in this browser, read live from chain</p>
        </div>
        {savedKey && !editing && (
          <div className="card-actions">
            <button className="btn ghost" onClick={() => load(savedKey, true)} disabled={refreshing}>{refreshing ? 'Refreshing' : 'Refresh'}</button>
            <button className="btn ghost" onClick={handleChange}>Edit</button>
            <button className="btn ghost" onClick={handleClear}>Clear</button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="stack">
          <p className="fine" style={{ margin: 0 }}>Paste the public key from your CLI wallet. It stays in this browser.</p>
          <input className="field mono" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSave()} placeholder="ta..." />
          <button className="btn" onClick={handleSave} disabled={loading || !input.trim()}>{loading ? 'Saving' : 'Save account'}</button>
          {error && <p className="notice bad">{error}</p>}
        </div>
      ) : (
        <div>
          {loading && <p className="fine">Loading account</p>}
          {error && !loading && <p className="notice bad">{error}</p>}
          {account && meta && (
            <div>
              <div className="rows">
                <AddrRow k="Public key" v={savedKey} />
                <Row k="Balance" v={`${Number(meta.balance ?? 0).toLocaleString()} THRU`} mono />
                <Row k="Nonce" v={meta.nonce} mono />
                <Row k="Seq" v={meta.seq} mono />
                <FlagRow k="Is new" v={flags?.isNew} />
                <FlagRow k="Is program" v={flags?.isProgram} />
              </div>
              <div className="inline" style={{ marginTop: 12, justifyContent: 'space-between' }}>
                <button className="btn plain" onClick={() => onLookup(savedKey)}>Open in lookup</button>
                {lastUpdated && <span className="fine">Updated {lastUpdated}</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function NameServiceCard({ account }) {
  const [decoded, setDecoded] = useState(null)

  useEffect(() => {
    setDecoded(null)
    const b64 = account?.data?.base64
    if (!b64) return
    try {
      setDecoded(decodeNameServiceAccount(b64))
    } catch {
      // Most accounts are not name service accounts. Stay quiet.
      setDecoded(null)
    }
  }, [account])

  if (!decoded) return null

  const isDomain = decoded.kindLabel === 'domain'

  return (
    <section className="card accent">
      <div className="card-head">
        <div>
          <p className="eyebrow">Name service</p>
          <h2 className="h2">{isDomain ? decoded.domainName : decoded.rootName}</h2>
        </div>
        <span className="pill tag">{isDomain ? 'Domain' : 'Root registrar'}</span>
      </div>

      {isDomain ? (
        <div>
          <div className="rows">
            <AddrRow k="Owner" v={decoded.owner} />
            <AddrRow k="Parent" v={decoded.parent} />
            <Row k="Registered" v={registrationDate(decoded)?.toLocaleString()} />
            <Row k="Records" v={decoded.recordCount} mono />
          </div>

          {decoded.records.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <p className="eyebrow">Records</p>
              {decoded.records.map((r) => (
                <div className="rec" key={r.key}>
                  <p className="rec-k">{r.key}</p>
                  <p className="rec-v">
                    {r.key === 'url' && /^https?:\/\//.test(r.display)
                      ? <a href={r.display} target="_blank" rel="noreferrer">{r.display}</a>
                      : r.key === 'com.twitter'
                        ? <a href={'https://x.com/' + r.display.replace(/^@/, '')} target="_blank" rel="noreferrer">@{r.display.replace(/^@/, '')}</a>
                        : r.display}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="rows">
          <AddrRow k="Authority" v={decoded.authority} />
          <Row k="Subdomains" v={decoded.totalSubdomains?.toString()} mono />
        </div>
      )}
    </section>
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
    } catch {
      setError('No account at that address on alphanet. Check the key, and note that 0 and O look alike in these addresses.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (prefillKey) { setInput(prefillKey); lookup(prefillKey); onPrefillUsed() }
  }, [prefillKey])

  const meta = account?.meta
  const flags = meta?.flags

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="h2">Look up an account</h2>
            <p className="sub">Any public key, token mint, or name service account</p>
          </div>
        </div>

        <div className="stack">
          <div className="inline">
            <input className="field mono" value={input} onChange={(e) => { setInput(e.target.value); setAccount(null); setError(null) }} onKeyDown={(e) => e.key === 'Enter' && lookup()} placeholder="ta..." />
            {input && <button className="btn ghost" onClick={() => { setInput(''); setAccount(null); setError(null) }}>Clear</button>}
          </div>
          <button className="btn" onClick={() => lookup()} disabled={loading || !input.trim()}>{loading ? 'Looking up' : 'Look up'}</button>
        </div>

        {error && <p className="notice bad" style={{ marginTop: 14 }}>{error}</p>}

        {account && meta && (
          <div className="rows" style={{ marginTop: 18 }}>
            <AddrRow k="Public key" v={account.address ?? input.trim()} />
            <Row k="Balance" v={`${Number(meta.balance ?? 0).toLocaleString()} THRU`} mono />
            <Row k="Data size" v={`${Number(meta.dataSize ?? 0).toLocaleString()} bytes`} mono />
            <Row k="Nonce" v={meta.nonce} mono />
            <Row k="Seq" v={meta.seq} mono />
            <Row k="Version" v={meta.version} mono />
            {meta.owner && <AddrRow k="Owner program" v={meta.owner} />}
            {flags && <FlagRow k="Is program" v={flags.isProgram} />}
            {flags && <FlagRow k="Is new" v={flags.isNew} />}
            {flags && <FlagRow k="Is ephemeral" v={flags.isEphemeral} />}
            {flags && <FlagRow k="Is deleted" v={flags.isDeleted} />}
            {flags && <FlagRow k="Is privileged" v={flags.isPrivileged} />}
            {flags && <FlagRow k="Is compressed" v={flags.isCompressed} />}
          </div>
        )}
      </section>

      {account && <NameServiceCard account={account} />}
    </>
  )
}

function GuidePanel() {
  const [open, setOpen] = useState(false)
  const [openStep, setOpenStep] = useState(null)

  return (
    <section className="card">
      <button className="disclose" onClick={() => setOpen(!open)}>
        <div>
          <h2 className="h2">Create a CLI wallet</h2>
          <p className="sub">Nine steps, works on Windows, macOS and Linux</p>
        </div>
        <span className="chev">{open ? '\u2212' : '+'}</span>
      </button>

      {open && (
        <div style={{ marginTop: 16 }}>
          {steps.map((step) => {
            const isOpen = openStep === step.number
            return (
              <div className="step" key={step.number} data-open={isOpen}>
                <button className="step-head" onClick={() => setOpenStep(isOpen ? null : step.number)}>
                  <span className="step-n">{step.number}</span>
                  <span className="step-t">{step.title}</span>
                  <span className="chev">{isOpen ? '\u2212' : '+'}</span>
                </button>
                {isOpen && (
                  <div className="step-body">
                    <p className="fine" style={{ marginTop: 0, lineHeight: 1.65 }}>{step.description}</p>
                    {step.linkUrl && <p><a href={step.linkUrl} target="_blank" rel="noreferrer" className="fine">{step.linkLabel}</a></p>}
                    {step.note && (
                      <>
                        <p className="caption">{step.note}</p>
                        <Code code={step.noteCommand} />
                      </>
                    )}
                    {step.command && (
                      <>
                        <p className="caption">Run this</p>
                        <Code code={step.command} />
                      </>
                    )}
                    {step.verify && (
                      <>
                        <p className="caption">Check it worked</p>
                        <Code code={step.verify} />
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function ExplorerPage() {
  const [lookupPrefill, setLookupPrefill] = useState(null)

  return (
    <div className="wrap">
      <p className="eyebrow">Community explorer</p>
      <h1 className="h1">Read anything on Thru alphanet</h1>
      <p className="lede">Accounts, balances, and name service records, decoded straight from the chain.</p>

      <DevAccountCard onLookup={(key) => setLookupPrefill(key)} />
      <AccountLookup prefillKey={lookupPrefill} onPrefillUsed={() => setLookupPrefill(null)} />

      <section className="card">
        <h2 className="h2">Browser wallet</h2>
        <p className="sub" style={{ marginBottom: 10 }}>Passkey based, no seed phrase or extension</p>
        <p className="fine" style={{ lineHeight: 1.65 }}>
          The React SDK behind the embedded wallet is unpublished on npm, so the connect button is off here until it returns.
          The hosted wallet still works: <a href="https://wallet.thru.org" target="_blank" rel="noreferrer">open it directly</a>.
        </p>
      </section>

      <GuidePanel />

      <footer className="foot">
        <p className="fine">Built by <a href="https://x.com/pgreyy" target="_blank" rel="noreferrer">pgreyy</a>, open source on <a href="https://github.com/pgreyy/thruscan" target="_blank" rel="noreferrer">GitHub</a></p>
        <p className="fine">A community project, not affiliated with Unto Labs</p>
      </footer>
    </div>
  )
}

/* ---------- updates ---------- */

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
      setReleases(await r.json())
    } catch {
      setError('Could not reach GitHub. Try refreshing in a moment.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => { fetchReleases() }, [])

  const fetchSummary = async (release) => {
    if (summaries[release.id] || loadingSummary[release.id]) return
    setLoadingSummary((prev) => ({ ...prev, [release.id]: true }))
    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagName: release.tag_name, publishedAt: release.published_at, releaseName: release.name }),
      })
      const data = await res.json()
      setSummaries((prev) => ({ ...prev, [release.id]: data.summary || 'Summary unavailable.' }))
    } catch {
      setSummaries((prev) => ({ ...prev, [release.id]: 'Could not generate a summary.' }))
    } finally {
      setLoadingSummary((prev) => ({ ...prev, [release.id]: false }))
    }
  }

  const handleToggle = (release) => {
    const isOpening = openRelease !== release.id
    setOpenRelease(isOpening ? release.id : null)
    if (isOpening) fetchSummary(release)
  }

  return (
    <div className="wrap">
      <p className="eyebrow">Network</p>
      <h1 className="h1">Releases</h1>
      <p className="lede">Every version Unto Labs has shipped, newest first, each with a plain-language summary.</p>

      <div className="inline" style={{ marginBottom: 18 }}>
        <button className="btn ghost" onClick={() => fetchReleases(true)} disabled={refreshing}>{refreshing ? 'Refreshing' : 'Refresh'}</button>
        <a className="btn ghost" href="https://github.com/Unto-Labs/thru/releases" target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>View on GitHub</a>
      </div>

      {loading && <p className="fine">Loading releases</p>}
      {error && <p className="notice bad">{error}</p>}

      {!loading && !error && releases.map((release, i) => {
        const isOpen = openRelease === release.id
        return (
          <section className="card" key={release.id} style={{ padding: 0 }}>
            <button className="disclose" onClick={() => handleToggle(release)} style={{ padding: '16px 18px' }}>
              <span className="inline" style={{ flexWrap: 'wrap', gap: 10 }}>
                {i === 0 && <span className="pill new">Latest</span>}
                <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 500 }}>{release.tag_name}</span>
                <span className="fine">{timeAgo(release.published_at)}</span>
              </span>
              <span className="chev">{isOpen ? '\u2212' : '+'}</span>
            </button>

            {isOpen && (
              <div style={{ padding: '0 18px 18px' }}>
                <p className="eyebrow">Summary</p>
                {loadingSummary[release.id]
                  ? <p className="fine">Writing a summary</p>
                  : <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7 }}>{summaries[release.id] || 'Loading'}</p>}
                <div className="inline" style={{ marginTop: 14, justifyContent: 'space-between' }}>
                  <a className="fine" href={release.html_url} target="_blank" rel="noreferrer">Release notes</a>
                  <span className="fine">{new Date(release.published_at).toLocaleDateString()}</span>
                </div>
              </div>
            )}
          </section>
        )
      })}

      <footer className="foot">
        <p className="fine">Summaries are generated from the version and release date, so they may not reflect every change.</p>
      </footer>
    </div>
  )
}

/* ---------- projects ---------- */

const EMPTY_PROJECT = { name: '', yourTwitter: '', projectName: '', projectTwitter: '', projectWebsite: '', founderDetails: '', yourRelationship: '' }

function ProjectsPage() {
  const PROJECTS = []
  const [form, setForm] = useState(EMPTY_PROJECT)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState(null)
  const [showForm, setShowForm] = useState(false)

  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }))

  const handleSubmit = async () => {
    if (!form.name || !form.projectName) { setError('Your name and the project name are both needed.'); return }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/submit-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      const data = await res.json()
      if (data.success) { setSubmitted(true); setForm(EMPTY_PROJECT) }
      else setError(data.error || 'That did not save. Try again.')
    } catch {
      setError('That did not save. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="wrap-wide">
      <p className="eyebrow">Ecosystem</p>
      <h1 className="h1">Projects</h1>
      <p className="lede">Teams and tools building on Thru. The list is short because the network is young.</p>

      {PROJECTS.length === 0 && (
        <div className="empty">
          <p style={{ fontWeight: 600 }}>Nothing listed yet</p>
          <p className="fine" style={{ marginBottom: 18 }}>Thru is still in alphanet. If you know something being built, add it.</p>
          <button className="btn" onClick={() => setShowForm(true)}>Suggest a project</button>
        </div>
      )}

      <section className="card">
        <button className="disclose" onClick={() => setShowForm(!showForm)}>
          <div>
            <h2 className="h2">Suggest a project</h2>
            <p className="sub">Reviewed before it goes on the list</p>
          </div>
          <span className="chev">{showForm ? '\u2212' : '+'}</span>
        </button>

        {showForm && (
          <div style={{ marginTop: 18 }}>
            {submitted ? (
              <div className="notice">
                <p style={{ margin: '0 0 4px', fontWeight: 600 }}>Suggestion received</p>
                <p className="fine" style={{ margin: '0 0 12px' }}>Thanks. It goes on the list if it checks out.</p>
                <button className="btn ghost" onClick={() => setSubmitted(false)}>Add another</button>
              </div>
            ) : (
              <div>
                <Field label="Your name" value={form.name} onChange={set('name')} placeholder="Your name" required />
                <Field label="Your X handle" value={form.yourTwitter} onChange={set('yourTwitter')} placeholder="handle without the at sign" />
                <Field label="Project name" value={form.projectName} onChange={set('projectName')} placeholder="Project name" required />
                <Field label="Project X handle" value={form.projectTwitter} onChange={set('projectTwitter')} placeholder="handle without the at sign" />
                <Field label="Project website" value={form.projectWebsite} onChange={set('projectWebsite')} placeholder="https://" type="url" />
                <Field label="Who is building it" value={form.founderDetails} onChange={set('founderDetails')} placeholder="Founder names, handles, background" type="textarea" />
                <Field label="How you know about it" value={form.yourRelationship} onChange={set('yourRelationship')} placeholder="Founder, community member, observer" />
                {error && <p className="notice bad" style={{ marginBottom: 14 }}>{error}</p>}
                <button className="btn full" onClick={handleSubmit} disabled={submitting}>{submitting ? 'Sending' : 'Send suggestion'}</button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

/* ---------- community ---------- */

const EMPTY_CONTENT = { name: '', yourTwitter: '', contentTitle: '', contentLink: '', description: '', contentType: 'Article' }

function ContentCard({ item }) {
  return (
    <article className="card" style={{ marginBottom: 0 }}>
      <div className="card-head" style={{ marginBottom: 8 }}>
        <a href={item.link} target="_blank" rel="noreferrer" style={{ fontWeight: 600, fontSize: 15, color: 'var(--ink)', textDecoration: 'none', lineHeight: 1.35 }}>{item.title}</a>
        <span className="pill tag">{item.type}</span>
      </div>
      {item.description && <p className="fine" style={{ lineHeight: 1.6, marginTop: 0 }}>{item.description}</p>}
      <div className="inline" style={{ justifyContent: 'space-between', marginTop: 12 }}>
        <a className="fine" href={'https://x.com/' + (item.twitter || item.author)} target="_blank" rel="noreferrer">{item.twitter || item.author}</a>
        <a className="btn plain" href={item.link} target="_blank" rel="noreferrer">Read</a>
      </div>
    </article>
  )
}

function CommunityPage() {
  const [records, setRecords] = useState([])
  const [loadingRecords, setLoadingRecords] = useState(true)
  const [form, setForm] = useState(EMPTY_CONTENT)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [activeTab, setActiveTab] = useState('featured')

  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }))

  useEffect(() => {
    fetch('/api/get-community')
      .then((r) => r.json())
      .then((data) => { setRecords(data.records || []); setLoadingRecords(false) })
      .catch(() => setLoadingRecords(false))
  }, [])

  const handleSubmit = async () => {
    if (!form.name || !form.contentTitle || !form.contentLink) { setError('Name, title and link are all needed.'); return }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/submit-community', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      const data = await res.json()
      if (data.success) { setSubmitted(true); setForm(EMPTY_CONTENT) }
      else setError(data.error || 'That did not save. Try again.')
    } catch {
      setError('That did not save. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="wrap-wide">
      <p className="eyebrow">Community</p>
      <h1 className="h1">Worth reading</h1>
      <p className="lede">Articles, threads, videos and tools from people figuring out Thru in public.</p>

      <div className="tabs" role="tablist">
        <button className="tab-btn" role="tab" aria-selected={activeTab === 'featured'} onClick={() => setActiveTab('featured')}>Featured</button>
        <button className="tab-btn" role="tab" aria-selected={activeTab === 'community'} onClick={() => setActiveTab('community')}>Community picks</button>
      </div>

      {activeTab === 'featured' && (
        <div className="grid">
          {FEATURED_CONTENT.map((item) => <ContentCard key={item.id} item={item} />)}
        </div>
      )}

      {activeTab === 'community' && (
        loadingRecords ? <p className="fine">Loading</p>
          : records.length > 0 ? (
            <div className="grid">{records.map((item) => <ContentCard key={item.id} item={item} />)}</div>
          ) : (
            <div className="empty">
              <p style={{ fontWeight: 600 }}>No picks yet</p>
              <p className="fine" style={{ marginBottom: 18 }}>Be the first to add something.</p>
              <button className="btn" onClick={() => setShowForm(true)}>Submit content</button>
            </div>
          )
      )}

      <section className="card" style={{ marginTop: 22 }}>
        <button className="disclose" onClick={() => setShowForm(!showForm)}>
          <div>
            <h2 className="h2">Submit content</h2>
            <p className="sub">Articles, threads, videos, tools. Reviewed weekly.</p>
          </div>
          <span className="chev">{showForm ? '\u2212' : '+'}</span>
        </button>

        {showForm && (
          <div style={{ marginTop: 18 }}>
            {submitted ? (
              <div className="notice">
                <p style={{ margin: '0 0 4px', fontWeight: 600 }}>Submitted</p>
                <p className="fine" style={{ margin: '0 0 12px' }}>Thanks. Picks are reviewed weekly.</p>
                <button className="btn ghost" onClick={() => setSubmitted(false)}>Add another</button>
              </div>
            ) : (
              <div>
                <Field label="Your name" value={form.name} onChange={set('name')} placeholder="Your name" required />
                <Field label="Your X handle" value={form.yourTwitter} onChange={set('yourTwitter')} placeholder="handle without the at sign" />
                <Field label="Title" value={form.contentTitle} onChange={set('contentTitle')} placeholder="Title of the article, thread or tool" required />
                <Field label="Link" value={form.contentLink} onChange={set('contentLink')} placeholder="https://" type="url" required />
                <div className="form-row">
                  <label className="label">Type</label>
                  <select className="field" value={form.contentType} onChange={set('contentType')}>
                    <option value="Article">Article</option>
                    <option value="Thread">Thread</option>
                    <option value="Video">Video</option>
                    <option value="Tool">Tool</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                <Field label="What it covers" value={form.description} onChange={set('description')} placeholder="What is this about, and who should read it" type="textarea" />
                {error && <p className="notice bad" style={{ marginBottom: 14 }}>{error}</p>}
                <button className="btn full" onClick={handleSubmit} disabled={submitting}>{submitting ? 'Sending' : 'Submit'}</button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Shell>
        <Routes>
          <Route path="/" element={<ExplorerPage />} />
          <Route path="/updates" element={<UpdatesPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/community" element={<CommunityPage />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  )
}
