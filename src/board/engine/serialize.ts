/**
 * Scene serialization.
 *
 * This is the boundary format: what undo restores, what export writes, and eventually what the CRDT
 * stores. It is a versioned envelope rather than a bare array, because a whiteboard saved last
 * month must still open today. `version` exists so a future format change can migrate rather than
 * silently drop someone's work.
 */

import type { SceneStore } from './store'
import type { BoardNode } from './types'

export const SCENE_VERSION = 1

export type SerializedScene = {
  version: number
  nodes: BoardNode[]
}

export function serializeScene(store: SceneStore): SerializedScene {
  // Transient nodes are deliberately excluded. They represent an in-flight gesture, not content,
  // and writing them into history or an export file would resurrect half-drawn shapes.
  const nodes: BoardNode[] = []
  for (const id of store.committedIds()) {
    const n = store.raw(id)
    if (n) nodes.push(n)
  }
  return { version: SCENE_VERSION, nodes }
}

export function deserializeScene(store: SceneStore, data: SerializedScene): void {
  store.clear()
  if (data.version !== SCENE_VERSION) {
    throw new Error(
      `Unsupported scene version ${data.version}, expected ${SCENE_VERSION}. ` +
        `Add a migration rather than loading this blindly.`,
    )
  }
  store.addMany(data.nodes)
}

export function snapshot(store: SceneStore): string {
  return JSON.stringify(serializeScene(store))
}

export function restore(store: SceneStore, snap: string): void {
  deserializeScene(store, JSON.parse(snap) as SerializedScene)
}
