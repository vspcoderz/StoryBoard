/**
 * Connector routing.
 *
 * Routing is the kind of code that looks correct and is subtly wrong, and it is pure — so it is
 * tested hard. The properties that matter:
 *
 * - a route starts at the source node's outline and ends at the target's, not at their centres
 * - it never contains zero-length segments (those render as visible kinks or stray dots)
 * - a straight route is exactly two points
 * - routing is deterministic: same inputs, same path, on every client
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  anchorPoint,
  bestSide,
  cleanPath,
  elbowPath,
  anchorFor,
  hitPath,
  nearestSide,
  routeConnector,
  type AnchorSide,
} from '../src/board/engine/connector'
import type { Rect, Vec } from '../src/board/engine/geometry'
import { dist } from '../src/board/engine/geometry'

const box = (x: number, y: number, w = 100, h = 100): Rect => ({ x, y, w, h })

/** Total path length, used to assert we are not taking absurd detours. */
const pathLength = (pts: Vec[]): number =>
  pts.reduce((n, p, i) => (i === 0 ? 0 : n + dist(pts[i - 1], p)), 0)

describe('anchors', () => {
  it('places each side at the midpoint of that edge', () => {
    const b = box(0, 0, 200, 100)
    assert.deepEqual(anchorPoint(b, 'top'), { x: 100, y: 0 })
    assert.deepEqual(anchorPoint(b, 'bottom'), { x: 100, y: 100 })
    assert.deepEqual(anchorPoint(b, 'left'), { x: 0, y: 50 })
    assert.deepEqual(anchorPoint(b, 'right'), { x: 200, y: 50 })
  })

  it('picks the side facing the target, by dominant axis', () => {
    const b = box(0, 0, 100, 100)
    assert.equal(bestSide(b, { x: 500, y: 50 }), 'right')
    assert.equal(bestSide(b, { x: -500, y: 50 }), 'left')
    assert.equal(bestSide(b, { x: 50, y: 500 }), 'bottom')
    assert.equal(bestSide(b, { x: 50, y: -500 }), 'top')
  })

  it('is stable for near-diagonal targets, so a drag does not flip sides', () => {
    // Two targets that are very close together but on genuinely different sides. If this were
    // computed with a tolerance band, dragging a node across the diagonal would make its arrow
    // flicker between sides.
    const b = box(0, 0, 100, 100)
    assert.equal(bestSide(b, { x: 101, y: 100 }), 'right')
    assert.equal(bestSide(b, { x: 100, y: 101 }), 'bottom')
  })

  it('points outward from the node', () => {
    const b = box(0, 0)
    assert.deepEqual(anchorFor(b, 'right').out, { x: 1, y: 0 })
    assert.deepEqual(anchorFor(b, 'top').out, { x: 0, y: -1 })
  })
})

describe('elbowPath', () => {
  it('starts and ends on the node outlines', () => {
    const a = anchorFor(box(0, 0, 100, 100), 'right')
    const b = anchorFor(box(300, 0, 100, 100), 'left')
    const path = elbowPath(a, b)
    assert.deepEqual(path[0], { x: 100, y: 50 }, 'starts on the source right edge')
    assert.deepEqual(path[path.length - 1], { x: 300, y: 50 }, 'ends on the target left edge')
  })

  it('has no zero-length segments', () => {
    const a = anchorFor(box(0, 0), 'right')
    const b = anchorFor(box(200, 0), 'left')
    for (let i = 1; i < elbowPath(a, b).length; i++) {
      assert.ok(dist(elbowPath(a, b)[i - 1], elbowPath(a, b)[i]) > 0.5)
    }
  })

  it('bows out when both ends leave the same side, instead of cutting a corner', () => {
    // Two boxes stacked; both arrows point right. A straight line would clip the source's corner.
    const a = anchorFor(box(0, 0), 'right')
    const b = anchorFor(box(0, 300), 'right')
    const path = elbowPath(a, b)
    assert.ok(path.length >= 3, 'needs a bow to clear the boxes')
    assert.ok(path.some((p) => p.x > 100), 'the bow must travel right of the source outline')
  })

  it('uses a single bend for opposing sides', () => {
    const a = anchorFor(box(0, 0, 100, 100), 'right')
    const b = anchorFor(box(300, 200, 100, 100), 'left')
    const path = elbowPath(a, b)
    assert.equal(path.length, 3, 'p0, one midpoint, p1')
    assert.equal(path[1].x, 200, 'the bend sits midway along the travel axis')
  })

  it('never produces a longer path than the straight line by a large factor', () => {
    // Guards against a router that wanders. 2x is generous but still catches runaway detours.
    const a = anchorFor(box(0, 0, 100, 100), 'right')
    const b = anchorFor(box(400, 20, 100, 100), 'left')
    const straight = dist(a.point, b.point)
    assert.ok(pathLength(elbowPath(a, b)) < straight * 2 + 1)
  })
})

describe('cleanPath', () => {
  it('drops duplicate points', () => {
    const out = cleanPath([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ])
    assert.equal(out.length, 2)
  })

  it('drops collinear midpoints', () => {
    const out = cleanPath([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ])
    assert.deepEqual(out, [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ])
  })

  it('keeps real corners', () => {
    const out = cleanPath([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ])
    assert.equal(out.length, 3, 'an L is a real corner and must survive')
  })

  it('never returns fewer than one point for a non-empty path', () => {
    assert.equal(cleanPath([{ x: 1, y: 1 }]).length, 1)
  })
})

describe('routeConnector', () => {
  it('derives unpinned sides from live geometry', () => {
    const from = { bounds: box(0, 0, 100, 100), side: null, toward: { x: 400, y: 50 } }
    const to = { bounds: box(300, 0, 100, 100), side: null, toward: { x: 50, y: 50 } }
    const path = routeConnector(from, to)
    assert.deepEqual(path[0], { x: 100, y: 50 })
    assert.deepEqual(path[path.length - 1], { x: 300, y: 50 })
  })

  it('re-aims when the node moves, because sides are recomputed not stored', () => {
    // This is the whole reason connectors store a node reference instead of a point.
    const moved = { bounds: box(0, 0, 100, 100), side: null, toward: { x: 50, y: -400 } }
    const to = { bounds: box(0, 300, 100, 100), side: null, toward: { x: 50, y: 0 } }
    const path = routeConnector(moved, to)
    assert.equal(path[0].y, 0, 'now leaves from the top edge, not the right')
  })

  it('honours a pinned side', () => {
    const from = { bounds: box(0, 0, 100, 100), side: 'bottom' as AnchorSide, toward: { x: 400, y: 50 } }
    const to = { bounds: box(300, 0, 100, 100), side: null, toward: { x: 50, y: 50 } }
    const path = routeConnector(from, to)
    assert.deepEqual(path[0], { x: 50, y: 100 }, 'pinned to the bottom edge midpoint')
  })

  it('straight style is exactly two endpoints', () => {
    const from = { bounds: box(0, 0, 100, 100), side: null, toward: { x: 400, y: 50 } }
    const to = { bounds: box(300, 0, 100, 100), side: null, toward: { x: 50, y: 50 } }
    assert.equal(routeConnector(from, to, 'straight').length, 2)
  })

  it('is deterministic, so two clients draw the identical line', () => {
    const from = { bounds: box(10, 20, 100, 100), side: null, toward: { x: 400, y: 333 } }
    const to = { bounds: box(300, 90, 100, 100), side: null, toward: { x: 60, y: 140 } }
    assert.deepEqual(routeConnector(from, to), routeConnector(from, to))
  })

  it('handles a connector to itself without dividing by zero', () => {
    const n = { bounds: box(0, 0, 100, 100), side: null, toward: { x: 400, y: 50 } }
    const path = routeConnector(n, n)
    assert.ok(path.length >= 1)
    for (const p of path) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))
  })
})

describe('hitPath', () => {
  const path: Vec[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ]

  it('hits near the line', () => {
    assert.ok(hitPath(path, { x: 50, y: 3 }, 5))
  })

  it('misses far from the line', () => {
    assert.ok(!hitPath(path, { x: 50, y: 50 }, 5))
  })

  it('treats a single point as a dot', () => {
    assert.ok(hitPath([{ x: 10, y: 10 }], { x: 12, y: 10 }, 5))
  })

  it('never hits an empty path', () => {
    assert.ok(!hitPath([], { x: 0, y: 0 }, 100))
  })
})

describe('nearestSide', () => {
  it('reports the side facing a point and how far away it is', () => {
    const r = nearestSide(box(0, 0, 100, 100), { x: 400, y: 50 })
    assert.equal(r.side, 'right')
    assert.ok(Math.abs(r.distance - 300) < 1e-6)
  })

  it('reports zero distance for a point already on the anchor', () => {
    const r = nearestSide(box(0, 0, 100, 100), { x: 100, y: 50 })
    assert.equal(r.side, 'right')
    assert.equal(r.distance, 0)
  })
})
