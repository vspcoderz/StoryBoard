/**
 * Connector drawing.
 *
 * Separate from the renderer because it is self-contained geometry — a path, an arrowhead, a label —
 * and keeping it out of `renderer.ts` means the elbow maths and the pixel maths can be reasoned about
 * separately. It is also the one place where a subtle mistake is invisible until someone looks for
 * it: an arrowhead drawn on the wrong end, or scaled by zoom so it vanishes when zoomed out.
 *
 * Arrowheads are sized in *screen* pixels and divided by zoom, so they stay legible at every scale.
 * Scaling them with the world is the classic bug — they turn into specks at low zoom and absurd
 * slabs at high zoom.
 */

import type { Ctx2D } from '../text'
import { fontString } from '../text'
import type { Vec } from '../geometry'
import { normalize, sub } from '../geometry'
import type { Style } from '../types'
import type { Theme } from '../theme'
import { alpha } from '../theme'

export const ARROW_SIZE = 9

/** The point at the end of the path closest to the tip, for arrowhead orientation. */
function lastDirection(pts: Vec[]): Vec {
  if (pts.length < 2) return { x: 1, y: 0 }
  return normalize(sub(pts[pts.length - 1], pts[pts.length - 2]))
}

function firstDirection(pts: Vec[]): Vec {
  if (pts.length < 2) return { x: -1, y: 0 }
  return normalize(sub(pts[1], pts[0]))
}

/**
 * Draw a filled triangular arrowhead at `tip`, pointing along `dir`.
 *
 * `size` is in world units — the caller divides a screen-pixel size by zoom to get here, so the
 * arrowhead is the same visual size regardless of zoom level.
 */
export function drawArrowhead(ctx: Ctx2D, tip: Vec, dir: Vec, size: number): void {
  const back = { x: tip.x - dir.x * size, y: tip.y - dir.y * size }
  // Half-width perpendicular to the direction, so the head is a proper isoceles triangle.
  const n = { x: -dir.y * size * 0.45, y: dir.x * size * 0.45 }
  ctx.beginPath()
  ctx.moveTo(tip.x, tip.y)
  ctx.lineTo(back.x + n.x, back.y + n.y)
  ctx.lineTo(back.x - n.x, back.y - n.y)
  ctx.closePath()
  ctx.fill()
}

/** Stroke a polyline. No arrowheads, no label — the reusable core. */
export function drawPath(ctx: Ctx2D, pts: Vec[], style: Style): void {
  if (pts.length === 0) return
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  if (style.stroke) {
    ctx.strokeStyle = style.stroke
    ctx.lineWidth = style.strokeWidth
    ctx.setLineDash(style.dash ?? [])
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke()
    ctx.setLineDash([])
  }
}

/** Centre of the longest segment, which is where a label has room to sit. */
function labelAnchor(pts: Vec[]): Vec {
  if (pts.length === 0) return { x: 0, y: 0 }
  if (pts.length === 1) return pts[0]
  let bestLen = -1
  let at = pts[0]
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    if (l > bestLen) {
      bestLen = l
      at = { x: (pts[i].x + pts[i - 1].x) / 2, y: (pts[i].y + pts[i - 1].y) / 2 }
    }
  }
  return at
}

export type ConnectorPaint = {
  pts: Vec[]
  style: Style
  startArrow: boolean
  endArrow: boolean
  label: string
  /** Screen pixels per world unit, so text and arrowheads keep a constant on-screen size. */
  scale: number
  theme: Theme
  selected: boolean
}

/**
 * Draw a whole connector: line, arrowheads, then the label knocked out of the line behind it.
 *
 * The label background matters more than it looks. Without it, a label sitting on a long connector is
 * unreadable — the line runs straight through the text. Knocking out a small filled rect behind the
 * text is what every diagram tool does and it is why they are readable.
 */
export function drawConnector(ctx: Ctx2D, paint: ConnectorPaint): void {
  const { pts, style, scale, theme } = paint
  if (pts.length === 0) return

  const colour = paint.selected ? theme.brass : (style.stroke ?? theme.graphite)

  drawPath(ctx, pts, { ...style, stroke: colour })

  const head = ARROW_SIZE / Math.max(scale, 0.0001)
  ctx.fillStyle = colour
  if (paint.endArrow) {
    const tip = pts[pts.length - 1]
    drawArrowhead(ctx, tip, lastDirection(pts), head)
  }
  if (paint.startArrow) {
    const tip = pts[0]
    drawArrowhead(ctx, tip, firstDirection(pts), head)
  }

  if (paint.label) {
    // Drawn in screen-sized text: divide the size by zoom so it does not scale with the world.
    const fontSize = Math.max(10, style.fontSize) / Math.max(scale, 0.0001)
    const font = fontString({ ...style, fontSize })
    ctx.font = font
    const w = ctx.measureText(paint.label).width
    const padX = 4 / Math.max(scale, 0.0001)
    const at = labelAnchor(pts)
    ctx.save()
    // Knock the line out from behind the label so the text stays legible.
    ctx.fillStyle = theme.sheet
    ctx.fillRect(at.x - w / 2 - padX, at.y - fontSize * 0.85, w + padX * 2, fontSize * 1.25)
    ctx.fillStyle = style.color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(paint.label, at.x, at.y)
    ctx.restore()
  }
}

/**
 * A translucent preview of the route being dragged out, before either end is committed.
 *
 * `pts` are in *screen* space and `scale` is the current zoom, because overlays are drawn after the
 * viewport transform has been popped. Passing the zoom lets the dash pattern and arrowhead stay a
 * constant size on screen instead of shrinking to nothing when zoomed out.
 */
export function drawPendingConnector(
  ctx: Ctx2D,
  pts: Vec[],
  style: Style,
  theme: Theme,
  scale = 1,
): void {
  if (pts.length < 2) return
  const dash = [6 / Math.max(scale, 0.0001), 4 / Math.max(scale, 0.0001)]
  drawPath(ctx, pts, {
    ...style,
    stroke: alpha(theme.brass, 0.8),
    strokeWidth: 2 / Math.max(scale, 0.0001),
    dash,
  })
  ctx.fillStyle = alpha(theme.brass, 0.8)
  drawArrowhead(ctx, pts[pts.length - 1], lastDirection(pts), ARROW_SIZE * 0.8)
}
