import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { getAccount, getTransaction, getBlockHeight } from './lib/rpcClient'
import { decodeNameServiceAccount, registrationDate } from './lib/nameservice'
import { decodeTokenProgramAccount, formatAmount } from './lib/token'
import { decodeWall, buildPostInstruction, toHex, MESSAGE_CHARS, NAME_CHARS, HANDLE_CHARS } from './lib/wall'
import {
  WORDS, WORD_LEN, MAX_GUESSES, randomWord, scoreGuess, keyboardState, pointsFor,
  getPlayerId, decodeBoard, rankByPoints, rankByStreak,
} from './lib/wordle'
import './styles.css'

// All chain reads go through /api/rpc, a serverless function that talks to the
// Thru node server to server. The node sends no CORS headers, so the browser
// can never call it directly.
async function fetchAccountFromChain(address) {
  return getAccount(address)
}

const STORAGE_KEY = 'thru_dev_account_pubkey'
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/Unto-Labs/thru/releases?per_page=10'

// Set in Vercel once the program and wall account exist. Until then the Wall
// page renders an honest "not live yet" state instead of erroring.
const WALL_PROGRAM = import.meta.env.VITE_THRU_WALL_PROGRAM || ''
const WALL_ACCOUNT = import.meta.env.VITE_THRU_WALL_ACCOUNT || ''
const WORDLE_BOARD = import.meta.env.VITE_THRU_WORDLE_BOARD || ''

const NAV = [
  { to: '/', label: 'Explorer' },
  { to: '/wall', label: 'Wall' },
  { to: '/games', label: 'Games' },
  { to: '/guides', label: 'Guides' },
  { to: '/projects', label: 'Projects' },
  { to: '/community', label: 'Community' },
  { to: '/updates', label: 'Updates' },
]

/* ---------- guide content ----------
   Written for someone who has never used a terminal for this before. Every
   step says what it does, what to expect, and how to tell it worked. Where a
   command differs between Windows and macOS/Linux, both are given rather than
   assuming the reader is on one of them. */

const GUIDES = [
  {
    id: 'cli-wallet',
    title: 'Create a wallet',
    blurb: 'Install the Thru command line tool, make a key, and get test tokens',
    minutes: '15 minutes',
    intro:
      'Everything on Thru starts with an account. This guide installs the Thru CLI, creates a key on your computer, registers it on the network, and funds it with free test tokens. Works the same on Windows, macOS and Linux.',
    steps: [
      {
        title: 'Install Node.js',
        description:
          'The Thru tool is distributed through npm, which comes with Node.js. Download the LTS version, run the installer, then close your terminal and open a new one so it picks up the change.',
        linkLabel: 'Download Node.js',
        linkUrl: 'https://nodejs.org',
        verify: 'node -v',
        verifyNote: 'Prints a version number like v22.14.0. If it says "not recognized", reopen your terminal.',
      },
      {
        title: 'Install the Thru CLI',
        description:
          'One command, nothing to compile. If you installed Thru before using Rust and cargo, that older copy can hide this one. Check the version afterwards, and if it looks older than you expect, remove the old one with: cargo uninstall thru',
        command: 'npm install -g thru',
        note: 'On Windows, if the version looks wrong, this shows every copy on your system:',
        noteCommand: 'Get-Command thru -All',
        verify: 'thru --version',
        verifyNote: 'Should print 0.3.2 or newer.',
      },
      {
        title: 'Check you can reach the network',
        description:
          'The CLI sets itself up the first time you run it and saves a config file in your home folder. This command asks the network what version it is running, which proves you can talk to it.',
        command: 'thru --json getversion',
        note: 'If you get a DNS error, point at the endpoint directly:',
        noteCommand: 'thru --json getversion --url https://rpc.alphanet.thru.org',
      },
      {
        title: 'Create your key',
        description:
          'This makes a key pair on your computer. "default" is just a label, you can use any name. Your private key is saved in plain text in the config file, so treat that file like a bank password: never share it, never put it in a screenshot, never commit it to GitHub.',
        command: 'thru keys generate default',
        verify: 'thru keys list',
        verifyNote:
          'Your new key name appears in the list. That name is your "key name", and other guides ask for it. If you used a name other than "default", you must add --fee-payer YOURNAME to most commands from here on.',
      },
      {
        title: 'Register the account on the network',
        description:
          'Your key exists on your computer, but the network does not know about it yet. This step registers it. If the command seems to hang, check with the verify command before running it again, because the transaction often went through anyway.',
        command: 'thru account create default',
        verify: 'thru --json getaccountinfo default',
        verifyNote: 'Returns account details instead of "not found".',
        note:
          'Worth knowing: alphanet resets from genesis whenever the network upgrades. When that happens your account, tokens and names all disappear and you run these steps again. Your keys stay on your computer, so it is only ever the on-chain side that resets.',
      },
      {
        title: 'Get free test tokens',
        description:
          'The faucet hands out THRU for testing. The limit is 10,000 per request, and you can ask more than once. These tokens only exist on alphanet and are not worth anything. You can send them back with: thru faucet deposit default 1000',
        command: 'thru faucet withdraw default 10000',
        verify: 'thru getbalance default',
        verifyNote: 'Shows a balance of 10,000.',
      },
      {
        title: 'If your key is not named "default"',
        description:
          'Most commands assume a key literally named "default" pays the fee. If you named yours something else, add --fee-payer followed by your key name to every command that writes to the chain, or you will get a "creator must match the fee payer" error.',
        note: 'Example, using a key named mykey:',
        noteCommand: 'thru faucet withdraw mykey 10000 --fee-payer mykey',
      },
      {
        title: 'See yourself in the explorer',
        description:
          'Copy your public key and paste it into the Explorer tab on this site. You should see your balance and account flags read straight from the chain. That is the same data the CLI sees, just easier to read.',
        command: 'thru --json keys list',
        verifyNote: 'Copy the public key, the long string starting with ta.',
      },
    ],
  },

  {
    id: 'mint-token',
    title: 'Mint your own token',
    blurb: 'Create $JOAT, give yourself a supply, and view it on ThruScan',
    minutes: '10 minutes',
    intro:
      'A token on Thru has two parts. The mint holds the rules: the name, how divisible it is, and who is allowed to create more. A token account holds a balance for one owner. You need both. This guide makes a token called JOAT and mints some to yourself. Finish the wallet guide first.',
    steps: [
      {
        title: 'Check your account is funded',
        description:
          'Every step here costs a small fee, so make sure you have a balance before starting. If it is zero, run the faucet command from the wallet guide. Words in CAPITALS later in this guide are placeholders: each command prints an address, and the next one wants you to paste it in place of the capitalised word.',
        command: 'thru getbalance default',
        note: 'Using a key that is not called "default"? Find its name and add --fee-payer YOURKEY to every command here:',
        noteCommand: 'thru keys list',
      },
      {
        title: 'Make a seed',
        description:
          'A seed is 32 random bytes written as 64 characters. Thru uses it to work out your token addresses, which means the same seed always gives the same addresses. Save it somewhere. Without it you cannot recreate these addresses later.',
        command: '-join ((1..32) | ForEach-Object { \'{0:x2}\' -f (Get-Random -Max 256) })',
        commandLabel: 'Windows PowerShell',
        note: 'On macOS or Linux:',
        noteCommand: 'openssl rand -hex 32',
      },
      {
        title: 'Create the mint',
        description:
          'This creates the token itself. Replace YOUR_PUBKEY with your own public key and SEED with the seed you just made. Decimals set how divisible the token is: 6 means the smallest piece is one millionth of a JOAT, the same as USDC. The command prints a mint address, which is your token\'s permanent ID.',
        command: 'thru token initialize-mint YOUR_PUBKEY JOAT SEED --decimals 6',
        note: 'Save the mint address it prints. You need it for every step after this.',
      },
      {
        title: 'Create a token account',
        description:
          'A mint cannot hold a balance, it only defines the token. To actually own JOAT you need a token account, which is like a wallet for this one token. Replace MINT with the address from the last step, and reuse the same seed.',
        command: 'thru token initialize-account MINT YOUR_PUBKEY SEED',
        note: 'Save the token account address it prints.',
      },
      {
        title: 'Mint the supply',
        description:
          'Now create the tokens. Amounts are given in the smallest unit, so with 6 decimals you multiply by a million: 1,000 JOAT is 1000000000. The authority is your public key, since you created the mint and only you can add more.',
        command: 'thru token mint-to MINT TOKEN_ACCOUNT YOUR_PUBKEY 1000000000',
        verify: 'thru token balance TOKEN_ACCOUNT --json',
        verifyNote: 'Shows an amount of 1000000000, which is 1,000 JOAT.',
      },
      {
        title: 'View it on ThruScan',
        description:
          'Paste the mint address into the Explorer tab. You will see a Token card showing the ticker, supply, decimals and who holds the mint authority. Paste the token account address instead and you get the balance view. Both are decoded from the raw bytes the chain stores.',
      },
    ],
  },

  {
    id: 'name-service',
    title: 'Register a name',
    blurb: 'Claim a root name, add a subdomain, and attach records to it',
    minutes: '10 minutes',
    intro:
      'Thru has a built-in name service, similar to ENS. It works in two layers: you claim a root name, then create subdomains under it. Each subdomain can hold records, which are key and value pairs like a website or a social handle. Finish the wallet guide first.',
    steps: [
      {
        title: 'Before you start: reading these commands',
        description:
          'Words in CAPITALS are placeholders, not things to type literally. Each command prints an address, and the next command wants you to paste that address in place of the capitalised word. So when a step says REGISTRAR, delete that word and paste the registrar address the previous step printed. Keep a notepad open, because you will need these addresses more than once.',
        note: 'Also: every command below assumes your key is called "default". Find yours with:',
        noteCommand: 'thru keys list',
        verifyNote:
          'If your key has a different name, add --fee-payer followed by that name to the end of every command in this guide.',
      },
      {
        title: 'Check the name is free',
        description:
          'Names are first come, first served, and there is no search page. You check by working out what address a name would live at, then asking the chain whether anything is there. Run the first command with the name you want, copy the registrar_account it prints, and paste it into the second.',
        command: 'thru nameservice derive-registrar-account yourname --json',
        note: 'Then look that address up:',
        noteCommand: 'thru getaccountinfo REGISTRAR --json',
        verifyNote:
          '"Account not found" means the name is free and yours to claim. If it returns account details instead, somebody already has it — pick another. You can also paste the registrar address into the Explorer tab on this site to see the same thing.',
      },
      {
        title: 'Claim a root name',
        description:
          'Replace yourname with the name you just checked. This root is yours, and every subdomain lives under it. The command prints a "Registrar account" address — copy it somewhere, you need it next.',
        command: 'thru nameservice init-root yourname',
        verify: 'thru nameservice derive-registrar-account yourname --json',
        verifyNote: 'Prints the same registrar address, so you can always recover it later.',
      },
      {
        title: 'Create a subdomain',
        description:
          'Subdomains are the part people actually use, like alice.yourname. Replace alice with the name you want, and replace REGISTRAR with the registrar address from the previous step. Note the order: the new name comes first, then the registrar. This prints a "Domain account" address, which you need for every step after this.',
        command: 'thru nameservice register-subdomain alice REGISTRAR',
        note: 'A worked example, so you can see the shape of a real one:',
        noteCommand: 'thru nameservice register-subdomain alice tax0PQTXev5N-300fljcI0u2AYWb_x0txqDWAcS4fuFz88',
      },
      {
        title: 'Attach records',
        description:
          'Records are labelled pieces of information attached to your name. Replace DOMAIN with the domain account address from the previous step. Common keys are url for a website, com.twitter for a handle, and thru.pubkey so the name points at your account. You can use any key name you like.',
        command: 'thru nameservice append-record DOMAIN url https://example.com',
        note: 'Add as many as you want, one at a time:',
        noteCommand: 'thru nameservice append-record DOMAIN com.twitter yourhandle',
      },
      {
        title: 'Check it worked',
        description:
          'This shows everything attached to the name: the owner, the parent, and all records. Add --key url to look at just one.',
        command: 'thru nameservice resolve DOMAIN --json',
        note: 'Made a mistake? Remove a record with:',
        noteCommand: 'thru nameservice delete-record DOMAIN url',
      },
      {
        title: 'View it on ThruScan',
        description:
          'Paste the domain account address into the Explorer tab. You get a Name Service card with the name, owner, when it was registered, and every record laid out. Links and handles become clickable.',
      },
    ],
  },

  {
    id: 'c-program',
    title: 'Deploy a program',
    blurb: 'Write a program in C, compile it to RISC-V, and put it on chain',
    minutes: '1 hour, mostly downloading',
    intro:
      'Thru programs are ordinary C compiled to RISC-V. This walks through the built-in starter program and deploys it. Most of the time is spent downloading a 1.1GB compiler. Windows users need WSL2, because the compiler is Linux and macOS only, and the notes below cover two traps that are not documented anywhere else.',
    steps: [
      {
        title: 'Windows only: install WSL2',
        description:
          'The Thru toolchain installer looks up your operating system using a Unix command that Windows does not have, so it fails immediately with "Failed to detect OS". WSL2 gives you a real Linux environment inside Windows. Run this in PowerShell as Administrator, then restart. Ubuntu opens on its own and asks you to pick a username and password. On macOS or Linux, skip this step.',
        command: 'wsl --install',
        commandLabel: 'PowerShell as Administrator',
        verify: 'wsl --list --verbose',
        verifyNote: 'Ubuntu appears with version 2.',
      },
      {
        title: 'Install the build tools',
        description:
          'Run everything from here on inside Linux, which for Windows users means the Ubuntu terminal rather than PowerShell. This installs make and the standard compiler tools, then Node.js so you can install the Thru CLI here too. Your Linux side is a separate machine as far as software is concerned.',
        command: 'sudo apt update && sudo apt install -y build-essential curl xz-utils',
        note: 'Then Node.js and the Thru CLI:',
        noteCommand: 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs && sudo npm install -g thru',
      },
      {
        title: 'Install the compiler and SDK',
        description:
          'The toolchain is the RISC-V compiler, around 1.1GB, so this takes a while. The SDK is the Thru header files your program includes. You need both.',
        command: 'thru dev toolchain install && thru dev sdk install c',
        verify: 'thru dev toolchain path && thru dev sdk path c',
        verifyNote: 'Both report installed and verified.',
      },
      {
        title: 'Create a project',
        description:
          'This generates a working starter program: a makefile and a C file with an entry point that does nothing but return successfully. Small on purpose, so you can confirm the whole pipeline works before writing real logic.',
        command: 'thru dev init c hello-thru',
      },
      {
        title: 'Build it',
        description:
          'Two things commonly go wrong here, both specific to Windows. First, the build looks for the compiler by searching upward from your project folder, so if your project sits on the Windows drive it never finds it. Setting RISCV_TOOLCHAIN_ROOT skips that search. Second, building on the Windows drive fails at the final linking step with a "file truncated" error, so keep the project in your Linux home folder instead.',
        command: 'echo \'export RISCV_TOOLCHAIN_ROOT=$HOME/.thru/sdk/toolchain\' >> ~/.bashrc && source ~/.bashrc',
        note: 'Then build, from your Linux home folder and not /mnt/c:',
        noteCommand: 'cd ~/hello-thru && make -j',
        verify: 'ls -la build/thruvm/bin/',
        verifyNote: 'hello_thru_c.bin appears, around 138 bytes.',
      },
      {
        title: 'Deploy it',
        description:
          'One command uploads the compiled program and registers it on the network. The seed is plain text here, not hex: a hex seed is too long and the deploy fails halfway through, after the upload has already been paid for. Windows users can copy the .bin to the Windows side and run this from PowerShell, so your keys never need to exist inside Linux.',
        command: 'thru program create hello-thru build/thruvm/bin/hello_thru_c.bin',
        verify: 'thru program status hello-thru --json',
        verifyNote: 'Status reads deployed, and program_deployed is true.',
      },
      {
        title: 'View it on ThruScan',
        description:
          'Paste the program account address into the Explorer tab. It shows Is program: Yes, and the data size matches your compiled file byte for byte. That is your own code, stored on a blockchain.',
      },
    ],
  },
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

// A Thru address is 46 characters of base64url behind a ta prefix, and it is
// the thing you spend the most time reading here, so it gets a real treatment
// instead of being dumped as plain text.
function Address({ value }) {
  const [copied, setCopied] = useState(false)
  if (!value) return <span className="row-v">-</span>

  const copy = () => {
    navigator.clipboard?.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <button className="addr" onClick={copy} title="Copy">
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

function useCopy(text) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard?.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  return [copied, copy]
}

function Code({ code, label }) {
  const [copied, copy] = useCopy(code)
  return (
    <div className="codeblock">
      <div className="codebar">
        <span className="codelabel">{label || 'Command'}</span>
        <button className="copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre className="codebody"><code>{code}</code></pre>
    </div>
  )
}

/** A command mentioned inside a sentence, copyable in one click. */
function InlineCode({ children }) {
  const [copied, copy] = useCopy(String(children))
  return (
    <button className="inline-code" onClick={copy} title="Copy">
      {children}<span className="mark">{copied ? 'copied' : 'copy'}</span>
    </button>
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

function Brand() {
  return (
    <>
      <span className="brand-mark">T</span>
      <span className="brand-name">ThruScan</span>
    </>
  )
}

function Shell({ children }) {
  const { pathname } = useLocation()
  const current = (to) => (pathname === to ? 'page' : undefined)

  return (
    <div className="shell">
      <nav className="rail">
        <Link to="/" className="brand"><Brand /></Link>
        {NAV.map((l) => (
          <Link key={l.to} to={l.to} className="rail-link" aria-current={current(l.to)}>{l.label}</Link>
        ))}
        <div className="rail-foot"><NetworkStatus /></div>
      </nav>

      <header className="topbar">
        <Link to="/" className="brand" style={{ margin: 0 }}><Brand /></Link>
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

function TokenCard({ account }) {
  const [decoded, setDecoded] = useState(null)

  useEffect(() => {
    setDecoded(null)
    const b64 = account?.data?.base64
    if (!b64) return
    try {
      // Returns null unless the account is owned by the token program AND is
      // exactly 115 or 73 bytes, so ordinary accounts fall through silently.
      setDecoded(decodeTokenProgramAccount(b64, account?.meta?.owner))
    } catch {
      setDecoded(null)
    }
  }, [account])

  if (!decoded) return null
  const isMint = decoded.kindLabel === 'mint'

  return (
    <section className="card accent">
      <div className="card-head">
        <div>
          <p className="eyebrow">Token program</p>
          <h2 className="h2">{isMint ? (decoded.ticker || 'Unnamed token') : 'Token balance'}</h2>
        </div>
        <span className="pill tag">{isMint ? 'Mint' : 'Token account'}</span>
      </div>

      {isMint ? (
        <div className="rows">
          <Row k="Ticker" v={decoded.ticker || '-'} />
          <Row k="Supply" v={`${decoded.supplyDisplay} ${decoded.ticker}`.trim()} mono />
          <Row k="Decimals" v={decoded.decimals} mono />
          <Row k="Base units" v={decoded.supply.toString()} mono />
          <AddrRow k="Mint authority" v={decoded.mintAuthority} />
          <AddrRow k="Creator" v={decoded.creator} />
          {decoded.hasFreezeAuthority
            ? <AddrRow k="Freeze authority" v={decoded.freezeAuthority} />
            : <Row k="Freeze authority" v="None, balances cannot be frozen" />}
        </div>
      ) : (
        <>
          <div className="rows">
            <Row k="Amount" v={formatAmount(decoded.amount, 0)} mono />
            <AddrRow k="Mint" v={decoded.mint} />
            <AddrRow k="Owner" v={decoded.owner} />
            <FlagRow k="Frozen" v={decoded.isFrozen} />
          </div>
          <p className="fine" style={{ marginBottom: 0 }}>
            Amount is in base units. Look up the mint to see its decimals and ticker.
          </p>
        </>
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
      setAccount(await fetchAccountFromChain(target))
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
            <p className="sub">Any public key, token mint, program, or name</p>
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
      {account && <TokenCard account={account} />}
    </>
  )
}

function AccountChips({ label, list }) {
  if (!list || list.length === 0) return null
  return (
    <div style={{ marginTop: 14 }}>
      <p className="eyebrow">{label} ({list.length})</p>
      <div className="chips">
        {list.map((a) => <Address key={a} value={a} />)}
      </div>
    </div>
  )
}

function TransactionLookup() {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [tx, setTx] = useState(null)
  const [error, setError] = useState(null)

  const lookup = async () => {
    const target = input.trim()
    if (!target) return
    setLoading(true)
    setError(null)
    setTx(null)
    try {
      setTx(await getTransaction(target))
    } catch {
      setError('No transaction with that signature. Alphanet prunes history on network resets, so older transactions may be gone.')
    } finally {
      setLoading(false)
    }
  }

  const exec = tx?.execution
  // Both codes read zero when nothing went wrong. vmError is an enum where the
  // zero value means no error, so treat missing and zero the same way.
  const failed = exec && (exec.userErrorCode !== '0' || (exec.vmError ?? 0) !== 0)

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="h2">Look up a transaction</h2>
          <p className="sub">Paste a signature from any CLI command that wrote to the chain</p>
        </div>
      </div>

      <div className="stack">
        <div className="inline">
          <input className="field mono" value={input} onChange={(e) => { setInput(e.target.value); setTx(null); setError(null) }} onKeyDown={(e) => e.key === 'Enter' && lookup()} placeholder="ts..." />
          {input && <button className="btn ghost" onClick={() => { setInput(''); setTx(null); setError(null) }}>Clear</button>}
        </div>
        <button className="btn" onClick={lookup} disabled={loading || !input.trim()}>{loading ? 'Looking up' : 'Look up'}</button>
      </div>

      {error && <p className="notice bad" style={{ marginTop: 14 }}>{error}</p>}

      {tx && (
        <div style={{ marginTop: 18 }}>
          <div className="card-head" style={{ marginBottom: 4 }}>
            <span className={failed ? 'pill off' : 'pill on'}>{failed ? 'Failed' : 'Succeeded'}</span>
            {tx.status?.label && <span className="pill tag">{tx.status.label}</span>}
          </div>

          <div className="rows">
            <AddrRow k="Signature" v={tx.signature ?? input.trim()} />
            <Row k="Slot" v={tx.slot ? Number(tx.slot).toLocaleString() : '-'} mono />
            <AddrRow k="Fee payer" v={tx.feePayer} />
            <AddrRow k="Program" v={tx.program} />
            <Row k="Fee" v={`${Number(tx.fee ?? 0).toLocaleString()} THRU`} mono />
            <Row k="Nonce" v={tx.nonce} mono />
            <Row k="Instruction data" v={`${Number(tx.instructionDataSize ?? 0).toLocaleString()} bytes`} mono />
          </div>

          {exec && (
            <div style={{ marginTop: 16 }}>
              <p className="eyebrow">Resources used</p>
              <div className="rows">
                <Row k="Compute units" v={`${Number(exec.consumedCompute ?? 0).toLocaleString()} of ${Number(tx.requested?.compute ?? 0).toLocaleString()}`} mono />
                <Row k="State units" v={`${Number(exec.consumedState ?? 0).toLocaleString()} of ${Number(tx.requested?.state ?? 0).toLocaleString()}`} mono />
                <Row k="Memory units" v={`${Number(exec.consumedMemory ?? 0).toLocaleString()} of ${Number(tx.requested?.memory ?? 0).toLocaleString()}`} mono />
                <Row k="Memory pages" v={exec.pagesUsed} mono />
                <Row k="Events" v={exec.eventsCount} mono />
                {failed && <Row k="VM error" v={exec.vmError} mono />}
                {failed && <Row k="Program error code" v={exec.userErrorCode} mono />}
              </div>
            </div>
          )}

          <AccountChips label="Accounts written" list={tx.readWriteAccounts} />
          <AccountChips label="Accounts read" list={tx.readOnlyAccounts} />
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
      <p className="lede">Accounts, tokens, names and transactions, decoded straight from the chain.</p>

      <DevAccountCard onLookup={(key) => setLookupPrefill(key)} />
      <AccountLookup prefillKey={lookupPrefill} onPrefillUsed={() => setLookupPrefill(null)} />
      <TransactionLookup />

      <section className="card">
        <h2 className="h2">Browser wallet</h2>
        <p className="sub" style={{ marginBottom: 10 }}>Passkey based, no seed phrase or extension</p>
        <p className="fine" style={{ lineHeight: 1.65 }}>
          Thru's hosted wallet is pre-alpha and currently cannot create accounts, because the fee payer it relies on does not
          exist on chain. The React SDK behind the embedded wallet is also unpublished on npm, so the connect button stays off
          here until both are fixed. In the meantime the <Link to="/guides">CLI wallet guide</Link> works today.
        </p>
      </section>

      <footer className="foot">
        <p className="fine">Built by <a href="https://x.com/pgreyy" target="_blank" rel="noreferrer">pgreyy</a>, open source on <a href="https://github.com/pgreyy/thruscan" target="_blank" rel="noreferrer">GitHub</a></p>
        <p className="fine">A community project, not affiliated with Unto Labs</p>
      </footer>
    </div>
  )
}

/* ---------- moderation ----------
   Not in the nav on purpose. Reachable at /moderate, gated by a password held
   in a Vercel environment variable and checked server side. The password is
   kept in sessionStorage so a page refresh does not log you out, and is gone
   when the tab closes. */

function ModeratePage() {
  const [password, setPassword] = useState(() => sessionStorage.getItem('thruscan_mod') || '')
  const [authed, setAuthed] = useState(false)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [edits, setEdits] = useState({})

  const load = async (pw) => {
    const secret = pw ?? password
    if (!secret) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/moderate?password=${encodeURIComponent(secret)}`)
      const data = await res.json()
      if (!data.ok) { setError(data.error || 'Could not load the queue.'); setAuthed(false); return }
      sessionStorage.setItem('thruscan_mod', secret)
      setItems(data.items)
      setAuthed(true)
    } catch {
      setError('Could not reach the server.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (password) load(password) }, [])

  const decide = async (item, action, pinned = false) => {
    setBusy(item.id)
    try {
      const res = await fetch('/api/moderate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          id: item.id,
          action,
          pinned,
          summary: edits[item.id]?.summary ?? item.summary,
          type: edits[item.id]?.type ?? item.type,
        }),
      })
      const data = await res.json()
      if (!data.ok) { setError(data.error || 'That did not go through.'); return }
      // Drop it from the list rather than reloading, so the queue does not
      // jump around while you are working through it.
      setItems((prev) => prev.filter((i) => i.id !== item.id))
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  const editItem = (id, patch) => setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  if (!authed) {
    return (
      <div className="wrap">
        <p className="eyebrow">Private</p>
        <h1 className="h1">Moderation</h1>
        <p className="lede">Approve or reject what the discovery agent found.</p>

        <section className="card">
          <div className="stack">
            <input
              className="field"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
              placeholder="Password"
            />
            <button className="btn" onClick={() => load()} disabled={loading || !password}>
              {loading ? 'Checking' : 'Unlock'}
            </button>
            {error && <p className="notice bad">{error}</p>}
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="wrap">
      <p className="eyebrow">Private</p>
      <h1 className="h1">Moderation</h1>
      <p className="lede">
        {items.length === 0
          ? 'Nothing waiting. The agent runs daily and anything it finds shows up here.'
          : `${items.length} item${items.length === 1 ? '' : 's'} waiting. Approved items go straight to the Community page.`}
      </p>

      <div className="inline" style={{ marginBottom: 18 }}>
        <button className="btn ghost" onClick={() => load()} disabled={loading}>{loading ? 'Loading' : 'Refresh'}</button>
      </div>

      {error && <p className="notice bad">{error}</p>}

      {items.map((item) => {
        const edit = edits[item.id] ?? {}
        const confident = item.confidence >= 0.8
        return (
          <section className="card" key={item.id}>
            <div className="card-head">
              <div style={{ minWidth: 0 }}>
                <a href={item.link} target="_blank" rel="noreferrer" style={{ fontWeight: 600, fontSize: 15, color: 'var(--ink)', textDecoration: 'none' }}>
                  {item.title}
                </a>
                <p className="sub">{item.source} · {item.foundAt ? new Date(item.foundAt).toLocaleDateString() : ''}</p>
              </div>
              <span className={confident ? 'pill on' : 'pill off'}>
                {Math.round((item.confidence ?? 0) * 100)}% sure
              </span>
            </div>

            <p className="fine" style={{ fontStyle: 'italic', marginTop: 0 }}>{item.reason}</p>

            <div className="form-row">
              <label className="label">Summary shown on the site</label>
              <textarea
                className="field"
                value={edit.summary ?? item.summary}
                onChange={(e) => editItem(item.id, { summary: e.target.value })}
              />
            </div>

            <div className="form-row">
              <label className="label">Type</label>
              <select className="field" value={edit.type ?? item.type} onChange={(e) => editItem(item.id, { type: e.target.value })}>
                <option value="Article">Article</option>
                <option value="Thread">Thread</option>
                <option value="Video">Video</option>
                <option value="Tool">Tool</option>
                <option value="Other">Other</option>
              </select>
            </div>

            <div className="inline" style={{ flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => decide(item, 'approve')} disabled={busy === item.id}>
                {busy === item.id ? 'Working' : 'Approve'}
              </button>
              <button className="btn ghost" onClick={() => decide(item, 'approve', true)} disabled={busy === item.id}>
                Approve and pin
              </button>
              <button className="btn ghost" onClick={() => decide(item, 'reject')} disabled={busy === item.id}>
                Reject
              </button>
              <a className="btn plain" href={item.link} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto' }}>Open</a>
            </div>
          </section>
        )
      })}
    </div>
  )
}

/* ---------- the wall ---------- */

// One field instead of two. The on-chain record still has separate name and
// handle slots, but asking for both was clutter: almost everyone wants to be
// known by one thing. A value that looks like an X handle goes in the handle
// slot and renders as a link; anything else is treated as a plain name.
function splitIdentity(value) {
  const clean = (value ?? '').trim().replace(/^@/, '')
  if (!clean) return { name: '', handle: '' }
  return /^[A-Za-z0-9_]{1,15}$/.test(clean)
    ? { name: '', handle: clean }
    : { name: clean.slice(0, 24), handle: '' }
}

function WallEntry({ entry }) {
  return (
    <article className="card" style={{ marginBottom: 12 }}>
      <div className="card-head" style={{ marginBottom: 10 }}>
        <div>
          <h3 className="h2" style={{ fontSize: 14 }}>
            {entry.handle
              ? <a href={'https://x.com/' + entry.handle} target="_blank" rel="noreferrer">@{entry.handle}</a>
              : (entry.name || 'Anonymous')}
          </h3>
          <p className="sub">{entry.postedAt.toLocaleString()}</p>
        </div>
        <span className={entry.verified ? 'pill on' : 'pill off'}>
          {entry.verified ? 'Signed by author' : 'Sponsored'}
        </span>
      </div>

      <p style={{ margin: '0 0 12px', fontSize: 15, lineHeight: 1.6, wordBreak: 'break-word' }}>{entry.message}</p>

      {entry.verified && <Address value={entry.poster} />}
    </article>
  )
}

function BrowserPostForm({ onPosted }) {
  const [who, setWho] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [signature, setSignature] = useState(null)

  const used = [...message].length
  const over = used > MESSAGE_CHARS

  const post = async () => {
    setSending(true)
    setError(null)
    setSignature(null)
    try {
      const res = await fetch('/api/post-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...splitIdentity(who), message }),
      })
      const data = await res.json()
      if (!data.ok) { setError(data.error || 'That did not post.'); return }
      setSignature(data.signature)
      setMessage('')
      onPosted()
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setSending(false)
    }
  }

  if (signature) {
    return (
      <div className="notice">
        <p style={{ margin: '0 0 6px', fontWeight: 600 }}>Posted to the chain</p>
        <p className="fine" style={{ margin: '0 0 10px' }}>Your message is now stored on Thru. Here is the transaction it created.</p>
        <Address value={signature} />
        <div className="inline" style={{ marginTop: 12 }}>
          <button className="btn ghost" onClick={() => setSignature(null)}>Post another</button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <p className="fine" style={{ marginTop: 0, lineHeight: 1.65 }}>
        ThruScan pays the fee for you, so you need no wallet and no tokens. Your message goes on chain exactly as typed
        and cannot be deleted afterwards.
      </p>

      <div className="form-row">
        <label className="label">Who are you</label>
        <input className="field" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Your X handle, or any name" maxLength={NAME_CHARS} />
        <p className="fine" style={{ margin: '6px 0 0' }}>
          Optional. An X handle becomes a link; anything else shows as plain text.
        </p>
      </div>

      <div className="form-row">
        <label className="label">Message<span className="req"> *</span></label>
        <textarea className="field" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Say something" />
        <p className="fine" style={{ margin: '6px 0 0', color: over ? 'var(--signal)' : 'var(--muted)' }}>
          {used} of {MESSAGE_CHARS} characters
        </p>
      </div>

      {error && <p className="notice bad" style={{ marginBottom: 14 }}>{error}</p>}

      <button className="btn full" onClick={post} disabled={sending || over || message.trim().length === 0}>
        {sending ? 'Posting' : 'Post to the wall'}
      </button>
    </div>
  )
}

function CliPostForm() {
  const [who, setWho] = useState('')
  const [message, setMessage] = useState('')
  // Remembered, because it is the same every time for a given person and
  // retyping it is the sort of friction that stops people bothering.
  const [keyName, setKeyName] = useState(() => localStorage.getItem('thruscan_keyname') || 'default')

  const saveKeyName = (value) => {
    setKeyName(value)
    localStorage.setItem('thruscan_keyname', value)
  }

  let command = null
  let problem = null
  try {
    if (message.trim().length > 0) {
      const hex = toHex(buildPostInstruction({ ...splitIdentity(who), message }))
      command = `thru txn execute ${WALL_PROGRAM} ${hex} --readwrite-accounts ${WALL_ACCOUNT} --fee-payer ${keyName || 'default'}`
    }
  } catch (e) {
    problem = e.message
  }

  return (
    <div>
      <p className="fine" style={{ marginTop: 0, lineHeight: 1.65 }}>
        Post signed with your own key instead of ours. Your entry gets marked as signed by the author, and your account
        address is recorded from the transaction itself rather than typed in, so it is proven rather than claimed.
        You need a CLI wallet first, which the <Link to="/guides">wallet guide</Link> covers.
      </p>

      <div className="form-row">
        <label className="label">Your key name</label>
        <input className="field mono" value={keyName} onChange={(e) => saveKeyName(e.target.value)} placeholder="default" />
        <p className="fine" style={{ margin: '6px 0 0' }}>
          Not sure which name is yours? Run <InlineCode>thru keys list</InlineCode> in your terminal and use the name it
          shows. It is whatever you picked when you ran <InlineCode>thru keys generate</InlineCode>, which is often but
          not always "default".
        </p>
      </div>

      <div className="form-row">
        <label className="label">Who are you</label>
        <input className="field" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Your X handle, or any name" maxLength={NAME_CHARS} />
        <p className="fine" style={{ margin: '6px 0 0' }}>
          Optional. An X handle becomes a link; anything else shows as plain text.
        </p>
      </div>

      <div className="form-row">
        <label className="label">Message<span className="req"> *</span></label>
        <textarea className="field" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Say something" />
        <p className="fine" style={{ margin: '6px 0 0' }}>{[...message].length} of {MESSAGE_CHARS} characters</p>
      </div>

      {problem && <p className="notice bad">{problem}</p>}

      {command && (
        <>
          <Code code={command} label="Run this in your terminal" />
          <p className="fine" style={{ marginBottom: 0 }}>
            The long hex string is your message encoded the way the program reads it. If it fails with "Fee payer account
            not found", the key name is wrong or that key has no account on chain yet — step 5 of the wallet guide covers
            creating one.
          </p>
        </>
      )}
    </div>
  )
}

// The numbers stay on screen; the lists behind them are opened on demand. Most
// visitors come to post, not to read a table, so the page leads with the form
// and keeps everything else one click away.
function WallStats({ wall }) {
  const signed = wall.entries.filter((e) => e.verified).length

  return (
    <div className="stats">
      <div className="stat">
        <b>{wall.totalPosted.toLocaleString()}</b>
        <span>messages ever</span>
      </div>
      <div className="stat">
        <b>{signed}</b>
        <span>signed by author</span>
      </div>
      <div className="stat">
        <b>{wall.entries.length}<small style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 400 }}>/{wall.capacity}</small></b>
        <span>slots filled</span>
      </div>
    </div>
  )
}

function WallPage() {
  const [wall, setWall] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('browser')
  // null keeps both lists closed on arrival.
  const [panel, setPanel] = useState(null)

  const load = async () => {
    if (!WALL_ACCOUNT) { setLoading(false); return }
    setLoading(true)
    setError(null)
    try {
      const account = await getAccount(WALL_ACCOUNT)
      setWall(decodeWall(account.data?.base64))
    } catch {
      setError('Could not read the wall right now. It may be mid-reset.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const notLive = !WALL_ACCOUNT || !WALL_PROGRAM

  return (
    <div className="wrap">
      <p className="eyebrow">On chain</p>
      <h1 className="h1">The Thru Wall</h1>
      <p className="lede">
        Leave a message and it gets written into an account on Thru by a program written in C. Not a database, not a
        server. The words below are stored on the chain itself.
      </p>

      {notLive ? (
        <div className="empty">
          <p style={{ fontWeight: 600 }}>Not live yet</p>
          <p className="fine" style={{ maxWidth: '46ch', margin: '0 auto' }}>
            The program is written and compiled, but alphanet is currently rejecting program deployments. The wall opens
            as soon as that clears.
          </p>
        </div>
      ) : (
        <>
          <section className="card">
            <div className="tabs" role="tablist" style={{ marginBottom: 18 }}>
              <button className="tab-btn" role="tab" aria-selected={tab === 'browser'} onClick={() => setTab('browser')}>Post here</button>
              <button className="tab-btn" role="tab" aria-selected={tab === 'cli'} onClick={() => setTab('cli')}>Post from your terminal</button>
            </div>
            {tab === 'browser' ? <BrowserPostForm onPosted={load} /> : <CliPostForm />}
          </section>

          {wall && <WallStats wall={wall} />}

          <div className="panel-toggle">
            <button className="panel-btn" aria-expanded={panel === 'messages'} onClick={() => setPanel(panel === 'messages' ? null : 'messages')}>
              Messages <span className="caret">▼</span>
            </button>
            <button className="btn ghost" onClick={load} disabled={loading} style={{ marginLeft: 'auto' }}>
              {loading ? 'Loading' : 'Refresh'}
            </button>
          </div>

          {error && <p className="notice bad">{error}</p>}
          {loading && !wall && <p className="fine">Reading the wall</p>}

          {wall && panel === 'messages' && (
            <>
              <p className="fine" style={{ marginTop: 0 }}>
                Showing the most recent {wall.entries.length} of {wall.capacity} slots
              </p>

              {wall.entries.length === 0 ? (
                <div className="empty">
                  <p style={{ fontWeight: 600 }}>Nothing here yet</p>
                  <p className="fine">Be the first to write on it.</p>
                </div>
              ) : (
                wall.entries.map((e) => <WallEntry key={`${e.slot}-${e.postedAtNs}`} entry={e} />)
              )}
            </>
          )}
        </>
      )}

      <footer className="foot">
        <p className="fine">
          Older messages are overwritten once the wall is full, and alphanet resets clear it entirely.
        </p>
      </footer>
    </div>
  )
}

/* ---------- games ---------- */

const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']

function WordleGame({ onFinished }) {
  const [answer, setAnswer] = useState(randomWord)
  const [guesses, setGuesses] = useState([])
  const [current, setCurrent] = useState('')
  const [status, setStatus] = useState('playing')
  const [shake, setShake] = useState(false)
  const [name, setName] = useState(() => localStorage.getItem('thruscan_player_name') || '')
  const [sending, setSending] = useState(false)
  const [signature, setSignature] = useState(null)
  const [error, setError] = useState(null)

  const finish = async (allGuesses, solved) => {
    setStatus(solved ? 'won' : 'lost')
    setSending(true)
    setError(null)
    try {
      const res = await fetch('/api/submit-game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: getPlayerId(),
          name: name.trim(),
          answer,
          guesses: allGuesses,
          solved,
        }),
      })
      const data = await res.json()
      if (!data.ok) { setError(data.error || 'Could not record that game.'); return }
      setSignature(data.signature)
      onFinished()
    } catch {
      setError('Could not reach the server. Your game still counts, it just was not recorded.')
    } finally {
      setSending(false)
    }
  }

  const submitGuess = () => {
    if (current.length !== WORD_LEN) {
      setShake(true)
      setTimeout(() => setShake(false), 400)
      return
    }
    const next = [...guesses, current]
    setGuesses(next)
    setCurrent('')

    if (current === answer) finish(next, true)
    else if (next.length === MAX_GUESSES) finish(next, false)
  }

  const press = (key) => {
    if (status !== 'playing') return
    if (key === 'enter') submitGuess()
    else if (key === 'back') setCurrent((c) => c.slice(0, -1))
    else if (/^[a-z]$/.test(key) && current.length < WORD_LEN) setCurrent((c) => c + key)
  }

  // Physical keyboard, because anyone playing on a laptop will type rather
  // than click, and a word game that ignores the keyboard feels broken.
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (document.activeElement?.tagName === 'INPUT') return
      if (e.key === 'Enter') press('enter')
      else if (e.key === 'Backspace') press('back')
      else if (/^[a-zA-Z]$/.test(e.key)) press(e.key.toLowerCase())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const newGame = () => {
    setAnswer(randomWord())
    setGuesses([])
    setCurrent('')
    setStatus('playing')
    setSignature(null)
    setError(null)
  }

  const keyState = keyboardState(guesses, answer)

  const rows = []
  for (let r = 0; r < MAX_GUESSES; r++) {
    const guess = guesses[r]
    const marks = guess ? scoreGuess(guess, answer) : null
    const letters = guess ?? (r === guesses.length ? current : '')

    rows.push(
      <div className="tile-row" key={r}>
        {Array.from({ length: WORD_LEN }, (_, c) => {
          const letter = letters[c] ?? ''
          const cls = marks ? marks[c] : letter ? 'filled' : ''
          return <div className={`tile ${cls}`} key={c}>{letter}</div>
        })}
      </div>
    )
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="h2">Guess the word</h2>
          <p className="sub">Six tries. Blue means right place, black means right letter wrong place.</p>
        </div>
      </div>

      <div className="form-row">
        <label className="label">Your name</label>
        <input
          className="field"
          value={name}
          onChange={(e) => { setName(e.target.value); localStorage.setItem('thruscan_player_name', e.target.value) }}
          placeholder="Shown on the leaderboard"
          maxLength={24}
        />
      </div>

      <div className="tiles" style={shake ? { animation: 'none' } : undefined}>{rows}</div>

      {status === 'playing' ? (
        <div className="keys">
          {KEY_ROWS.map((row, i) => (
            <div className="key-row" key={i}>
              {i === 2 && <button className="key wide" onClick={() => press('enter')}>Enter</button>}
              {row.split('').map((letter) => (
                <button className={`key ${keyState[letter] ?? ''}`} key={letter} onClick={() => press(letter)}>
                  {letter}
                </button>
              ))}
              {i === 2 && <button className="key wide" onClick={() => press('back')}>Del</button>}
            </div>
          ))}
        </div>
      ) : (
        <div className="result">
          <h3>{status === 'won' ? `Solved in ${guesses.length}` : 'Out of guesses'}</h3>
          <p className="answer">{answer}</p>
          <p className="fine" style={{ margin: '8px 0 0' }}>
            {status === 'won' ? `${pointsFor(true, guesses.length)} points` : 'No points this time'}
            {sending && ' · recording on chain'}
          </p>

          {error && <p className="notice bad" style={{ marginTop: 12, textAlign: 'left' }}>{error}</p>}

          {signature && (
            <div style={{ marginTop: 12 }}>
              <p className="fine" style={{ margin: '0 0 6px' }}>Recorded on chain</p>
              <Address value={signature} />
            </div>
          )}

          <button className="btn" onClick={newGame} style={{ marginTop: 14 }} disabled={sending}>
            {sending ? 'Saving' : 'Play again'}
          </button>
        </div>
      )}
    </section>
  )
}

function WordleBoard({ board, refresh, loading }) {
  const [tab, setTab] = useState('points')
  const me = getPlayerId()

  const ranked = tab === 'points' ? rankByPoints(board.entries) : rankByStreak(board.entries)

  return (
    <>
      <div className="stats">
        <div className="stat">
          <b>{board.games.toLocaleString()}</b>
          <span>games played</span>
        </div>
        <div className="stat">
          <b>{board.entries.length}</b>
          <span>players</span>
        </div>
        <div className="stat">
          <b>{board.entries.reduce((n, p) => n + p.won, 0).toLocaleString()}</b>
          <span>words solved</span>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <div className="tabs" role="tablist" style={{ marginBottom: 0, borderBottom: 0 }}>
            <button className="tab-btn" role="tab" aria-selected={tab === 'points'} onClick={() => setTab('points')}>Points</button>
            <button className="tab-btn" role="tab" aria-selected={tab === 'streak'} onClick={() => setTab('streak')}>Streaks</button>
          </div>
          <button className="btn ghost" onClick={refresh} disabled={loading}>{loading ? 'Loading' : 'Refresh'}</button>
        </div>

        {ranked.length === 0 ? (
          <p className="fine" style={{ marginBottom: 0 }}>Nobody has played yet. Solve one and the board is yours.</p>
        ) : (
          <div className="board">
            {ranked.slice(0, 50).map((p, i) => (
              <div className={`board-row${p.id === me ? ' you' : ''}`} key={p.id}>
                <span className="board-rank">{i + 1}</span>
                <span className="board-who">
                  <strong>{p.name || 'Anonymous'}{p.id === me && ' (you)'}</strong>
                  <span>{p.won} of {p.played} solved</span>
                </span>
                <span className="board-count">
                  {tab === 'points' ? p.points.toLocaleString() : p.bestStreak}
                  <span>{tab === 'points' ? 'points' : `best streak, ${p.streak} now`}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

function GamesPage() {
  const [board, setBoard] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = async () => {
    if (!WORDLE_BOARD) { setLoading(false); return }
    setLoading(true)
    setError(null)
    try {
      const account = await getAccount(WORDLE_BOARD)
      setBoard(decodeBoard(account.data?.base64))
    } catch {
      setError('Could not read the scoreboard right now.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  if (!WORDLE_BOARD) {
    return (
      <div className="wrap">
        <p className="eyebrow">Games</p>
        <h1 className="h1">Not live yet</h1>
        <p className="lede">The game is built and the program is deployed, but the scoreboard is still being wired up.</p>
      </div>
    )
  }

  return (
    <div className="wrap">
      <p className="eyebrow">Games</p>
      <h1 className="h1">Thru Wordle</h1>
      <p className="lede">
        Guess a five letter word in six tries. Every finished game is written to Thru by a program running on chain, and
        the scoreboard below is read straight back out of it. No wallet needed, ThruScan pays.
      </p>

      <WordleGame onFinished={load} />

      {error && <p className="notice bad">{error}</p>}
      {loading && !board && <p className="fine">Reading the scoreboard</p>}
      {board && <WordleBoard board={board} refresh={load} loading={loading} />}

      <footer className="foot">
        <p className="fine">
          The program recomputes your score from the word and your guesses, so a claimed win has to come with the guess
          that proves it. It cannot check which word you were given, since the game runs in your browser.
        </p>
        <p className="fine">Scores reset whenever alphanet resets. Think of them as seasons.</p>
      </footer>
    </div>
  )
}

/* ---------- guides ---------- */

function GuideDetail({ guide, onBack }) {
  const [openStep, setOpenStep] = useState(0)

  return (
    <div className="wrap">
      <button className="back" onClick={onBack}>← All guides</button>

      <p className="eyebrow">{guide.minutes}</p>
      <h1 className="h1">{guide.title}</h1>
      <p className="lede">{guide.intro}</p>

      {guide.steps.map((step, i) => {
        const isOpen = openStep === i
        return (
          <div className="step" key={step.title} data-open={isOpen}>
            <button className="step-head" onClick={() => setOpenStep(isOpen ? null : i)}>
              <span className="step-n">{i + 1}</span>
              <span className="step-t">{step.title}</span>
              <span className="chev">{isOpen ? '\u2212' : '+'}</span>
            </button>
            {isOpen && (
              <div className="step-body">
                <p className="fine" style={{ marginTop: 0, lineHeight: 1.7 }}>{step.description}</p>
                {step.warning && (
                  <p className="notice bad" style={{ marginBottom: 14, lineHeight: 1.65 }}>{step.warning}</p>
                )}
                {step.linkUrl && <p><a href={step.linkUrl} target="_blank" rel="noreferrer" className="fine">{step.linkLabel} →</a></p>}
                {step.command && <Code code={step.command} label={step.commandLabel || 'Run this'} />}
                {step.note && <p className="caption">{step.note}</p>}
                {step.noteCommand && <Code code={step.noteCommand} />}
                {step.verify && <Code code={step.verify} label="Check it worked" />}
                {step.verifyNote && <p className="fine" style={{ marginBottom: 0 }}>{step.verifyNote}</p>}
              </div>
            )}
          </div>
        )
      })}

      <footer className="foot">
        <p className="fine">Something unclear or out of date? <a href="https://x.com/pgreyy" target="_blank" rel="noreferrer">Let me know</a> and I will fix it.</p>
      </footer>
    </div>
  )
}

function GuidesPage() {
  const [active, setActive] = useState(null)
  const guide = GUIDES.find((g) => g.id === active)

  if (guide) return <GuideDetail guide={guide} onBack={() => setActive(null)} />

  return (
    <div className="wrap">
      <p className="eyebrow">Guides</p>
      <h1 className="h1">How to do things on Thru</h1>
      <p className="lede">Step by step, written for people who have not done this before. Every command can be copied, and every step tells you how to check it worked.</p>

      {GUIDES.map((g, i) => (
        <button className="guide" key={g.id} onClick={() => setActive(g.id)}>
          <span className="guide-n">{i + 1}</span>
          <span className="guide-body">
            <h3>{g.title}</h3>
            <p>{g.blurb}</p>
          </span>
          <span className="chev">→</span>
        </button>
      ))}

      <p className="fine" style={{ marginTop: 18 }}>
        Guides are tested against the current Thru CLI. More will be added as the network grows.
      </p>
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
  // Counting is fire and forget with keepalive, so the browser finishes the
  // request even as it navigates away. The link never waits on it.
  const countClick = () => {
    if (!item.id) return
    try {
      fetch('/api/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
        keepalive: true,
      })
    } catch { /* counting is optional */ }
  }

  return (
    <article className="post">
      <a href={item.link} target="_blank" rel="noreferrer" onClick={countClick}>
        {item.image
          ? <img className="post-img" src={item.image} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none' }} />
          : <span className="post-alt">{item.type || 'Link'}</span>}
      </a>

      <div className="post-body">
        <h3>
          <a href={item.link} target="_blank" rel="noreferrer" onClick={countClick}>{item.title}</a>
        </h3>

        {item.description && (
          <p className="fine" style={{ margin: 0, lineHeight: 1.6 }}>{item.description}</p>
        )}

        <div className="post-meta">
          {item.pinned && <span className="pill on">Pinned</span>}
          <span className="pill tag">{item.type}</span>
          {(item.twitter || item.author) && (
            item.twitter
              ? <a className="fine" href={'https://x.com/' + item.twitter} target="_blank" rel="noreferrer">@{item.twitter}</a>
              : <span className="fine">{item.author}</span>
          )}
          {item.clicks > 0 && <span className="fine" style={{ marginLeft: 'auto' }}>{item.clicks} opened</span>}
        </div>
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
  // Remembered per browser, since it is a reading preference rather than
  // something worth re-choosing on every visit.
  const [view, setView] = useState(() => localStorage.getItem('thruscan_view') || 'grid')

  const setViewMode = (mode) => { setView(mode); localStorage.setItem('thruscan_view', mode) }

  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }))

  useEffect(() => {
    fetch('/api/get-content')
      .then((r) => r.json())
      .then((data) => { setRecords(data.items || []); setLoadingRecords(false) })
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
      <p className="lede">
        Articles, threads, videos and tools from people figuring out Thru in public. Pinned items sit at the top;
        everything else rises as readers open it.
      </p>

      {records.length > 0 && (
        <div className="view-toggle">
          <button aria-pressed={view === 'grid'} onClick={() => setViewMode('grid')}>Grid</button>
          <button aria-pressed={view === 'list'} onClick={() => setViewMode('list')}>List</button>
        </div>
      )}

      {loadingRecords && <p className="fine">Loading</p>}

      {!loadingRecords && records.length === 0 && (
        <div className="empty">
          <p style={{ fontWeight: 600 }}>Nothing here yet</p>
          <p className="fine" style={{ marginBottom: 18 }}>Know something worth reading? Add it below.</p>
        </div>
      )}

      {records.length > 0 && (
        <div className={view === 'list' ? 'feed-list' : 'grid'}>
          {records.map((item) => <ContentCard key={item.id} item={item} />)}
        </div>
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
          <Route path="/wall" element={<WallPage />} />
          <Route path="/moderate" element={<ModeratePage />} />
          <Route path="/games" element={<GamesPage />} />
          <Route path="/guides" element={<GuidesPage />} />
          <Route path="/updates" element={<UpdatesPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/community" element={<CommunityPage />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  )
}
