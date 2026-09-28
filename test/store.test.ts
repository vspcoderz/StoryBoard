import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SceneStore } from '../src/board/engine/store'
import { makeNode } from '../src/board/engine/types'

const shape = (x: number, y: number, id?: string) =>
  makeNode({ type: 'shape', shape: 'rect', text: '', x, y, w: 100, h: 100, ...(id ? { id } : {}) })

describe('preview overlay — the collaboration commit rule', () => {
  it('reports no change when a drag never moved', () => {
    const s = new SceneStore()
    const n = shape(0, 0)
    s.add(n)

    s.beginPreview()
    s.setPreview(n.id, { x: 0, y: 0 })
    const patches = s.endPreview()

    // A click that does not move anything must produce zero writes. A no-op CRDT write still costs
    // a round trip, and on a shared board a stream of them is what makes other people's cursors
    // stutter.
    assert.deepEqual(patches, [])
  })

  it('reports only the fields that actually changed', () => {
    const s = new SceneStore()
    const n = shape(10, 10)
    s.add(n)

    s.beginPreview()
    s.setPreview(n.id, { x: 55, y: 10 })
    const patches = s.endPreview()

    assert.equal(patches.length, 1)
    const [id, patch] = patches[0]
    assert.equal(id, n.id)
    assert.deepEqual(patch, { x: 55 })
    // y was set to its existing value, so it must not be replicated.
    assert.equal('y' in patch, false)
  })

  it('does not mutate the committed node until the patch is applied', () => {
    const s = new SceneStore()
    const n = shape(0, 0)
    s.add(n)

    s.beginPreview()
    s.setPreview(n.id, { x: 300 })
    // The preview is what the renderer reads...
    assert.equal(s.get(n.id)!.x, 300)
    // ...but the committed body, and therefore anything that syncs, is untouched.
    assert.equal(s.raw(n.id)!.x, 0)
    s.cancelPreview()
    assert.equal(s.get(n.id)!.x, 0)
  })

  it('re-indexes so a previewed drag stays hit-testable', () => {
    const s = new SceneStore()
    const n = shape(0, 0)
    s.add(n)

    s.beginPreview()
    s.setPreview(n.id, { x: 5000 })
    assert.equal(s.pick({ x: 5050, y: 50 }), n.id)
    s.cancelPreview()
    assert.equal(s.pick({ x: 5050, y: 50 }), null)
  })
  it('rejects a preview that was never begun', () => {
    const s = new SceneStore()
    const n = shape(0, 0)
    s.add(n)
    // Regression guard. A missing beginPreview once made every drag a silent no-op, disabling move,
    // resize, drag-to-draw and freehand simultaneously while the UI still looked correct. Failing
    // loudly is the only way that bug can never ship again.
    assert.throws(() => s.setPreview(n.id, { x: 10 }), /no active preview/)
  })

  it('moves a node across a whole preview-then-commit cycle', () => {
    const s = new SceneStore()
    const n = shape(0, 0)
    s.add(n)

    s.beginPreview()
    s.setPreview(n.id, { x: 40, y: 25 })
    s.setPreview(n.id, { x: 120 })
    s.updateMany(s.endPreview())

    assert.equal(s.raw(n.id)!.x, 120)
    assert.equal(s.raw(n.id)!.y, 25)
    assert.deepEqual(s.getBounds(n.id), { x: 120, y: 25, w: 100, h: 100 })
  })

  it('reverts cleanly when a preview is cancelled', () => {
    const s = new SceneStore()
    const n = shape(10, 10)
    s.add(n)
    s.beginPreview()
    s.setPreview(n.id, { x: 999 })
    s.cancelPreview()
    assert.equal(s.get(n.id)!.x, 10)
    assert.equal(s.pick({ x: 60, y: 60 }), n.id, 'index must be restored to committed geometry')
  })
})

describe('transient nodes', () => {
  it('keeps in-flight nodes out of the replicated set', () => {
    const s = new SceneStore()
    const done = shape(0, 0, 'done')
    const live = shape(200, 0, 'live')
    s.add(done)
    s.addTransient(live)

    assert.equal(s.has('live'), true, 'must still render')
    assert.deepEqual(s.committedIds(), ['done'], 'must not be replicated yet')
  })

  it('promotes on commit and drops on discard', () => {
    const s = new SceneStore()
    const a = shape(0, 0, 'a')
    s.addTransient(a)
    assert.deepEqual(s.commitTransient(['a']), ['a'])
    assert.deepEqual(s.committedIds(), ['a'])

    const b = shape(0, 0, 'b')
    s.addTransient(b)
    s.discardTransient(['b'])
    assert.equal(s.has('b'), false)
  })
})

describe('ordering', () => {
  it('is a total order even when z values collide', () => {
    const s = new SceneStore()
    s.addMany([
      makeNode({ type: 'shape', shape: 'rect', text: '', id: 'c', z: 1, w: 10, h: 10 }),
      makeNode({ type: 'shape', shape: 'rect', text: '', id: 'a', z: 1, w: 10, h: 10 }),
      makeNode({ type: 'shape', shape: 'rect', text: '', id: 'b', z: 0, w: 10, h: 10 }),
    ])
    // Two nodes sharing a z must still sort deterministically, or they flicker between frames.
    assert.deepEqual(
      s.ordered().map((n) => n.id),
      ['b', 'a', 'c'],
    )
  })

  it('allocates z above everything placed', () => {
    const s = new SceneStore()
    s.add(makeNode({ type: 'shape', shape: 'rect', text: '', z: 7, w: 10, h: 10 }))
    assert.equal(s.nextZ(), 8)
  })
})

describe('selection', () => {
  it('unions bounds across the selection', () => {
    const s = new SceneStore()
    const a = shape(0, 0, 'a')
    const b = makeNode({ type: 'shape', shape: 'rect', text: '', id: 'b', x: 200, y: 50, w: 100, h: 100 })
    s.addMany([a, b])
    s.select(['a', 'b'])
    assert.deepEqual(s.selectionBounds(), { x: 0, y: 0, w: 300, h: 150 })
  })

  it('returns null bounds when nothing is selected', () => {
    assert.equal(new SceneStore().selectionBounds(), null)
  })

  it('drops deleted nodes from the selection', () => {
    const s = new SceneStore()
    const n = shape(0, 0)
    s.add(n)
    s.select([n.id])
    s.remove([n.id])
    assert.equal(s.selection.size, 0)
  })
})
