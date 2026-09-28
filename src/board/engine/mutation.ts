/**
 * Mutations.
 *
 * A mutation is the only way anything changes the document. It exists so that the same code path
 * serves both modes: with no collab backend attached, `applyMutation` writes straight to the store;
 * with a Yjs bridge attached, the bridge writes to the CRDT and the CRDT's observer writes back to
 * the store. Either way exactly one function decides what a change means, so local and remote edits
 * cannot drift apart in how they are interpreted.
 *
 * Note the direction of authority. When a bridge is present the CRDT is authoritative, not the
 * store — the store is a projection of it. That is what makes undo correct: `Y.UndoManager` can
 * revert a transaction and the projection simply re-derives itself, whereas a store that is
 * authoritative has to be manually kept in step and will eventually not be.
 */

import type { SceneStore, NodePatch } from './store'
import type { BoardNode } from './types'

export type Mutation =
  | { type: 'create'; nodes: BoardNode[] }
  | { type: 'update'; patches: [string, NodePatch][] }
  | { type: 'remove'; ids: string[] }
  /** Wholesale replacement: loading a document, or clearing the board. */
  | { type: 'replace'; nodes: BoardNode[] }

export function applyMutation(store: SceneStore, m: Mutation): void {
  switch (m.type) {
    case 'create':
      if (m.nodes.length) store.addMany(m.nodes)
      return
    case 'update':
      if (m.patches.length) store.updateMany(m.patches)
      return
    case 'remove':
      store.remove(m.ids)
      return
    case 'replace':
      store.clear()
      if (m.nodes.length) store.addMany(m.nodes)
      return
  }
}

export const isEmptyMutation = (m: Mutation): boolean =>
  (m.type === 'create' && m.nodes.length === 0) ||
  (m.type === 'update' && m.patches.length === 0) ||
  (m.type === 'remove' && m.ids.length === 0) ||
  (m.type === 'replace' && m.nodes.length === 0)
