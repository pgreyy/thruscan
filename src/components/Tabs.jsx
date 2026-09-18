/**
 * A tab strip.
 *
 * Scrolling is a bad way to move between things that are not related. Swap,
 * liquidity and the pool list are three different jobs, and so are the builder
 * directory, the project list and the community page: putting them on top of
 * each other means the second one is found by accident, if at all.
 *
 * The selected tab lives in the URL rather than in state, which costs nothing
 * and buys three things: the back button works, a refresh keeps you where you
 * were, and a link to a tab is a link to that tab.
 *
 * Every panel's element is built by the caller, but only the selected one is
 * rendered. React elements are cheap to make and do nothing until mounted, so
 * the three unselected pages never fetch anything.
 */

import { useSearchParams } from 'react-router-dom'

export function Tabs({ tabs, param = 'tab', eyebrow, title, lede }) {
  const [params, setParams] = useSearchParams()
  const wanted = params.get(param)
  const active = tabs.find((t) => t.key === wanted) ?? tabs[0]

  const pick = (key) => {
    const next = new URLSearchParams(params)
    if (key === tabs[0].key) next.delete(param)
    else next.set(param, key)
    // replace, so flicking between tabs does not fill the back button with
    // steps nobody wants to walk back through.
    setParams(next, { replace: true })
  }

  return (
    <>
      {(eyebrow || title || lede) && (
        <div className="wrap wrap-tight">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          {title && <h1 className="h1">{title}</h1>}
          {lede && <p className="lede">{lede}</p>}
        </div>
      )}

      <div className="tabstrip-wrap">
        <div className="tabstrip" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              className="tabstrip-tab"
              aria-selected={t.key === active.key}
              onClick={() => pick(t.key)}
            >
              {t.label}
              {t.badge != null && <span className="tabstrip-badge">{t.badge}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="tabstrip-panel" role="tabpanel">{active.el}</div>
    </>
  )
}

export default Tabs
