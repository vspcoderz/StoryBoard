/**
 * Editor orchestrator.
 *
 * Owns the store, the renderer, pointer input, the text overlay and the keyboard map, and is the
 * only thing React talks to. React never reaches into the store mid-frame; it asks for coarse
 * state and subscribes to coarse events.
 *
 * UNDO IS A KNOWN GAP. It is snapshot-based here so the editor is usable and testable today, and
 * it is replaced wholesale by `Y.UndoManager` in the collaboration step. Snapshot undo has two
 * properties that will not survive: it is O(whole scene) per entry, and it cannot distinguish my
 * edits from a collaborator's, so it would happily undo their work. Do not build features that
 * depend on it — see PLAN.md.
 */

import { PointerInput } from './input/pointer'
import { TextEditor, isTextEditable } from './input/textEditor'
import { Renderer, type OverlayState } from './render/renderer'
import { restore, snapshot } from './serialize'
import { SceneStore } from './store'
import { toolByKey, type Tool } from './tools/registry'
import { makeNode, DEFAULT_STYLE, newId, type BoardNode, type Style } from './types'
import { rectUnionAll } from './geometry'
import { zoomAt, type Viewport } from './viewport'

const HISTORY_LIMIT = 100

export type EditorEvents = {
  tool: (tool: Tool) => void
  selection: (ids: string[]) => void
  stats: (stats: { nodes: number; zoom: number }) => void
}

export class Editor {
  readonly store = new SceneStore()
  readonly renderer: Renderer
  readonly pointer: PointerInput
  readonly textEditor: TextEditor

  private tool: Tool = { kind: 'select' }
  private history: string[] = []
  private future: string[] = []
  private clipboard: BoardNode[] = []
  private overlay: OverlayState = { marquee: null, hoverId: null, remote: [] }
  private listeners: { [K in keyof EditorEvents]: Set<EditorEvents[K]> } = {
    tool: new Set(),
    selection: new Set(),
    stats: new Set(),
  }
  private disposers: (() => void)[] = []
  private statsTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private canvas: HTMLCanvasElement,
    private container: HTMLElement,
  ) {
    this.renderer = new Renderer(canvas, this.store)

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
      onTransientCommitted: () => this.pushHistory(),
      onTransientDiscarded: () => {},
    })
    this.pointer.onMarquee = (r) => {
      this.overlay.marquee = r
      this.renderer.setOverlay({ marquee: r })
    }

    this.disposers.push(
      this.store.on((ev) => {
        if (ev === 'selection') {
          this.selDirty = true
          for (const fn of this.listeners.selection) fn([...this.store.selection])
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
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('resize', onResize)
    canvas.addEventListener('pointerdown', onFocus)
    this.disposers.push(() => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('resize', onResize)
      canvas.removeEventListener('pointerdown', onFocus)
    })

    this.resize()
  }

  // ------------------------------------------------------------ lifecycle

  destroy(): void {
    this.pointer.destroy()
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
   * object or array on every call. So each of these caches its value and only rebuilds it when the
   * underlying state actually changed. Returning a stable reference is not an optimisation here —
   * it is the difference between working and an infinite render loop.
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
    this.store.update(id, { text } as never)
    this.textEditor.layout()
  }

  private onTextDone(): void {
    const id = this.textEditor.editingId
    this.textEditor.close()
    if (!id) return
    const n = this.store.get(id)
    if (!isTextEditable(n)) return
    // A text tool click that was never typed into should leave nothing behind. Committing an empty
    // node is how whiteboards fill up with invisible 1×1 ghosts.
    if (n.text.trim() === '') {
      this.store.discardTransient([id])
      if (this.store.selection.has(id)) this.store.clearSelection()
      this.requestRender()
      return
    }
    this.store.commitTransient([id])
    this.pushHistory()
  }

  // ------------------------------------------------------------ commands

  private pushHistory(): void {
    this.history.push(snapshot(this.store))
    if (this.history.length > HISTORY_LIMIT) this.history.shift()
    this.future = []
  }

  undo(): void {
    const prev = this.history.pop()
    if (!prev) return
    this.future.push(snapshot(this.store))
    restore(this.store, prev)
    this.requestRender()
  }

  redo(): void {
    const next = this.future.pop()
    if (!next) return
    this.history.push(snapshot(this.store))
    restore(this.store, next)
    this.requestRender()
  }

  deleteSelection(): void {
    const ids = [...this.store.selection]
    if (ids.length === 0) return
    this.pushHistory()
    this.store.remove(ids)
    for (const fn of this.listeners.selection) fn([])
  }

  selectAll(): void {
    this.store.select(this.store.committedIds())
  }

  copy(): void {
    const ids = [...this.store.selection]
    this.clipboard = ids
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
    this.store.addMany(clones)
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
    this.store.updateMany(
      ids.map((id) => {
        const b = this.store.getBounds(id)
        return [id, { x: (b?.x ?? 0) + dx, y: (b?.y ?? 0) + dy }] as const
      }),
    )
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
    // Never steal keys from a text field. The overlay stops propagation, but a stray guard here
    // means an input rendered outside the canvas cannot be broken by a global shortcut.
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
    if (def && !e.altKey) {
      this.setTool(def.tool)
    }
  }

  // ------------------------------------------------------------ misc

  /** Seed the board so an empty canvas never greets anyone. */
  seedSample(): void {
    const z0 = this.store.nextZ()
    const style = (over: Partial<Style>): Style => ({ ...DEFAULT_STYLE, ...over })
    this.store.addMany([
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
    ])
  }
}
