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

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Editor, type RemoteUser } from './engine/editor'
import type { Tool } from './engine/tools/registry'
import type { BridgeStatus } from './collab/ydoc'
import { ToolRail } from './ui/ToolRail'
import { Inspector } from './ui/Inspector'
import { PresenceBar } from './ui/PresenceBar'
import { ChatPanel, type ChatDocLike } from '../chat/ChatPanel'
import { connectChat, setChatPresence, watchChatPresence } from '../chat/transport'
import { randomUser, type ChatUser } from '../chat/model'
import { watchStatus as watchProviderStatus } from './collab/provider'

/** Stable identities so `getSnapshot` can never hand React a fresh object and loop forever. */
const DEFAULT_TOOL: Tool = { kind: 'select' }
const NO_SELECTION: string[] = []
const ZERO_STATS = { nodes: 0, zoom: 1 }
const NO_USERS: RemoteUser[] = []

const BOARD_NAME = 'Untitled story'

/** Where the local identity is kept between visits. */
const IDENTITY_KEY = 'storyboard.identity'

/**
 * A stable local identity.
 *
 * Persisted so you keep your name and colour across reloads — a chat where you are a different
 * person every time you open the tab is unusable. It is deliberately *local* and self-declared: this
 * is the pre-auth behaviour, and `PLAN.md` lists real accounts as unbuilt. Swapping this for a
 * server-issued user id is the intended upgrade path and touches only this function.
 */
function localIdentity(): ChatUser {
  if (typeof localStorage === 'undefined') return randomUser()
  try {
    const raw = localStorage.getItem(IDENTITY_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ChatUser
      if (parsed && typeof parsed.id === 'string' && typeof parsed.name === 'string') {
        return parsed
      }
    }
    const fresh = randomUser()
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(fresh))
    return fresh
  } catch {
    // Private mode, quota, corrupt JSON — a random identity is a fine degradation.
    return randomUser()
  }
}

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

  // ---------------------------------------------------------------- chat

  const [me] = useState<ChatUser>(localIdentity)
  const [chat, setChat] = useState<ChatDocLike | null>(null)
  const [chatStatus, setChatStatus] = useState<BridgeStatus>('connecting')
  const [peers, setPeers] = useState<ChatUser[]>([])

  useEffect(() => {
    if (!boardId) return
    const conn = connectChat(boardId, token ?? null)
    setChat(conn.chat)
    setChatPresence(conn.provider, me)
    const offPresence = watchChatPresence(conn.provider, (states) => {
      setPeers(
        states
          .map((s) => s.user)
          .filter((u): u is ChatUser => !!u && typeof (u as ChatUser).id === 'string'),
      )
    })
    const offStatus = watchProviderStatus(conn.provider, setChatStatus)
    return () => {
      offPresence()
      offStatus()
      conn.destroy()
      setChat(null)
    }
  }, [boardId, token, me])

  // The roster is us plus everyone in the room. Mentions resolve against it, and a name that is not
  // in the room deliberately does not resolve — see `parseMentions`.
  const roster = useMemo(() => [me, ...peers], [me, peers])

  /** Jump to a node a message or task refers to, and bring it into view. */
  const revealNode = useCallback(
    (nodeId: string) => {
      if (!editor) return
      editor.store.select([nodeId])
      editor.revealNode(nodeId)
    },
    [editor],
  )

  /** A human name for the single selected node, so a chat pill can say what it points at. */
  const selectedLabel = useMemo(() => {
    if (!editor || selection.length !== 1) return null
    const n = editor.store.get(selection[0])
    if (!n) return null
    if ('text' in n && typeof n.text === 'string' && n.text.trim()) {
      return n.text.trim().slice(0, 32)
    }
    if (n.type === 'frame') return n.title
    if (n.type === 'connector') return n.label || 'a connector'
    return n.type
  }, [editor, selection])

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

      {boardId ? (
        <ChatPanel
          chat={chat}
          me={me}
          roster={roster}
          status={chatStatus}
          onRevealNode={revealNode}
          selectedNodeId={selection.length === 1 ? selection[0] : null}
          selectedNodeLabel={selectedLabel}
        />
      ) : (
        <LocalChatHint />
      )}
    </div>
  )
}

/**
 * Why chat is absent on the default route.
 *
 * Shown instead of an empty panel because a chat box that silently refuses to send is worse than one
 * that explains itself. The default route has no board id, so there is no room to talk in.
 */
function LocalChatHint() {
  return (
    <aside
      aria-label="Conversation"
      className="flex w-80 shrink-0 flex-col items-center justify-center gap-2 border-l border-line bg-desk px-6 text-center"
    >
      <h2 className="text-[11px] font-semibold text-graphite">Conversation</h2>
      <p className="text-[12px] leading-relaxed text-quiet">
        Chat is per board. Open a shared board and the conversation for it appears here, alongside the
        diagram and the tasks.
      </p>
    </aside>
  )
}
