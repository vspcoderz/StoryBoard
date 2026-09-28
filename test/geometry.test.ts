import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  distToSegment,
  localToWorld,
  normAngle,
  rectFromDrag,
  rectFromPoints,
  rectsIntersect,
  segmentsIntersect,
  worldToLocal,
} from '../src/board/engine/geometry'

describe('rect helpers', () => {
  it('normalises a backwards drag', () => {
    const r = rectFromDrag({ x: 100, y: 80 }, { x: 20, y: 10 })
    assert.deepEqual(r, { x: 20, y: 10, w: 80, h: 70 })
  })

  it('treats a zero-size drag as a point', () => {
    const r = rectFromDrag({ x: 5, y: 5 }, { x: 5, y: 5 })
    assert.deepEqual(r, { x: 5, y: 5, w: 0, h: 0 })
  })

  it('computes bounds from a point cloud', () => {
    const r = rectFromPoints([
      { x: 3, y: -2 },
      { x: -1, y: 7 },
      { x: 5, y: 1 },
    ])
    assert.deepEqual(r, { x: -1, y: -2, w: 6, h: 9 })
  })

  it('counts an edge touch as an intersection', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 }
    assert.equal(rectsIntersect(a, { x: 5, y: 5, w: 10, h: 10 }), true)
    // Marquee selection follows the Figma/Excalidraw convention: a box that merely touches a node
    // selects it. Being strict here would mean dragging a selection that visibly encloses something
    // and silently leaving it out, which is far more confusing than being slightly generous.
    assert.equal(rectsIntersect(a, { x: 10, y: 0, w: 10, h: 10 }), true)
    assert.equal(rectsIntersect(a, { x: 10.5, y: 0, w: 10, h: 10 }), false)
  })
})

describe('rotated frames', () => {
  const box = { x: 100, y: 100, w: 200, h: 100 }
  const angle = Math.PI / 4

  it('round-trips a point through world and local space', () => {
    const p = { x: 137, y: 211 }
    const back = localToWorld(worldToLocal(p, box, angle), box, angle)
    assert.ok(Math.abs(back.x - p.x) < 1e-9)
    assert.ok(Math.abs(back.y - p.y) < 1e-9)
  })

  it('maps the box centre to the local origin', () => {
    const c = worldToLocal({ x: 200, y: 150 }, box, angle)
    assert.ok(Math.abs(c.x) < 1e-9)
    assert.ok(Math.abs(c.y) < 1e-9)
  })

  it('is a no-op at zero rotation', () => {
    const p = { x: 120, y: 130 }
    assert.deepEqual(worldToLocal(p, box, 0), { x: -80, y: -20 })
  })
})

describe('normAngle', () => {
  it('wraps into [0, 2pi)', () => {
    assert.ok(Math.abs(normAngle(-Math.PI / 2) - (3 * Math.PI) / 2) < 1e-9)
    assert.ok(Math.abs(normAngle(Math.PI * 3) - Math.PI) < 1e-9)
    assert.equal(normAngle(0), 0)
  })
})

describe('segment maths', () => {
  it('detects a crossing', () => {
    assert.equal(
      segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }),
      true,
    )
    assert.equal(
      segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 5, y: 5 }, { x: 6, y: 6 }),
      false,
    )
  })

  it('measures distance to the nearest point on a segment', () => {
    assert.equal(distToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5)
    // Beyond the end, the distance is to the endpoint, not the infinite line.
    assert.equal(distToSegment({ x: 20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 10)
  })
})
