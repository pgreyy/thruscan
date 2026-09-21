// src/pages/Detail.jsx
//
// The transaction page (/tx/:id) and the account page (/account/:id), in the
// same style as the explorer's front page: search on top, a details card,
// then everything else. Read live from alphanet through /api/rpc.

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getAccount, getTransaction } from '../lib/rpcClient.js'
import { describe, programName, timeAgo } from '../lib/activity.js'
import { decodeTokenProgramAccount, formatAmount } from '../lib/token.js'
import { decodeNameServiceAccount } from '../lib/nameservice.js'
import { ownedNames } from '../lib/holdings.js'
import { ROOT_SUFFIX, ROOT_REGISTRAR } from '../lib/names.js'
import { Activity } from '../components/Activity.jsx'
import { Search } from './Home.jsx'
import './home.css'

const num = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString())
const EOA_PROGRAM = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const NAME_SERVICE = 'taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUF'

function pretty(label) {
  if (!label) return null
  return label.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function Copy({ text }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="detail-copy"
      onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400) }}
    >
      {done ? 'copied' : 'copy'}
    </button>
  )
}

function Field({ k, children }) {
  return (
    <div className="detail-field">
      <span className="detail-k">{k}</span>
      <span className="detail-v">{children}</span>
    </div>
  )
}

function Addr({ value, label }) {
  if (!value) return <span>-</span>
  return (
    <span className="detail-addr">
      <Link className="mono" to={`/account/${value}`}>{value}</Link>
      {label && <span className="detail-tag">{label}</span>}
      <Copy text={value} />
    </span>
  )
}

function Frame({ title, children }) {
  return (
    <div className="home">
      <section className="home-hero detail-hero">
        <div className="home-hero-inner">
          <h1>{title}</h1>
          <Search compact />
        </div>
      </section>
      <div className="home-wrap detail-wrap">{children}</div>
    </div>
  )
}

/* ---------- transaction ---------- */

export function TxPage() {
  const { id } = useParams()
  const [tx, setTx] = useState(null)
  const [time, setTime] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    setTx(null); setTime(null); setError(null)
    getTransaction(id)
      .then(async (t) => {
        if (!alive) return
        setTx(t)
        if (t?.slot) {
          const r = await fetch(`/api/rpc?action=blocktimes&slots=${t.slot}`).then((x) => x.json()).catch(() => null)
          if (alive && r?.times?.[t.slot]) setTime(r.times[t.slot])
        }
      })
      .catch(() => { if (alive) setError('No transaction with that signature. Alphanet resets can remove old history.') })
    return () => { alive = false }
  }, [id])

  const exec = tx?.execution
  const failed = exec && (exec.userErrorCode !== '0' || (exec.vmError ?? 0) !== 0)
  const action = tx ? describe({ program: tx.program, feePayer: tx.feePayer, rw: tx.readWriteAccounts ?? [], data: tx.instructionData }, null).label : null

  return (
    <Frame title="Transaction">
      {error && <section className="home-list detail-card"><p className="notice bad" style={{ margin: '14px 0' }}>{error}</p></section>}
      {!tx && !error && <section className="home-list detail-card"><p className="fine home-pad">Reading the chain</p></section>}

      {tx && (
        <>
          <section className="home-list detail-card">
            <div className="home-list-head"><h2>Overview</h2></div>
            <Field k="Signature"><span className="detail-addr"><span className="mono detail-break">{tx.signature ?? id}</span><Copy text={tx.signature ?? id} /></span></Field>
            <Field k="Status">
              <span className={`home-badge${failed ? ' bad' : ''}`}>{failed ? 'Failed' : 'Success'}</span>
              {tx.status?.label && <span className="fine detail-after">{pretty(tx.status.label)}</span>}
            </Field>
            <Field k="Action"><b>{action}</b></Field>
            <Field k="Block">
              <span className="mono">{num(tx.slot)}</span>
              {time && <span className="fine detail-after">{timeAgo(time)} · {new Date(time).toLocaleString()}</span>}
            </Field>
            <Field k="From"><Addr value={tx.feePayer} /></Field>
            <Field k="Program"><Addr value={tx.program} label={programName(tx.program)} /></Field>
            <Field k="Fee"><span>{num(tx.fee)} THRU</span></Field>
            {failed && (
              <Field k="Error"><span className="mono">vm {exec.vmError}, program code {exec.userErrorCode}</span></Field>
            )}
          </section>

          <section className="home-list detail-card">
            <div className="home-list-head"><h2>Accounts</h2><span className="fine">{(tx.readWriteAccounts?.length ?? 0) + (tx.readOnlyAccounts?.length ?? 0)}</span></div>
            {(tx.readWriteAccounts ?? []).map((a) => (
              <Field key={`w${a}`} k="Written"><Addr value={a} label={programName(a)} /></Field>
            ))}
            {(tx.readOnlyAccounts ?? []).map((a) => (
              <Field key={`r${a}`} k="Read"><Addr value={a} label={programName(a)} /></Field>
            ))}
          </section>

          <section className="home-list detail-card">
            <details>
              <summary className="home-list-head detail-summary"><h2>Execution</h2></summary>
              <Field k="Compute used"><span className="mono">{num(exec?.consumedCompute)} of {num(tx.requested?.compute)}</span></Field>
              <Field k="State used"><span className="mono">{num(exec?.consumedState)} of {num(tx.requested?.state)}</span></Field>
              <Field k="Memory used"><span className="mono">{num(exec?.consumedMemory)} of {num(tx.requested?.memory)}</span></Field>
              <Field k="Events"><span className="mono">{num(exec?.eventsCount)}</span></Field>
              <Field k="Nonce"><span className="mono">{tx.nonce}</span></Field>
              <Field k="Instruction data"><span className="mono">{num(tx.instructionDataSize)} bytes</span></Field>
            </details>
          </section>
        </>
      )}
    </Frame>
  )
}

/* ---------- account ---------- */

function kindOf(account, token, ns) {
  const meta = account?.meta
  if (!meta) return 'Account'
  if (meta.flags?.isProgram) return 'Program'
  if (token) return token.kindLabel === 'mint' ? 'Token mint' : 'Token account'
  if (ns) return ns.kindLabel === 'domain' ? 'Name' : 'Name root'
  if (!meta.owner || meta.owner === EOA_PROGRAM) return 'Wallet'
  return 'Data account'
}

export function AccountPage() {
  const { id } = useParams()
  const [account, setAccount] = useState(null)
  const [error, setError] = useState(null)
  const [names, setNames] = useState(null)

  useEffect(() => {
    let alive = true
    setAccount(null); setError(null); setNames(null)
    getAccount(id)
      .then((a) => { if (alive) setAccount(a) })
      .catch(() => { if (alive) setError('Nothing on alphanet at that address. 0 and O look alike in these addresses.') })
    return () => { alive = false }
  }, [id])

  let token = null, ns = null
  try { token = account ? decodeTokenProgramAccount(account.data?.base64, account.meta?.owner) : null } catch { token = null }
  try { ns = account?.meta?.owner === NAME_SERVICE ? decodeNameServiceAccount(account.data?.base64) : null } catch { ns = null }
  const kind = kindOf(account, token, ns)

  useEffect(() => {
    if (kind !== 'Wallet' || !account?.address) return
    let alive = true
    ownedNames(account.address).then((rows) => { if (alive) setNames(rows.map((r) => r.name)) }).catch(() => {})
    return () => { alive = false }
  }, [kind, account?.address])

  const meta = account?.meta

  return (
    <Frame title="Account">
      {error && <section className="home-list detail-card"><p className="notice bad" style={{ margin: '14px 0' }}>{error}</p></section>}
      {!account && !error && <section className="home-list detail-card"><p className="fine home-pad">Reading the chain</p></section>}

      {account && (
        <>
          <section className="home-list detail-card">
            <div className="home-list-head"><h2>Overview</h2><span className="home-badge">{kind}</span></div>
            <Field k="Address"><span className="detail-addr"><span className="mono detail-break">{account.address ?? id}</span><Copy text={account.address ?? id} /></span></Field>
            {names && names.length > 0 && (
              <Field k="Names"><b>{names.map((n) => `${n}.${ROOT_SUFFIX}`).join(', ')}</b></Field>
            )}
            <Field k="Balance"><b>{num(meta?.balance)} THRU</b></Field>

            {token?.kindLabel === 'mint' && (
              <>
                <Field k="Ticker"><b>{token.ticker || 'Unnamed'}</b><Link className="fine" to={`/token/${account.address ?? id}`}>token page, price and trades</Link></Field>
                <Field k="Supply"><span>{token.supplyDisplay}</span><span className="fine detail-after">{token.decimals} decimals</span></Field>
                <Field k="Mint authority"><Addr value={token.mintAuthority} /></Field>
                <Field k="Creator"><Addr value={token.creator} /></Field>
              </>
            )}
            {token?.kindLabel === 'token-account' && (
              <>
                <Field k="Holds"><b>{formatAmount(token.amount, 0)}</b><span className="fine detail-after">base units</span></Field>
                <Field k="Token"><Addr value={token.mint} /></Field>
                <Field k="Owner"><Addr value={token.owner} /></Field>
              </>
            )}
            {ns?.kindLabel === 'domain' && (
              <>
                <Field k="Name"><b>{ns.parent === ROOT_REGISTRAR ? `${ns.domainName}.${ROOT_SUFFIX}` : ns.domainName}</b></Field>
                <Field k="Owner"><Addr value={ns.owner} /></Field>
                {ns.records.map((r) => (
                  <Field key={r.key} k={r.key}><span className="mono detail-break">{r.display ?? r.text ?? ''}</span></Field>
                ))}
              </>
            )}

            {meta?.owner && meta.owner !== EOA_PROGRAM && (
              <Field k="Owned by"><Addr value={meta.owner} label={programName(meta.owner)} /></Field>
            )}
            <Field k="Data"><span className="mono">{num(meta?.dataSize)} bytes</span></Field>
          </section>

          <Activity key={account.address} addresses={[account.address ?? id]} me={account.address ?? id} title="Transactions" />
        </>
      )}
    </Frame>
  )
}
