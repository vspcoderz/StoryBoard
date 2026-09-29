/**
 * Chat and tasks document model.
 *
 * ## Why this is a separate Y.Doc and a separate PartyKit room
 *
 * The obvious thing is to put messages in the board's own document. That is wrong, and the reason is
 * arithmetic rather than taste:
 *
 * - The board document is **spatial and low-churn**. A scene is a few thousand nodes, edited by
 *   gestures. Its snapshot persistence and its ~8MB archive threshold both assume that shape.
 * - Chat is **textual and high-churn**. A busy room rewrites that document constantly, for changes
 *   that have nothing to do with the picture. Every one of those transactions would force a
 *   re-projection of the whole board, dirty-rect churn, and a larger snapshot — while a colleague
 *   typing a message changed nothing anyone was looking at.
 *
 * So each board gets `board:<id>` for the canvas and `chat:<id>` for the room. They share a team, a
 * roster and a transport, not a document.
 *
 * ## Why a Y.Map of messages, not a Y.Array
 *
 * Chat is append-only, and a Yjs sequence *does* handle concurrent appends deterministically. The
 * problem is everything else: editing a message, deleting one, and threading replies all need stable
 * identity, and a Y.Array gives you positional identity. Two people deleting adjacent messages
 * produce an off-by-one that resurrects text someone meant to remove.
 *
 * So messages are a `Y.Map<Y.Map>` keyed by id, ordered by `(createdAt, id)`. The id tiebreak is
 * what makes the order total: two messages sent in the same millisecond must not swap places between
 * renders. This is the same reasoning as z-order being a numeric field rather than a sequence.
 *
 * Per-message `Y.Map` (not a plain object) is what lets two people react to the same message
 * concurrently without one clobbering the other, and lets one edit the body while the other adds a
 * reaction.
 *
 * ## Deletion is a flag
 *
 * `deleted: true`, not a map delete. In a CRDT you cannot reliably delete: the delete has to win
 * against every concurrent edit, and a plain `Y.Map.delete` is a tombstone that can and does lose to
 * a late-arriving field write, resurrecting the message. A flag is a value every replica converges
 * on, so a deleted message stays deleted everywhere, permanently.
 */

import * as Y from 'yjs'

/** Marks a transaction as ours, for undo scoping. Matches the board's origin symbol. */
export const CHAT_LOCAL_ORIGIN = Symbol('storyboard.chat.local')

export type TaskStatus = 'todo' | 'doing' | 'done'

export type ChatMessage = {
  id: string
  authorId: string
  authorName: string
  body: string
  /** Epoch ms. Sorting key, paired with `id` for a total order. */
  createdAt: number
  editedAt: number | null
  /** Set on replies; the root message this hangs off. */
  threadId: string | null
  /** Board node this message is about. Clicking it selects and centres the node. */
  anchorNodeId: string | null
  deleted: boolean
  /** Emoji -> user ids. Stored as a nested Y.Map so concurrent reactions merge. */
  reactions: Record<string, string[]>
  /** User ids mentioned in the body, resolved at post time. */
  mentions: string[]
}

export type ChatTask = {
  id: string
  title: string
  status: TaskStatus
  assigneeId: string | null
  createdBy: string
  createdAt: number
  anchorNodeId: string | null
}

export type ChatUser = {
  id: string
  name: string
  color: string
}

const MESSAGES = 'messages'
const TASKS = 'tasks'
const UNDO_SCOPE = 'chat'

// ---------------------------------------------------------------- pure helpers

/**
 * Total order over messages.
 *
 * `createdAt` alone is not enough: two people can post in the same millisecond, and without a
 * tiebreak their messages swap places on each render, which reads as the room being haunted.
 */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Build a mention matcher from the actual roster.
 *
 * A generic pattern like `/@([\w .-]{0,30})/` cannot work, and the failure is nasty rather than
 * obvious: in `"hey @Alice look"`, the character class greedily captures `"Alice look"`, which
 * resolves to nobody, so the mention silently stops working the moment someone types a word after
 * the name. Matching against the names that actually exist removes the ambiguity entirely, and
 * multi-word names come for free.
 *
 * Returns null for an empty roster, so callers can skip the scan entirely.
 */
function mentionMatcher(roster: ChatUser[]): { re: RegExp; byName: Map<string, string> } | null {
  const byName = new Map<string, string>()
  for (const u of roster) byName.set(u.name.toLowerCase(), u.id)
  if (byName.size === 0) return null
  // Longest first, so "Red Pen" wins over "Red" when both are in the room.
  const names = [...byName.keys()].sort((a, b) => b.length - a.length)
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return { re: new RegExp(`@(${escaped.join('|')})`, 'gi'), byName }
}

/**
 * Extract `@name` mentions and resolve them against a roster.
 *
 * Unresolved mentions are dropped rather than kept as text, because a mention chip for a person who
 * is not in the room is worse than no chip — it implies a notification that will never arrive. The
 * raw text is always preserved in the body either way.
 */
export function parseMentions(body: string, roster: ChatUser[]): string[] {
  const m = mentionMatcher(roster)
  if (!m) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const hit of body.matchAll(m.re)) {
    const id = m.byName.get(hit[1].toLowerCase())
    if (id && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/** Split a body into text runs and mention runs, for rendering highlights. */
export function segmentMentions(
  body: string,
  roster: ChatUser[],
): { text: string; userId: string | null }[] {
  const m = mentionMatcher(roster)
  if (!m) return [{ text: body, userId: null }]
  const out: { text: string; userId: string | null }[] = []
  let last = 0
  for (const hit of body.matchAll(m.re)) {
    const id = m.byName.get(hit[1].toLowerCase()) ?? null
    if (id === null) continue
    if (hit.index > last) out.push({ text: body.slice(last, hit.index), userId: null })
    out.push({ text: hit[0], userId: id })
    last = hit.index + hit[0].length
  }
  if (last < body.length) out.push({ text: body.slice(last), userId: null })
  return out
}

/**
 * Collapse a reaction map to the emoji worth showing, with who added it.
 *
 * Sorted by code unit rather than `localeCompare`: emoji collation is locale-dependent, so the same
 * reactions could render in a different order for two people reading the same message, which looks
 * like the row is shuffling itself.
 */
export function reactionSummary(
  reactions: Record<string, string[]>,
): { emoji: string; userIds: string[] }[] {
  return Object.entries(reactions)
    .filter(([, ids]) => ids.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([emoji, userIds]) => ({ emoji, userIds: [...userIds].sort() }))
}

/** Has this user already added this reaction? Drives the toggle's pressed state. */
export function hasReacted(reactions: Record<string, string[]>, emoji: string, userId: string): boolean {
  return (reactions[emoji] ?? []).includes(userId)
}

/** Group messages into roots with their replies, preserving the total order at both levels. */
export interface Thread {
  root: ChatMessage
  replies: ChatMessage[]
}

export function buildThreads(messages: ChatMessage[]): Thread[] {
  const byId = new Map(messages.map((m) => [m.id, m]))
  const roots: ChatMessage[] = []
  const replies = new Map<string, ChatMessage[]>()
  for (const m of messages) {
    // A reply whose root is missing is promoted to a root rather than dropped. That happens when a
    // root is deleted while replies survive, and silently hiding replies loses someone's words.
    if (m.threadId && byId.has(m.threadId)) {
      const list = replies.get(m.threadId)
      if (list) list.push(m)
      else replies.set(m.threadId, [m])
    } else {
      roots.push(m)
    }
  }
  return roots
    .sort(compareMessages)
    .map((root) => ({ root, replies: (replies.get(root.id) ?? []).sort(compareMessages) }))
}

/** Split a body into paragraphs, so multi-line messages render with real breaks. */
export function paragraphs(body: string): string[] {
  return body.replace(/\r\n/g, '\n').split(/\n{2,}/)
}

// ---------------------------------------------------------------- document

export function newMessageId(): string {
  return `m_${crypto.randomUUID()}`
}

export function newTaskId(): string {
  return `t_${crypto.randomUUID()}`
}

/** Plausible default roster entries, so a local board is usable before any auth exists. */
const NAME_POOL: [string, string][] = [
  ['Quiet Draft', '#e2b13c'],
  ['Red Pen', '#d1553f'],
  ['Second Draft', '#4f9de2'],
  ['Margin Note', '#6fbf73'],
  ['Plot Twist', '#b06fd1'],
  ['Cutaway', '#e07a5f'],
  ['Cold Open', '#3fa9a3'],
  ['Final Pass', '#8a8fd4'],
]

export function randomUser(): ChatUser {
  const i = Math.floor(Math.random() * NAME_POOL.length)
  return { id: `u_${crypto.randomUUID()}`, name: NAME_POOL[i][0], color: NAME_POOL[i][1] }
}

/**
 * The chat document.
 *
 * Deliberately has no transport and no React: it owns a `Y.Doc` and the rules for reading and
 * writing it, so all of the merge semantics are unit-testable by exchanging updates between two
 * in-memory docs — which is exactly the class of bug that is invisible in a single-user session and
 * obvious the first time two people talk at once.
 */
export class ChatDoc {
  readonly doc: Y.Doc
  private messages: Y.Map<Y.Map<unknown>>
  private tasks: Y.Map<Y.Map<unknown>>
  /**
   * Named `undoManager`, not `undo`. A class field called `undo` shadows the `undo()` *method* on
   * the prototype, so `chat.undo()` resolves to the UndoManager object and throws
   * "chat.undo is not a function" — while `canUndo` still works, because that is a real method. It
   * looks like undo is wired up and silently is not.
   */
  private undoManager: Y.UndoManager
  private listeners = new Set<() => void>()
  /** Bumped on every change, so React can use a primitive as its snapshot. */
  private version = 0

  constructor(doc: Y.Doc) {
    this.doc = doc
    this.messages = doc.getMap<Y.Map<unknown>>(MESSAGES)
    this.tasks = doc.getMap<Y.Map<unknown>>(TASKS)
    this.undoManager = new Y.UndoManager([this.messages, this.tasks], {
      trackedOrigins: new Set([CHAT_LOCAL_ORIGIN]),
      captureTimeout: 300,
    })
    const bump = () => {
      this.version++
      for (const fn of this.listeners) fn()
    }
    this.messages.observeDeep(bump)
    this.tasks.observeDeep(bump)
  }

  /** Subscribe to changes. Returns an unsubscribe. The argument is a revision counter, not state. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  get revision(): number {
    return this.version
  }

  // ------------------------------------------------------------ read

  list(): ChatMessage[] {
    const out: ChatMessage[] = []
    this.messages.forEach((ym) => {
      const m = this.readMessage(ym)
      if (m) out.push(m)
    })
    return out.sort(compareMessages)
  }

  listTasks(): ChatTask[] {
    const out: ChatTask[] = []
    this.tasks.forEach((ym) => {
      const t = ym.toJSON() as ChatTask
      if (t && typeof t.id === 'string' && t.title) out.push(t)
    })
    return out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
  }

  private readMessage(ym: Y.Map<unknown>): ChatMessage | null {
    const raw = ym.toJSON() as Omit<ChatMessage, 'reactions'> & { reactions?: unknown }
    if (!raw || typeof raw.id !== 'string' || typeof raw.createdAt !== 'number') return null
    // Reactions live in nested Y.Maps, which `toJSON` renders as plain objects keyed by user id.
    const reactions: Record<string, string[]> = {}
    const yReactions = this.messages.get(raw.id)?.get('reactions')
    if (yReactions instanceof Y.Map) {
      yReactions.forEach((ym, emoji) => {
        if (ym instanceof Y.Map) reactions[emoji] = [...ym.keys()].sort()
      })
    }
    return {
      id: raw.id,
      authorId: String(raw.authorId ?? ''),
      authorName: String(raw.authorName ?? 'Unknown'),
      body: String(raw.body ?? ''),
      createdAt: raw.createdAt,
      editedAt: typeof raw.editedAt === 'number' ? raw.editedAt : null,
      threadId: typeof raw.threadId === 'string' ? raw.threadId : null,
      anchorNodeId: typeof raw.anchorNodeId === 'string' ? raw.anchorNodeId : null,
      deleted: raw.deleted === true,
      reactions,
      mentions: Array.isArray(raw.mentions) ? (raw.mentions as string[]) : [],
    }
  }

  // ------------------------------------------------------------ write

  post(input: {
    body: string
    author: ChatUser
    threadId?: string | null
    anchorNodeId?: string | null
    roster?: ChatUser[]
  }): ChatMessage | null {
    const body = input.body.trim()
    // An empty message is a no-op, not a blank bubble. Worth guarding because the composer can
    // submit on Enter while the user is still typing a reply they have not finished.
    if (!body) return null
    const now = Date.now()
    const id = newMessageId()
    const msg: ChatMessage = {
      id,
      authorId: input.author.id,
      authorName: input.author.name,
      body,
      createdAt: now,
      editedAt: null,
      threadId: input.threadId ?? null,
      anchorNodeId: input.anchorNodeId ?? null,
      deleted: false,
      reactions: {},
      mentions: parseMentions(body, input.roster ?? []),
    }
    this.doc.transact(() => {
      const ym = new Y.Map<unknown>()
      for (const [k, v] of Object.entries({ ...msg, reactions: undefined })) {
        if (v !== undefined) ym.set(k, v as never)
      }
      ym.set('reactions', new Y.Map<Y.Map<unknown>>())
      this.messages.set(id, ym)
    }, CHAT_LOCAL_ORIGIN)
    return msg
  }

  edit(id: string, body: string): void {
    const ym = this.messages.get(id)
    if (!ym) return
    const next = body.trim()
    if (!next) return
    this.doc.transact(() => {
      ym.set('body', next)
      ym.set('editedAt', Date.now())
    }, CHAT_LOCAL_ORIGIN)
  }

  /**
   * Soft delete.
   *
   * Sets only `deleted: true`, and deliberately **leaves the body in the document**. An earlier
   * version also cleared the body, which is wrong in a way that is easy to miss: clearing `body` is a
   * write to the *same key* a collaborator's concurrent edit is writing, so Yjs resolves the two
   * last-writer-wins and the text comes back — on one replica, nondeterministically. The test
   * `"a delete is not resurrected by a concurrent edit"` reproduces exactly that: `deleted` converged
   * correctly and the body did not.
   *
   * A flag on its own key cannot lose that race, because nothing else writes it. So deletion is
   * authoritative, and every reader is required to check it. The cost is that the text stays in the
   * CRDT rather than being erased. For a team board that is the right trade — deletion is about what
   * is *shown*, and it keeps deletion from being a data-loss bug. If this ever needs to be a true
   * erasure, that is a deliberate data-deletion feature with its own audit trail, not a side effect
   * of a delete button.
   */
  remove(id: string): void {
    const ym = this.messages.get(id)
    if (!ym) return
    this.doc.transact(() => {
      ym.set('deleted', true)
      ym.set('reactions', new Y.Map<Y.Map<unknown>>())
    }, CHAT_LOCAL_ORIGIN)
  }

  /**
   * Add or remove a reaction.
   *
   * A nested `Y.Map` per emoji, not a plain record: two people adding *different* reactions to the
   * same message are then writing different keys and cannot clobber each other. A plain object
   * would make the second write a last-writer-wins replacement of the whole reaction set.
   */
  toggleReaction(id: string, emoji: string, userId: string): void {
    const ym = this.messages.get(id)
    if (!ym) return
    this.doc.transact(() => {
      // Typed as a local, not widened to `unknown`: `ym.get` returns `unknown`, and letting the
      // variable's type be inferred from that makes every later call on it an error.
      let reactions: Y.Map<Y.Map<unknown>> | undefined
      const current = ym.get('reactions')
      if (current instanceof Y.Map) {
        reactions = current as Y.Map<Y.Map<unknown>>
      } else {
        reactions = new Y.Map<Y.Map<unknown>>()
        ym.set('reactions', reactions)
      }
      const yEmoji = reactions.get(emoji)
      if (yEmoji instanceof Y.Map) {
        if (yEmoji.has(userId)) yEmoji.delete(userId)
        else yEmoji.set(userId, true)
      } else {
        const created = new Y.Map<unknown>()
        created.set(userId, true)
        reactions.set(emoji, created)
      }
    }, CHAT_LOCAL_ORIGIN)
  }

  addTask(input: {
    title: string
    createdBy: string
    assigneeId?: string | null
    anchorNodeId?: string | null
  }): ChatTask | null {
    const title = input.title.trim()
    if (!title) return null
    const task: ChatTask = {
      id: newTaskId(),
      title,
      status: 'todo',
      assigneeId: input.assigneeId ?? null,
      createdBy: input.createdBy,
      createdAt: Date.now(),
      anchorNodeId: input.anchorNodeId ?? null,
    }
    this.doc.transact(() => {
      const ym = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(task)) ym.set(k, v as never)
      this.tasks.set(task.id, ym)
    }, CHAT_LOCAL_ORIGIN)
    return task
  }

  setTaskStatus(id: string, status: TaskStatus): void {
    const ym = this.tasks.get(id)
    if (!ym) return
    this.doc.transact(() => ym.set('status', status), CHAT_LOCAL_ORIGIN)
  }

  toggleTask(id: string): void {
    const ym = this.tasks.get(id)
    if (!ym) return
    const now = ym.get('status')
    const next = now === 'done' ? 'todo' : 'done'
    this.doc.transact(() => ym.set('status', next), CHAT_LOCAL_ORIGIN)
  }

  setTaskAssignee(id: string, assigneeId: string | null): void {
    const ym = this.tasks.get(id)
    if (!ym) return
    this.doc.transact(() => ym.set('assigneeId', assigneeId), CHAT_LOCAL_ORIGIN)
  }

  removeTask(id: string): void {
    this.doc.transact(() => this.tasks.delete(id), CHAT_LOCAL_ORIGIN)
  }

  // ------------------------------------------------------------ undo

  undo(): void {
    this.undoManager.undo()
  }

  redo(): void {
    this.undoManager.redo()
  }

  get canUndo(): boolean {
    return this.undoManager.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.undoManager.redoStack.length > 0
  }

  destroy(): void {
    this.undoManager.destroy()
    this.listeners.clear()
    this.doc.destroy()
  }
}
