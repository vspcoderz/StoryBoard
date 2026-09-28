import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SceneStore } from '../src/board/engine/store'
import { makeNode } from '../src/board/engine/types'
import { SCENE_VERSION, deserializeScene, serializeScene } from '../src/board/engine/serialize'

const build = (): SceneStore => {
  const s = new SceneStore()
  s.addMany([
    makeNode({ type: 'shape', shape: 'rect', text: 'one', x: 0, y: 0, w: 10, h: 10 }),
    makeNode({ type: 'sticky', text: 'two', author: null, x: 20, y: 20, w: 10, h: 10 }),
  ])
  return s
}

describe('scene serialization', () => {
  it('round-trips a scene', () => {
    const a = build()
    const b = new SceneStore()
    deserializeScene(b, serializeScene(a))
    assert.equal(b.size, a.size)
    assert.deepEqual([...b.all()].map((n) => n.type), [...a.all()].map((n) => n.type))
  })

  it('stamps the version so a future format can migrate', () => {
    assert.equal(serializeScene(build()).version, SCENE_VERSION)
  })

  it('refuses to load an unknown version instead of silently dropping content', () => {
    // A whiteboard holds someone's unfinished novel. Guessing at a format and rendering an empty
    // board is far worse than refusing and saying so.
    assert.throws(
      () => deserializeScene(new SceneStore(), { version: 999, nodes: [] }),
      /Unsupported scene version/,
    )
  })

  it('excludes transient nodes', () => {
    const s = build()
    s.addTransient(makeNode({ type: 'shape', shape: 'ellipse', text: '', w: 5, h: 5 }))
    const out = serializeScene(s)
    assert.equal(out.nodes.length, 2, 'the in-flight shape must not be serialized')
  })
})
