'use client'

/**
 * Chat and tasks panel.
 *
 * Subscribes to the chat document with `useSyncExternalStore` on a **revision counter**, not on the
 * message array. That distinction is the whole React boundary rule applied correctly: building a new
 * array from the Y.Doc on every render would make the snapshot a fresh object each time, and React
 * would loop forever re-rendering. The counter is a number, so identity comparison works.
 *
 * The Y.Doc is read during render rather than in an effect. Reading a CRDT is cheap and synchronous;
 * wrapping it in an effect would mean rendering one frame of stale data after every keystroke from a
 * collaborator, which for a chat panel is the difference between live and laggy.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  buildThreads,
  hasReacted,
  paragraphs,
  reactionSummary,
  segmentMentions,
  type ChatMessage,
  type ChatTask,
  type ChatUser,
} from './model'

const QUICK_REACTIONS = ['👍', '🎉', '👀', '❤️']

export type ChatPanelProps = {
  /** Null until the transport is up. The panel renders read-only rather than not at all. */
  chat: ChatDocLike | null
  me: ChatUser
  /** Everyone known to be in the room, used to resolve `@mentions`. */
  roster: ChatUser[]
  status: 'connecting' | 'connected' | 'disconnected'
  /** Called when a message pill naming a board node is clicked. */
  onRevealNode: (nodeId: string) => void
  /** Node currently selected on the canvas, offered as a link target. */
  selectedNodeId: string | null
  /** Label for the selected node, shown in the composer. */
  selectedNodeLabel: string | null
}

/** The slice of ChatDoc this panel needs. Structural, so a fake is easy in a test. */
type ChatDocLike = {
  revision: number
  onChange(fn: () => void): () => void
  list(): ChatMessage[]
  listTasks(): ChatTask[]
  post(input: {
    body: string
    author: ChatUser
    threadId?: string | null
    anchorNodeId?: string | null
    roster?: ChatUser[]
  }): ChatMessage | null
  edit(id: string, body: string): void
  remove(id: string): void
  toggleReaction(id: string, emoji: string, userId: string): void
  addTask(input: {
    title: string
    createdBy: string
    assigneeId?: string | null
    anchorNodeId?: string | null
  }): ChatTask | null
  toggleTask(id: string): void
  setTaskAssignee(id: string, assigneeId: string | null): void
  removeTask(id: string): void
}

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function Avatar({ user, size = 20 }: { user: ChatUser; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ background: user.color, width: size, height: size, fontSize: size * 0.5 }}
    >
      {user.name.slice(0, 1).toUpperCase()}
    </span>
  )
}

function Body({ text, roster }: { text: string; roster: ChatUser[] }) {
  const segments = useMemo(() => segmentMentions(text, roster), [text, roster])
  return (
    <>
      {segments.map((s, i) =>
        s.userId ? (
          <span key={i} className="rounded bg-brass/15 px-0.5 font-medium text-brass">
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  )
}

function Message({
  message,
  me,
  roster,
  onReact,
  onDelete,
  onReply,
  onOpenThread,
  onReveal,
  nodeLabel,
  replyCount,
}: {
  message: ChatMessage
  me: ChatUser
  roster: ChatUser[]
  onReact: (id: string, emoji: string) => void
  onDelete: (id: string) => void
  onReply: (id: string) => void
  onOpenThread: (id: string) => void
  onReveal: (nodeId: string) => void
  nodeLabel: (nodeId: string) => string
  replyCount: number
}) {
  // `deleted` is the authority, and the body may still be present in the document — see the note on
  // ChatDoc.remove. Rendering it here is the bug that would resurrect removed messages.
  if (message.deleted) {
    return (
      <li className="px-3 py-1 text-[12px] italic text-quiet">Message deleted</li>
    )
  }

  const mine = message.authorId === me.id
  const reactions = reactionSummary(message.reactions)

  return (
    <li className="group px-3 py-1.5">
      <div className="flex items-baseline gap-2">
        <Avatar user={{ ...me, name: message.authorName, color: mine ? me.color : '#6b7280' }} />
        <span className="text-[12px] font-semibold text-ink">{message.authorName}</span>
        <time className="text-[11px] text-quiet" dateTime={new Date(message.createdAt).toISOString()}>
          {time(message.createdAt)}
        </time>
        {message.editedAt && <span className="text-[11px] text-quiet">edited</span>}
        {mine && (
          <button
            type="button"
            onClick={() => onDelete(message.id)}
            className="ml-auto hidden text-[11px] text-quiet hover:text-vermilion group-hover:inline"
            aria-label="Delete message"
          >
            Delete
          </button>
        )}
      </div>

      <div className="mt-0.5 space-y-1 text-[13px] leading-snug text-ink">
        {paragraphs(message.body).map((p, i) => (
          <p key={i} className="whitespace-pre-wrap break-words">
            <Body text={p} roster={roster} />
          </p>
        ))}
      </div>

      {message.anchorNodeId && (
        <button
          type="button"
          onClick={() => onReveal(message.anchorNodeId!)}
          className="mt-1 inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-graphite hover:text-ink"
        >
          <span aria-hidden>◈</span>
          {nodeLabel(message.anchorNodeId)}
        </button>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-1">
        {reactions.map((r) => (
          <button
            key={r.emoji}
            type="button"
            onClick={() => onReact(message.id, r.emoji)}
            aria-pressed={hasReacted(message.reactions, r.emoji, me.id)}
            title={r.userIds.join(', ')}
            className={`rounded-full border px-1.5 py-px text-[11px] ${
              hasReacted(message.reactions, r.emoji, me.id)
                ? 'border-brass bg-brass/15 text-brass'
                : 'border-line text-graphite'
            }`}
          >
            {r.emoji} {r.userIds.length}
          </button>
        ))}
        <span className="flex gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          {QUICK_REACTIONS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => onReact(message.id, e)}
              className="rounded px-1 text-[12px] hover:bg-surface"
              aria-label={`React ${e}`}
            >
              {e}
            </button>
          ))}
        </span>
        {replyCount > 0 && (
          <button
            type="button"
            onClick={() => onOpenThread(message.id)}
            className="rounded px-1 text-[11px] font-medium text-brass hover:underline"
          >
            {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
          </button>
        )}
        <button
          type="button"
          onClick={() => onReply(message.id)}
          className="rounded px-1 text-[11px] text-quiet hover:text-ink"
        >
          Reply
        </button>
      </div>
    </li>
  )
}

function TaskRow({
  task,
  roster,
  onToggle,
  onAssign,
  onRemove,
  onReveal,
  nodeLabel,
}: {
  task: ChatTask
  roster: ChatUser[]
  onToggle: (id: string) => void
  onAssign: (id: string, userId: string | null) => void
  onRemove: (id: string) => void
  onReveal: (nodeId: string) => void
  nodeLabel: (nodeId: string) => string
}) {
  const done = task.status === 'done'
  const assignee = roster.find((u) => u.id === task.assigneeId)
  return (
    <li className="flex items-center gap-2 px-3 py-1 text-[13px]">
      <input
        type="checkbox"
        checked={done}
        onChange={() => onToggle(task.id)}
        aria-label={`Mark "${task.title}" ${done ? 'not done' : 'done'}`}
      />
      <span className={done ? 'flex-1 text-quiet line-through' : 'flex-1 text-ink'}>
        {task.title}
      </span>
      {task.anchorNodeId && (
        <button
          type="button"
          onClick={() => onReveal(task.anchorNodeId!)}
          className="text-[11px] text-graphite hover:text-ink"
        >
          {nodeLabel(task.anchorNodeId)}
        </button>
      )}
      <label className="sr-only" htmlFor={`assignee-${task.id}`}>
        Assign "{task.title}"
      </label>
      <select
        id={`assignee-${task.id}`}
        value={task.assigneeId ?? ''}
        onChange={(e) => onAssign(task.id, e.target.value || null)}
        className="w-4 border-0 bg-transparent p-0 text-transparent"
        title={assignee ? `Assigned to ${assignee.name}` : 'Unassigned'}
      >
        <option value="">Unassigned</option>
        {roster.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onRemove(task.id)}
        className="text-[11px] text-quiet hover:text-vermilion"
        aria-label={`Delete task "${task.title}"`}
      >
        ×
      </button>
    </li>
  )
}

export function ChatPanel({
  chat,
  me,
  roster,
  status,
  onRevealNode,
  selectedNodeId,
  selectedNodeLabel,
}: ChatPanelProps) {
  // The counter is the snapshot. Reading the document happens *after*, during render, and is not
  // itself a snapshot — see the note at the top of this file.
  useSyncExternalStore(
    (cb) => (chat ? chat.onChange(cb) : () => {}),
    () => chat?.revision ?? 0,
    () => 0,
  )

  const [draft, setDraft] = useState('')
  const [taskDraft, setTaskDraft] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [openThread, setOpenThread] = useState<string | null>(null)
  const [attachNode, setAttachNode] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)

  const messages = chat?.list() ?? []
  const tasks = chat?.listTasks() ?? []
  const threads = useMemo(() => buildThreads(messages), [messages, chat?.revision])
  const replyCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of threads) if (t.replies.length) m.set(t.root.id, t.replies.length)
    return m
  }, [threads])

  const nodeLabel = useCallback(
    (id: string) => (id === selectedNodeId ? (selectedNodeLabel ?? 'selection') : 'a node'),
    [selectedNodeId, selectedNodeLabel],
  )

  const open = openThread ? threads.find((t) => t.root.id === openThread) : null

  // Keep the newest message in view. `end`-anchored scroll is the whole point of a chat panel, and
  // without it you read new messages only after dragging the scrollbar back.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat?.revision, openThread])

  const send = (e: React.FormEvent) => {
    e.preventDefault()
    if (!chat) return
    chat.post({
      body: draft,
      author: me,
      threadId: openThread,
      anchorNodeId: attachNode ? selectedNodeId : null,
      roster,
    })
    setDraft('')
    setReplyTo(null)
  }

  const openTasks = tasks.filter((t) => t.status !== 'done')
  const doneTasks = tasks.filter((t) => t.status === 'done')

  return (
    <section
      aria-label="Conversation"
      className="flex w-80 shrink-0 flex-col border-l border-line bg-desk"
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="text-[11px] font-semibold text-graphite">Conversation</h2>
        <span
          role="status"
          className={`text-[11px] ${
            status === 'connected' ? 'text-quiet' : 'text-vermilion'
          }`}
        >
          {status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Offline'}
        </span>
        {openThread && (
          <button
            type="button"
            onClick={() => setOpenThread(null)}
            className="ml-auto text-[11px] text-brass hover:underline"
          >
            Close thread
          </button>
        )}
      </header>

      <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
        {open
          ? open.replies.map((m) => (
              <Message
                key={m.id}
                message={m}
                me={me}
                roster={roster}
                replyCount={0}
                nodeLabel={nodeLabel}
                onReact={(id, e) => chat?.toggleReaction(id, e, me.id)}
                onDelete={(id) => chat?.remove(id)}
                onReply={setReplyTo}
                onOpenThread={() => {}}
                onReveal={onRevealNode}
              />
            ))
          : threads.map((t) => (
              <Message
                key={t.root.id}
                message={t.root}
                me={me}
                roster={roster}
                replyCount={replyCounts.get(t.root.id) ?? 0}
                nodeLabel={nodeLabel}
                onReact={(id, e) => chat?.toggleReaction(id, e, me.id)}
                onDelete={(id) => chat?.remove(id)}
                onReply={(id) => {
                  setReplyTo(id)
                  setOpenThread(id)
                }}
                onOpenThread={(id) => setOpenThread(id)}
                onReveal={onRevealNode}
              />
            ))}
        {messages.length === 0 && (
          <li className="px-3 py-4 text-[12px] text-quiet">
            Nothing here yet. Messages are shared with everyone on this board and saved with it.
          </li>
        )}
      </ul>

      {/* Tasks live beside the conversation rather than in a separate view: a task and the argument
          for it are the same thought, and splitting them across two screens loses the link. */}
      <div className="border-t border-line">
        <h3 className="px-3 pt-2 text-[11px] font-semibold text-graphite">Tasks</h3>
        <ul>
          {openTasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              roster={roster}
              nodeLabel={nodeLabel}
              onToggle={(id) => chat?.toggleTask(id)}
              onAssign={(id, u) => chat?.setTaskAssignee(id, u)}
              onRemove={(id) => chat?.removeTask(id)}
              onReveal={onRevealNode}
            />
          ))}
          {openTasks.length === 0 && (
            <li className="px-3 py-1 text-[12px] text-quiet">No open tasks.</li>
          )}
        </ul>
        {doneTasks.length > 0 && (
          <details className="px-3 pb-1">
            <summary className="cursor-pointer text-[11px] text-quiet">
              {doneTasks.length} done
            </summary>
            <ul>
              {doneTasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  roster={roster}
                  nodeLabel={nodeLabel}
                  onToggle={(id) => chat?.toggleTask(id)}
                  onAssign={(id, u) => chat?.setTaskAssignee(id, u)}
                  onRemove={(id) => chat?.removeTask(id)}
                  onReveal={onRevealNode}
                />
              ))}
            </ul>
          </details>
        )}
        <form
          className="flex gap-1 px-3 pb-3 pt-1"
          onSubmit={(e) => {
            e.preventDefault()
            if (!chat) return
            chat.addTask({
              title: taskDraft,
              createdBy: me.id,
              anchorNodeId: attachNode ? selectedNodeId : null,
            })
            setTaskDraft('')
          }}
        >
          <label className="sr-only" htmlFor="new-task">
            New task
          </label>
          <input
            id="new-task"
            value={taskDraft}
            onChange={(e) => setTaskDraft(e.target.value)}
            placeholder="Add a task…"
            className="min-w-0 flex-1 rounded-md border border-line bg-sheet px-2 py-1 text-[12px] text-ink placeholder:text-quiet focus:border-brass"
          />
        </form>
      </div>

      <form onSubmit={send} className="border-t border-line p-2">
        {replyTo && (
          <p className="mb-1 text-[11px] text-quiet">
            Replying in thread
            <button
              type="button"
              onClick={() => {
                setReplyTo(null)
                setOpenThread(null)
              }}
              className="ml-2 text-brass hover:underline"
            >
              cancel
            </button>
          </p>
        )}
        {selectedNodeId && (
          <label className="mb-1 flex items-center gap-1.5 text-[11px] text-graphite">
            <input
              type="checkbox"
              checked={attachNode}
              onChange={(e) => setAttachNode(e.target.checked)}
            />
            Link to {selectedNodeLabel ?? 'selection'}
          </label>
        )}
        <div className="flex gap-1">
          <label className="sr-only" htmlFor="chat-input">
            Message
          </label>
          <textarea
            id="chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter breaks the line. The near-universal convention, and the
              // alternative (a send button only) makes catching yourself mid-sentence slower.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                e.currentTarget.form?.requestSubmit()
              }
            }}
            rows={2}
            placeholder={openThread ? 'Reply…' : 'Message the team…  (@name to mention)'}
            className="min-w-0 flex-1 resize-none rounded-md border border-line bg-sheet px-2 py-1.5 text-[13px] text-ink placeholder:text-quiet focus:border-brass"
          />
        </div>
      </form>
    </section>
  )
}

export type { ChatDocLike }
