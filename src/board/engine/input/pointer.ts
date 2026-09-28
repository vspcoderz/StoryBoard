/**
 * Pointer interaction state machine.
 *
 * One explicit state machine rather than a pile of boolean flags. Dragging a selection, resizing a
 * selection, marquee-selecting, panning, drawing a shape and drawing a freehand stroke all look
 * superficially similar — press, move, release — but they have genuinely different commit rules,
 * and the bug you get from conflating them is a node committed while the user was still dragging
 * it. Making the states explicit means each one's commit rule lives in exactly one place.
 *
 * The commit rule, in one line: every interaction writes to the store's preview overlay while it is
 * in flight and writes the real document exactly once, on release.
 */

import type { Rect, Vec } from '../geometry'
import { rectFromDrag } from '../geometry'
import type { SceneStore } from '../store'
import { makeNode } from '../types'
import type { Tool } from '../tools/registry'
import { createNode, styleFor, toolDef } from '../tools/registry'
import type { Mutation } from '../mutation'
import { type HandleId, handleAt, remapRect, resizeRect, resizeRotated } from '../transform'
import { panBy, toScreen, toWorld, zoomAt } from '../viewport'
import { StrokeCapture } from './stroke'

/** Screen-pixel slop below which a drag counts as a click, not a resize or a box draw. */
const CLICK_SLOP = 4
const HANDLE_TOL = 7

type Interaction =
  | { kind: 'idle' }
  | { kind: 'pan'; last: Vec }
  | { kind: 'marquee'; start: Vec; additive: boolean; base: string[] }
  | { kind: 'move'; start: Vec; origin: Map<string, Rect>; moved: boolean }
  | {
      kind: 'resize'
      handle: HandleId
      startUnion: Rect
      origin: Map<string, Rect>
      singleId: string | null
    }
  | { kind: 'create'; start: Vec; nodeId: string; tool: Tool; moved: boolean }
  | { kind: 'draw'; capture: StrokeCapture; nodeId: string }

export interface PointerHost {
  store: SceneStore
  getTool(): Tool
  setTool(t: Tool): void
  requestRender(): void
  beginTextEdit(id: string): void
  isTextEditing(): boolean
  /**
   * The single write path. Every committed gesture goes through here rather than touching the store
   * directly, because the store is a projection of the CRDT when one is attached — a direct write
   * would render locally and then be overwritten by the next transaction, reaching nobody.
   */
  commit(m: Mutation): void
  onTransientCommitted(ids: string[]): void
  onTransientDiscarded(ids: string[]): void
}

export class PointerInput {
  private state: Interaction = { kind: 'idle' }
  private spaceDown = false
  private activePointer: number | null = null
  private hoverId: string | null = null
  private hoverHandle: HandleId | null = null
  private detach: (() => void)[] = []

  constructor(
    private el: HTMLCanvasElement,
    private host: PointerHost,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      el.addEventListener(type, fn as EventListener, opts)
      this.detach.push(() => el.removeEventListener(type, fn as EventListener, opts))
    }

    on('pointerdown', this.onDown)
    on('pointermove', this.onMove)
    on('pointerup', this.onUp)
    on('pointercancel', this.onCancel)
    on('dblclick', this.onDoubleClick)
    on('wheel', this.onWheel, { passive: false })
    on('contextmenu', this.onContextMenu)
  }

  destroy(): void {
    for (const d of this.detach) d()
    this.detach = []
  }

  setSpaceDown(down: boolean): void {
    this.spaceDown = down
    this.updateCursor()
  }

  // ------------------------------------------------------------ coordinates

  private local(e: { clientX: number; clientY: number }): Vec {
    const r = this.el.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private worldOf(e: { clientX: number; clientY: number }): Vec {
    return toWorld(this.local(e), this.host.store.viewport)
  }

  /** Selection box in screen space — where handles actually live. */
  private selectionScreenBox(): Rect | null {
    const b = this.host.store.selectionBounds()
    if (!b) return null
    const vp = this.host.store.viewport
    const a = toScreen({ x: b.x, y: b.y }, vp)
    return { x: a.x, y: a.y, w: b.w * vp.scale, h: b.h * vp.scale }
  }

  // ------------------------------------------------------------ down

  private onDown = (e: PointerEvent): void => {
    if (this.host.isTextEditing()) return
    if (e.button !== 0 && e.button !== 1) return
    this.el.setPointerCapture(e.pointerId)
    this.activePointer = e.pointerId

    const world = this.worldOf(e)
    const tool = this.host.getTool()
    const store = this.host.store

    // Pan wins over everything: middle mouse, or space held, or the hand tool. It must be checked
    // first or you cannot pan while a shape tool is active, which is the one thing you always need
    // to do mid-creation.
    if (e.button === 1 || this.spaceDown || tool.kind === 'hand') {
      this.state = { kind: 'pan', last: this.local(e) }
      this.el.style.cursor = 'grabbing'
      return
    }

    if (tool.kind === 'draw') {
      const capture = new StrokeCapture()
      capture.add(world, e.pointerType, e.pressure)
      const b = capture.bounds()
      const node = makeNode({
        type: 'draw',
        points: capture.toNormalized(),
        baseWidth: 3,
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        z: store.nextZ(),
        style: styleFor(tool),
      })
      store.addTransient(node)
      store.beginPreview()
      this.state = { kind: 'draw', capture, nodeId: node.id }
      this.host.requestRender()
      return
    }

    if (tool.kind === 'shape' || tool.kind === 'text' || tool.kind === 'sticky' || tool.kind === 'frame') {
      const node = createNode(tool, { x: world.x, y: world.y, w: 1, h: 1 }, store.nextZ())
      if (!node) return
      store.addTransient(node)
      store.beginPreview()
      this.state = { kind: 'create', start: world, nodeId: node.id, tool, moved: false }
      if (tool.kind === 'text' || tool.kind === 'sticky') {
        // Open the editor immediately. Requiring a second click to start typing is the kind of
        // friction that makes a text tool feel broken.
        this.host.beginTextEdit(node.id)
      }
      this.host.requestRender()
      return
    }

    // Select tool.
    const selBox = this.selectionScreenBox()
    if (selBox && store.selection.size > 0) {
      const h = handleAt(selBox, this.local(e), HANDLE_TOL)
      if (h) {
        const ids = [...store.selection]
        store.beginPreview()
        this.state = {
          kind: 'resize',
          handle: h.id,
          startUnion: store.selectionBounds()!,
          origin: new Map(ids.map((id) => [id, store.getBounds(id)!])),
          singleId: ids.length === 1 ? ids[0] : null,
        }
        return
      }
    }

    const hit = store.pickExact(world, this.tolerance())
    if (hit) {
      let ids: string[]
      if (e.shiftKey) {
        store.toggleSelection(hit)
        ids = [...store.selection]
        // Shift-clicking an already-selected node starts a move of the whole selection, not of the
        // clicked node alone — matching every other design tool.
      } else if (store.selection.has(hit)) {
        ids = [...store.selection]
      } else {
        store.select([hit])
        ids = [hit]
      }
      store.beginPreview()
      this.state = {
        kind: 'move',
        start: world,
        origin: new Map(ids.map((id) => [id, store.getBounds(id)!])),
        moved: false,
      }
      return
    }

    if (!e.shiftKey) store.clearSelection()
    this.state = {
      kind: 'marquee',
      start: world,
      additive: e.shiftKey,
      base: e.shiftKey ? [...store.selection] : [],
    }
  }

  // ------------------------------------------------------------ move

  private onMove = (e: PointerEvent): void => {
    const store = this.host.store

    if (this.activePointer === null) {
      // Hover feedback only — no interaction in flight.
      const world = this.worldOf(e)
      const tool = this.host.getTool()
      const nextHover = tool.kind === 'select' ? store.pickExact(world, this.tolerance()) : null
      if (nextHover !== this.hoverId) {
        this.hoverId = nextHover
        this.host.requestRender()
      }
      const box = this.selectionScreenBox()
      this.hoverHandle = box ? handleAt(box, this.local(e), HANDLE_TOL)?.id ?? null : null
      this.updateCursor()
      return
    }
    if (e.pointerId !== this.activePointer) return

    const world = this.worldOf(e)
    const s = this.state

    switch (s.kind) {
      case 'pan': {
        const p = this.local(e)
        store.setViewport(panBy(store.viewport, p.x - s.last.x, p.y - s.last.y))
        this.state = { kind: 'pan', last: p }
        return
      }
      case 'marquee': {
        const r = rectFromDrag(s.start, world)
        this.host.requestRender()
        this.setMarquee(r)
        const inside = store.inRect(r)
        store.select(s.additive ? [...new Set([...s.base, ...inside])] : inside)
        return
      }
      case 'move': {
        const dx = world.x - s.start.x
        const dy = world.y - s.start.y
        if (!s.moved && Math.hypot(dx, dy) < CLICK_SLOP / store.viewport.scale) return
        for (const [id, r] of s.origin) store.setPreview(id, { x: r.x + dx, y: r.y + dy })
        this.state = { ...s, moved: true }
        return
      }
      case 'resize': {
        this.applyResize(s, world, e.altKey)
        return
      }
      case 'create': {
        const r = rectFromDrag(s.start, world)
        if (r.w < CLICK_SLOP || r.h < CLICK_SLOP) return
        store.setPreview(s.nodeId, { x: r.x, y: r.y, w: r.w, h: r.h })
        this.state = { ...s, moved: true }
        return
      }
      case 'draw': {
        // Coalesced events give every sub-frame sample the hardware captured. On a 240Hz pen this is
        // the difference between a smooth stroke and a visibly polygonal one.
        const events =
          typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e]
        const list = events.length ? events : [e]
        let added = false
        for (const ce of list) {
          const w = toWorld(this.local(ce), store.viewport)
          if (s.capture.add(w, e.pointerType, ce.pressure)) added = true
        }
        if (!added) return
        const f = s.capture.finish()
        store.setPreview(s.nodeId, f)
        return
      }
      case 'idle':
        return
    }
  }

  private applyResize(
    s: Extract<Interaction, { kind: 'resize' }>,
    world: Vec,
    fromCenter: boolean,
  ): void {
    const store = this.host.store

    if (s.singleId) {
      const node = store.get(s.singleId)
      const r = s.origin.get(s.singleId)!
      if (!node) return
      const next = resizeRotated(r, node.rotation, s.handle, world)
      store.setPreview(s.singleId, next)
      return
    }

    const nextUnion = resizeRect(s.startUnion, s.handle, world, { fromCenter })
    for (const [id, r] of s.origin) {
      const mapped = remapRect(r, s.startUnion, nextUnion)
      store.setPreview(id, {
        x: mapped.x,
        y: mapped.y,
        w: Math.max(1, mapped.w),
        h: Math.max(1, mapped.h),
      })
    }
  }

  // ------------------------------------------------------------ up

  private onUp = (e: PointerEvent): void => this.finish(e, false)

  /**
   * A cancelled pointer is not a completed one.
   *
   * The browser fires `pointercancel` when it takes the gesture away — a palm rejection on touch, a
   * system gesture, the window losing the pointer. Committing there would drop a half-drawn shape
   * onto the board that the user never finished.
   */
  private onCancel = (e: PointerEvent): void => this.finish(e, true)

  private finish(e: PointerEvent, cancelled: boolean): void {
    if (e.pointerId !== this.activePointer) return
    this.activePointer = null
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId)

    const store = this.host.store
    const s = this.state
    this.state = { kind: 'idle' }
    this.setMarquee(null)
    this.updateCursor()

    switch (s.kind) {
      case 'move':
      case 'resize': {
        // One write, on release. Not one per pointermove.
        const patches = cancelled ? (store.cancelPreview(), []) : store.endPreview()
        this.host.commit({ type: 'update', patches })
        return
      }
      case 'create': {
        if (cancelled) {
          store.cancelPreview()
          store.discardTransient([s.nodeId])
          return
        }
        const node = store.get(s.nodeId)
        if (!node) return
        let final = node
        if (!s.moved) {
          // A click, not a drag: place at the tool's default size so a quick tap still gives you
          // a sensibly sized shape instead of a 1×1 speck. Centred on the click rather than hung
          // off its top-left, so the shape appears under the cursor where you actually aimed.
          const def = toolDef(s.tool)
          final = {
            ...node,
            x: s.start.x - def.size.w / 2,
            y: s.start.y - def.size.h / 2,
            w: def.size.w,
            h: def.size.h,
          }
        }
        store.endPreview()
        store.discardTransient([s.nodeId])
        // Committed as a create, never as an update. The node was transient, so it is not in the
        // CRDT yet; patching an id the document has never seen is silently a no-op, and the shape
        // would arrive at every collaborator as a 1x1 speck.
        this.host.commit({ type: 'create', nodes: [final] })
        this.host.onTransientCommitted([final.id])
        store.select([final.id])
        this.host.setTool({ kind: 'select' })
        return
      }
      case 'draw': {
        if (cancelled) {
          store.cancelPreview()
          store.discardTransient([s.nodeId])
          return
        }
        const node = store.get(s.nodeId)
        if (!node) return
        let final = node
        if (s.capture.length < 2) {
          // A tap with the draw tool is a single dot. Legitimate, so keep it.
          final = { ...node, ...s.capture.finish() }
        } else {
          final = { ...node, ...s.capture.finish() }
        }
        store.endPreview()
        store.discardTransient([s.nodeId])
        this.host.commit({ type: 'create', nodes: [final] })
        this.host.onTransientCommitted([final.id])
        this.host.setTool({ kind: 'select' })
        return
      }
      default:
        return
    }
  }

  private setMarquee(r: Rect | null): void {
    this.onMarquee?.(r)
  }

  /** Supplied by the editor so the renderer overlay can show the live marquee. */
  onMarquee: ((r: Rect | null) => void) | null = null

  // ------------------------------------------------------------ misc handlers

  private onDoubleClick = (e: PointerEvent | MouseEvent): void => {
    const store = this.host.store
    const hit = store.pickExact(this.worldOf(e), this.tolerance())
    if (hit) this.host.beginTextEdit(hit)
  }

  /** Hit tolerance in world units, from a fixed screen-pixel slop. */
  private tolerance(): number {
    return 6 / this.host.store.viewport.scale
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const store = this.host.store
    const local = this.local(e)
    if (e.ctrlKey || e.metaKey) {
      // Pinch on a trackpad arrives as ctrl+wheel. Exponential so each notch is a constant
      // proportional step regardless of current zoom, rather than an additive one.
      const factor = Math.exp(-e.deltaY * 0.01)
      store.setViewport(zoomAt(store.viewport, local, factor))
    } else {
      store.setViewport(panBy(store.viewport, -e.deltaX, -e.deltaY))
    }
  }

  private onContextMenu = (e: MouseEvent): void => {
    // The canvas owns its own gestures; the browser menu is never what you want mid-draw.
    e.preventDefault()
  }

  private updateCursor(): void {
    if (this.state.kind === 'pan') {
      this.el.style.cursor = 'grabbing'
      return
    }
    if (this.state.kind === 'move' || this.state.kind === 'resize') {
      const h =
        this.state.kind === 'resize'
          ? { id: this.state.handle }
          : null
      this.el.style.cursor = h ? handleCursor(h.id) : 'move'
      return
    }
    if (this.hoverHandle) {
      this.el.style.cursor = handleCursor(this.hoverHandle)
      return
    }
    this.el.style.cursor = toolDef(this.host.getTool()).cursor
  }
}

function handleCursor(id: HandleId): string {
  switch (id) {
    case 'n':
    case 's':
      return 'ns-resize'
    case 'e':
    case 'w':
      return 'ew-resize'
    case 'nw':
    case 'se':
      return 'nwse-resize'
    default:
      return 'nesw-resize'
  }
}
