import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { handleAt, remapRect, resizeRect, resizeRotated, HANDLES } from '../src/board/engine/transform'
import { nodeBounds, makeNode } from '../src/board/engine/types'

describe('resizeRect', () => {
  const start = { x: 0, y: 0, w: 100, h: 100 }

  it('drags the east edge only', () => {
    assert.deepEqual(resizeRect(start, 'e', { x: 150, y: 999 }), { x: 0, y: 0, w: 150, h: 100 })
  })

  it('moves the origin when dragging the west edge', () => {
    assert.deepEqual(resizeRect(start, 'w', { x: -20, y: 0 }), { x: -20, y: 0, w: 120, h: 100 })
  })

  it('ignores the axis the handle does not own', () => {
    // A north handle must not care where the pointer is horizontally.
    const r = resizeRect(start, 'n', { x: 999, y: 40 })
    assert.equal(r.x, 0)
    assert.equal(r.w, 100)
    assert.equal(r.h, 60)
  })

  it('refuses to collapse past the minimum size', () => {
    const r = resizeRect(start, 'e', { x: -9999, y: 0 })
    assert.ok(r.w >= 8, `expected at least the minimum width, got ${r.w}`)
  })

  it('grows symmetrically with alt', () => {
    const r = resizeRect(start, 'e', { x: 150, y: 50 }, { fromCenter: true })
    assert.equal(r.w, 200)
    assert.equal(r.x, -50, 'centre must stay put')
  })
})

describe('resizeRotated', () => {
  it('preserves the rotation axis instead of squashing along the wrong one', () => {
    const box = { x: 100, y: 100, w: 200, h: 100 }
    const angle = Math.PI / 4
    const c = { x: 200, y: 150 }
    // Drag the east handle out along the node's own local +x, which is diagonal in world space.
    const dir = { x: Math.cos(angle), y: Math.sin(angle) }
    const pointer = { x: c.x + dir.x * 150, y: c.y + dir.y * 150 }

    const rotated = resizeRotated(box, angle, 'e', pointer)
    const naive = resizeRect(box, 'e', pointer)

    // The local box spans -100..100, so an edge at local 150 means width 250.
    assert.ok(Math.abs(rotated.w - 250) < 1e-6, `width should follow the local axis, got ${rotated.w}`)
    assert.ok(
      Math.abs(rotated.h - 100) < 1e-6,
      `height must be untouched by a horizontal handle, got ${rotated.h}`,
    )
    // A world-space resize measures the pointer's world-x extent instead of its local-x, so a
    // diagonal drag yields a different width. That divergence is the bug this frame prevents.
    assert.ok(
      Math.abs(naive.w - rotated.w) > 1,
      `sanity: naive world-space path should disagree, naive=${naive.w} rotated=${rotated.w}`,
    )
  })

  it('reduces to the axis-aligned path at zero rotation', () => {
    const box = { x: 0, y: 0, w: 100, h: 100 }
    assert.deepEqual(resizeRotated(box, 0, 'e', { x: 130, y: 0 }), resizeRect(box, 'e', { x: 130, y: 0 }))
  })
})

describe('remapRect', () => {
  it('maps a box proportionally into a new frame', () => {
    const from = { x: 0, y: 0, w: 100, h: 100 }
    const to = { x: 0, y: 0, w: 200, h: 50 }
    const r = remapRect({ x: 25, y: 50, w: 50, h: 25 }, from, to)
    assert.deepEqual(r, { x: 50, y: 25, w: 100, h: 12.5 })
  })
})

describe('handleAt', () => {
  const box = { x: 0, y: 0, w: 100, h: 100 }

  it('finds a corner within tolerance', () => {
    assert.equal(handleAt(box, { x: 2, y: 1 }, 7)?.id, 'nw')
  })

  it('returns null away from every handle', () => {
    assert.equal(handleAt(box, { x: 50, y: 50 }, 7), null)
  })

  it('covers eight handles', () => {
    assert.equal(HANDLES.length, 8)
    const ids = new Set(HANDLES.map((h) => h.id))
    assert.equal(ids.size, 8)
  })
})

describe('nodeBounds', () => {
  it('is the raw box when unrotated', () => {
    const n = makeNode({ type: 'shape', shape: 'rect', text: '', x: 5, y: 7, w: 20, h: 30 })
    assert.deepEqual(nodeBounds(n), { x: 5, y: 7, w: 20, h: 30 })
  })

  it('swells to a conservative superset when rotated', () => {
    const n = makeNode({
      type: 'shape',
      shape: 'rect',
      text: '',
      x: 0,
      y: 0,
      w: 100,
      h: 20,
      rotation: Math.PI / 4,
    })
    const b = nodeBounds(n)
    // A 45°-rotated 100×20 box projects to roughly 84.9 on each axis. The culling rect must never be
    // smaller than the drawn shape or nodes vanish at the viewport edge.
    assert.ok(b.w > 80 && b.w < 90, `got width ${b.w}`)
    assert.ok(b.h > 80 && b.h < 90, `got height ${b.h}`)
  })
})
