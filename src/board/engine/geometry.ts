/**
 * Geometry primitives. Pure functions, no canvas, no DOM — which is why these are the first thing
 * to unit test. Every hit test, marquee and transform bottoms out here.
 */

export type Vec = { x: number; y: number }
export type Rect = { x: number; y: number; w: number; h: number }

export const EPS = 1e-6

export const v = (x: number, y: number): Vec => ({ x, y })
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y })
export const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k })
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x
export const len = (a: Vec): number => Math.hypot(a.x, a.y)
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)
export const mid = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const clamp = (n: number, lo: number, hi: number): number =>
  n < lo ? lo : n > hi ? hi : n

export function normalize(a: Vec): Vec {
  const l = len(a)
  return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}

export function rotate(a: Vec, angle: number): Vec {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c }
}

/** Wrap to [0, 2π) so rotation comparisons and interpolation stay in one branch. */
export function normAngle(a: number): number {
  const t = a % (Math.PI * 2)
  return t < 0 ? t + Math.PI * 2 : t
}

// ---------------------------------------------------------------- rects

export const rectCenter = (r: Rect): Vec => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

export function rectFromPoints(points: Vec[]): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function rectUnion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  }
}

export function rectUnionAll(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  let acc = rects[0]
  for (let i = 1; i < rects.length; i++) acc = rectUnion(acc, rects[i])
  return acc
}

export const inflate = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + by * 2,
  h: r.h + by * 2,
})

export const pointInRect = (p: Vec, r: Rect): boolean =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
}

/** Build a rect from two drag points, normalising so the result is never negative-sized. */
export function rectFromDrag(a: Vec, b: Vec): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  }
}

// ---------------------------------------------------------------- rotated frames

/**
 * Map a world point into a node's unrotated local frame: center at origin, no rotation.
 * Hit tests all run in this space, which keeps them a plain point-in-rect with no trigonometry.
 */
export function worldToLocal(p: Vec, box: Rect, rotation: number): Vec {
  const c = rectCenter(box)
  return rotate({ x: p.x - c.x, y: p.y - c.y }, -rotation)
}

/** Inverse of `worldToLocal`. */
export function localToWorld(p: Vec, box: Rect, rotation: number): Vec {
  const c = rectCenter(box)
  return add(rotate(p, rotation), c)
}

/** The node's box expressed in its own local frame — always centered, rotation-free. */
export function localBox(box: Rect): Rect {
  return { x: -box.w / 2, y: -box.h / 2, w: box.w, h: box.h }
}

/** Segment/segment intersection, used by connector routing and the draw tool. */
export function segmentsIntersect(a1: Vec, a2: Vec, b1: Vec, b2: Vec): boolean {
  const d1 = cross(sub(b2, b1), sub(a1, b1))
  const d2 = cross(sub(b2, b1), sub(a2, b1))
  const d3 = cross(sub(a2, a1), sub(b1, a1))
  const d4 = cross(sub(a2, a1), sub(b2, a1))
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/** Shortest distance from `p` to segment `a`–`b`. */
export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a)
  const l2 = dot(ab, ab)
  if (l2 < EPS) return dist(p, a)
  const t = clamp(dot(sub(p, a), ab) / l2, 0, 1)
  return dist(p, add(a, mul(ab, t)))
}
