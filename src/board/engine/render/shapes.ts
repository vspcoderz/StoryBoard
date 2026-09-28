/**
 * Shape outline construction.
 *
 * Every path is emitted in *local* space: origin at the node's center, no rotation, no translation.
 * The renderer sets the transform once and then draws the shape in a coordinate system where a
 * rect is just a rect. Without this convention every shape would need its own rotation-aware
 * maths, and ellipse hit tests would need the inverse transform anyway.
 */

import type { ShapeKind } from '../types'

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function roundedRectPath(ctx: Ctx2D, w: number, h: number, r: number): void {
  const hw = w / 2
  const hh = h / 2
  // Clamp so a radius larger than the box collapses to a lozenge instead of inverting.
  const rad = Math.max(0, Math.min(r, hw, hh))
  ctx.beginPath()
  ctx.moveTo(-hw + rad, -hh)
  ctx.lineTo(hw - rad, -hh)
  ctx.arcTo(hw, -hh, hw, -hh + rad, rad)
  ctx.lineTo(hw, hh - rad)
  ctx.arcTo(hw, hh, hw - rad, hh, rad)
  ctx.lineTo(-hw + rad, hh)
  ctx.arcTo(-hw, hh, -hw, hh - rad, rad)
  ctx.lineTo(-hw, -hh + rad)
  ctx.arcTo(-hw, -hh, -hw + rad, -hh, rad)
  ctx.closePath()
}

function polyPath(ctx: Ctx2D, pts: [number, number][]): void {
  ctx.beginPath()
  ctx.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
  ctx.closePath()
}

/** Pointy left/right hexagon — the flowchart orientation, not the flat-top maths one. */
function hexagonPath(ctx: Ctx2D, w: number, h: number): void {
  const hw = w / 2
  const hh = h / 2
  const q = w / 4
  polyPath(ctx, [
    [-hw, 0],
    [-q, -hh],
    [q, -hh],
    [hw, 0],
    [q, hh],
    [-q, hh],
  ])
}

function trianglePath(ctx: Ctx2D, w: number, h: number): void {
  polyPath(ctx, [
    [0, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ])
}

function diamondPath(ctx: Ctx2D, w: number, h: number): void {
  polyPath(ctx, [
    [0, -h / 2],
    [w / 2, 0],
    [0, h / 2],
    [-w / 2, 0],
  ])
}

function ellipsePath(ctx: Ctx2D, w: number, h: number): void {
  ctx.beginPath()
  ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2)
  ctx.closePath()
}

/** Cylinder — a "database" shape. Body plus elliptical caps. */
function cylinderPath(ctx: Ctx2D, w: number, h: number): void {
  const hw = w / 2
  const hh = h / 2
  const ry = Math.min(h * 0.18, hw * 0.4)
  ctx.beginPath()
  ctx.moveTo(-hw, -hh + ry)
  ctx.ellipse(0, -hh + ry, hw, ry, 0, Math.PI, 0, true)
  ctx.lineTo(hw, hh - ry)
  ctx.ellipse(0, hh - ry, hw, ry, 0, 0, Math.PI)
  ctx.closePath()
}

/** Document — a rectangle with a wavy trailing edge, as used for "this is a record". */
function documentPath(ctx: Ctx2D, w: number, h: number): void {
  const hw = w / 2
  const hh = h / 2
  const wave = Math.min(h * 0.12, 14)
  const steps = 6
  ctx.beginPath()
  ctx.moveTo(-hw, -hh)
  ctx.lineTo(hw, -hh)
  ctx.lineTo(hw, hh - wave)
  for (let i = 0; i <= steps; i++) {
    const x = hw - (w * i) / steps
    const y = hh - wave + Math.sin((i / steps) * Math.PI) * wave
    ctx.lineTo(x, y)
  }
  ctx.closePath()
}

/**
 * Cloud — a thought bubble. Built from tangent arcs along the top and bottom rather than a
 * hand-placed bezier soup, which keeps the silhouette even at any size instead of going lumpy when
 * the box is wide and short.
 */
function cloudPath(ctx: Ctx2D, w: number, h: number): void {
  const bumpsTop = Math.max(3, Math.round(w / 110))
  const bumpsBottom = Math.max(2, Math.round(w / 190))
  const r = (w / bumpsTop) * 0.62
  const topY = -h / 2 + r
  const botY = h / 2 - r

  ctx.beginPath()
  ctx.moveTo(-w / 2 + r, topY)

  for (let i = 0; i < bumpsTop; i++) {
    const cx = -w / 2 + r + ((i + 0.5) * w) / bumpsTop
    const a0 = Math.PI - (i * Math.PI) / bumpsTop
    const a1 = Math.PI - ((i + 1) * Math.PI) / bumpsTop
    ctx.arc(cx, topY, r, a0, a1, true)
  }

  ctx.lineTo(w / 2 - r, botY)
  for (let i = 0; i < bumpsBottom; i++) {
    const span = (w - 2 * r) / bumpsBottom
    const cx = w / 2 - r - span * (i + 0.5)
    ctx.arc(cx, botY, r * 0.86, 0, Math.PI, false)
  }

  ctx.closePath()
}

/** Build the outline for a shape in local space. */
export function shapePath(ctx: Ctx2D, kind: ShapeKind, w: number, h: number, radius: number): void {
  switch (kind) {
    case 'rect':
      roundedRectPath(ctx, w, h, radius)
      break
    case 'pill':
      roundedRectPath(ctx, w, h, h / 2)
      break
    case 'ellipse':
      ellipsePath(ctx, w, h)
      break
    case 'diamond':
      diamondPath(ctx, w, h)
      break
    case 'triangle':
      trianglePath(ctx, w, h)
      break
    case 'hexagon':
      hexagonPath(ctx, w, h)
      break
    case 'cylinder':
      cylinderPath(ctx, w, h)
      break
    case 'cloud':
      cloudPath(ctx, w, h)
      break
    case 'document':
      documentPath(ctx, w, h)
      break
  }
}

/**
 * Hit test a shape in local space, treating it as filled.
 *
 * Tolerance grows as `1/scale` so a thin line stays clickable when zoomed out. Without this, at 10%
 * zoom every stroke is sub-pixel and the board becomes unusable exactly when you are zoomed out to
 * see the shape of the story.
 */
export function hitShapeLocal(
  kind: ShapeKind,
  w: number,
  h: number,
  radius: number,
  lx: number,
  ly: number,
  tolerance: number,
): boolean {
  if (lx >= -w / 2 - tolerance && lx <= w / 2 + tolerance && ly >= -h / 2 - tolerance && ly <= h / 2 + tolerance) {
    if (kind === 'ellipse') {
      const nx = lx / (w / 2 + tolerance)
      const ny = ly / (h / 2 + tolerance)
      return nx * nx + ny * ny <= 1
    }
    if (kind === 'diamond') {
      return Math.abs(lx) / (w / 2 + tolerance) + Math.abs(ly) / (h / 2 + tolerance) <= 1
    }
    if (kind === 'triangle') {
      // Inside the triangle via barycentric-ish half-plane test against its three edges.
      const p: [number, number][] = [
        [0, -h / 2],
        [w / 2, h / 2],
        [-w / 2, h / 2],
      ]
      return pointInPolyLocal(p, lx, ly)
    }
    if (kind === 'hexagon') {
      const q = w / 4 + tolerance
      return (
        Math.abs(lx) <= w / 2 + tolerance &&
        Math.abs(ly) <= h / 2 + tolerance &&
        w / 2 + tolerance - Math.abs(lx) + q >= h / 2 + tolerance - Math.abs(ly)
      )
    }
    // rect, pill, document, cylinder, cloud are boxy enough that the bounds test is correct.
    return true
  }
  return false
}

function pointInPolyLocal(p: [number, number][], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i]
    const [xj, yj] = p[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
