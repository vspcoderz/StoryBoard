/**
 * Theme bridge for the canvas.
 *
 * The CSS custom properties in `globals.css` are the single source of truth. The canvas cannot use
 * Tailwind classes, so it reads the same variables back through `getComputedStyle` and paints with
 * identical values. One source of truth means the toolbar and the board can never drift apart — the
 * failure mode where a light chrome sits over a dark canvas, which looks broken and reads as a bug.
 *
 * Because the variables resolve per media query, the canvas needs no appearance state of its own. It
 * just re-reads them when the system appearance changes.
 */

export type Theme = {
  sheet: string
  grid: string
  ink: string
  graphite: string
  line: string
  brass: string
  brassWash: string
  vermilion: string
  beat: string
  turning: string
  character: string
  location: string
  thread: string
}

const VARS: Record<keyof Theme, string> = {
  sheet: '--color-sheet',
  grid: '--color-grid',
  ink: '--color-ink',
  graphite: '--color-graphite',
  line: '--color-line',
  brass: '--color-brass',
  brassWash: '--color-brass-wash',
  vermilion: '--color-vermilion',
  beat: '--color-beat',
  turning: '--color-turning',
  character: '--color-character',
  location: '--color-location',
  thread: '--color-thread',
}

const FALLBACK: Theme = {
  sheet: '#f6f7f9',
  grid: '#d4d8e0',
  ink: '#15171c',
  graphite: '#5c6270',
  line: '#c9cdd6',
  brass: '#a9741a',
  brassWash: '#f6efe1',
  vermilion: '#c2410c',
  beat: '#7a5119',
  turning: '#822944',
  character: '#0d3c37',
  location: '#8748b6',
  thread: '#4070bd',
}

let cached: Theme | null = null

export function readTheme(el: HTMLElement = document.documentElement): Theme {
  if (typeof window === 'undefined') return FALLBACK
  const cs = getComputedStyle(el)
  const out = {} as Theme
  for (const key of Object.keys(VARS) as (keyof Theme)[]) {
    // An empty string means the variable is unset (stylesheet not loaded yet, or a test
    // environment). Falling back keeps the canvas paintable instead of silently black.
    out[key] = cs.getPropertyValue(VARS[key]).trim() || FALLBACK[key]
  }
  return out
}

export function theme(): Theme {
  return cached ?? FALLBACK
}

/** Call once the canvas is mounted, and again whenever the system appearance flips. */
export function initTheme(onChange: () => void): () => void {
  cached = readTheme()
  if (typeof window === 'undefined') return () => {}

  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const handle = () => {
    cached = readTheme()
    onChange()
  }
  mq.addEventListener('change', handle)
  return () => mq.removeEventListener('change', handle)
}

/** Serialise a colour with an alpha channel, for the translucent overlays the canvas draws. */
export function alpha(color: string, a: number): string {
  const hex = color.replace('#', '')
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
  if (full.length !== 6) return color
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}
