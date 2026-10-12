import { ThemeRow } from './components/ThemeSwitch.jsx'
import { Icon, Spinner } from './components/Icon.jsx'
import { CopyId } from './components/CopyId.jsx'
import { onToast } from './lib/toasts.js'
import { Analytics } from '@vercel/analytics/react'
import { CloudflareBeacon, usePageViews } from './components/Counters.jsx'
import { useState, useEffect, useRef, createContext, useCallback, useSyncExternalStore } from 'react'
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate, Navigate } from 'react-router-dom'
import { SwapPage, LaunchDetailPage, FaucetPage } from './pages/Dex.jsx'
import { MarketHome } from './pages/Market.jsx'
import { Wordmark } from './components/Wordmark.jsx'
import { WalletPage } from './pages/Wallet.jsx'
import { NamesPage } from './pages/Names.jsx'
import { WalletPill } from './components/WalletPill.jsx'
import { useDismissDetails } from './lib/dismiss.js'
import { NotificationBell, NotificationWatch } from './components/Notifications.jsx'
import { TabBar } from './components/TabBar.jsx'
import { ProfilePage } from './pages/Profile.jsx'
import { Search } from './pages/Home.jsx'
import { ExplorerPage } from './pages/Explorer.jsx'
import { TxPage, AccountPage } from './pages/Detail.jsx'
import { TokenPage } from './pages/Token.jsx'
import { GetWalletPage } from './pages/GetWallet.jsx'
import { PalsPage } from './pages/Pals.jsx'
import { NftsPage } from './pages/Nfts.jsx'
import { StatsPage } from './pages/Stats.jsx'
import { WordlePage } from './pages/Wordle.jsx'
import { getBlockHeight } from './lib/rpcClient'
import { network } from './lib/networks.js'
import './styles.css'

/* The bar (Update 02, 5a): ThruPad, Swap and Explorer, then More.
 *
 * `exact` matters for '/' and only for '/'. Active state elsewhere is a prefix
 * match so that /launch/3 lights ThruPad, but a prefix match on '/' matches
 * every page on the site. */
const TOP_NAV = [
  { to: '/', label: 'ThruPad', exact: true, also: ['/token', '/launch', '/create'] },
  { to: '/swap', label: 'Swap' },
  { to: '/explorer', label: 'Explorer', also: ['/tx', '/account', '/block'] },
]
/* More, in this order, on the desktop menu and in the phone drawer. */
const MORE_NAV = [
  { to: '/collections', label: 'Collections', also: ['/pixelpals'] },
  { to: '/names', label: 'ThruID' },
  { to: '/faucet', label: 'Faucet' },
  { to: '/get-wallet', label: 'ThruScan Wallet' },
  { to: '/games', label: 'Wordle' },
]

/* Pages you arrive at from a list. On a phone they get a back arrow in the
   bar, since there is no nav item lit to take you back up. */
const DETAIL_PATHS = ['/launch/', '/token/', '/tx/', '/account/']

/* Whether the desktop bar is showing (1024px and up). */
const DESK = '(min-width: 1024px)'
function useDesktop() {
  return useSyncExternalStore(
    (fn) => { const m = window.matchMedia(DESK); m.addEventListener('change', fn); return () => m.removeEventListener('change', fn) },
    () => window.matchMedia(DESK).matches,
    () => true,
  )
}

/* ---------- toasts ----------
   A tiny context rather than prop drilling, because anything that writes to
   the chain should be able to confirm it without every component in between
   knowing about toasts. */

const ToastContext = createContext(() => {})

function ToastHost({ children }) {
  const [items, setItems] = useState([])

  const dismiss = useCallback((id) => setItems((list) => list.filter((t) => t.id !== id)), [])

  const show = useCallback((toast) => {
    const id = Math.random().toString(36).slice(2)
    setItems((list) => [...list.slice(-2), { ...toast, id }])
    // Long enough to read a signature and decide, short enough not to linger.
    setTimeout(() => dismiss(id), 6500)
  }, [dismiss])

  // Toasts raised from anywhere (see lib/toasts.js).
  useEffect(() => onToast(show), [show])

  return (
    <ToastContext.Provider value={show}>
      {children}

      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <Toast key={t.id} toast={t} onClose={() => dismiss(t.id)} />)}
      </div>
    </ToastContext.Provider>
  )
}

function Toast({ toast, onClose }) {
  /* Four kinds (2h): submitted, confirmed, failed, rejected. Older callers
     pass none; anything with a signature has landed, so it reads as done. */
  const kind = toast.kind ?? (toast.signature ? 'confirmed' : 'info')
  const icon = kind === 'submitted' ? <Spinner size={18} />
    : kind === 'confirmed' ? <Icon name="success" size={18} stroke={2} />
      : kind === 'failed' || kind === 'rejected' ? <Icon name="failed" size={18} stroke={2} />
        : null

  return (
    <div className={`toast ${kind}`}>
      {icon && <span className="toast-icon">{icon}</span>}
      <div className="toast-body">
        <div className="toast-title">{toast.title}</div>
        {toast.sub && <div className="toast-sub">{toast.sub}</div>}
        {toast.signature && (
          <span className="toast-sig"><CopyId value={toast.signature} to={`/tx/${toast.signature}`} onNavigate={onClose} /></span>
        )}
      </div>
      <button className="toast-close" onClick={onClose} aria-label="Dismiss"><Icon name="failed" size={16} /></button>
    </div>
  )
}

/* ---------- shell ---------- */

/* The test-network strip can be closed; the badge in the bar cannot, so the
   site never stops saying it is a test network. The choice is read before the
   first paint so a closed strip never flashes. */
const STRIP_KEY = 'thruscan_testnet_banner_dismissed'
function readStripClosed() {
  try { return localStorage.getItem(STRIP_KEY) === '1' } catch { return false }
}
function saveStripClosed(closed) {
  try {
    if (closed) localStorage.setItem(STRIP_KEY, '1')
    else localStorage.removeItem(STRIP_KEY)
  } catch { /* private mode: it stays closed for this visit only */ }
}

/* "How ThruScan works" in the test strip re-opens the New here? steps on the
   home page, which is where they live; the home page listens for this. */
const INTRO_KEY = 'thruscan_intro'
function reopenIntro() {
  try { localStorage.removeItem(`${INTRO_KEY}_dismissed`) } catch { /* private mode */ }
  window.dispatchEvent(new Event('thruscan-intro'))
}

/* The networks the menu lists: the one this build is pointed at. Its name
   comes from the network config, never from a string typed here. */
const NETWORKS = [network]

const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
const titleCase = (w) => w.charAt(0).toUpperCase() + w.slice(1)

/* The network badge (2f): which network, and that it is a test one. It is a
   button that opens the network menu on click, tap, Enter or Space, never on
   hover: hover does not exist on touch and closes by accident.
 *
 * The block height is read through the proxy on a timer; it is the one number
 * that proves the site is talking to a real chain, so it stays, in the
 * tooltip. Dashed until the first read answers, red with a cross once a read
 * fails. Never green: "healthy" is not something the site can promise. */
function NetworkMenu({ stripClosed, onShowStrip }) {
  const [height, setHeight] = useState(null)
  const [down, setDown] = useState(false)
  const [readAt, setReadAt] = useState(null)
  /* Open on the page it was opened on, so following a link puts it away. */
  const { pathname } = useLocation()
  const [openOn, setOpenOn] = useState(null)
  const open = openOn === pathname
  const setOpen = (v) => setOpenOn((was) => ((typeof v === 'function' ? v(was === pathname) : v) ? pathname : null))
  const wrap = useRef(null)
  const btn = useRef(null)
  const pop = useRef(null)

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const h = await getBlockHeight()
        const n = (h && typeof h === 'object')
          ? Object.values(h).find((v) => typeof v === 'string' || typeof v === 'number')
          : h
        if (!alive) return
        setHeight(n == null ? null : String(n))
        setDown(n == null)
        if (n != null) setReadAt(Date.now())
      } catch {
        if (alive) setDown(true)
      }
    }
    tick()
    const id = setInterval(tick, 12000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  useEffect(() => {
    if (!open) return undefined
    pop.current?.focus()
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpenOn(null) }
    const key = (e) => {
      if (e.key !== 'Escape') return
      setOpenOn(null)
      btn.current?.focus()
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key) }
  }, [open])

  /* The network's name comes from the build rather than from a string typed
     here, so it cannot go on saying "alphanet" on the day that stops being
     true. */
  const name = network.label.toUpperCase()
  const pretty = height && !Number.isNaN(Number(height)) ? Number(height).toLocaleString() : height
  const title = `${network.label}${network.test ? ' (test network)' : ''}${pretty ? ` · block ${pretty}` : ''}`
  const state = down ? 'down' : !height ? 'checking' : 'ok'

  return (
    <div className="netmenu" ref={wrap}>
      <button
        ref={btn} type="button" title={title}
        className={`netbadge${state === 'ok' ? '' : ` ${state}`}`}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}
      >
        {state === 'down' && <><Icon name="failed" size={12} stroke={2.4} /><span className="long">{name} · UNREACHABLE</span><span className="short">{network.test ? 'TEST' : name}</span></>}
        {state === 'checking' && <><span className="netbadge-dot" /><span className="long">CHECKING NETWORK</span><span className="short">CHECKING</span></>}
        {state === 'ok' && <><span className="netbadge-dot" /><span className="long">{name}{network.test ? ' · TEST' : ''}</span><span className="short">{network.test ? 'TEST' : name}</span></>}
        <Icon name="expand" size={12} stroke={1.8} className="netbadge-chev" />
      </button>
      <span className="sr-only" role="status">{state === 'down' ? 'Network unreachable' : state === 'checking' ? 'Checking network' : ''}</span>

      {open && (
        <>
          <div className="netmenu-scrim" aria-hidden="true" onPointerDown={() => setOpenOn(null)} />
          <div className="netmenu-pop" ref={pop} role="dialog" aria-label="Network" tabIndex={-1}>
            <span className="netmenu-grab" aria-hidden="true" />
            <div className="netmenu-label">Network</div>
            {NETWORKS.map((n) => (
              <div key={n.label} className="netmenu-net">
                <div className="netmenu-net-top">
                  <span className="netbadge-dot" />
                  <b>{titleCase(n.label)}</b>
                  {n.test && <span className="netmenu-chip">TEST</span>}
                  {n === network && <Icon name="success" size={16} className="netmenu-check" title="Current network" />}
                </div>
                {n.test && <div className="netmenu-sub">Thru test network. Tokens have no value.</div>}
              </div>
            ))}
            <div className={`netmenu-status ${state}`}>
              <span className="netmenu-status-k">
                {state === 'down' ? <Icon name="failed" size={12} stroke={2.4} /> : <span className="netbadge-dot" />}
                {state === 'down' ? 'Unreachable' : state === 'checking' ? 'Checking…' : 'Reachable'}
              </span>
              {readAt && <span className="netmenu-time">Last update {hhmm(readAt)}</span>}
            </div>
            {network.test && stripClosed && (
              <>
                <div className="menu-sep" />
                <button type="button" className="netmenu-item" onClick={() => { onShowStrip(); setOpen(false); btn.current?.focus() }}>Show test network notice</button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/* The test-network strip, under the bar on every page while the network is a
   test one. It is the product's first promise: nothing here has value. It can
   be closed because the badge in the bar goes on saying so. */
function TestStrip({ closed, onClose }) {
  if (!network.test || closed) return null
  const name = network.label.toLowerCase()
  return (
    <div className="teststrip" role="note">
      <span className="teststrip-long">
        <span className="teststrip-chip">TEST NETWORK</span>
      </span>
      <span className="teststrip-long">Thru {name}. Tokens here have no value, and balances can disappear when the network resets.</span>
      <span className="teststrip-long ts-push" />
      <Link className="teststrip-long" to="/" onClick={reopenIntro}>How ThruScan works</Link>
      <span className="teststrip-short">
        <b>Test network.</b> Tokens on Thru {name} have no value. <Link to="/" onClick={reopenIntro}>Learn more</Link>
      </span>
      <button type="button" className="teststrip-x" onClick={onClose} aria-label="Dismiss test network notice">
        <Icon name="failed" size={20} />
      </button>
    </div>
  )
}
/* The footer (Update 02, 5k): the symbol and name, one line about the site,
   and one link. On a phone it clears the tab bar. */
function SiteFooter() {
  return (
    <footer className="site-foot">
      <div className="site-foot-in">
        <div className="site-foot-id">
          <span className="site-foot-brand"><Wordmark /></span>
          <p className="site-foot-text">Launch, swap and track tokens on Thru.</p>
        </div>
        <Link className="site-foot-link" to="/get-wallet">ThruScan Wallet</Link>
      </div>
    </footer>
  )
}

function Shell({ children }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const desktop = useDesktop()

  /* Whether a nav link is the page you are on. A prefix match is what makes
     /launch/3 light up ThruPad, but '/' is a prefix of everything, so the
     link that points at the root has to ask for an exact match instead. */
  const isOn = (l) =>
    (l.exact ? pathname === l.to : pathname === l.to || pathname.startsWith(l.to + '/')) ||
    (l.also ?? []).some((t) => pathname === t || pathname.startsWith(t + '/'))
  const active = (l) => (isOn(l) ? 'page' : undefined)
  const moreOn = MORE_NAV.some(isOn)

  const [drawer, setDrawer] = useState(false)
  const [finding, setFinding] = useState(false)
  const [stripClosed, setStripClosed] = useState(readStripClosed)
  const closeStrip = () => { saveStripClosed(true); setStripClosed(true) }
  const showStrip = () => { saveStripClosed(false); setStripClosed(false) }
  const moreRef = useRef(null)
  const moreTimer = useRef(null)
  useEffect(() => () => clearTimeout(moreTimer.current), [])
  useDismissDetails(moreRef)

  // Following a link puts the drawer and the search row away again.
  const [lastPath, setLastPath] = useState(pathname)
  if (lastPath !== pathname) { setLastPath(pathname); setDrawer(false); setFinding(false) }

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { setDrawer(false); setFinding(false); return }
      // "/" jumps to search from anywhere that is not already a text field.
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      e.preventDefault()
      const desk = document.querySelector('.bar-search input')
      if (desk && desk.offsetParent) desk.focus()
      else setFinding(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const isDetail = DETAIL_PATHS.some((p) => pathname.startsWith(p))
  const back = () => (window.history.length > 1 ? navigate(-1) : navigate('/'))

  const closeMore = (e) => e.currentTarget.closest('details')?.removeAttribute('open')
  const moreLink = (l, onClick, className) => (
    <Link key={l.label} className={className} to={l.to} aria-current={active(l)} onClick={onClick}>{l.label}</Link>
  )

  return (
    <div className="shell">
      <NotificationWatch />
      <header className="bar">
        {/* Desktop: a three-column grid, so the search sits in the true
            centre. Phone: the groups dissolve into one row (display:
            contents) and each item takes its place by order. */}
        <div className="bar-in">
          <div className="bar-left">
            {isDetail && (
              <button className="bar-icon bar-back" onClick={back} aria-label="Back"><Icon name="arrow-left" /></button>
            )}
            <Link to="/" className="brand" aria-label="ThruScan home"><Wordmark /></Link>

            <nav className="bar-nav" aria-label="Main">
              {TOP_NAV.map((l) => (
                <Link key={l.to} to={l.to} aria-current={active(l)}>{l.label}</Link>
              ))}
              {/* Opens on hover as well as on click. Leaving closes it after a
                  beat rather than instantly, because the pointer has to cross a
                  gap between the summary and the menu. Touch never fires these. */}
              <details
                className={`bar-more${moreOn ? ' on' : ''}`}
                ref={moreRef}
                onPointerEnter={(e) => { if (e.pointerType === 'mouse') { clearTimeout(moreTimer.current); e.currentTarget.open = true } }}
                onPointerLeave={(e) => {
                  if (e.pointerType !== 'mouse') return
                  const el = e.currentTarget
                  moreTimer.current = setTimeout(() => { el.open = false }, 180)
                }}
              >
                <summary>More<Icon name="expand" size={14} stroke={1.8} /></summary>
                <div className="menu" style={{ left: 0 }}>
                  {MORE_NAV.map((l) => moreLink(l, closeMore))}
                  <div className="menu-sep" />
                  <ThemeRow />
                </div>
              </details>
            </nav>
          </div>

          <div className="bar-search"><Search bar /></div>

          <div className="bar-right">
            <NetworkMenu stripClosed={stripClosed} onShowStrip={showStrip} />
            <span className="bar-spacer" />
            <button className="bar-icon bar-find" onClick={() => setFinding((f) => !f)} aria-label="Search" aria-expanded={finding}>
              <Icon name="search" />
            </button>
            <NotificationBell mobile={!desktop} />
            <WalletPill />
            <button className="bar-icon bar-menu" onClick={() => setDrawer(true)} aria-label="Menu" aria-expanded={drawer}>
              <Icon name="menu" />
            </button>
          </div>
        </div>
        {finding && <div className="bar-searchrow"><Search bar autoFocus /></div>}
      </header>

      <TestStrip closed={stripClosed} onClose={closeStrip} />

      {drawer && (
        <>
          <button className="scrim drawer-scrim" aria-label="Close menu" onClick={() => setDrawer(false)} />
          <nav className="drawer" aria-label="Menu">
            <div className="drawer-top">
              <Wordmark />
              <button className="bar-icon" onClick={() => setDrawer(false)} aria-label="Close menu"><Icon name="failed" /></button>
            </div>
            <Search bar />
            {TOP_NAV.map((l) => (
              <Link key={l.to} className="drawer-link" to={l.to} aria-current={active(l)}>{l.label}</Link>
            ))}
            <div className="menu-sep" />
            {MORE_NAV.map((l) => moreLink(l, undefined, 'drawer-link'))}
            <div className="menu-sep" />
            <ThemeRow />
          </nav>
        </>
      )}

      <main className="main">{children}</main>
      <SiteFooter />
      {!desktop && <TabBar />}
    </div>
  )
}

/* Any address the site does not know. */
function NotFoundPage() {
  return (
    <div className="wrap nf">
      <h1 className="h1">Nothing at this address</h1>
      <p className="lede">There is no page here. If you followed a link to a token or a transaction, it may have been on a network that has since been reset.</p>
      <div className="nf-actions">
        <Link className="btn" to="/">Go to ThruPad</Link>
        <Link className="btn secondary" to="/explorer">Open Explorer</Link>
      </div>
    </div>
  )
}

/* The front door. It also catches the query links the old home page
   understood, which are in people's messages and bookmarks. */
function HomeRoute() {
  const navigate = useNavigate()
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (q.get('tx')) navigate(`/tx/${q.get('tx')}`, { replace: true })
    else if (q.get('account')) navigate(`/account/${q.get('account')}`, { replace: true })
    else if (q.get('tab')) navigate(`/explorer?tab=${q.get('tab')}`, { replace: true })
  }, [navigate])
  return <MarketHome />
}

/* /activity and /wall moved into the Explorer (Update 02, section 4). The
   query string comes along, so /activity?address=ta… still filters. */
function ToExplorer({ tab }) {
  const { search } = useLocation()
  const q = new URLSearchParams(search)
  q.set('tab', tab)
  return <Navigate to={`/explorer?${q}`} replace />
}

/* Page views. Vercel counts them on its own; this reports each in-app page
   change as well, since the site never reloads while you move around it. */
function Counted() {
  usePageViews()
  return (<><Analytics /><CloudflareBeacon /></>)
}

/* Pages retired in Update 02. Their old addresses land on ThruPad. */
const RETIRED = ['/archives', '/builders', '/guides', '/updates', '/projects', '/community', '/moderate']

export default function App() {
  return (
    <BrowserRouter>
      <ToastHost>
        <Shell>
          <Counted />
          <Routes>
            <Route path="/" element={<HomeRoute />} />
            <Route path="/create" element={<MarketHome create />} />
            <Route path="/explorer" element={<ExplorerPage />} />
            <Route path="/activity" element={<ToExplorer tab="activity" />} />
            <Route path="/wall" element={<ToExplorer tab="wall" />} />
            <Route path="/launch" element={<Navigate to="/" replace />} />
            <Route path="/tx/:id" element={<TxPage />} />
            <Route path="/account/:id" element={<AccountPage />} />
            <Route path="/token/:mint" element={<TokenPage />} />
            <Route path="/swap" element={<SwapPage />} />
            <Route path="/launch/:id" element={<LaunchDetailPage />} />
            <Route path="/faucet" element={<FaucetPage />} />
            <Route path="/wallet" element={<WalletPage />} />
            <Route path="/get-wallet" element={<GetWalletPage />} />
            <Route path="/pixelpals" element={<PalsPage />} />
            <Route path="/pals" element={<Navigate to="/pixelpals" replace />} />
            <Route path="/collections" element={<NftsPage />} />
            <Route path="/nfts" element={<Navigate to="/collections" replace />} />
            {/* Not linked anywhere: ThruScan's own numbers. */}
            <Route path="/stats" element={<StatsPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/names" element={<NamesPage />} />
            {/* Wordle keeps its address; 2048 is retired. */}
            <Route path="/games" element={<WordlePage />} />
            <Route path="/wordle" element={<Navigate to="/games" replace />} />
            {RETIRED.map((p) => <Route key={p} path={p} element={<Navigate to="/" replace />} />)}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Shell>
      </ToastHost>
    </BrowserRouter>
  )
}
