/**
 * Presence — who is here, where they are pointing, what they have selected.
 *
 * Awareness is ephemeral by design and is never persisted into the document. That is the correct
 * behaviour: a cursor position from an hour ago is not content, and storing it would mean replaying
 * ghosts. It also means this is the one part of the system that gets *throttled* rather than
 * batched with everything else — a cursor at pointer-event rate is a firehose that buys nothing,
 * because nobody can perceive a cursor moving faster than about 20Hz.
 *
 * Colours are drawn from a fixed rotation rather than generated, so a given person keeps the same
 * colour for the whole session and across reconnects. A cursor whose colour changes when someone
 * re-renders is much harder to follow than one that merely moves.
 */

import type { Awareness } from 'y-protocols/awareness'
import type { RemoteUser } from '../engine/editor'

export type PresenceState = {
  name: string
  color: string
  x: number
  y: number
  selection: string[]
}

/** Chosen to stay legible on both appearances and to avoid the reserved brass accent. */
const ROTATION = [
  '#1d4ed8',
  '#0f766e',
  '#b45309',
  '#7c3aed',
  '#be123c',
  '#0369a1',
  '#4d7c0f',
  '#a21caf',
]

/** ~20Hz. Fast enough to read as continuous, slow enough not to saturate the socket. */
const THROTTLE_MS = 50

export function pickColor(clientId: number): string {
  return ROTATION[clientId % ROTATION.length]
}

export function randomName(): string {
  const a = ['Quiet', 'Sharp', 'Late', 'Bright', 'Steady', 'Restless', 'First', 'Second']
  const b = ['Draft', 'Revision', 'Cut', 'Margin', 'Chapter', 'Outline', 'Draft', 'Draft']
  return `${a[Math.floor(Math.random() * a.length)]} ${b[Math.floor(Math.random() * b.length)]}`
}

export class PresenceChannel {
  private local: PresenceState
  private listeners = new Set<(users: RemoteUser[]) => void>()
  private pending: PresenceState | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private onAwarenessChange = () => this.emit()

  constructor(private awareness: Awareness) {
    this.local = {
      name: randomName(),
      color: pickColor(awareness.clientID),
      x: 0,
      y: 0,
      selection: [],
    }
    this.awareness.setLocalStateField('user', this.local)
    this.awareness.on('change', this.onAwarenessChange)
  }

  get me(): PresenceState {
    return this.local
  }

  setName(name: string): void {
    this.local = { ...this.local, name }
    this.schedule()
  }

  /**
   * Record a cursor position. Coalesced to a fixed rate and flushed on a trailing timer, so a fast
   * drag sends roughly twenty updates a second instead of two hundred.
   */
  moveCursor(x: number, y: number): void {
    this.pending = { ...this.local, x, y }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, THROTTLE_MS)
  }

  setSelection(ids: string[]): void {
    this.local = { ...this.local, selection: ids }
    this.schedule()
  }

  private schedule(): void {
    this.pending = { ...this.local }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, THROTTLE_MS)
  }

  private flush(): void {
    if (!this.pending) return
    this.local = this.pending
    this.pending = null
    this.awareness.setLocalStateField('user', this.local)
  }

  private emit(): void {
    const users: RemoteUser[] = []
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.awareness.clientID) continue
      const u = (state as { user?: PresenceState }).user
      if (!u) continue
      users.push({ id: String(clientId), name: u.name, color: u.color, x: u.x, y: u.y, selection: u.selection })
    }
    for (const fn of this.listeners) fn(users)
  }

  onChange(fn: (users: RemoteUser[]) => void): () => void {
    this.listeners.add(fn)
    fn([])
    return () => this.listeners.delete(fn)
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer)
    this.awareness.off('change', this.onAwarenessChange)
    this.awareness.setLocalState(null)
    this.listeners.clear()
  }
}
