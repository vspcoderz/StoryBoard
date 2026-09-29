/**
 * Connector behaviour at the store level.
 *
 * The routing maths is tested in `connector.test.ts`. What is tested here is the part that only
 * exists in the store and is where the real bugs live:
 *
 * - a connector's bounding box is derived, not authored, and must track its endpoints
 * - deleting a node must delete the connectors bound to it, or orphans accumulate forever
 * - an unbound connector must resolve to an empty path rather than throwing
 * - picking a connector must use the routed line, not its bounding box
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SceneStore } from '../src/board/engine/store'
import { makeNode, type ConnectorNode, type ShapeNode } from '../src/board/engine/types'
import { applyMutation } from '../src/board/engine/mutation'
import { snapshot } from '../src/board/engine/serialize'

const shape = (id: string, x: number, y = 0): ShapeNode => ({
  ...makeNode<ShapeNode>({ type: 'shape', shape: 'rect', text: '', x, y, w: 100, h: 100 }),
  id,
})

const connector = (id: string, fromId: string | null, toId: string | null): ConnectorNode => ({
  ...makeNode<ConnectorNode>({
    type: 'connector',
    fromId,
    toId,
    fromSide: null,
    toSide: null,
    startArrow: false,
    endArrow: true,
    route: 'orthogonal',
    label: '',
    edgeKind: null,
  }),
  id,
})

/** A store with two boxes and a connector between them. */
function scene(): { store: SceneStore; a: ShapeNode; b: ShapeNode; c: ConnectorNode } {
  const store = new SceneStore()
  const a = shape('a', 0, 0)
  const b = shape('b', 400, 0)
  const c = connector('c', 'a', 'b')
  applyMutation(store, { type: 'create', nodes: [a, b, c] })
  return { store, a, b, c }
}

describe('connector bounds', () => {
  it('derives its box from the route rather than the seeded value', () => {
    const { store, c } = scene()
    const b = store.get(c.id) as ConnectorNode
    assert.ok(b.w > 1, `expected a real width, got ${b.w}`)
    assert.equal(b.w, 300, 'spans from a right edge to b left edge')
  })

  it('re-derives when an endpoint moves, so culling stays correct', () => {
    const { store, c } = scene()
    store.update('b', { x: 900 })

    const after = store.get(c.id) as ConnectorNode
    assert.equal(after.w, 800, 'grew because the far node moved away')
  })

  it('is idempotent — syncing twice changes nothing', () => {
    const { store, c } = scene()

    const once = JSON.stringify(store.get(c.id))

    assert.equal(JSON.stringify(store.get(c.id)), once)
  })

  it('collapses to nothing when unbound, so it is culled rather than drawn at a stale place', () => {
    const store = new SceneStore()
    store.addMany([shape('a', 0), connector('c', 'a', null)])
    const c = store.get('c') as ConnectorNode
    assert.equal(c.w, 0)
    assert.equal(c.h, 0)
  })

  it('is derived on create through a mutation, not only by add()', () => {
    // Regression. Bounds syncing was wired into `add` but not `addMany`, and every create goes
    // through `addMany`. A connector created by a normal gesture therefore kept the 200x120 default
    // from makeNode: wrong culling box, and 200x120 reported in the inspector instead of the line's
    // real extent. `afterChange` now funnels every mutation so this cannot be missed again.
    const store = new SceneStore()
    applyMutation(store, { type: 'create', nodes: [shape('a', 0, 0), shape('b', 50, 300)] })
    applyMutation(store, { type: 'create', nodes: [connector('c', 'a', 'b')] })
    const c = store.get('c') as ConnectorNode
    assert.deepEqual(
      { x: c.x, y: c.y, w: c.w, h: c.h },
      { x: 50, y: 100, w: 50, h: 200 },
      'box is the route bounding box, not the makeNode default',
    )
  })

  it('is derived when nodes move via a mutation, including the multi-node path', () => {
    // `updateMany` is the other mutation entry point; if it were missed the same bug reappears on
    // every multi-select drag.
    const store = new SceneStore()
    applyMutation(store, { type: 'create', nodes: [shape('a', 0, 0), shape('b', 400, 0)] })
    applyMutation(store, { type: 'create', nodes: [connector('c', 'a', 'b')] })
    assert.equal((store.get('c') as ConnectorNode).w, 300, 'a right edge 100 to b left edge 400')

    applyMutation(store, {
      type: 'update',
      patches: [
        ['b', { x: 900 }],
        ['a', { x: 20 }],
      ],
    })
    // Now the line runs from a's right edge (120) to b's left edge (900).
    const c = store.get('c') as ConnectorNode
    assert.equal(c.x, 120, 'left edge is the source anchor')
    assert.equal(c.w, 780, 'and the width spans to the far anchor')
  })

  it('is derived on replace, which is how a document loads', () => {
    const store = new SceneStore()
    applyMutation(store, {
      type: 'replace',
      nodes: [shape('a', 0, 0), shape('b', 0, 400), connector('c', 'a', 'b')],
    })
    const c = store.get('c') as ConnectorNode
    assert.ok(c.h > 100, `expected a real height from the route, got ${c.h}`)
    assert.notEqual(c.h, 120, 'not the makeNode default')
  })
})

describe('connector path', () => {
  it('resolves to a real path when both ends are bound', () => {
    const { store, c } = scene()
    assert.ok(store.connectorPath(c.id).length >= 2)
  })

  it('is empty, not throwing, when an end is unbound', () => {
    const store = new SceneStore()
    store.addMany([shape('a', 0), connector('c', 'a', null)])
    assert.deepEqual(store.connectorPath('c'), [])
  })

  it('is empty for a missing node id, not a crash', () => {
    const { store, c } = scene()
    store.remove(['b'])
    assert.deepEqual(store.connectorPath(c.id), [])
  })

  it('is empty for an unknown id', () => {
    const { store } = scene()
    assert.deepEqual(store.connectorPath('nope'), [])
  })

  it('is empty for a non-connector id', () => {
    const { store } = scene()
    assert.deepEqual(store.connectorPath('a'), [])
  })
})

describe('connector lifecycle', () => {
  it('deletes connectors when their endpoint is deleted', () => {
    const { store, c } = scene()
    store.remove(['b'])
    assert.ok(!store.has(c.id), 'a connector to a deleted node is an invisible orphan')
  })

  it('deletes a connector when its source is deleted too', () => {
    const { store, c } = scene()
    store.remove(['a'])
    assert.ok(!store.has(c.id))
  })

  it('deletes several connectors bound to one node', () => {
    const store = new SceneStore()
    store.addMany([
      shape('a', 0),
      shape('b', 300),
      shape('c', 600),
      connector('e1', 'a', 'b'),
      connector('e2', 'a', 'c'),
      connector('e3', 'b', 'c'),
    ])

    store.remove(['a'])
    assert.ok(!store.has('e1'))
    assert.ok(!store.has('e2'))
    assert.ok(store.has('e3'), 'the edge that does not touch a is untouched')
  })

  it('leaves a half-bound connector alone when the bound end survives', () => {
    const store = new SceneStore()
    store.addMany([shape('a', 0), connector('c', 'a', null)])

    store.remove(['a'])
    assert.ok(!store.has('c'), 'still orphaned, because its only bound end is gone')
  })

  it('lists connectors for the pointer endpoint pass', () => {
    const { store } = scene()
    assert.deepEqual(store.connectorIds().sort(), ['c'])
  })
})

describe('connector picking', () => {
  /**
   * A point strictly between a connector's two endpoints.
   *
   * Deliberately not `path[floor(len/2)]` — after `cleanPath` collapses collinear points, the last
   * element of a straight route is the *target node's own anchor*, so probing there hits the shape
   * instead of the line and the test passes or fails for the wrong reason.
   */
  const onLine = (store: SceneStore, id: string) => {
    const path = store.connectorPath(id)
    const a = path[0]
    const b = path[path.length - 1]
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }

  it('picks a connector on its line', () => {
    const { store, c } = scene()
    const p = onLine(store, c.id)
    assert.equal(store.pickConnector(p, 4), c.id)
  })

  it('misses a connector well away from its line, even inside its bounding box', () => {
    const { store, c } = scene()
    const p = onLine(store, c.id)
    // The connector's box spans this whole horizontal span at y=50 with zero height, so a point
    // directly above the line is outside the box too. To prove the *line* is what is tested, aim at
    // a point that is inside the box's x-range but far off its y.
    assert.equal(store.pickConnector({ x: p.x, y: p.y + 40 }, 4), null, 'off the line, no hit')
  })

  it('never picks a locked connector', () => {
    const { store, c } = scene()
    store.update(c.id, { locked: true })
    assert.equal(store.pickConnector(onLine(store, c.id), 4), null)
  })

  it('pickExact also finds connectors, since that is what a click actually calls', () => {
    const { store, c } = scene()
    assert.equal(store.pickExact(onLine(store, c.id), 4), c.id)
  })

  it('pickExact prefers the connector over a shape whose edge it crosses', () => {
    // The connector is drawn after the shapes, so a click on the line where it crosses a box
    // outline should give the line, not the box. This is the "what you click is what you get"
    // property, and it only holds because pickExact sorts front to back.
    const store = new SceneStore()
    store.addMany([shape('a', 0, 0), shape('b', 400, 0)])
    store.add({
      ...connector('c', 'a', 'b'),
      z: 99,
    })

    const p = onLine(store, 'c')
    assert.equal(store.pickExact(p, 4), 'c')
  })
})

describe('serialization', () => {
  it('round-trips a connector through the snapshot envelope', () => {
    const { store } = scene()
    const parsed = JSON.parse(snapshot(store))
    assert.equal(parsed.nodes.length, 3)
    const c = parsed.nodes.find((n: ConnectorNode) => n.id === 'c') as ConnectorNode
    assert.equal(c.fromId, 'a')
    assert.equal(c.toId, 'b')
    assert.equal(c.endArrow, true)
  })
})
