// src/components/Icon.jsx
//
// The icon set, drawn on a 20px grid with a 1.6 stroke and square caps.
//
// Inline rather than an icon package: a dozen glyphs is not worth a
// dependency, and these inherit currentColor so they follow the text they sit
// in, in either theme. The shapes are the design system's (artboard 2c); only
// add one here when an action has a symbol people already recognise.

const SHAPES = {
  search: <><circle cx="9" cy="9" r="5.5" /><path d="M13 13L17 17" /></>,
  copy: <><rect x="7" y="7" width="9" height="9" rx="1.5" /><path d="M4 13V5.5C4 4.7 4.7 4 5.5 4H13" /></>,
  external: <path d="M11 4H16V9M16 4L9 11M8 5H4V16H15V12" />,
  success: <path d="M4.5 10.5L8 14L15.5 6.5" />,
  failed: <path d="M5 5L15 15M15 5L5 15" />,
  warning: <><path d="M10 3L18 16.5H2Z" /><path d="M10 8V11.5M10 13.5V14.5" /></>,
  swap: <path d="M4 7H16L12.5 3.5M16 13H4L7.5 16.5" />,
  flip: <path d="M7 4V16L4 13M13 16V4L16 7" />,
  wallet: <><rect x="3" y="5" width="14" height="11" rx="2" /><path d="M12.5 10.5H17" /></>,
  create: <path d="M10 4V16M4 10H16" />,
  pending: <><circle cx="10" cy="10" r="6.5" /><path d="M10 6.5V10L12.5 11.5" /></>,
  locked: <><rect x="4.5" y="9" width="11" height="8" rx="1.5" /><path d="M7 9V6.5C7 4.8 8.3 3.5 10 3.5S13 4.8 13 6.5V9" /></>,
  expand: <path d="M6 8L10 12L14 8" />,
  'arrow-left': <path d="M16 10H4M8 6L4 10L8 14" />,
  'arrow-right': <path d="M4 10H16M12 6L16 10L12 14" />,
  menu: <path d="M3 6H17M3 10H17M3 14H17" />,
  /* Update 02: the bell, the carousel arrows and the wall. */
  bell: <><path d="M5 14V9A5 5 0 0 1 15 9V14L16.5 15.5H3.5Z" /><path d="M8 17.5H12" /></>,
  'chevron-left': <path d="M12 5L7 10L12 15" />,
  'chevron-right': <path d="M8 5L13 10L8 15" />,
  message: <path d="M3.5 4.5H16.5V13.5H9L5.5 16.5V13.5H3.5Z" />,
  coins: <><circle cx="8" cy="8" r="4.5" /><path d="M11.5 5.5A4.5 4.5 0 1 1 8 15.5" /></>,
  receive: <path d="M10 3.5V14M5.5 9.5L10 14L14.5 9.5M4 16.5H16" />,
  send: <path d="M10 16.5V6M5.5 10.5L10 6L14.5 10.5M4 3.5H16" />,
}

export function Icon({ name, size = 20, stroke = 1.6, className, title }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor"
      strokeWidth={stroke} strokeLinecap="square" strokeLinejoin="miter"
      className={className} aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      {SHAPES[name]}
    </svg>
  )
}

/** The loading arc: a 16px spinner beside a verb. Under reduced motion it
 *  stops turning and the clock stands in for it, so the wait still reads. */
export function Spinner({ size = 16 }) {
  return (
    <span className="spin" aria-hidden="true">
      <svg className="spin-arc" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M10 3A7 7 0 1 1 3 10" />
      </svg>
      <Icon name="pending" size={size} className="spin-still" />
    </span>
  )
}

export default Icon
