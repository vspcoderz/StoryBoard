/**
 * Palette contrast verification.
 *
 * A palette that passes on a designer's monitor and fails for someone with low vision is not a
 * finished palette. These assertions exist so the colours cannot be quietly "adjusted" into
 * illegibility later: if someone changes `--color-graphite` to look nicer, this fails and the
 * regression is caught at commit time rather than by a user.
 *
 * The thresholds come from the accessibility guidance: 4.5:1 for body text, 3:1 for large text,
 * bold text, and non-text indicators like focus rings and selection outlines.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '../src/app/globals.css'), 'utf8')

// --- WCAG relative luminance and contrast -----------------------------------

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const channel = (c: number): number => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(channel)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export function contrast(a: string, b: string): number {
  const l1 = luminance(a)
  const l2 = luminance(b)
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

// --- read the tokens straight out of the stylesheet ------------------------

function token(name: string): string {
  const re = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{3,8})`)
  const m = css.match(re)
  assert.ok(m, `token --color-${name} not found in globals.css`)
  return m[1]
}

/** Tokens declared in the dark block, which appear after the media query. */
function darkToken(name: string): string {
  const dark = css.slice(css.indexOf('prefers-color-scheme: dark'))
  const m = dark.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{3,8})`))
  assert.ok(m, `dark token --color-${name} not found`)
  return m[1]
}

const LIGHT_TEXT_PAIRS: [string, string, number][] = [
  // [foreground, background, minimum ratio]
  ['ink', 'sheet', 4.5],
  ['ink', 'surface', 4.5],
  ['graphite', 'sheet', 4.5],
  ['graphite', 'desk', 4.5],
  ['brass-ink', 'sheet', 4.5],
  ['brass-ink', 'brass-wash', 4.5],
  ['vermilion', 'vermilion-wash', 4.5],
  ['beat', 'sheet', 4.5],
  ['turning', 'sheet', 4.5],
  ['character', 'sheet', 4.5],
  ['location', 'sheet', 4.5],
  ['thread', 'sheet', 4.5],
  // Non-text indicators need 3:1, not 4.5:1.
  ['brass', 'sheet', 3],
  ['brass', 'desk', 3],
  ['line', 'sheet', 1.2],
]

const DARK_TEXT_PAIRS: [string, string, number][] = [
  ['ink', 'sheet', 4.5],
  ['ink', 'surface', 4.5],
  ['graphite', 'sheet', 4.5],
  ['graphite', 'desk', 4.5],
  ['brass-ink', 'sheet', 4.5],
  ['brass-ink', 'brass-wash', 4.5],
  ['vermilion', 'vermilion-wash', 4.5],
  ['beat', 'sheet', 4.5],
  ['turning', 'sheet', 4.5],
  ['character', 'sheet', 4.5],
  ['location', 'sheet', 4.5],
  ['thread', 'sheet', 4.5],
  ['brass', 'sheet', 3],
  ['brass', 'desk', 3],
  ['line', 'sheet', 1.2],
]

describe('palette — light appearance', () => {
  for (const [fg, bg, need] of LIGHT_TEXT_PAIRS) {
    it(`${fg} on ${bg} meets ${need}:1`, () => {
      const r = contrast(token(fg), token(bg))
      assert.ok(
        r >= need,
        `${fg} (#${token(fg)}) on ${bg} (#${token(bg)}) is ${r.toFixed(2)}:1, needs ${need}:1`,
      )
    })
  }
})

describe('palette — dark appearance', () => {
  for (const [fg, bg, need] of DARK_TEXT_PAIRS) {
    it(`${fg} on ${bg} meets ${need}:1`, () => {
      const r = contrast(darkToken(fg), darkToken(bg))
      assert.ok(
        r >= need,
        `dark: ${fg} (#${darkToken(fg)}) on ${bg} (#${darkToken(bg)}) is ${r.toFixed(2)}:1, needs ${need}:1`,
      )
    })
  }
})

describe('palette — semantics', () => {
  it('does not reuse one colour for two meanings', () => {
    // The reserved accent means "active / selected / focused" and nothing else. If a story semantic
    // shares it, selection state and story state stop being distinguishable — which is precisely
    // the ambiguity the guidance warns about.
    const accent = token('brass').toLowerCase()
    for (const semantic of ['beat', 'turning', 'character', 'location', 'thread']) {
      assert.notEqual(
        token(semantic).toLowerCase(),
        accent,
        `--color-${semantic} collides with the reserved accent`,
      )
    }
  })

  it('keeps story semantics distinct from each other in luminance', () => {
    // Under deuteranopia the red/green axis collapses, so two semantics are only reliably told
    // apart if their luminance differs. Equal-luminance pairs are the classic colour-blind failure.
    const semantics = ['beat', 'turning', 'character', 'location', 'thread']
    for (const mode of ['light', 'dark'] as const) {
      const lum = semantics.map((s) => luminance(mode === 'light' ? token(s) : darkToken(s)))
      for (let i = 0; i < lum.length; i++) {
        for (let j = i + 1; j < lum.length; j++) {
          const delta = Math.abs(lum[i] - lum[j])
          assert.ok(
            delta > 0.03,
            `${mode}: ${semantics[i]} and ${semantics[j]} are too close in luminance (Δ${delta.toFixed(3)})`,
          )
        }
      }
    }
  })

  it('gives light and dark genuinely different surfaces, not an inversion', () => {
    // Three distinguishable depth planes: desk (behind), sheet (canvas), surface (panels).
    assert.ok(luminance(token('desk')) < luminance(token('sheet')))
    assert.ok(luminance(token('surface')) >= luminance(token('sheet')))
    assert.ok(luminance(darkToken('desk')) < luminance(darkToken('sheet')))
    assert.ok(luminance(darkToken('surface')) >= luminance(darkToken('sheet')))
  })
})

describe('stylesheet', () => {
  it('never removes focus indication', () => {
    // A `outline: none` without a replacement is the single most common accessibility regression.
    assert.ok(css.includes(':focus-visible'))
    assert.equal(
      /:focus\s*\{[^}]*outline:\s*none/.test(css),
      false,
      'a bare :focus rule must not strip the focus ring',
    )
  })

  it('respects reduced motion and reduced transparency', () => {
    assert.ok(css.includes('prefers-reduced-motion'))
    assert.ok(css.includes('prefers-reduced-transparency'))
  })

  it('follows the system appearance rather than offering its own setting', () => {
    assert.ok(css.includes('prefers-color-scheme'))
  })
})
