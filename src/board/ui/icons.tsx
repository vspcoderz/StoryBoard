/**
 * Tool icons.
 *
 * Hand-drawn 24×24 paths on a 1.6 stroke rather than an icon package. Twelve glyphs do not justify a
 * dependency, and a whiteboard's toolbar is the one piece of UI where generic icons read as
 * generic — the shape of the tool *is* the label.
 */

type P = { className?: string }

const base = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

export const IconSelect = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M5 3l14 8-6 1.6L10.6 19z" />
  </svg>
)

export const IconHand = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M8 12V5.5a1.5 1.5 0 013 0V11m0-1V4.5a1.5 1.5 0 013 0V11m0-.5V6.5a1.5 1.5 0 013 0V14c0 3.3-2.7 6-6 6h-1c-2 0-3.2-1-4.2-2.6L6 15c-.6-1 .3-2.3 1.4-2l.6.3" />
  </svg>
)

export const IconRect = ({ className }: P) => (
  <svg {...base} className={className}>
    <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
  </svg>
)

export const IconEllipse = ({ className }: P) => (
  <svg {...base} className={className}>
    <ellipse cx="12" cy="12" rx="8.5" ry="7" />
  </svg>
)

export const IconDiamond = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z" />
  </svg>
)

export const IconPill = ({ className }: P) => (
  <svg {...base} className={className}>
    <rect x="2.5" y="7.5" width="19" height="9" rx="4.5" />
  </svg>
)

export const IconTriangle = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M12 4l8.5 15h-17z" />
  </svg>
)

export const IconHexagon = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" />
  </svg>
)

export const IconCylinder = ({ className }: P) => (
  <svg {...base} className={className}>
    <ellipse cx="12" cy="6" rx="7.5" ry="3" />
    <path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
  </svg>
)

export const IconCloud = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M7 18a4 4 0 01-.6-8A5.5 5.5 0 0117 9.2 3.9 3.9 0 0117.5 18z" />
  </svg>
)

export const IconDocument = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M5.5 3.5h13v14c0 1.2-1 1.7-2.2 1.2s-2.2-.4-2.2-1.2-1-1.2-2.2-1.2-2.2.4-2.2 1.2-1 1.2-2.2 1.2-2.2-.4-2.2-1.2z" />
  </svg>
)

export const IconText = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M5 6.5V5h14v1.5M12 5v14M9 19h6" />
  </svg>
)

export const IconSticky = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M4.5 4.5h15v9l-6 6h-9z" />
    <path d="M19.5 13.5h-6v6" />
  </svg>
)

export const IconDraw = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M3 20c3.5 0 4-8 7.5-8s3 4 6 4 3-2 4.5-4" />
  </svg>
)

export const IconFrame = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M7 3v18M17 3v18M3 7h18M3 17h18" />
  </svg>
)

export const IconUndo = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M4 9h10a5 5 0 010 10h-3" />
    <path d="M7.5 5.5L4 9l3.5 3.5" />
  </svg>
)

export const IconRedo = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M20 9H10a5 5 0 000 10h3" />
    <path d="M16.5 5.5L20 9l-3.5 3.5" />
  </svg>
)

export const IconFit = ({ className }: P) => (
  <svg {...base} className={className}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </svg>
)

/** A right-pointing arrow between two dots: the connector tool, distinct from the freehand squiggle. */
export const IconConnector = ({ className }: P) => (
  <svg {...base} className={className}>
    <circle cx="5" cy="12" r="2" />
    <path d="M8 12h7" />
    <path d="M12.5 8.5L16 12l-3.5 3.5" />
  </svg>
)
