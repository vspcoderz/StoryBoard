/**
 * Alignment guides and grid snapping.
 *
 * The idea, borrowed from every design tool worth using: while dragging, look at the moving box
 * against every other box, and if any of their edges or centres nearly line up, snap to that
 * alignment and draw a guide line so the snap is *visible*. Invisible snapping feels like the app
 * fighting you — you move something and it lurches for reasons you cannot see.
 *
 * Two thresholds, and the difference is deliberate:
 *
 * - **Grid snap** applies only when nothing better is in range. It is a fallback for placing things
 *   in empty space, not a competitor to alignment.
 * - **Alignment snap** is screen-space, so the tolerance feels the same at every zoom. A fixed
 *   world-space tolerance would be unusable when zoomed out and sticky when zoomed in.
 *
 * Pure and canvas-free, so all of this is unit-testable — which matters, because guide maths is
 * where "it looks right at 100%" bugs live.
 */

import type { Rect, Vec } from './geometry'
import type { SpatialIndex } from './spatial'

/** How close, in *screen* pixels, two edges must be to count as aligned. */
export const ALIGN_TOLERANCE_PX = 6

export const GRID_SIZE = 20

export type SnapAxis = 'x' | 'y'

export type Guide = {
  axis: SnapAxis
  /** World coordinate of the guide line. */
  at: number
  /** Span to draw, so the guide only crosses the shapes it relates. */
  from: number
  to: number
}

export type SnapResult = {
  /** The adjusted rect. */
  rect: Rect
  /** Guides to draw while the drag is live. */
  guides: Guide[]
  /** True when an alignment (not the grid) caused the snap. */
  aligned: boolean
}

/** Candidate lines on one axis: the moving box's three positions, against everything else. */
type Candidate = { moving: number; target: number; from: number; to: number }

/**
 * Collect alignment candidates for one axis.
 *
 * Only *same-kind* alignment is offered: left-to-left, centre-to-centre, right-to-right (and the
 * equivalents on y). Cross-kind pairing — a left edge snapping onto a neighbour's centre — looks like
 * a generous extra alignment but is never what anyone meant, and because it is usually *closer* it
 * wins the "closest candidate" contest and hijacks the drag. A test caught exactly that.
 *
 * The consequence worth stating: aligning two boxes of different widths by their left edges also
 * aligns nothing else, which is the correct and predictable behaviour. Aligning centres is a separate
 * candidate and competes on distance like everything else.
 */
function candidates(
  moving: Rect,
  others: Rect[],
  axis: SnapAxis,
): Candidate[] {
  const movingVals: Record<SnapAxis, [number, number, number]> = {
    x: [moving.x, moving.x + moving.w / 2, moving.x + moving.w],
    y: [moving.y, moving.y + moving.h / 2, moving.y + moving.h],
  }
  const out: Candidate[] = []
  for (const o of others) {
    const otherVals: Record<SnapAxis, [number, number, number]> = {
      x: [o.x, o.x + o.w / 2, o.x + o.w],
      y: [o.y, o.y + o.h / 2, o.y + o.h],
    }
    for (let i = 0; i < 3; i++) {
      const mv = movingVals[axis][i]
      const ov = otherVals[axis][i]
      if (axis === 'x') {
        out.push({
          moving: mv,
          target: ov,
          from: Math.min(moving.y, o.y),
          to: Math.max(moving.y + moving.h, o.y + o.h),
        })
      } else {
        out.push({
          moving: mv,
          target: ov,
          from: Math.min(moving.x, o.x),
          to: Math.max(moving.x + moving.w, o.x + o.w),
        })
      }
    }
  }
  return out
}

/**
 * Snap `moving` against `others`, then the grid.
 *
 * `scale` converts the screen-pixel tolerance into world units. `others` should already exclude the
 * moving nodes — snapping a box to itself is a no-op that happens to win every comparison.
 */
export function snapRect(
  moving: Rect,
  others: Rect[],
  opts: { scale: number; grid?: number; exclude?: Set<string> },
): SnapResult {
  const tol = ALIGN_TOLERANCE_PX / Math.max(opts.scale, 0.0001)
  const grid = opts.grid ?? GRID_SIZE

  const rect = { ...moving }
  const guides: Guide[] = []
  let aligned = false

  for (const axis of ['x', 'y'] as SnapAxis[]) {
    let best: { delta: number; c: Candidate } | null = null
    for (const c of candidates(moving, others, axis)) {
      const delta = c.target - c.moving
      if (Math.abs(delta) > tol) continue
      // Closest wins, so the snap you get is the least intrusive one available.
      if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, c }
    }
    if (best) {
      aligned = true
      if (axis === 'x') rect.x += best.delta
      else rect.y += best.delta
      guides.push({ axis, at: best.c.target, from: best.c.from, to: best.c.to })
    } else if (grid > 0) {
      // Fall back to the grid. Only the origin corner snaps, not every edge: snapping all three
      // would fight the size of the object and make resizing feel like it is on rails.
      if (axis === 'x') rect.x = Math.round(rect.x / grid) * grid
      else rect.y = Math.round(rect.y / grid) * grid
    }
  }

  return { rect, guides, aligned }
}

/** Snap a single point, for dragging one node rather than a selection. */
export function snapPoint(
  p: Vec,
  size: { w: number; h: number },
  others: Rect[],
  opts: { scale: number; grid?: number },
): SnapResult {
  return snapRect({ x: p.x, y: p.y, w: size.w, h: size.h }, others, opts)
}

/**
 * Neighbouring rects to snap against, read from the index.
 *
 * `boundsOf` is injected rather than imported so the spatial index — which deliberately stores ids
 * only, never node objects — stays decoupled from the store. That separation is load-bearing: it is
 * what lets the index be tested and reasoned about without a scene.
 *
 * The query area is inflated so candidates just outside the moving box still count. An edge you are
 * 4px from snapping to is exactly the one you meant, and the index would otherwise not return it.
 */
export function snapNeighbours(
  index: SpatialIndex,
  moving: Rect,
  movingIds: Set<string>,
  scale: number,
  boundsOf: (id: string) => Rect | null,
): Rect[] {
  const pad = (ALIGN_TOLERANCE_PX * 4) / Math.max(scale, 0.0001)
  const area = {
    x: moving.x - pad,
    y: moving.y - pad,
    w: moving.w + pad * 2,
    h: moving.h + pad * 2,
  }
  const out: Rect[] = []
  for (const id of index.query(area)) {
    if (movingIds.has(id)) continue
    const b = boundsOf(id)
    if (b) out.push(b)
  }
  return out
}
