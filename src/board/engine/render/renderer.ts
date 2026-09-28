/**
 * The render loop.
 *
 * Frame discipline, in priority order:
 *   1. Never set React state. This file is called from rAF, not from a render.
 *   2. Never draw a node the viewport cannot see. Cull through the spatial index first.
 *   3. Repaint only what changed. A drag marks a rect; we clip to it and redraw just that.
 *
 * Anything that touches the DOM per frame belongs to the engine, not to React.
 */

import type { Rect, Vec } from '../geometry'
import type { SceneStore } from '../store'
import type { BoardNode, DrawNode, FrameNode, GroupNode, ShapeNode, StickyNode, TextNode } from '../types'
import { nodeBounds } from '../types'
import { fitCanvas, toScreen, visibleWorldRect } from '../viewport'
import { chaikinStroke, strokeOutline } from './draw'
import { shapePath } from './shapes'
import type { Ctx2D } from '../text'
import { baselineOffset, fontString, layoutText } from '../text'

const ACCENT = '#4f46e5'
const BG = '#f7f7fb'
const GRID = '#d9d9e8'
const TEXT_PAD = 12

export type RemoteCursor = {
  id: string
  name: string
  color: string
  x: number
  y: number
  selection: string[]
}

export type OverlayState = {
  /** Live marquee rectangle, world space. */
  marquee: Rect | null
  /** Node under the cursor, for the hover ring. */
  hoverId: string | null
  remote: RemoteCursor[]
}

export class Renderer {
  private ctx: Ctx2D
  private frame = 0
  private cssW = 0
  private cssH = 0
  private overlay: OverlayState = { marquee: null, hoverId: null, remote: [] }
  /** Geometry cache for the node currently being dragged, so hit tests do not rebuild outlines. */
  private strokeCache = new Map<string, Vec[]>()

  constructor(
    private canvas: HTMLCanvasElement,
    private store: SceneStore,
  ) {
    this.ctx = canvas.getContext('2d')!
  }

  setOverlay(next: Partial<OverlayState>): void {
    this.overlay = { ...this.overlay, ...next }
    this.requestFrame()
  }

  resize(cssW: number, cssH: number): void {
    this.cssW = cssW
    this.cssH = cssH
    fitCanvas(this.canvas, cssW, cssH)
    this.store.markDirty(null)
    this.requestFrame()
  }

  requestFrame(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.draw()
    })
  }

  // ------------------------------------------------------------ frame

  private draw(): void {
    const ctx = fitCanvas(this.canvas, this.cssW, this.cssH) as CanvasRenderingContext2D
    const { all, rect } = this.store.consumeDirty()
    const vp = this.store.viewport

    ctx.save()
    if (!all && rect) {
      const a = toScreen({ x: rect.x, y: rect.y }, vp)
      const b = toScreen({ x: rect.x + rect.w, y: rect.y + rect.h }, vp)
      ctx.beginPath()
      ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y)
      ctx.clip()
    }

    ctx.fillStyle = BG
    ctx.fillRect(0, 0, this.cssW, this.cssH)

    this.drawGrid(ctx, vp)

    // Cull against a slightly inflated view rect so nodes entering the screen are never one
    // frame late — a node that pops in a beat after it should have appeared looks like a bug.
    const pad = 64 / vp.scale
    const view = visibleWorldRect(vp, this.cssW, this.cssH)
    const cull = { x: view.x - pad, y: view.y - pad, w: view.w + pad * 2, h: view.h + pad * 2 }
    const visibleIds = new Set(this.store.inRect(cull))

    const nodes = this.store.ordered()
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      if (!visibleIds.has(n.id)) continue
      this.drawNode(ctx, n, vp)
    }

    ctx.restore()

    // Overlays are drawn unclipped: a selection ring that extends past the dirty rect must still
    // appear, otherwise dragging feels like the selection is falling apart.
    ctx.save()
    this.drawOverlays(ctx, vp)
    ctx.restore()
  }

  // ------------------------------------------------------------ background

  private drawGrid(ctx: Ctx2D, vp: { x: number; y: number; scale: number }): void {
    // Step through a power-of-two ladder so dot density stays constant as you zoom, instead of
    // the grid becoming a solid grey wash when zoomed out.
    let step = 20
    while (step * vp.scale < 18) step *= 2
    while (step * vp.scale > 90) step /= 2

    const view = visibleWorldRect(vp, this.cssW, this.cssH)
    const x0 = Math.floor(view.x / step) * step
    const y0 = Math.floor(view.y / step) * step
    const r = Math.max(0.6, 1.1 * Math.min(vp.scale, 2))

    ctx.fillStyle = GRID
    for (let wx = x0; wx < view.x + view.w; wx += step) {
      for (let wy = y0; wy < view.y + view.h; wy += step) {
        const p = toScreen({ x: wx, y: wy }, vp)
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  // ------------------------------------------------------------ nodes

  private drawNode(ctx: Ctx2D, n: BoardNode, vp: { x: number; y: number; scale: number }): void {
    const screen = toScreen({ x: n.x, y: n.y }, vp)

    ctx.save()
    ctx.globalAlpha = n.opacity
    ctx.translate(screen.x, screen.y)
    ctx.scale(vp.scale, vp.scale)
    ctx.translate(n.w / 2, n.h / 2)
    if (n.rotation) ctx.rotate(n.rotation)

    switch (n.type) {
      case 'shape':
        this.drawShape(ctx, n)
        break
      case 'text':
        this.drawTextNode(ctx, n)
        break
      case 'sticky':
        this.drawSticky(ctx, n)
        break
      case 'draw':
        this.drawFreehand(ctx, n)
        break
      case 'frame':
        this.drawFrame(ctx, n)
        break
      case 'group':
        this.drawGroupOutline(ctx, n)
        break
    }
    ctx.restore()
  }

  private drawShape(ctx: Ctx2D, n: ShapeNode): void {
    shapePath(ctx, n.shape, n.w, n.h, n.style.radius)
    const s = n.style
    if (s.fill) {
      ctx.fillStyle = s.fill
      ctx.fill()
    }
    if (s.stroke && s.strokeWidth > 0) {
      ctx.strokeStyle = s.stroke
      ctx.lineWidth = s.strokeWidth
      ctx.setLineDash(s.dash ?? [])
      ctx.stroke()
      ctx.setLineDash([])
    }
    // A shape's label is centred and non-wrapping-outside-the-box, the way a flowchart node reads.
    // `asBlock: false` means the label is not clipped, so a long label overflows rather than
    // silently vanishing — visible overflow is recoverable, invisible text is not.
    if (n.text) this.paintText(ctx, n.text, s, n.w, n.h, false, false)
  }

  private drawTextNode(ctx: Ctx2D, n: TextNode): void {
    this.paintText(ctx, n.text, n.style, n.w, n.h, n.autoHeight, n.type === 'text')
  }

  private drawSticky(ctx: Ctx2D, n: StickyNode): void {
    const s = n.style
    ctx.save()
    ctx.shadowColor = 'rgba(15, 12, 60, 0.18)'
    ctx.shadowBlur = 12
    ctx.shadowOffsetY = 3
    shapePath(ctx, 'rect', n.w, n.h, Math.min(4, s.radius))
    if (s.fill) {
      ctx.fillStyle = s.fill
      ctx.fill()
    }
    ctx.restore()
    if (s.stroke) {
      ctx.strokeStyle = s.stroke
      ctx.lineWidth = 1
      ctx.stroke()
    }
    this.paintText(ctx, n.text, { ...s, align: 'left', valign: 'top' }, n.w, n.h, true, true)
  }

  private drawFrame(ctx: Ctx2D, n: FrameNode): void {
    const s = n.style
    ctx.fillStyle = s.fill ?? 'rgba(255,255,255,0.55)'
    ctx.fillRect(-n.w / 2, -n.h / 2, n.w, n.h)
    if (s.stroke) {
      ctx.strokeStyle = s.stroke
      ctx.lineWidth = s.strokeWidth
      ctx.setLineDash([6, 4])
      ctx.strokeRect(-n.w / 2, -n.h / 2, n.w, n.h)
      ctx.setLineDash([])
    }
    // Label sits above the frame, not inside it, so it never competes with the content.
    ctx.font = fontString({ ...s, fontSize: Math.max(11, s.fontSize) })
    ctx.fillStyle = s.color
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(n.title, -n.w / 2, -n.h / 2 - 8)
  }

  private drawGroupOutline(ctx: Ctx2D, n: GroupNode): void {
    ctx.strokeStyle = '#9c9ce0'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.strokeRect(-n.w / 2, -n.h / 2, n.w, n.h)
    ctx.setLineDash([])
  }

  private drawFreehand(ctx: Ctx2D, n: DrawNode): void {
    if (n.points.length === 0) return
    // Denormalize to local space, then smooth position and pressure together. Smoothing happens in
    // local units, so the stroke's character does not change as you zoom.
    const raw = n.points.map((p) => ({
      x: (p.x - 0.5) * n.w,
      y: (p.y - 0.5) * n.h,
      p: p.p,
    }))
    const pts = chaikinStroke(raw, 2)
    this.strokeCache.set(n.id, pts)

    const outline = strokeOutline(pts, n.baseWidth * (n.style.strokeWidth || 1))
    if (outline.length < 3) return

    ctx.beginPath()
    ctx.moveTo(outline[0].x, outline[0].y)
    for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i].x, outline[i].y)
    ctx.closePath()
    ctx.fillStyle = n.style.color
    ctx.fill()
  }

  /**
   * Shared text painting for shape labels, text nodes and stickies.
   *
   * `asBlock` distinguishes an editable text box (clips to its bounds) from a shape label (which
   * just centres what it has, the way a flowchart node does).
   */
  private paintText(
    ctx: Ctx2D,
    text: string,
    style: import('../types').Style,
    w: number,
    h: number,
    autoHeight: boolean,
    asBlock: boolean,
  ): void {
    if (!text) return
    const boxW = asBlock ? Math.max(0, w - TEXT_PAD * 2) : Math.max(0, w)
    const boxH = asBlock ? Math.max(0, h - TEXT_PAD * 2) : h
    const layout = layoutText(ctx, text, style, boxW, boxH, autoHeight)
    if (layout.lines.length === 0) return

    ctx.font = fontString(style)
    ctx.fillStyle = style.color
    ctx.textBaseline = 'alphabetic'

    let ox = 0
    if (style.align === 'center') ox = 0
    else if (style.align === 'right') ox = w / 2 - boxW
    else ox = -w / 2 + TEXT_PAD

    let oy = 0
    if (style.valign === 'middle') oy = -Math.min(layout.height, boxH) / 2
    else if (style.valign === 'bottom') oy = h / 2 - boxH - layout.height + layout.lineHeight
    else oy = -h / 2 + TEXT_PAD

    const baseline = baselineOffset(style, layout.lineHeight)
    const nLines = asBlock ? Math.max(1, Math.floor((boxH + baseline) / layout.lineHeight)) : layout.lines.length
    for (let i = 0; i < Math.min(layout.lines.length, nLines); i++) {
      const line = layout.lines[i]
      const wLine = ctx.measureText(line).width
      let lx = ox
      if (style.align === 'center') lx = -wLine / 2
      else if (style.align === 'right') lx = w / 2 - TEXT_PAD - wLine
      ctx.fillText(line, lx, oy + i * layout.lineHeight + baseline)
    }
  }

  // ------------------------------------------------------------ overlays

  private drawOverlays(ctx: Ctx2D, vp: { x: number; y: number; scale: number }): void {
    const sel = this.store.selection
    const selRect = this.store.selectionBounds()

    if (this.overlay.hoverId && !sel.has(this.overlay.hoverId)) {
      const n = this.store.get(this.overlay.hoverId)
      if (n) this.ring(ctx, nodeBounds(n), vp, '#b4b4e8', 1)
    }

    if (sel.size > 0 && selRect) {
      ctx.save()
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 1.5
      // Screen-constant outline. Scaling the stroke with the zoom makes the selection ring vanish
      // when zoomed out, which reads as "the app lost my selection".
      const size = 8
      for (const id of sel) {
        const n = this.store.get(id)
        if (n) this.ring(ctx, nodeBounds(n), vp, ACCENT, 1.5 / vp.scale)
      }
      // One transform frame around the whole selection.
      const a = toScreen({ x: selRect.x, y: selRect.y }, vp)
      const b = toScreen({ x: selRect.x + selRect.w, y: selRect.y + selRect.h }, vp)
      const corners: Vec[] = [
        { x: a.x, y: a.y },
        { x: b.x, y: a.y },
        { x: b.x, y: b.y },
        { x: a.x, y: b.y },
      ]
      for (const c of corners) {
        ctx.fillStyle = '#ffffff'
        ctx.strokeStyle = ACCENT
        ctx.beginPath()
        ctx.rect(c.x - size / 2, c.y - size / 2, size, size)
        ctx.fill()
        ctx.stroke()
      }
      ctx.restore()
    }

    for (const r of this.overlay.remote) {
      const p = toScreen({ x: r.x, y: r.y }, vp)
      ctx.save()
      ctx.fillStyle = r.color
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(p.x + 11, p.y + 4)
      ctx.lineTo(p.x + 4.5, p.y + 5.5)
      ctx.lineTo(p.x + 3, p.y + 12)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()

      ctx.font = '500 11px ui-sans-serif, system-ui, sans-serif'
      const w = ctx.measureText(r.name).width
      ctx.fillStyle = r.color
      ctx.beginPath()
      ctx.roundRect(p.x + 12, p.y + 10, w + 12, 18, 4)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.fillText(r.name, p.x + 18, p.y + 23)
      ctx.restore()
    }

    const m = this.overlay.marquee
    if (m) {
      const a = toScreen({ x: m.x, y: m.y }, vp)
      const b = toScreen({ x: m.x + m.w, y: m.y + m.h }, vp)
      ctx.save()
      ctx.fillStyle = 'rgba(79, 70, 229, 0.08)'
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 1
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y)
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)
      ctx.restore()
    }
  }

  private ring(
    ctx: Ctx2D,
    r: Rect,
    vp: { x: number; y: number; scale: number },
    color: string,
    lineWidth: number,
  ): void {
    const a = toScreen({ x: r.x, y: r.y }, vp)
    const b = toScreen({ x: r.x + r.w, y: r.y + r.h }, vp)
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = lineWidth
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)
    ctx.restore()
  }

  /** Exposed so the input layer can hit-test without duplicating the maths. */
  hitTest(p: Vec): string | null {
    return this.store.pick(p)
  }

  strokeOf(id: string): Vec[] | undefined {
    return this.strokeCache.get(id)
  }
}
