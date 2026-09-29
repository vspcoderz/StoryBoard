/**
 * Alignment snapping and grid fallback.
 *
 * The property that matters most: the tolerance is in *screen* pixels, converted through the zoom.
 * A fixed world-space tolerance is the classic bug — 6 world units is a huge snap distance at 10%
 * zoom (everything snaps to everything) and a pixel at 400% (snapping never fires). These tests pin
 * the zoom-invariance explicitly.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ALIGN_TOLERANCE_PX, GRID_SIZE, snapRect } from '../src/board/engine/snap'
import type { Rect } from '../src/board/engine/geometry'

const r = (x: number, y: number, w = 100, h = 100): Rect => ({ x, y, w, h })

describe('alignment snapping', () => {
  it('snaps a left edge to a neighbour left edge', () => {
    const other = r(0, 0, 100, 100)
    // Moving box's left edge is 3 world units from the neighbour's; at scale 1 that is 3px, inside
    // the 6px tolerance.
    const out = snapRect(r(3, 300, 100, 100), [other], { scale: 1, grid: 0 })
    assert.equal(out.rect.x, 0, 'pulled onto the neighbour left edge')
    assert.ok(out.aligned)
  })

  it('leaves a box alone when it is outside the tolerance', () => {
    const other = r(0, 0, 100, 100)
    const out = snapRect(r(40, 300, 100, 100), [other], { scale: 1, grid: 0 })
    assert.equal(out.rect.x, 40, '40px away is well outside 6px')
    assert.ok(!out.aligned)
  })

  it('is zoom-invariant: the same pixel offset snaps at any zoom', () => {
    const other = r(0, 0, 100, 100)
    // 3 screen pixels away, expressed in world units for each zoom level.
    for (const scale of [0.25, 0.5, 1, 2, 4]) {
      const worldOffset = 3 / scale
      const out = snapRect(r(worldOffset, 300, 100, 100), [other], { scale, grid: 0 })
      assert.equal(out.rect.x, 0, `should snap at scale ${scale}`)
      assert.ok(out.aligned, `should report aligned at scale ${scale}`)
    }
  })

  it('does not snap a far world offset when zoomed out, which is what breaks naive implementations', () => {
    const other = r(0, 0, 100, 100)
    // 20 world units away. At scale 1 that is 20px — no snap. At scale 0.1 it is 2px — should snap.
    assert.equal(snapRect(r(20, 300), [other], { scale: 1, grid: 0 }).rect.x, 20)
    assert.equal(snapRect(r(20, 300), [other], { scale: 0.1, grid: 0 }).rect.x, 0)
  })

  it('snaps centres, not just edges', () => {
    // Different widths on purpose: with equal widths the left, centre and right deltas are all
    // identical, so you cannot tell which rule fired. Here only the centres are in range —
    // moving left 98 vs neighbour left 46 (52 away), moving right 198 vs neighbour right 246
    // (48 away), centres 148 vs 146 (2 away).
    const out = snapRect(r(98, 300, 100, 100), [r(46, 0, 200, 100)], { scale: 1, grid: 0 })
    assert.equal(out.rect.x, 96, 'centre-aligned onto the neighbour')
    assert.ok(out.aligned)
  })

  it('never aligns a left edge to a neighbour centre, even when that is closer', () => {
    // Regression. The moving box's left edge (100) is 3px from the neighbour's *centre* (103), which
    // is well inside tolerance. A 3x3 candidate sweep takes that one and drags the box 3px right —
    // a visible lurch toward a relationship the user never asked for. Same-kind candidates here are
    // all 47px or more away, so the correct answer is to not snap at all.
    const out = snapRect(r(100, 300, 100, 100), [r(-47, 0, 300, 100)], { scale: 1, grid: 0 })
    assert.equal(out.rect.x, 100, 'left alone, because no same-kind edge lines up')
    assert.ok(!out.aligned)
  })

  it('picks the closest candidate when several are in range', () => {
    // Neighbours at x=0 (left edge 0) and x=6 (left edge 6). Moving left edge at 4 is 4 from one
    // and 2 from the other, so the closer one must win.
    const out = snapRect(r(4, 500, 50, 50), [r(0, 0), r(6, 200)], { scale: 1, grid: 0 })
    assert.equal(out.rect.x, 6)
  })

  it('emits a guide for the axis it snapped', () => {
    const out = snapRect(r(3, 300, 100, 100), [r(0, 0)], { scale: 1, grid: 0 })
    assert.equal(out.guides.length, 1)
    assert.equal(out.guides[0].axis, 'x')
    assert.equal(out.guides[0].at, 0)
  })

  it('the guide spans both shapes so it visibly connects them', () => {
    const out = snapRect(r(3, 300, 100, 100), [r(0, 0, 100, 100)], { scale: 1, grid: 0 })
    const g = out.guides[0]
    assert.equal(g.from, 0, 'starts at the neighbour top')
    assert.equal(g.to, 400, 'ends at the moving box bottom')
  })

  it('falls back to the grid when nothing is in alignment range', () => {
    const out = snapRect(r(37, 311, 100, 100), [], { scale: 1 })
    assert.equal(out.rect.x, 40, 'snapped to the nearest 20')
    assert.equal(out.rect.y, 320)
    assert.ok(!out.aligned, 'grid snapping is not alignment')
    assert.equal(out.guides.length, 0, 'and draws no guide')
  })

  it('prefers alignment over the grid', () => {
    // 37 would grid-snap to 40, but 38 is within 2px of the neighbour at 40.
    const out = snapRect(r(38, 311, 100, 100), [r(40, 0)], { scale: 1, grid: GRID_SIZE })
    assert.equal(out.rect.x, 40)
    assert.ok(out.aligned, 'alignment won, so it is not grid-snapped to 40 by accident but by guide')
  })

  it('grid: 0 disables grid snapping entirely', () => {
    const out = snapRect(r(37, 311, 100, 100), [], { scale: 1, grid: 0 })
    assert.equal(out.rect.x, 37, 'left exactly where it was')
  })

  it('snaps both axes independently', () => {
    // x: left edge 3 vs 0 -> snaps. y: top edge 107 vs 105 -> 2px, also inside tolerance, so it
    // snaps too. Each axis is decided on its own candidates, not "if x snapped, leave y alone".
    const out = snapRect(r(3, 107, 100, 100), [r(0, 105, 100, 100)], { scale: 1, grid: 0 })
    assert.equal(out.rect.x, 0, 'x aligned')
    assert.equal(out.rect.y, 105, 'y aligned independently')
  })

  it('leaves an axis untouched when it has no candidate in range', () => {
    const out = snapRect(r(3, 400, 100, 100), [r(0, 105, 100, 100)], { scale: 1, grid: 0 })
    assert.equal(out.rect.x, 0, 'x aligned')
    assert.equal(out.rect.y, 400, 'y is 295px from anything, so it stays put')
    assert.equal(out.guides.filter((g) => g.axis === 'y').length, 0, 'and draws no y guide')
  })

  it('handles an empty candidate list without producing NaN', () => {
    const out = snapRect(r(10, 10, 100, 100), [], { scale: 1, grid: 0 })
    assert.ok(Number.isFinite(out.rect.x))
    assert.ok(Number.isFinite(out.rect.y))
  })

  it('does not mutate the rect it was given', () => {
    const moving = r(3, 300, 100, 100)
    snapRect(moving, [r(0, 0)], { scale: 1, grid: 0 })
    assert.equal(moving.x, 3, 'input untouched')
  })

  it('tolerance is exposed so the renderer can match its line weight to it', () => {
    assert.ok(ALIGN_TOLERANCE_PX > 0)
  })
})
