import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SpatialIndex } from '../src/board/engine/spatial'
import type { Rect } from '../src/board/engine/geometry'

const bounds = new Map<string, Rect>()
const lookup = (id: string): Rect | null => bounds.get(id) ?? null

const rect = (x: number, y: number, w = 40, h = 40): Rect => ({ x, y, w, h })

describe('SpatialIndex', () => {
  it('finds a node whose cell it shares', () => {
    const ix = new SpatialIndex()
    bounds.clear()
    bounds.set('a', rect(10, 10))
    ix.insert('a', rect(10, 10))
    assert.deepEqual(ix.query(rect(0, 0, 100, 100)), ['a'])
  })

  it('does not return nodes outside the query', () => {
    const ix = new SpatialIndex()
    bounds.clear()
    bounds.set('a', rect(10, 10))
    bounds.set('b', rect(5000, 5000))
    ix.insert('a', rect(10, 10))
    ix.insert('b', rect(5000, 5000))
    assert.deepEqual(ix.queryExact(rect(0, 0, 200, 200), lookup), ['a'])
  })

  it('follows a node when it moves', () => {
    const ix = new SpatialIndex()
    bounds.clear()
    bounds.set('a', rect(10, 10))
    ix.insert('a', rect(10, 10))
    assert.deepEqual(ix.query(rect(0, 0, 100, 100)), ['a'])
    bounds.set('a', rect(9000, 9000))
    ix.insert('a', rect(9000, 9000))
    assert.deepEqual(ix.query(rect(0, 0, 100, 100)), [])
    assert.deepEqual(ix.query(rect(8900, 8900, 200, 200)), ['a'])
  })

  it('does not duplicate a node across its own cells', () => {
    const ix = new SpatialIndex()
    // Wider than one cell, so it lands in several.
    ix.insert('wide', rect(0, 0, 1200, 40))
    const hits = ix.query(rect(0, 0, 2000, 2000)).filter((id) => id === 'wide')
    assert.equal(hits.length, 1)
  })

  it('picks the smallest containing node', () => {
    const ix = new SpatialIndex()
    bounds.clear()
    bounds.set('big', rect(0, 0, 500, 500))
    bounds.set('small', rect(100, 100, 50, 50))
    ix.insert('big', rect(0, 0, 500, 500))
    ix.insert('small', rect(100, 100, 50, 50))
    // On a pile of overlapping nodes, the small one you can actually see is the one you meant.
    assert.equal(ix.pick({ x: 120, y: 120 }, lookup), 'small')
    assert.equal(ix.pick({ x: 400, y: 400 }, lookup), 'big')
    assert.equal(ix.pick({ x: 900, y: 900 }, lookup), null)
  })

  it('removes cleanly and frees its cells', () => {
    const ix = new SpatialIndex()
    ix.insert('a', rect(0, 0, 40, 40))
    ix.remove('a')
    assert.deepEqual(ix.query(rect(0, 0, 500, 500)), [])
  })
})
