/**
 * Editor orchestrator.
 *
 * Owns the store, the renderer, pointer input, the text overlay and the keyboard map, and is the
 * only thing React talks to. React never reaches into the store mid-frame; it asks for coarse state
 * and subscribes to coarse events.
 *
 * Every mutation goes through one function, `mutate`. That indirection is the whole point: with a
 * collab bridge attached, `mutate` writes to the CRDT and the store is re-derived from it; without
 * one, it writes to the store directly. Same call sites either way, so the local-only path cannot
 * quietly diverge from the collaborative one.
 *
 * Undo has two implementations behind one method. With a bridge it is `Y.UndoManager`, which knows
 * which transactions were mine and will refuse to revert a collaborator's. Without one it falls back
 * to whole-scene snapshots — correct for a single user, and honest about its limits: it is
 * O(whole scene) per step and it cannot tell my edits from anyone else's.
 */

import { PointerInput } from './input/pointer'
import { TextEditor, isTextEditable } from './input/textEditor'
import { applyMutation, type Mutation } from './mutation'
import { Renderer, type OverlayState } from './render/renderer'
import { snapshot, restore } from './serialize'
import { SceneStore } from './store'
import { toolByKey, type Tool } from './tools/registry'
import { makeNode, DEFAULT_STYLE, newId, type BoardNode, type Style } from './types'
import { rectUnionAll } from './geometry'
import { zoomAt, toWorld, type Viewport } from './viewport'
import { initTheme } from './theme'
import { YDocBridge, type BridgeStatus } from '../collab/ydoc'
import { connect as connectCollab, watchStatus } from '../collab/provider'
import { PresenceChannel } from '../collab/presence'

const HISTORY_LIMIT = 100

export type EditorEvents = {
  tool: (tool: Tool) => void
  selection: (ids: string[]) => void
  stats: (stats: { nodes: number; zoom: number }) => void
  status: (status: BridgeStatus) => void
}

export class Editor {
  readonly store = new SceneStore()
  readonly renderer: Renderer
  readonly pointer: PointerInput
  readonly textEditor: TextEditor

  private tool: Tool = { kind: 'select' }
  private mutate: (m: Mutation) => void
  private bridge: YDocBridge | null = null
  private history: string[] = []
  private future: string[] = []
  private clipboard: BoardNode[] = []
  private overlay: OverlayState = {
    marquee: null,
    hoverId: null,
    remote: [],
    guides: [],
    pendingConnector: null,
  }
  private listeners: { [K in keyof EditorEvents]: Set<EditorEvents[K]> } = {
    tool: new Set(),
    selection: new Set(),
    stats: new Set(),
    status: new Set(),
  }
  private disposers: (() => void)[] = []
  private statsTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private canvas: HTMLCanvasElement,
    private container: HTMLElement,
  ) {
    this.renderer = new Renderer(canvas, this.store)
    this.mutate = (m) => applyMutation(this.store, m)

    this.textEditor = new TextEditor(
      container,
      this.store,
      () => this.store.viewport,
      (id, text) => this.onTextChange(id, text),
      () => this.onTextDone(),
    )

    this.pointer = new PointerInput(canvas, {
      store: this.store,
      getTool: () => this.tool,
      setTool: (t) => this.setTool(t),
      requestRender: () => this.requestRender(),
      beginTextEdit: (id) => this.textEditor.open(id),
      isTextEditing: () => this.textEditor.isOpen,
      setGuides: (guides) => {
        this.overlay.guides = guides
        this.renderer.setOverlay({ guides })
        if (guides.length > 0) this.requestRender()
      },
      onPendingConnector: (pts) => {
        this.overlay.pendingConnector = pts
        this.renderer.setOverlay({ pendingConnector: pts })
      },
      commit: (m) => {
        // Undo point first, then mutate — see pushHistory. On the create path the node is still
        // transient here, so it is correctly excluded from the captured snapshot.
        this.pushHistory()
        this.mutate(m)
      },
      // The node just landed via commit above, which already pushed the undo point. Pushing again
      // would add a second, redundant entry and make one undo appear to do nothing.
      onTransientCommitted: () => {},
      onTransientDiscarded: () => {},
    })
    // The hover ring was computed by the pointer but never handed to the renderer, so the ring in
    // `drawOverlays` was unreachable. One line, and it is the difference between a board that feels
    // alive and one where you cannot tell what you are about to grab.
    this.pointer.onHover = (id) => {
      this.overlay.hoverId = id
      this.renderer.setOverlay({ hoverId: id })
    }
    this.pointer.onMarquee = (r) => {
      this.overlay.marquee = r
      this.renderer.setOverlay({ marquee: r })
    }
    // Report my cursor for presence, in world coordinates — the renderer draws remote cursors
    // through the viewport transform, so a normalised screen position would land somewhere else
    // entirely for anyone at a different zoom. Throttled downstream, so per-move is safe; a timer
    // would instead lag visibly behind the real pointer.
    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect()
      const p = toWorld({ x: e.clientX - r.left, y: e.clientY - r.top }, this.store.viewport)
      this.reportCursor(p.x, p.y)
    })

    this.disposers.push(
      this.store.on((ev) => {
        if (ev === 'selection') {
          this.selDirty = true
          const ids = [...this.store.selection]
          this.reportSelection(ids)
          for (const fn of this.listeners.selection) fn(ids)
        }
        if (ev === 'viewport') {
          this.statsDirty = true
          this.textEditor.layout()
        }
        if (ev === 'change') this.statsDirty = true
        this.requestRender()
        this.scheduleStats()
      }),
    )

    const onKey = (e: KeyboardEvent) => this.onKeyDown(e)
    const onKeyUp = (e: KeyboardEvent) => this.onKeyUp(e)
    const onResize = () => this.resize()
    const onFocus = () => this.container.focus()
    // Space is the pan modifier, and a keyup missed while the window is unfocused leaves it stuck
    // down — after which *every* drag pans the board and nothing on it can be moved. Losing focus
    // always releases it.
    const onBlur = () => this.pointer.setSpaceDown(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onBlur)
    canvas.addEventListener('pointerdown', onFocus)
    this.disposers.push(() => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onBlur)
      canvas.removeEventListener('pointerdown', onFocus)
    })

    // Re-read the palette and repaint when the system appearance flips, so the canvas follows the
    // system rather than freezing at whatever it saw on first paint.
    this.disposers.push(
      initTheme(() => {
        this.store.markDirty(null)
        this.requestRender()
      }),
    )

    this.resize()
  }

  // ------------------------------------------------------------ lifecycle

  destroy(): void {
    this.pointer.destroy()
    this.bridge?.destroy()
    for (const d of this.disposers) d()
    this.disposers = []
    if (this.statsTimer) clearTimeout(this.statsTimer)
  }

  private resize(): void {
    const r = this.container.getBoundingClientRect()
    this.renderer.resize(r.width, r.height)
  }

  requestRender(): void {
    this.renderer.requestFrame()
  }

  private scheduleStats(): void {
    if (this.statsTimer) return
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null
      for (const fn of this.listeners.stats) {
        fn({ nodes: this.store.size, zoom: this.store.viewport.scale })
      }
    }, 120)
  }

  // ------------------------------------------------------------ events

  on<K extends keyof EditorEvents>(ev: K, fn: EditorEvents[K]): () => void {
    this.listeners[ev].add(fn)
    return () => this.listeners[ev].delete(fn)
  }

  /**
   * Cached snapshots for `useSyncExternalStore`.
   *
   * React compares snapshots by identity and re-renders forever if `getSnapshot` returns a fresh
   * object or array on every call. So each caches its value and only rebuilds when the underlying
   * state actually changed. A stable reference is not an optimisation here — it is the difference
   * between working and an infinite render loop.
   */
  private selCache: string[] = []
  private selDirty = true
  private statsCache: { nodes: number; zoom: number } = { nodes: 0, zoom: 1 }
  private statsDirty = true

  getSelectionSnapshot = (): string[] => {
    if (this.selDirty) {
      this.selCache = [...this.store.selection]
      this.selDirty = false
    }
    return this.selCache
  }

  getStatsSnapshot = (): { nodes: number; zoom: number } => {
    if (this.statsDirty) {
      this.statsCache = { nodes: this.store.size, zoom: this.store.viewport.scale }
      this.statsDirty = false
    }
    return this.statsCache
  }

  /** A string, so identity comparison is value comparison — no cache needed. */
  getStatusSnapshot = (): BridgeStatus => this.connectionStatus

  // ------------------------------------------------------------ collab

  /**
   * Hand document authority to a CRDT bridge.
   *
   * After this call the store is a projection: `mutate` writes to the CRDT and the store re-derives
   * itself. Undo becomes the bridge's, which is the point — it knows which transactions were mine.
   */
  attachBridge(bridge: YDocBridge): void {
    this.bridge = bridge
    this.mutate = (m) => bridge.apply(m)
    bridge.onStatus((s) => {
      for (const fn of this.listeners.status) fn(s)
    })
    for (const fn of this.listeners.status) fn(bridge.status)
  }

  get connectionStatus(): BridgeStatus {
    return this.bridge?.status ?? 'disconnected'
  }

  /**
   * Connect to a shared board and wire presence. Returns a disposer.
   *
   * This lives on the editor rather than in the React component so the whole collab stack has one
   * owner and one teardown path. A component-level cleanup that half-closes a provider is how you
   * end up with a socket that outlives the document it was carrying.
   *
   * Presence feeds back into the engine in two directions: remote cursors out to the renderer, and
   * my own cursor and selection up to the awareness channel, so collaborators see me pointing at
   * things.
   */
  attachCollab(
    boardId: string,
    token: string | null,
    onUsers: (users: RemoteUser[]) => void,
  ): () => void {
    const { doc, provider } = connectCollab(boardId, token)
    const bridge = new YDocBridge(this.store, doc)
    this.attachBridge(bridge)

    const presence = new PresenceChannel(provider.awareness)
    presence.onChange((users) => {
      this.setRemote(users)
      onUsers(users)
    })

    const stopStatus = watchStatus(provider, (s) => {
      for (const fn of this.listeners.status) fn(s)
    })

    this.cursorSink = (x, y) => presence.moveCursor(x, y)
    this.selectionSink = (ids) => presence.setSelection(ids)

    return () => {
      this.cursorSink = null
      this.selectionSink = null
      stopStatus()
      presence.destroy()
      provider.destroy()
      doc.destroy()
      bridge.destroy()
    }
  }

  /** Called by the pointer layer on every move; presence throttles it. */
  private cursorSink: ((x: number, y: number) => void) | null = null
  private selectionSink: ((ids: string[]) => void) | null = null

  reportCursor(x: number, y: number): void {
    this.cursorSink?.(x, y)
  }

  reportSelection(ids: string[]): void {
    this.selectionSink?.(ids)
  }

  /** Live presence, in the shape the renderer draws. */
  setRemote(users: RemoteUser[]): void {
    this.overlay.remote = users
    this.renderer.setOverlay({ remote: users })
  }

  // ------------------------------------------------------------ tool

  getTool(): Tool {
    return this.tool
  }

  setTool(tool: Tool): void {
    if (JSON.stringify(tool) === JSON.stringify(this.tool)) return
    this.tool = tool
    for (const fn of this.listeners.tool) fn(tool)
    this.requestRender()
  }

  // ------------------------------------------------------------ text

  private onTextChange(id: string, text: string): void {
    const n = this.store.get(id)
    if (!isTextEditable(n)) return
    this.mutate({ type: 'update', patches: [[id, { text } as never]] })
    this.textEditor.layout()
  }

  private onTextDone(): void {
    const id = this.textEditor.editingId
    this.textEditor.close()
    if (!id) return
    const n = this.store.get(id)
    if (!isTextEditable(n)) return
    // A text tool click that was never typed into should leave nothing behind. Committing an empty
    // node is how whiteboards fill up with invisible ghosts.
    if (n.text.trim() === '') {
      if (this.store.isTransient(id)) {
        this.store.discardTransient([id])
        this.store.clearSelection()
        this.requestRender()
        return
      }
      this.pushHistory()
      this.mutate({ type: 'remove', ids: [id] })
    }
  }

  // ------------------------------------------------------------ undo

  /**
   * Capture the current scene as an undo point.
   *
   * MUST be called *before* the mutation is applied. Undo restores a snapshot, so pushing
   * afterwards stores the state you are already in and undo becomes a no-op. `snapshot` omits
   * transient nodes, which is what makes this safe on the create path: the in-progress node is
   * still transient at this point, so the captured state is genuinely "before this node existed".
   */
  private pushHistory(): void {
    if (this.bridge) return // the CRDT's UndoManager keeps its own stack
    this.history.push(snapshot(this.store))
    if (this.history.length > HISTORY_LIMIT) this.history.shift()
    // A fresh edit invalidates the redo stack, but only once the edit is real.
    this.future = []
  }

  undo(): void {
    if (this.bridge) {
      this.bridge.undo()
      return
    }
    const prev = this.history.pop()
    if (!prev) return
    this.future.push(snapshot(this.store))
    restore(this.store, prev)
    this.requestRender()
  }

  redo(): void {
    if (this.bridge) {
      this.bridge.redo()
      return
    }
    const next = this.future.pop()
    if (!next) return
    this.history.push(snapshot(this.store))
    restore(this.store, next)
    this.requestRender()
  }

  get canUndo(): boolean {
    return this.bridge ? this.bridge.canUndo : this.history.length > 0
  }

  get canRedo(): boolean {
    return this.bridge ? this.bridge.canRedo : this.future.length > 0
  }

  // ------------------------------------------------------------ commands

  deleteSelection(): void {
    const ids = [...this.store.selection]
    if (ids.length === 0) return
    this.pushHistory()
    this.mutate({ type: 'remove', ids })
    for (const fn of this.listeners.selection) fn([])
  }

  selectAll(): void {
    this.store.select(this.store.committedIds())
  }

  copy(): void {
    this.clipboard = [...this.store.selection]
      .map((id) => this.store.raw(id))
      .filter((n): n is BoardNode => !!n)
      .map((n) => structuredClone(n))
  }

  cut(): void {
    this.copy()
    this.deleteSelection()
  }

  paste(offset = 24): void {
    if (this.clipboard.length === 0) return
    this.pushHistory()
    let z = this.store.nextZ()
    const clones = this.clipboard.map((n) => ({
      ...structuredClone(n),
      id: newId(),
      x: n.x + offset,
      y: n.y + offset,
      z: z++,
    }))
    this.mutate({ type: 'create', nodes: clones })
    this.store.select(clones.map((c) => c.id))
    for (const fn of this.listeners.selection) fn(clones.map((c) => c.id))
  }

  duplicate(): void {
    this.copy()
    this.paste()
  }

  nudge(dx: number, dy: number): void {
    const ids = [...this.store.selection]
    if (ids.length === 0) return
    this.pushHistory()
    this.mutate({
      type: 'update',
      patches: ids.map((id) => {
        const b = this.store.getBounds(id)
        return [id, { x: (b?.x ?? 0) + dx, y: (b?.y ?? 0) + dy }] as const
      }) as [string, never][],
    })
  }

  /** Apply a patch from outside — the inspector, or a collaborator-aware command. */
  patch(id: string, p: Record<string, unknown>): void {
    this.pushHistory()
    this.mutate({ type: 'update', patches: [[id, p as never]] })
  }

  // ------------------------------------------------------------ viewport

  setViewport(vp: Viewport): void {
    this.store.setViewport(vp)
  }

  /** Frame the whole scene, with padding. The "I lost the board" escape hatch. */
  zoomToFit(): void {
    const rects = []
    for (const n of this.store.all()) {
      const b = this.store.getBounds(n.id)
      if (b) rects.push(b)
    }
    const union = rectUnionAll(rects)
    const r = this.container.getBoundingClientRect()
    if (!union || r.width === 0 || r.height === 0) return
    const pad = 80
    const scale = Math.min(
      (r.width - pad * 2) / Math.max(union.w, 1),
      (r.height - pad * 2) / Math.max(union.h, 1),
    )
    const s = Math.max(0.05, Math.min(scale, 2))
    this.store.setViewport({
      scale: s,
      x: union.x - (r.width / s - union.w) / 2,
      y: union.y - (r.height / s - union.h) / 2,
    })
  }

  zoomBy(factor: number): void {
    const r = this.container.getBoundingClientRect()
    this.store.setViewport(
      zoomAt(this.store.viewport, { x: r.width / 2, y: r.height / 2 }, factor),
    )
  }

  // ------------------------------------------------------------ keyboard

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') this.pointer.setSpaceDown(false)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Never steal keys from a text field.
    const t = e.target as HTMLElement | null
    if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return

    const mod = e.metaKey || e.ctrlKey
    const key = e.key.toLowerCase()

    if (e.code === 'Space' && !mod) {
      this.pointer.setSpaceDown(true)
      e.preventDefault()
      return
    }

    if (mod) {
      switch (key) {
        case 'z':
          e.preventDefault()
          if (e.shiftKey) this.redo()
          else this.undo()
          return
        case 'y':
          e.preventDefault()
          this.redo()
          return
        case 'a':
          e.preventDefault()
          this.selectAll()
          return
        case 'c':
          this.copy()
          return
        case 'x':
          e.preventDefault()
          this.cut()
          return
        case 'v':
          e.preventDefault()
          this.paste()
          return
        case 'd':
          e.preventDefault()
          this.duplicate()
          return
        case '0':
          e.preventDefault()
          this.zoomBy(1)
          return
        default:
          return
      }
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      this.deleteSelection()
      return
    }

    if (e.key === 'Escape') {
      if (this.textEditor.isOpen) this.textEditor.close()
      else if (this.store.selection.size > 0) this.store.clearSelection()
      else this.setTool({ kind: 'select' })
      return
    }

    if (e.key === 'Enter') {
      const id = [...this.store.selection][0]
      if (id && isTextEditable(this.store.get(id))) {
        e.preventDefault()
        this.textEditor.open(id)
      }
      return
    }

    if (e.key.startsWith('Arrow')) {
      const step = e.shiftKey ? 20 : 1
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
      if (d) {
        e.preventDefault()
        this.nudge(d[0], d[1])
      }
      return
    }

    if (e.key === '1') {
      e.preventDefault()
      this.zoomToFit()
      return
    }

    const def = toolByKey(key)
    if (def && !e.altKey) this.setTool(def.tool)
  }

  // ------------------------------------------------------------ sample

  /** Seed the board so an empty canvas never greets anyone. */
  seedSample(): void {
    if (this.store.size > 0) return
    const z0 = this.store.nextZ()
    const style = (over: Partial<Style>): Style => ({ ...DEFAULT_STYLE, ...over })
    this.mutate({
      type: 'create',
      nodes: [
        makeNode({
          type: 'frame',
          title: 'Act I — Setup',
          x: -40,
          y: -40,
          w: 720,
          h: 460,
          z: z0,
          style: style({ fill: 'rgba(238,242,255,0.7)', stroke: '#a5a5c8', color: '#4f46e5' }),
        }),
        makeNode({
          type: 'shape',
          shape: 'rect',
          text: 'The inciting incident',
          x: 40,
          y: 40,
          w: 260,
          h: 130,
          z: z0 + 1,
          style: style({ fill: '#e8e6ff', stroke: '#4f46e5' }),
        }),
        makeNode({
          type: 'shape',
          shape: 'diamond',
          text: 'Will she go back?',
          x: 400,
          y: 40,
          w: 240,
          h: 130,
          z: z0 + 2,
          style: style({ fill: '#fde68a', stroke: '#d97706', color: '#422006' }),
        }),
        makeNode({
          type: 'sticky',
          text: 'Midpoint reversal — she finds the letter',
          author: null,
          x: 120,
          y: 250,
          w: 200,
          h: 160,
          z: z0 + 3,
          style: style({
            fill: '#bbf7d0',
            stroke: '#15803d',
            color: '#052e16',
            align: 'left',
            valign: 'top',
            radius: 4,
            strokeWidth: 1,
          }),
        }),
      ],
    })
  }
}

export type RemoteUser = {
  id: string
  name: string
  color: string
  x: number
  y: number
  selection: string[]
}
