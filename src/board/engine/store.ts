/**
 * Scene store.
 *
 * Deliberately framework-free: it imports no React and no canvas. It owns nodes, the spatial
 * index, selection, viewport and an *uncommitted preview overlay*. Chrome subscribes through
 * `on()` and reads coarse state; the renderer reads everything.
 *
 * The preview overlay is the reason collaboration stays smooth. While you drag, mutations land
 * here and nowhere else. The CRDT is written once, on pointer-up. Continuous writes during a drag
 * saturate the socket and make every other user's cursor stutter — it is the single biggest
 * difference between a collaborative canvas that feels solid and one that feels awful.
 */

import type { Rect, Vec } from './geometry'
import { clamp, rectUnion, rectUnionAll } from './geometry'
import { hitNode } from './hit'
import { SpatialIndex } from './spatial'
import type { BoardNode, NodeBase } from './types'
import { nodeBounds } from './types'
import { MAX_ZOOM, MIN_ZOOM, type Viewport } from './viewport'

export type StoreEvent = 'change' | 'selection' | 'viewport'

type Listener = (ev: StoreEvent) => void

/** Fields that may be shadowed by the uncommitted preview during a drag. */
export type NodePatch = Partial<Omit<BoardNode, 'id' | 'type'>>

export class SceneStore {
  private nodes = new Map<string, BoardNode>()
  private index = new SpatialIndex()
  private listeners = new Set<Listener>()

  private sel = new Set<string>()
  private vp: Viewport = { x: 0, y: 0, scale: 1 }

  /** Uncommitted drag state, keyed by node id. Never persisted, never synced. */
  private preview: Map<string, NodePatch> | null = null

  /**
   * Nodes that exist in the scene but are not yet real — a freehand stroke mid-draw, or a shape
   * being dragged out. They render and hit-test like any other node, but the sync layer skips them
   * until they are committed. Without this, every pointermove during a stroke would be a CRDT write
   * and every collaborator would watch a shape materialise one pixel at a time.
   */
  private transient = new Set<string>()

  /** Accumulated repaint region. `null` means "repaint everything". */
  private dirty: Rect | null = { x: 0, y: 0, w: 0, h: 0 }
  private dirtyAll = true

  private sortedCache: BoardNode[] | null = null

  // ------------------------------------------------------------ events

  on(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(ev: StoreEvent): void {
    for (const fn of this.listeners) fn(ev)
  }

  // ------------------------------------------------------------ dirty tracking

  markDirty(rect: Rect | null): void {
    if (rect === null) {
      this.dirtyAll = true
      this.dirty = null
      return
    }
    if (this.dirtyAll) return
    this.dirty = this.dirty ? rectUnion(this.dirty, rect) : { ...rect }
  }

  markAllDirty(): void {
    this.dirtyAll = true
    this.dirty = null
  }

  /** Read-and-reset. The render loop calls this once per frame. */
  consumeDirty(): { all: boolean; rect: Rect | null } {
    const out = { all: this.dirtyAll, rect: this.dirty }
    this.dirtyAll = false
    this.dirty = null
    return out
  }

  // ------------------------------------------------------------ viewport

  get viewport(): Viewport {
    return this.vp
  }

  setViewport(next: Viewport): void {
    this.vp = { ...next, scale: clamp(next.scale, MIN_ZOOM, MAX_ZOOM) }
    this.markDirty(null)
    this.emit('viewport')
  }

  // ------------------------------------------------------------ nodes

  get size(): number {
    return this.nodes.size
  }

  has(id: string): boolean {
    return this.nodes.has(id)
  }

  isTransient(id: string): boolean {
    return this.transient.has(id)
  }

  /** Add a node that must not reach the network until `commitTransient` is called for it. */
  addTransient(node: BoardNode): void {
    this.transient.add(node.id)
    this.add(node)
  }

  /** Promote transient nodes to real ones. Callers sync only after this. */
  commitTransient(ids: Iterable<string>): string[] {
    const out: string[] = []
    for (const id of ids) {
      if (this.transient.delete(id)) out.push(id)
    }
    return out
  }

  /** Drop transient nodes without promoting — used when a drag is cancelled or Escape is pressed. */
  discardTransient(ids: Iterable<string>): void {
    const list = [...ids]
    for (const id of list) this.transient.delete(id)
    this.remove(list)
  }

  /** Ids the sync layer should replicate: everything real, nothing transient. */
  committedIds(): string[] {
    const out: string[] = []
    for (const id of this.nodes.keys()) if (!this.transient.has(id)) out.push(id)
    return out
  }

  /** The node as committed, ignoring any preview. */
  raw(id: string): BoardNode | undefined {
    return this.nodes.get(id)
  }

  /** The node as it should be drawn right now: preview shadowing the committed body. */
  get(id: string): BoardNode | undefined {
    const n = this.nodes.get(id)
    if (!n) return undefined
    const p = this.preview?.get(id)
    return p ? ({ ...n, ...p } as BoardNode) : n
  }

  all(): IterableIterator<BoardNode> {
    return this.nodes.values()
  }

  private boundsOf = (id: string): Rect | null => {
    const n = this.get(id)
    return n ? nodeBounds(n) : null
  }

  /** Commit. Invalidates the z-sort cache and reindexes only the touched node. */
  add(node: BoardNode): void {
    this.nodes.set(node.id, node)
    this.index.insert(node.id, nodeBounds(node))
    this.sortedCache = null
    this.markDirty(nodeBounds(node))
    this.emit('change')
  }

  /** Add many in one pass. Used for paste, templates and undo, where per-node events would thrash. */
  addMany(nodes: BoardNode[]): void {
    let dirty: Rect | null = null
    for (const n of nodes) {
      this.nodes.set(n.id, n)
      this.index.insert(n.id, nodeBounds(n))
      const b = nodeBounds(n)
      dirty = dirty ? rectUnion(dirty, b) : b
    }
    this.sortedCache = null
    this.markDirty(dirty)
    this.emit('change')
  }

  update(id: string, patch: NodePatch): void {
    const n = this.nodes.get(id)
    if (!n) return
    const before = nodeBounds(n)
    const next = { ...n, ...patch } as BoardNode
    this.nodes.set(id, next)
    const after = nodeBounds(next)
    this.index.insert(id, after)
    this.markDirty(rectUnion(before, after))
    this.emit('change')
  }

  updateMany(patches: Iterable<[string, NodePatch]>): void {
    let dirty: Rect | null = null
    for (const [id, patch] of patches) {
      const n = this.nodes.get(id)
      if (!n) continue
      const before = nodeBounds(n)
      const next = { ...n, ...patch } as BoardNode
      this.nodes.set(id, next)
      const after = nodeBounds(next)
      this.index.insert(id, after)
      dirty = dirty ? rectUnion(dirty, rectUnion(before, after)) : rectUnion(before, after)
    }
    this.sortedCache = null
    this.markDirty(dirty)
    this.emit('change')
  }

  remove(ids: Iterable<string>): void {
    let dirty: Rect | null = null
    for (const id of ids) {
      const n = this.nodes.get(id)
      if (!n) continue
      dirty = dirty ? rectUnion(dirty, nodeBounds(n)) : nodeBounds(n)
      this.nodes.delete(id)
      this.index.remove(id)
      this.sel.delete(id)
    }
    this.sortedCache = null
    this.markDirty(dirty)
    this.emit('change')
    this.emit('selection')
  }

  /** Bounds of a node, preview included. */
  getBounds(id: string): Rect | null {
    return this.boundsOf(id)
  }

  /**
   * Union of the selected nodes' bounds, or null when nothing is selected. Rotation-aware, so a
   * rotated marquee and a rotated selection outline agree with each other.
   */
  selectionBounds(): Rect | null {
    const rects: Rect[] = []
    for (const id of this.sel) {
      const b = this.boundsOf(id)
      if (b) rects.push(b)
    }
    return rectUnionAll(rects)
  }

  /** All nodes, back to front. Cached until the next structural change. */
  ordered(): BoardNode[] {
    if (this.sortedCache) return this.sortedCache
    const arr = [...this.nodes.values()].filter((n) => n.visible)
    // The id tiebreak is what makes this a total order. Without it, two nodes sharing a z would
    // swap places arbitrarily between frames and visibly flicker.
    arr.sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1))
    this.sortedCache = arr
    return arr
  }

  /** Next z above everything currently placed. */
  nextZ(): number {
    let max = 0
    for (const n of this.nodes.values()) if (n.z > max) max = n.z
    return max + 1
  }

  // ------------------------------------------------------------ selection

  get selection(): ReadonlySet<string> {
    return this.sel
  }

  select(ids: Iterable<string>): void {
    this.sel = new Set(ids)
    this.emit('selection')
  }

  addToSelection(ids: Iterable<string>): void {
    for (const id of ids) this.sel.add(id)
    this.emit('selection')
  }

  toggleSelection(id: string): void {
    if (this.sel.has(id)) this.sel.delete(id)
    else this.sel.add(id)
    this.emit('selection')
  }

  clearSelection(): void {
    if (this.sel.size === 0) return
    this.sel = new Set()
    this.emit('selection')
  }

  // ------------------------------------------------------------ preview overlay

  beginPreview(): void {
    this.preview = new Map()
  }

  setPreview(id: string, patch: NodePatch): void {
    if (!this.preview) return
    const n = this.nodes.get(id)
    if (!n) return
    this.preview.set(id, { ...this.preview.get(id), ...patch })
    const before = nodeBounds(n)
    const after = nodeBounds({ ...n, ...patch } as NodeBase)
    // The index must follow the preview, not just the dirty rect. A node being dragged has to be
    // hit-testable at the position it is *visually* at, or hovering and re-grabbing it mid-drag
    // uses stale geometry.
    this.index.insert(id, after)
    this.markDirty(rectUnion(before, after))
  }

  previewOf(id: string): NodePatch | undefined {
    return this.preview?.get(id)
  }

  /**
   * Drop the preview, returning what changed so the caller can commit it exactly once.
   * Returns an empty array when nothing actually moved — worth checking before writing, because a
   * no-op CRDT write still costs a round trip.
   */
  endPreview(): [string, NodePatch][] {
    const out: [string, NodePatch][] = []
    if (this.preview) {
      for (const [id, patch] of this.preview) {
        const n = this.nodes.get(id)
        if (!n) continue
        let changed = false
        const clean: NodePatch = {}
        for (const k of Object.keys(patch) as (keyof NodePatch)[]) {
          if (n[k as keyof BoardNode] !== patch[k]) {
            ;(clean as Record<string, unknown>)[k as string] = patch[k]
            changed = true
          }
        }
        if (changed) out.push([id, clean])
      }
    }
    this.preview = null
    // Restore the index to committed geometry. The caller applies the returned patches through
    // update/updateMany, which reindexes again; doing it here means the index is never wrong even
    // if the caller decides not to apply them.
    for (const [id] of out) {
      const n = this.nodes.get(id)
      if (n) this.index.insert(id, nodeBounds(n))
    }
    return out
  }

  cancelPreview(): void {
    if (!this.preview) return
    for (const [id, patch] of this.preview) {
      const n = this.nodes.get(id)
      if (!n) continue
      this.markDirty(rectUnion(nodeBounds(n), nodeBounds({ ...n, ...patch } as NodeBase)))
      this.index.insert(id, nodeBounds(n))
    }
    this.preview = null
  }

  // ------------------------------------------------------------ queries

  /** Nodes intersecting a world-space rect, honouring the preview. */
  inRect(area: Rect): string[] {
    return this.index.queryExact(area, this.boundsOf)
  }

  /** Topmost node at a world point, or null. */
  pick(p: Vec): string | null {
    return this.index.pick(p, this.boundsOf)
  }

  /**
   * Topmost node at a world point, confirmed against its real outline.
   *
   * `pick` is AABB-only and fast but wrong for pointed shapes; this is the accurate one used for
   * clicking. Candidates come from the index (a handful), then each is tested properly, front to
   * back, so what you click is what you see.
   */
  pickExact(p: Vec, tolerance: number): string | null {
    const cell = Math.max(1, tolerance)
    const area = { x: p.x - cell, y: p.y - cell, w: cell * 2, h: cell * 2 }
    const candidates = this.index.query(area)
    if (candidates.length === 0) return null
    // Front to back. The index returns cells in hash order, which has nothing to do with stacking,
    // so without this you would sometimes click through to a shape hidden behind another.
    candidates.sort((a, b) => {
      const na = this.get(a)
      const nb = this.get(b)
      return (nb?.z ?? 0) - (na?.z ?? 0)
    })
    for (const id of candidates) {
      const n = this.get(id)
      if (n && !n.locked && hitNode(n, p, tolerance)) return id
    }
    return null
  }

  clear(): void {
    this.nodes.clear()
    this.index.clear()
    this.sel = new Set()
    this.preview = null
    this.transient.clear()
    this.sortedCache = null
    this.markAllDirty()
    this.emit('change')
    this.emit('selection')
  }
}
