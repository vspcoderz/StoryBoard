/**
 * Freehand stroke geometry.
 *
 * The naive approach — stroke a polyline and hope — gives a stroke whose width is constant, which
 * reads as a pen *outline* rather than a pen. To get pressure response we build the stroke as a
 * single filled outline polygon and fill it once.
 *
 * One fill instead of N segments matters: a 900-point stroke would otherwise be 900 stroke calls
 * per frame, which is the difference between 60fps and a visible stall on every pen movement.
 */

import type { Vec } from '../geometry'
import { EPS, len, normalize, sub } from '../geometry'

export type StrokePoint = { x: number; y: number; p: number }

/** Centripetal-ish smoothing: nudge each point toward the average of its neighbours. */
export function smooth(points: StrokePoint[], strength = 0.5): StrokePoint[] {
  if (points.length < 3) return points
  const out: StrokePoint[] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    const next = points[i + 1]
    out.push({
      x: cur.x + ((prev.x + next.x) / 2 - cur.x) * strength,
      y: cur.y + ((prev.y + next.y) / 2 - cur.y) * strength,
      p: cur.p,
    })
  }
  out.push(points[points.length - 1])
  return out
}

/** Chaikin corner-cutting. Two iterations is enough to kill pointer jitter without softening intent. */
export function chaikin(points: Vec[], iterations = 2): Vec[] {
  let pts = points
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) return pts
    const next: Vec[] = [pts[0]]
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 })
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 })
    }
    next.push(pts[pts.length - 1])
    pts = next
  }
  return pts
}

/**
 * Chaikin that carries stroke pressure through the interpolation.
 *
 * Pressure must be smoothed along with position. Interpolating position while looking pressure back
 * up by nearest neighbour looks correct once and is quadratic in the point count — a 500-point
 * stroke would burn 250k distance comparisons *per frame*, which is exactly the kind of stall that
 * makes a drawing tool feel broken. Interpolating all three channels together is O(n) and gives the
 * same result.
 */
export function chaikinStroke(points: StrokePoint[], iterations = 2): StrokePoint[] {
  let pts = points
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) return pts
    const next: StrokePoint[] = [pts[0]]
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      next.push({
        x: a.x * 0.75 + b.x * 0.25,
        y: a.y * 0.75 + b.y * 0.25,
        p: a.p * 0.75 + b.p * 0.25,
      })
      next.push({
        x: a.x * 0.25 + b.x * 0.75,
        y: a.y * 0.25 + b.y * 0.75,
        p: a.p * 0.25 + b.p * 0.75,
      })
    }
    next.push(pts[pts.length - 1])
    pts = next
  }
  return pts
}

/** Resample to roughly even spacing so smoothing behaves consistently across input rates. */
export function resample(points: Vec[], spacing: number): Vec[] {
  if (points.length < 2) return points
  const out: Vec[] = [points[0]]
  let carry = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const seg = len(sub(b, a))
    if (seg < EPS) continue
    let t = spacing - carry
    while (t <= seg) {
      const k = t / seg
      out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k })
      t += spacing
    }
    carry = seg - (t - spacing)
  }
  out.push(points[points.length - 1])
  return out
}

/** Interpolated width at a point, from its recorded pressure. */
function widthAt(p: StrokePoint, baseWidth: number): number {
  return Math.max(0.4, baseWidth * (0.25 + 0.75 * p.p))
}

/**
 * Build the filled outline of a variable-width stroke.
 *
 * Offsets along the averaged normal at each point rather than the per-segment normal: using the
 * per-segment normal makes the outline self-intersect on tight corners, which the nonzero-fill rule
 * turns into visible notches. Averaging is the standard fix.
 */
export function strokeOutline(points: StrokePoint[], baseWidth: number): Vec[] {
  if (points.length === 0) return []
  if (points.length === 1) {
    const p = points[0]
    const r = widthAt(p, baseWidth) / 2
    return circle(p, r)
  }

  const normals: Vec[] = []
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)]
    const next = points[Math.min(points.length - 1, i + 1)]
    const dir = normalize(sub(next, prev))
    if (dir.x === 0 && dir.y === 0) {
      normals.push({ x: 0, y: -1 })
    } else {
      normals.push({ x: -dir.y, y: dir.x })
    }
  }

  const left: Vec[] = []
  const right: Vec[] = []
  for (let i = 0; i < points.length; i++) {
    const hw = widthAt(points[i], baseWidth) / 2
    const n = normals[i]
    left.push({ x: points[i].x + n.x * hw, y: points[i].y + n.y * hw })
    right.push({ x: points[i].x - n.x * hw, y: points[i].y - n.y * hw })
  }

  // Round caps at both ends, otherwise strokes end in a hard chisel.
  const startCap = arcCap(points[0], points[1], widthAt(points[0], baseWidth) / 2, normals[0])
  const endCap = arcCap(
    points[points.length - 1],
    points[points.length - 2],
    widthAt(points[points.length - 1], baseWidth) / 2,
    normals[normals.length - 1],
  )

  return [...startCap, ...left.slice(1), ...endCap, ...right.slice(1).reverse()]
}

function arcCap(p: StrokePoint, toward: StrokePoint, r: number, normal: Vec): Vec[] {
  const dir = normalize(sub(toward as Vec, p as Vec))
  const start = Math.atan2(normal.y, normal.x)
  // Sweep the half circle that closes the outline on the far side of the stroke.
  const delta = Math.atan2(dir.y, dir.x) - start
  const sweep = delta > 0 ? delta - Math.PI : delta + Math.PI
  const out: Vec[] = []
  const steps = 8
  for (let i = 0; i <= steps; i++) {
    const a = start + sweep * (i / steps)
    out.push({ x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r })
  }
  return out
}

function circle(c: Vec, r: number): Vec[] {
  const out: Vec[] = []
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r })
  }
  return out
}

/** Minimum distance from a point to the stroke, for hit testing a thin freehand path. */
export function distToStroke(points: Vec[], p: Vec): number {
  let best = Infinity
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const l2 = abx * abx + aby * aby
    if (l2 < EPS) {
      best = Math.min(best, Math.hypot(p.x - a.x, p.y - a.y))
      continue
    }
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2
    t = t < 0 ? 0 : t > 1 ? 1 : t
    best = Math.min(best, Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t)))
  }
  return best
}
