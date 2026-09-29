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
import { anchorFor, bestSide } from '../connector'
import type { Guide } from '../snap'
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

/** Union of the original rects of a multi-node drag — the box that gets snapped as a unit. */
function unionOf(origin: Map<string, Rect>): Rect {
  const rects = [...origin.values()]
  let x = Infinity
  let y = Infinity
  let r = -Infinity
  let b = -Infinity
  for (const q of rects) {
    x = Math.min(x, q.x)
    y = Math.min(y, q.y)
    r = Math.max(r, q.x + q.w)
    b = Math.max(b, q.y + q.h)
  }
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  return { x, y, w: r - x, h: b - y }
}

/** World position of one end of a connector, for deciding which side a re-bind should use. */
function worldOf(connectorId: string, store: SceneStore, end: 'from' | 'to'): Vec {
  const pts = store.connectorPath(connectorId)
  if (pts.length === 0) return { x: 0, y: 0 }
  return end === 'from' ? pts[0] : pts[pts.length - 1]
}

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
  /**
   * Dragging out a connector.
   *
   * `fromId` is the node the line started on (null when started on empty canvas), and `toId` is
   * whatever is under the cursor *now*. The connector is transient and unbound at the ends until
   * release, so a half-drawn connector costs zero CRDT writes — same rule as every other gesture.
   */
  | {
      kind: 'connector'
      start: Vec
      nodeId: string
      fromId: string | null
      toId: string | null
    }
  /**
   * Dragging one end of an existing connector to re-aim or re-bind it.
   *
   * Separate from `connector` because the commit differs: a new connector is a create, this is an
   * update of two fields. Conflating them would make dragging an endpoint look like it duplicated
   * the line.
   */
  | { kind: 'connectorEnd'; connectorId: string; end: 'from' | 'to'; start: Vec }

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
  /** Alignment guides to draw for the gesture in flight. */
  setGuides(guides: Guide[]): void
  /** The route of a connector currently being dragged out, for the pending preview. */
  onPendingConnector(pts: Vec[] | null): void
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

    // The connector tool grabs whatever is under the cursor and drags a line from it. Started on
    // empty canvas it still works — it just starts unbound, which is how you draw a free line.
    if (tool.kind === 'connector') {
      const hit = store.pickExact(world, this.tolerance())
      const fromId = hit && store.get(hit)?.type !== 'connector' ? hit : null
      const node = makeNode({
        type: 'connector',
        fromId,
        toId: null,
        fromSide: null,
        toSide: null,
        startArrow: false,
        endArrow: true,
        route: 'orthogonal',
        label: '',
        edgeKind: null,
        // Bounds are meaningless for a connector — the store keeps them as the route's bounding box
        // so the spatial index can still cull it. Seeded at the pointer so the initial query works.
        x: world.x,
        y: world.y,
        w: 1,
        h: 1,
        z: store.nextZ(),
        style: styleFor(tool),
      })
      store.addTransient(node)
      store.beginPreview()
      this.state = { kind: 'connector', start: world, nodeId: node.id, fromId, toId: null }
      this.host.requestRender()
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
      // A connector's ends are grabbable well before its line is. Thin-line picking alone makes
      // re-aiming an arrow almost impossible, which is the whole point of having endpoints.
      const grabbedEnd = this.connectorEndAt(world, store, e.shiftKey)
      if (grabbedEnd) {
        store.beginPreview()
        this.state = {
          kind: 'connectorEnd',
          connectorId: grabbedEnd.connectorId,
          end: grabbedEnd.end,
          start: world,
        }
        return
      }
      const h = handleAt(selBox, this.local(e), HANDLE_TOL)
      // A connector's handles are not drawn, and must not be grabbable either: a resize would be
      // reverted the moment the route is re-derived, which looks like the app ignoring you.
      if (h && !this.onlyConnectorsSelected(store)) {
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
        this.onHover(nextHover)
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
        this.setMarquee(r)
        const inside = store.inRect(r)
        store.select(s.additive ? [...new Set([...s.base, ...inside])] : inside)
        return
      }
      case 'move': {
        const dx = world.x - s.start.x
        const dy = world.y - s.start.y
        if (!s.moved && Math.hypot(dx, dy) < CLICK_SLOP / store.viewport.scale) return
        // Snap the whole selection as one box, not each node separately. Snapping per node would let
        // members of a group pull against each other and tear the selection apart.
        const raw = unionOf(s.origin)
        const moved = { ...raw, x: raw.x + dx, y: raw.y + dy }
        const snapped = store.snap(moved, s.origin.keys(), store.viewport.scale)
        this.host.setGuides(snapped.guides)
        const ax = snapped.rect.x - raw.x
        const ay = snapped.rect.y - raw.y
        for (const [id, r] of s.origin) store.setPreview(id, { x: r.x + dx + ax, y: r.y + dy + ay })
        this.state = { ...s, moved: true }
        this.host.requestRender()
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
      case 'connector': {
        // Re-resolve the far end every frame so the preview tracks whatever is under the cursor,
        // including grabbing a node that was not there when the drag started.
        const over = store.pickExact(world, this.tolerance())
        const toId = over && over !== s.fromId && store.get(over)?.type !== 'connector' ? over : null
        if (toId !== s.toId) this.state = { ...s, toId }
        this.host.onPendingConnector(this.pendingRoute(s, world))
        this.host.requestRender()
        return
      }
      case 'connectorEnd': {
        const over = store.pickExact(world, this.tolerance())
        const c = store.get(s.connectorId)
        if (!c || c.type !== 'connector') return
        const otherId = s.end === 'from' ? c.toId : c.fromId
        const targetId = over && over !== otherId && over !== s.connectorId ? over : null
        if (targetId) {
          // Dropping onto a node re-binds it and pins the side, so the arrow stays put even if the
          // node later moves. Dropping on empty canvas unpins and lets the route float.
          const targetBounds = store.getBounds(targetId)
          const side = targetBounds
            ? bestSide(targetBounds, worldOf(s.connectorId, store, s.end))
            : null
          store.setPreview(
            s.connectorId,
            s.end === 'from'
              ? { fromId: targetId, fromSide: side }
              : { toId: targetId, toSide: side },
          )
        } else {
          store.setPreview(s.connectorId, s.end === 'from' ? { fromId: null, fromSide: null } : { toId: null, toSide: null })
        }
        this.host.requestRender()
        return
      }
      case 'idle':
        return
    }
  }

  /** Is the whole selection connectors? Such a selection has no meaningful resize gesture. */
  private onlyConnectorsSelected(store: SceneStore): boolean {
    if (store.selection.size === 0) return false
    for (const id of store.selection) {
      if (store.get(id)?.type !== 'connector') return false
    }
    return true
  }

  /**
   * The dashed route shown while dragging a connector out.
   *
   * When the far end is over a real node we route against that node, so the preview is exactly the
   * line you will get. When it is over empty canvas we draw a straight hint to the cursor — there is
   * nothing to route against yet, and a fake elbow to nowhere would imply a binding that is not
   * there. The store's connectorPath cannot help here because the far end is not yet a node.
   */
  private pendingRoute(s: Extract<Interaction, { kind: 'connector' }>, world: Vec): Vec[] {
    const store = this.host.store
    if (!s.fromId) return [s.start, world]
    const fromBounds = store.getBounds(s.fromId)
    if (!fromBounds) return [s.start, world]
    const fromSide = bestSide(fromBounds, world)
    const from = anchorFor(fromBounds, fromSide)
    return [from.point, world]
  }

  /**
   * Which connector end, if any, is under the pointer.
   *
   * Only considers the *selected* connectors when a selection exists, because grabbing a line you
   * have not selected is disorienting — you click near an arrow belonging to something else and
   * start dragging it. With no selection, all connectors are fair game, since there is no ambiguity
   * about what you meant.
   *
   * Requires both ends bound: an unbound end has no fixed position to grab.
   */
  private connectorEndAt(
    world: Vec,
    store: SceneStore,
    additive: boolean,
  ): { connectorId: string; end: 'from' | 'to' } | null {
    const tol = this.tolerance() * 1.5
    const pool =
      store.selection.size > 0 && !additive ? [...store.selection] : store.connectorIds()
    let best: { connectorId: string; end: 'from' | 'to'; d: number } | null = null
    for (const id of pool) {
      const c = store.get(id)
      if (!c || c.type !== 'connector' || !c.fromId || !c.toId) continue
      const pts = store.connectorPath(id)
      if (pts.length < 2) continue
      for (const end of ['from', 'to'] as const) {
        const p = end === 'from' ? pts[0] : pts[pts.length - 1]
        const d = Math.hypot(p.x - world.x, p.y - world.y)
        if (d <= tol && (!best || d < best.d)) best = { connectorId: id, end, d }
      }
    }
    return best ? { connectorId: best.connectorId, end: best.end } : null
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

  /** Called on Escape and on window blur, so a gesture can never get stuck in flight. */
  abort(): void {
    if (this.state.kind === 'idle') return
    this.state = { kind: 'idle' }
    this.host.setGuides([])
    this.host.onPendingConnector(null)
    this.host.store.cancelPreview()
    this.host.setTool({ kind: 'select' })
    this.updateCursor()
    this.host.requestRender()
  }

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
        // Guides belong to the gesture, so they go when it does. Left up, the board would keep
        // showing alignment lines for a drag that finished seconds ago.
        this.host.setGuides([])
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
        const final = { ...node, ...s.capture.finish() }
        store.endPreview()
        store.discardTransient([s.nodeId])
        this.host.commit({ type: 'create', nodes: [final] })
        this.host.onTransientCommitted([final.id])
        this.host.setTool({ kind: 'select' })
        return
      }
      case 'connector': {
        this.host.onPendingConnector(null)
        if (cancelled) {
          store.cancelPreview()
          store.discardTransient([s.nodeId])
          return
        }
        const node = store.get(s.nodeId)
        if (!node || node.type !== 'connector') return
        // A connector with neither end bound is a line to nowhere. Committing it would leave an
        // invisible orphan in the document, every layer list and export, so drop it instead.
        if (!node.fromId && !node.toId) {
          store.cancelPreview()
          store.discardTransient([s.nodeId])
          return
        }
        store.endPreview()
        store.discardTransient([s.nodeId])
        const bound = node.type === 'connector' ? { ...node, toId: s.toId } : node
        this.host.commit({ type: 'create', nodes: [bound] })
        this.host.onTransientCommitted([node.id])
        store.select([node.id])
        this.host.setTool({ kind: 'select' })
        return
      }
      case 'connectorEnd': {
        // One update, on release — the endpoints were previewed, never written.
        const patches = cancelled ? (store.cancelPreview(), []) : store.endPreview()
        this.host.commit({ type: 'update', patches })
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
  /** Hover reporting, assigned by the editor. A callback rather than a host method because hover is
   *  presentation-only: the pointer has no business knowing that a hover ring exists. */
  onHover: (id: string | null) => void = () => {}

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
