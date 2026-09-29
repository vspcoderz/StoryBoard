/**
 * Sticky note text wrapping.
 *
 * Regression test: `drawSticky` passed `autoHeight: true` to `paintText`, which made `layoutText`
 * skip wrapping and return the raw text as one line. A sticky is a fixed box the user sized by
 * dragging, so its text must wrap to that width — instead it overflowed and painted outside the note.
 *
 * The renderer needs a real canvas to draw, so this tests the layout decision it depends on rather
 * than the pixels: for a fixed box, `autoHeight` must be false.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutText } from '../src/board/engine/text'
import { DEFAULT_STYLE, type Style } from '../src/board/engine/types'
import type { Ctx2D } from '../src/board/engine/text'

/** Fixed-width stub: every glyph is 10px, so wrapping is arithmetic and not font-dependent. */
const fakeCtx = {
  font: '',
  measureText: (s: string) => ({ width: s.length * 10 }),
} as unknown as Ctx2D

const style: Style = { ...DEFAULT_STYLE, fontSize: 16 }

test('a fixed box wraps text to its width', () => {
  const layout = layoutText(fakeCtx, 'Midpoint reversal — she finds the letter', style, 180, 160, false)
  assert.ok(layout.lines.length > 1, 'long text must wrap inside a fixed box')
  for (const line of layout.lines) {
    assert.ok(line.length * 10 <= 180 + 10, `line overflows the box: ${JSON.stringify(line)}`)
  }
})

test('autoHeight skips wrapping, which is why a sticky must not use it', () => {
  // This is the exact defect: one long line, no wrap.
  const layout = layoutText(fakeCtx, 'Midpoint reversal — she finds the letter', style, 180, 160, true)
  assert.equal(layout.lines.length, 1, 'autoHeight deliberately does not wrap')
  assert.ok(
    layout.lines[0].length * 10 > 180,
    'and that line is wider than the sticky, so it would paint outside the note',
  )
})

test('a wrapped sticky still fits its height, or the overflow is clipped not spilled', () => {
  const text = 'Midpoint reversal — she finds the letter'
  const boxW = 180
  const boxH = 160
  const layout = layoutText(fakeCtx, text, style, boxW, boxH, false)
  const baseline = (layout.lineHeight + style.fontSize * 0.7) / 2
  // Mirrors the renderer's line budget for block text.
  const maxLines = Math.max(1, Math.floor((boxH + baseline) / layout.lineHeight))
  assert.ok(layout.lines.length <= maxLines, 'text must fit the note vertically')
})
