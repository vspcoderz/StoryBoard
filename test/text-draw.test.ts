import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chaikinStroke, distToStroke, strokeOutline } from '../src/board/engine/render/draw'
import { wrapText, layoutText, lineHeightFor } from '../src/board/engine/text'
import { DEFAULT_STYLE } from '../src/board/engine/types'
import type { Ctx2D } from '../src/board/engine/text'

/** Minimal stand-in for a 2D context. Text wrapping is pure measurement, so a fixed-width
 *  stub tests the wrapping logic without dragging a canvas implementation into the test run. */
const fakeCtx = (charWidth = 10): Ctx2D =>
  ({
    font: '',
    measureText: (t: string) => ({ width: t.length * charWidth }),
  }) as unknown as Ctx2D

describe('wrapText', () => {
  it('keeps short text on one line', () => {
    assert.deepEqual(wrapText(fakeCtx(), 'hello', DEFAULT_STYLE, 1000), ['hello'])
  })

  it('honours explicit newlines', () => {
    assert.deepEqual(wrapText(fakeCtx(), 'a\nb', DEFAULT_STYLE, 1000), ['a', 'b'])
  })

  it('wraps on whitespace', () => {
    // 10px per char, 100px budget => 10 chars per line.
    assert.deepEqual(wrapText(fakeCtx(), 'aaaa bbbb cccc', DEFAULT_STYLE, 100), ['aaaa bbbb', 'cccc'])
  })

  it('force-breaks a token too long for the line', () => {
    // A pasted URL must wrap rather than overflow or vanish.
    const lines = wrapText(fakeCtx(), 'aaaaaaaaaaaaaaa', DEFAULT_STYLE, 50)
    assert.ok(lines.length > 1)
    for (const l of lines) assert.ok(l.length <= 5, `line too wide: ${l}`)
  })

  it('preserves blank lines', () => {
    assert.deepEqual(wrapText(fakeCtx(), 'a\n\nb', DEFAULT_STYLE, 1000), ['a', '', 'b'])
  })
})

describe('layoutText', () => {
  it('sizes the box to content when autoHeight', () => {
    const l = layoutText(fakeCtx(), 'ab', DEFAULT_STYLE, 500, 500, true)
    assert.equal(l.lines.length, 1)
    assert.equal(l.width, 20)
    assert.equal(l.height, lineHeightFor(DEFAULT_STYLE))
  })

  it('reports wrapped width in a fixed box', () => {
    const l = layoutText(fakeCtx(), 'aaaa bbbb', DEFAULT_STYLE, 50, 500, false)
    assert.ok(l.lines.length > 1)
  })
})

describe('chaikinStroke', () => {
  it('interpolates pressure alongside position', () => {
    const pts = [
      { x: 0, y: 0, p: 0 },
      { x: 10, y: 0, p: 1 },
      { x: 20, y: 0, p: 0 },
    ]
    const out = chaikinStroke(pts, 1)
    // Interior points must gain interpolated pressure. The old nearest-neighbour pressure lookup
    // was quadratic; carrying pressure through the interpolation is O(n) and gives this instead.
    assert.ok(out.length > pts.length)
    const mid = out[2]
    assert.ok(mid.p > 0 && mid.p < 1, `expected interpolated pressure, got ${mid.p}`)
  })

  it('leaves short strokes alone', () => {
    const pts = [{ x: 0, y: 0, p: 0.5 }, { x: 1, y: 1, p: 0.5 }]
    assert.equal(chaikinStroke(pts, 2).length, 2)
  })
})

describe('strokeOutline', () => {
  it('builds a closed ring around a straight stroke', () => {
    const pts = [
      { x: 0, y: 0, p: 1 },
      { x: 50, y: 0, p: 1 },
      { x: 100, y: 0, p: 1 },
    ]
    const out = strokeOutline(pts, 10)
    assert.ok(out.length > 6, 'caps and both sides should be present')
    // The ring should straddle the line, so it must reach above and below y=0.
    assert.ok(out.some((p) => p.y < 0))
    assert.ok(out.some((p) => p.y > 0))
  })

  it('handles a single point as a dot', () => {
    assert.ok(strokeOutline([{ x: 0, y: 0, p: 1 }], 8).length >= 8)
  })

  it('varies width with pressure', () => {
    const thin = strokeOutline(
      [
        { x: 0, y: 0, p: 0.1 },
        { x: 50, y: 0, p: 0.1 },
      ],
      10,
    )
    const thick = strokeOutline(
      [
        { x: 0, y: 0, p: 1 },
        { x: 50, y: 0, p: 1 },
      ],
      10,
    )
    const spread = (pts: { x: number; y: number }[]) =>
      Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y))
    assert.ok(spread(thick) > spread(thin), 'high pressure must produce a wider stroke')
  })
})

describe('distToStroke', () => {
  it('measures distance to the path', () => {
    const d = distToStroke(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      { x: 50, y: 12 },
    )
    assert.ok(Math.abs(d - 12) < 1e-9)
  })
})
