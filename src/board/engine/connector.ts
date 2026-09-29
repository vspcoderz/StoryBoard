/**
 * Connector geometry.
 *
 * A connector is an edge between two nodes. The hard part is not the line, it is deciding *where on
 * each node* the line should attach and how to get between those two points without cutting through
 * the middle of a shape.
 *
 * Two decisions worth recording:
 *
 * 1. **Anchors, not arbitrary points.** A connector stores which node it is bound to and which side
 *    of that node it leaves from, and recomputes the actual point every render. If it stored a raw
 *    coordinate instead, moving a node would leave the arrow hanging in space — and two people
 *    moving either end concurrently would fight over a coordinate that has no meaning on its own.
 *    Recomputing from the bound node also means one person's move updates the connector for everyone.
 *
 * 2. **Orthogonal routing, not straight lines, when it is ugly.** A straight line between two boxes
 *    is the right answer most of the time and the wrong answer when the boxes are side by side, where
 *    it clips a corner. We pick per-connector, deterministically, so both clients route identically
 *    and the line does not flicker between renders.
 *
 * Pure functions only. No canvas, no store — which is what makes routing unit-testable, and routing
 * is exactly the kind of code that looks right and is subtly wrong.
 */

import type { Rect, Vec } from './geometry'
import { dist, distToSegment, rectCenter } from './geometry'

/** Which side of a node a connector attaches to. */
export type AnchorSide = 'top' | 'right' | 'bottom' | 'left'

/** A resolved endpoint: the world point plus which way the line leaves the node. */
export type Anchor = {
  point: Vec
  side: AnchorSide
  /** Unit vector pointing away from the node, i.e. the direction the line travels on leaving. */
  out: Vec
}

export const SIDES: AnchorSide[] = ['top', 'right', 'bottom', 'left']

const SIDE_VEC: Record<AnchorSide, Vec> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}

/** The point at the centre of one side of a box. */
export function anchorPoint(b: Rect, side: AnchorSide): Vec {
  switch (side) {
    case 'top':
      return { x: b.x + b.w / 2, y: b.y }
    case 'bottom':
      return { x: b.x + b.w / 2, y: b.y + b.h }
    case 'left':
      return { x: b.x, y: b.y + b.h / 2 }
    case 'right':
      return { x: b.x + b.w, y: b.y + b.h / 2 }
  }
}

/**
 * Choose the side of `b` that a line to `toward` should leave from.
 *
 * Purely a function of the dominant axis, so it is stable: nudging a node a few pixels does not
 * flip which side the arrow uses, which would otherwise make connectors visibly snap between sides
 * during a drag.
 */
export function bestSide(b: Rect, toward: Vec): AnchorSide {
  const c = rectCenter(b)
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left'
  return dy > 0 ? 'bottom' : 'top'
}

export function anchorFor(b: Rect, side: AnchorSide): Anchor {
  return { point: anchorPoint(b, side), side, out: SIDE_VEC[side] }
}

/**
 * Build an elbow path from `a` to `b`.
 *
 * The route leaves `a` along its own outward normal, turns once, and arrives at `b` along `b`'s. A
 * single bend is the most that reads as "deliberate" — two-bend Z routes are for grid layouts where
 * everything is axis-aligned, and they look like noise on a freeform story board.
 *
 * We pick the bend that produces the shorter path, so a connector between two side-by-side boxes
 * takes a shallow Z rather than a detour.
 */
export function elbowPath(a: Anchor, b: Anchor): Vec[] {
  const p0 = a.point
  const p1 = b.point

  if (a.side === b.side) {
    // Both leave the same side. Bow out perpendicular to that side, then come back. This is the
    // case a straight line gets worst: two boxes side by side, arrows both pointing right.
    const n = SIDE_VEC[a.side]
    const spread = Math.max(24, dist(p0, p1) * 0.25)
    return [p0, addScaled(p0, n, spread), addScaled(p1, n, spread), p1]
  }

  const along = Math.abs(dot2(a.out, b.out))
  if (along > 0.5) {
    // Opposite sides (right→left, top→bottom). One bend between them.
    const n = a.out
    const gap = dot2(sub2(p1, p0), n)
    const mid = addScaled(p0, n, gap / 2)
    return [p0, mid, p1]
  }

  // Adjacent sides. A corner: step out from `a` far enough to clear the source box, then go
  // straight across to `b`. The step is a fixed world distance rather than a fraction of the gap,
  // because it has to clear the *source box* — scaling it with the gap would leave a short connector
  // turning inside its own node.
  return [p0, addScaled(p0, a.out, BEND_CLEARANCE), p1]
}

/** How far a connector steps out of its source before turning. In world units. */
export const BEND_CLEARANCE = 24

const sub2 = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y })
const dot2 = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y
const addScaled = (p: Vec, dir: Vec, k: number): Vec => ({ x: p.x + dir.x * k, y: p.y + dir.y * k })
export function cleanPath(pts: Vec[]): Vec[] {
  const out: Vec[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (last && dist(last, p) < 0.5) continue
    out.push(p)
  }
  // Remove midpoints that sit on the line between their neighbours, which otherwise render as
  // invisible joins that make the line look like it has a kink.
  for (let i = out.length - 2; i >= 1; i--) {
    const a = out[i - 1]
    const b = out[i]
    const c = out[i + 1]
    const ab = sub2(b, a)
    const bc = sub2(c, b)
    const cross = ab.x * bc.y - ab.y * bc.x
    const scale = Math.max(1, Math.hypot(ab.x, ab.y) * Math.hypot(bc.x, bc.y))
    if (Math.abs(cross) / scale < 1e-3) out.splice(i, 1)
  }
  return out
}

/**
 * The full route for a connector: resolve both anchors from the live node geometry, then join.
 *
 * `fromSide`/`toSide` are only honoured when pinned. An unpinned end re-derives its side every time,
 * so dragging a node re-aims the arrow; a pinned end stays put because the user chose it.
 */
export function routeConnector(
  from: { bounds: Rect; side: AnchorSide | null; toward: Vec },
  to: { bounds: Rect; side: AnchorSide | null; toward: Vec },
  style: 'orthogonal' | 'straight' = 'orthogonal',
): Vec[] {
  const a = anchorFor(from.bounds, from.side ?? bestSide(from.bounds, from.toward))
  const b = anchorFor(to.bounds, to.side ?? bestSide(to.bounds, to.toward))
  const path = style === 'straight' ? [a.point, b.point] : elbowPath(a, b)
  return cleanPath(path)
}

/** Is `p` within `tol` of the connector's path? Used for picking thin lines. */
export function hitPath(pts: Vec[], p: Vec, tol: number): boolean {
  if (pts.length === 0) return false
  if (pts.length === 1) return dist(pts[0], p) <= tol
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(p, pts[i - 1], pts[i]) <= tol) return true
  }
  return false
}

/**
 * Which side of a node a point is closest to, and how far away it is.
 *
 * Used when dragging a connector endpoint: we need to know both *which* node is under the cursor and
 * *how close* it is, because a drop that is very close to a node should re-aim that node's arrow
 * rather than do nothing at all.
 */
export function nearestSide(b: Rect, p: Vec): { side: AnchorSide; point: Vec; distance: number } {
  const side = bestSide(b, p)
  const point = anchorPoint(b, side)
  return { side, point, distance: dist(p, point) }
}
