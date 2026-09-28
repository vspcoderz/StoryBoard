/**
 * The board surface: one canvas, one editor, and the thinnest possible React shell.
 *
 * React's entire job here is to own the chrome and hand the canvas to the engine. It must never
 * observe per-frame state — that is what `useSyncExternalStore` with the engine's cached snapshots
 * buys us. The alternative (a `useState` per pointermove) is the single most common way a
 * collaborative canvas ends up feeling sluggish, because every drag re-renders the whole tree.
 */

'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Editor } from './engine/editor'
import type { Tool } from './engine/tools/registry'
import { ToolRail } from './ui/ToolRail'

/** Stable identities so `getSnapshot` can never hand React a fresh object and loop forever. */
const DEFAULT_TOOL: Tool = { kind: 'select' }
const NO_SELECTION: string[] = []
const ZERO_STATS = { nodes: 0, zoom: 1 }

export function BoardView() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [editor, setEditor] = useState<Editor | null>(null)

  useEffect(() => {
    if (!canvasRef.current || !wrapRef.current) return
    const e = new Editor(canvasRef.current, wrapRef.current)
    e.seedSample()
    e.zoomToFit()
    setEditor(e)
    return () => {
      e.destroy()
      setEditor(null)
    }
  }, [])

  const subscribe = useCallback(
    (cb: () => void) => {
      if (!editor) return () => {}
      const offs = [
        editor.on('tool', cb),
        editor.on('selection', cb),
        editor.on('stats', cb),
      ]
      return () => offs.forEach((off) => off())
    },
    [editor],
  )

  const tool = useSyncExternalStore(
    subscribe,
    () => editor?.getTool() ?? DEFAULT_TOOL,
    () => DEFAULT_TOOL,
  )
  const selection = useSyncExternalStore(
    subscribe,
    () => editor?.getSelectionSnapshot() ?? NO_SELECTION,
    () => NO_SELECTION,
  )
  const stats = useSyncExternalStore(
    subscribe,
    () => editor?.getStatsSnapshot() ?? ZERO_STATS,
    () => ZERO_STATS,
  )

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-neutral-50 text-neutral-900">
      <ToolRail
        tool={tool}
        onTool={(t) => editor?.setTool(t)}
        onUndo={() => editor?.undo()}
        onRedo={() => editor?.redo()}
        onFit={() => editor?.zoomToFit()}
      />

      <div className="relative flex-1">
        <div
          ref={wrapRef}
          tabIndex={0}
          className="absolute inset-0 outline-none"
          aria-label="Story board"
        >
          <canvas ref={canvasRef} className="block h-full w-full touch-none" />
        </div>

        <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-3 rounded-lg bg-white/90 px-3 py-1.5 text-xs text-neutral-500 shadow-sm ring-1 ring-neutral-200 backdrop-blur">
          <span>{stats.nodes} objects</span>
          <span className="text-neutral-300">·</span>
          <span>{Math.round(stats.zoom * 100)}%</span>
          {selection.length > 0 && (
            <>
              <span className="text-neutral-300">·</span>
              <span>{selection.length} selected</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
