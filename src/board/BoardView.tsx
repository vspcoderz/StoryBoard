/**
 * The board surface: one canvas, one editor, and the thinnest possible React shell.
 *
 * React's entire job is to own the chrome and hand the canvas to the engine. It must never observe
 * per-frame state — that is what the engine's cached snapshots plus `useSyncExternalStore` buy us.
 * The alternative, a `useState` per pointermove, is the most common reason a collaborative canvas
 * feels sluggish: every drag re-renders the whole tree.
 *
 * Collaboration is optional at runtime, not at build time. With no PartyKit host configured the
 * board still opens and is fully usable; it simply is not shared, and the status says so rather than
 * pretending. Being unable to read your own story because a network is down is a far worse failure
 * than editing alone for a moment.
 */

'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Editor, type RemoteUser } from './engine/editor'
import type { Tool } from './engine/tools/registry'
import type { BridgeStatus } from './collab/ydoc'
import { ToolRail } from './ui/ToolRail'
import { Inspector } from './ui/Inspector'
import { PresenceBar } from './ui/PresenceBar'

/** Stable identities so `getSnapshot` can never hand React a fresh object and loop forever. */
const DEFAULT_TOOL: Tool = { kind: 'select' }
const NO_SELECTION: string[] = []
const ZERO_STATS = { nodes: 0, zoom: 1 }
const NO_USERS: RemoteUser[] = []

const BOARD_NAME = 'Untitled story'

export function BoardView({ boardId, token }: { boardId?: string; token?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [users, setUsers] = useState<RemoteUser[]>(NO_USERS)

  useEffect(() => {
    if (!canvasRef.current || !wrapRef.current) return
    const e = new Editor(canvasRef.current, wrapRef.current)

    // Connect before seeding, so a shared board is never briefly overwritten by sample content.
    // `seedSample` no-ops once the document has content, and the CRDT is the authority.
    const disconnect = boardId ? e.attachCollab(boardId, token ?? null, setUsers) : null

    e.seedSample()
    if (!boardId) e.zoomToFit()
    setEditor(e)

    return () => {
      disconnect?.()
      e.destroy()
      setEditor(null)
    }
  }, [boardId, token])

  const subscribe = useCallback(
    (cb: () => void) => {
      if (!editor) return () => {}
      const offs = [
        editor.on('tool', cb),
        editor.on('selection', cb),
        editor.on('stats', cb),
        editor.on('status', cb),
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
  const status = useSyncExternalStore(
    subscribe,
    () => editor?.getStatusSnapshot() ?? 'disconnected',
    () => 'disconnected' as BridgeStatus,
  )

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-desk text-ink">
      <ToolRail
        tool={tool}
        onTool={(t) => editor?.setTool(t)}
        onUndo={() => editor?.undo()}
        onRedo={() => editor?.redo()}
        onFit={() => editor?.zoomToFit()}
        canUndo={editor?.canUndo ?? false}
        canRedo={editor?.canRedo ?? false}
      />

      <div className="relative flex-1">
        <div
          ref={wrapRef}
          tabIndex={0}
          className="absolute inset-0 outline-none"
          role="application"
          aria-label="Story board canvas"
        >
          <canvas ref={canvasRef} className="block h-full w-full touch-none" />
        </div>

        <PresenceBar users={users} status={status} boardName={BOARD_NAME} />

        <div className="material pointer-events-none absolute bottom-3 left-3 flex items-center gap-3 rounded-lg px-3 py-1.5 text-[12px] text-graphite shadow-sm ring-1 ring-line">
          <span>{stats.nodes} objects</span>
          <span aria-hidden="true">·</span>
          <span>{Math.round(stats.zoom * 100)}%</span>
          {selection.length > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{selection.length} selected</span>
            </>
          )}
        </div>

        {/*
          A canvas is invisible to a screen reader, so the selection is announced here instead. The
          canvas is a `role="application"` region with a label; this live region carries the state
          that vision alone would give you.
        */}
        <p aria-live="polite" className="sr-only">
          {selection.length === 0
            ? 'Nothing selected'
            : `${selection.length} object${selection.length === 1 ? '' : 's'} selected`}
        </p>
      </div>

      <Inspector editor={editor} selection={selection} />
    </div>
  )
}
