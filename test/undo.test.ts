/**
 * Undo ordering.
 *
 * This is a regression test for a bug the unit suite could not catch and only a real browser
 * could: `pushHistory` ran *after* the mutation, so the undo stack held post-edit state and undo
 * restored what was already on screen. Every pure-logic test passed while undo did nothing.
 *
 * The invariant, in one line: an undo point must be captured BEFORE the mutation it undoes.
 * `snapshot` omits transient nodes, which is what lets the create path capture "before" while the
 * new node is still transient.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SceneStore } from '../src/board/engine/store'
import { snapshot, restore } from '../src/board/engine/serialize'
import { applyMutation } from '../src/board/engine/mutation'
import { makeNode, type ShapeNode } from '../src/board/engine/types'

// makeNode mints its own id, so pin it explicitly — these tests address nodes by id.
const rect = (id: string, x: number): ShapeNode => ({
  ...makeNode<ShapeNode>({ type: 'shape', shape: 'rect', text: '', x, y: 0, w: 100, h: 100 }),
  id,
})

test('an undo point captured after a mutation restores the post-edit state (the bug)', () => {
  // Reproduces the original ordering: the mutation lands, THEN the undo point is pushed. The
  // snapshot therefore contains the very node the user is trying to undo, and undo is a no-op.
  const store = new SceneStore()
  const history: string[] = []

  store.add(rect('a', 0))
  store.add(rect('b', 200))
  history.push(snapshot(store)) // WRONG: captured after the node existed

  const restored = new SceneStore()
  restore(restored, history.pop()!)

  assert.equal(restored.size, 2, 'undo kept both nodes, so it did nothing')
})

test('an undo point captured before a mutation removes the node', () => {
  const store = new SceneStore()
  const history: string[] = []

  store.add(rect('a', 0))
  history.push(snapshot(store)) // RIGHT: captured before the node existed
  store.add(rect('b', 200))

  const restored = new SceneStore()
  restore(restored, history.pop()!)

  assert.equal(restored.size, 1)
  assert.ok(restored.has('a'), 'the pre-existing node survives')
  assert.ok(!restored.has('b'), 'the node created after the snapshot is gone')
})

test('a transient node is excluded from the snapshot, so capture-before works on create', () => {
  const store = new SceneStore()
  store.add(rect('a', 0))

  // This is exactly what the pointer does: the new node is transient while the undo point is taken.
  store.addTransient(rect('b', 200))
  const before = snapshot(store)
  const committed = store.commitTransient(['b'])

  assert.deepEqual(committed, ['b'])
  assert.equal(store.size, 2, 'the store has the node committed')
  assert.equal(JSON.parse(before).nodes.length, 1, 'but the snapshot taken mid-gesture does not')

  const restored = new SceneStore()
  restore(restored, before)
  assert.equal(restored.size, 1, 'so restoring it correctly drops the just-created node')
})

test('undo/redo round-trips through applyMutation', () => {
  const store = new SceneStore()
  store.add(rect('a', 0))
  const before = snapshot(store)

  applyMutation(store, { type: 'create', nodes: [rect('b', 200)] })
  assert.equal(store.size, 2)

  const restored = new SceneStore()
  restore(restored, before)
  assert.equal(restored.size, 1)

  applyMutation(restored, { type: 'create', nodes: [rect('b', 200)] })
  assert.equal(restored.size, 2, 'redo re-applies the same edit')
})
