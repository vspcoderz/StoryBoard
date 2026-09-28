/**
 * Yjs document bridge.
 *
 * The CRDT is authoritative. This class is the only writer, and `SceneStore` is a projection of it
 * that it re-derives on every transaction — local or remote. Three consequences worth stating,
 * because they are the whole reason for the shape of this file:
 *
 * 1. Undo only ever touches my own edits. `trackedOrigins` is pinned to `LOCAL_ORIGIN`, so
 *    `Y.UndoManager` refuses to revert a collaborator's transaction. Without that, pressing undo
 *    deletes someone else's work.
 * 2. One node is one nested `Y.Map`, not a plain object. Two people editing `x` and `text` on the
 *    same shape converge field-by-field. Flattened into a single JSON value, the second write would
 *    silently clobber the first.
 * 3. Z-order is a numeric field, not a `Y.Array`. Concurrent reorderings of a Yjs sequence produce
 *    an order neither user asked for, and it cannot be repaired. A numeric sort with an id tiebreak
 *    is idempotent, so "wrong" is unrepresentable.
 */

import * as Y from 'yjs'
import { applyMutation, isEmptyMutation, type Mutation } from '../engine/mutation'
import type { NodePatch, SceneStore } from '../engine/store'
import type { BoardNode } from '../engine/types'

/** Marks a transaction as ours. Only transactions carrying this origin are undoable by us. */
export const LOCAL_ORIGIN = Symbol('storyboard.local')

const NODES = 'nodes'

/** Y.Map is not JSON-serialisable; it goes over the wire as a plain object. */
const toPlain = (n: BoardNode): Record<string, unknown> => JSON.parse(JSON.stringify(n)) as Record<string, unknown>

export type BridgeStatus = 'connecting' | 'connected' | 'disconnected'

export class YDocBridge {
  readonly doc: Y.Doc
  private yNodes: Y.Map<Y.Map<unknown>>
  private undoManager: Y.UndoManager
  private statusListeners = new Set<(s: BridgeStatus) => void>()
  private _status: BridgeStatus = 'disconnected'
  private detachProvider: (() => void)[] = []

  constructor(
    private store: SceneStore,
    doc: Y.Doc,
    provider?: {
      onStatus?: (cb: (s: BridgeStatus) => void) => () => void
      destroy?: () => void
    },
  ) {
    this.doc = doc
    this.yNodes = doc.getMap<Y.Map<unknown>>(NODES)

    this.undoManager = new Y.UndoManager(this.yNodes, {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      // 300ms of coalescing. Long enough that dragging a node and then nudging it is one undo
      // step, short enough that undo feels immediate after a pause.
      captureTimeout: 300,
    })

    // The one place the store is written. Every transaction — ours or a collaborator's — lands
    // here and the projection is rebuilt from it.
    this.yNodes.observeDeep(this.onRemoteChange)

    if (provider) {
      const off = provider.onStatus?.((s) => this.setStatus(s))
      if (off) this.detachProvider.push(off)
      if (provider.destroy) this.detachProvider.push(() => provider.destroy!())
    }
  }

  // ------------------------------------------------------------ status

  get status(): BridgeStatus {
    return this._status
  }

  onStatus(fn: (s: BridgeStatus) => void): () => void {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }

  private setStatus(s: BridgeStatus): void {
    if (this._status === s) return
    this._status = s
    for (const fn of this.statusListeners) fn(s)
  }

  // ------------------------------------------------------------ inbound (Y -> store)

  private onRemoteChange = (): void => {
    // We are not suppressing our own writes: the projection must be re-derived from the CRDT in
    // both directions, because undo works by reverting a transaction and expecting the store to
    // follow. If we skipped our own transactions the store would drift out of step with the
    // document the moment anyone hit undo.

    const incoming = new Map<string, BoardNode>()
    this.yNodes.forEach((ym) => {
      const obj = ym.toJSON() as BoardNode
      if (obj && typeof obj.id === 'string') incoming.set(obj.id, obj)
    })

    // Diff rather than wholesale replace. Replacing would clear the store on every transaction,
    // which drops the user's selection — so a collaborator typing a single character would visibly
    // deselect whatever you were working on. Applying the minimum diff keeps untouched nodes, and
    // therefore the selection, exactly where they are.
    const created: BoardNode[] = []
    const patches: [string, NodePatch][] = []
    for (const [id, node] of incoming) {
      const current = this.store.raw(id)
      if (!current) {
        created.push(node)
        continue
      }
      const before = JSON.stringify(current)
      if (before === JSON.stringify(node)) continue
      // A whole-node rewrite is correct here and nowhere else: the CRDT has already merged the
      // fields, so `node` is the agreed truth and patching only the changed keys would be guesswork.
      const next: NodePatch = {} as NodePatch
      for (const k of Object.keys(node) as (keyof BoardNode)[]) {
        if (k === 'id' || k === 'type') continue
        ;(next as Record<string, unknown>)[k as string] = (node as Record<string, unknown>)[k as string]
      }
      patches.push([id, next])
    }

    const removed: string[] = []
    for (const id of this.store.committedIds()) {
      if (!incoming.has(id)) removed.push(id)
    }

    if (created.length) applyMutation(this.store, { type: 'create', nodes: created })
    if (patches.length) applyMutation(this.store, { type: 'update', patches })
    if (removed.length) applyMutation(this.store, { type: 'remove', ids: removed })
  }

  // ------------------------------------------------------------ outbound (app -> Y)

  apply(m: Mutation): void {
    if (isEmptyMutation(m)) return
    this.doc.transact(() => {
      switch (m.type) {
        case 'create':
          for (const n of m.nodes) this.writeNode(n)
          return
        case 'update':
          for (const [id, patch] of m.patches) this.patchNode(id, patch)
          return
        case 'remove':
          for (const id of m.ids) this.yNodes.delete(id)
          return
        case 'replace':
          // Clear then rewrite. Not atomic-friendly, but a document load is a whole-board event
          // and no sane collaborator is mid-sentence during it.
          for (const id of [...this.yNodes.keys()]) this.yNodes.delete(id)
          for (const n of m.nodes) this.writeNode(n)
          return
      }
    }, LOCAL_ORIGIN)
  }

  private writeNode(n: BoardNode): void {
    const ym = new Y.Map<unknown>()
    for (const [k, v] of Object.entries(toPlain(n))) ym.set(k, v)
    this.yNodes.set(n.id, ym)
  }

  /**
   * Apply a field-level patch.
   *
   * Only keys that are actually present in the patch are touched. A patch that omitted a field must
   * leave it alone — that is what lets two people edit different fields of one node without
   * clobbering, and a blind "set every key from the local copy" would destroy that guarantee.
   */
  private patchNode(id: string, patch: NodePatch): void {
    const ym = this.yNodes.get(id)
    if (!ym) return
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (k === 'id' || k === 'type') continue
      ym.set(k, v)
    }
  }

  // ------------------------------------------------------------ undo

  undo(): void {
    this.undoManager.undo()
  }

  redo(): void {
    this.undoManager.redo()
  }

  get canUndo(): boolean {
    return this.undoManager.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.undoManager.redoStack.length > 0
  }

  // ------------------------------------------------------------ lifecycle

  destroy(): void {
    for (const d of this.detachProvider) d()
    this.detachProvider = []
    this.statusListeners.clear()
    this.undoManager.destroy()
    this.yNodes.unobserveDeep(this.onRemoteChange)
  }
}
