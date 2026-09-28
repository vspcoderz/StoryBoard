/**
 * Uniform-grid spatial index.
 *
 * Chosen over an R-tree deliberately. An R-tree is asymptotically better for very uneven
 * distributions, but this workload is a few thousand roughly-uniformly-sized nodes, a uniform grid
 * answers both queries we need (viewport culling, hit testing) in O(1) with no tree rebalancing, and
 * — the actual reason — it is short enough to read end to end and therefore actually correct.
 *
 * Cells hold *ids*, never node objects, so the index can never hand back stale geometry. Node
 * bodies live only in the store.
 */

import type { Rect, Vec } from './geometry'
import { pointInRect, rectsIntersect } from './geometry'

export class SpatialIndex {
  /** Nodes are a few hundred units wide at most; 320 keeps the grid sparse without huge cells. */
  private readonly cell = 320
  private grid = new Map<string, Set<string>>()
  /** Tracked cells per id, so a move only rewrites the cells it actually left. */
  private occupied = new Map<string, string[]>()

  clear(): void {
    this.grid.clear()
    this.occupied.clear()
  }

  private key(cx: number, cy: number): string {
    return `${cx}:${cy}`
  }

  /** All cell keys a rect overlaps. */
  private cellsFor(r: Rect): string[] {
    const out: string[] = []
    const c0 = Math.floor(r.x / this.cell)
    const c1 = Math.floor((r.x + r.w) / this.cell)
    const r0 = Math.floor(r.y / this.cell)
    const r1 = Math.floor((r.y + r.h) / this.cell)
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) out.push(this.key(cx, cy))
    }
    return out
  }

  insert(id: string, bounds: Rect): void {
    this.remove(id)
    const keys = this.cellsFor(bounds)
    this.occupied.set(id, keys)
    for (const k of keys) {
      let set = this.grid.get(k)
      if (!set) {
        set = new Set()
        this.grid.set(k, set)
      }
      set.add(id)
    }
  }

  remove(id: string): void {
    const prev = this.occupied.get(id)
    if (!prev) return
    for (const k of prev) {
      const set = this.grid.get(k)
      if (!set) continue
      set.delete(id)
      // Drop empty cells eagerly. A long editing session churns through thousands of them and
      // letting them accumulate turns every query into a scan of dead Sets.
      if (set.size === 0) this.grid.delete(k)
    }
    this.occupied.delete(id)
  }

  /** Ids whose cells overlap `area`. May include false positives — the caller re-checks bounds. */
  query(area: Rect): string[] {
    const seen = new Set<string>()
    for (const k of this.cellsFor(area)) {
      const set = this.grid.get(k)
      if (!set) continue
      for (const id of set) seen.add(id)
    }
    return [...seen]
  }

  /** Ids intersecting `area`, with a real bounds test to drop cell-level false positives. */
  queryExact(area: Rect, boundsOf: (id: string) => Rect | null): string[] {
    const out: string[] = []
    for (const id of this.query(area)) {
      const b = boundsOf(id)
      if (b && rectsIntersect(b, area)) out.push(id)
    }
    return out
  }

  /** Topmost id containing `p`, or null. `boundsOf` supplies current geometry. */
  pick(p: Vec, boundsOf: (id: string) => Rect | null): string | null {
    const k = this.key(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell))
    const set = this.grid.get(k)
    if (!set) return null
    let best: string | null = null
    let bestArea = Infinity
    // Smallest containing node wins. On an overlapping pile this matches what the eye expects:
    // the little sticky note you can see is the one you meant to click.
    for (const id of set) {
      const b = boundsOf(id)
      if (b && pointInRect(p, b) && b.w * b.h < bestArea) {
        best = id
        bestArea = b.w * b.h
      }
    }
    return best
  }
}
