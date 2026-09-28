/**
 * Board chrome that floats over the canvas: who is here, and whether we are connected.
 *
 * These sit on the canvas rather than in a top bar on purpose — a navbar is navigation, and this is
 * not navigation. Keeping the top edge clear leaves the board as the only thing with structure.
 *
 * Connection state is stated in words, not just a coloured dot. A dot alone fails everyone who
 * cannot separate the colours, and "why is my edit not showing up" is a question people should never
 * have to guess at.
 */

'use client'

import type { BridgeStatus } from '../collab/ydoc'
import type { RemoteUser } from '../engine/editor'

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

const STATUS_TEXT: Record<BridgeStatus, string> = {
  connected: 'Saved',
  connecting: 'Reconnecting',
  disconnected: 'Offline',
}

const STATUS_DOT: Record<BridgeStatus, string> = {
  connected: 'bg-thread',
  connecting: 'bg-beat',
  disconnected: 'bg-vermilion',
}

export function PresenceBar({
  users,
  status,
  boardName,
}: {
  users: RemoteUser[]
  status: BridgeStatus
  boardName: string
}) {
  return (
    <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2">
      <div className="material pointer-events-auto flex items-center gap-2 rounded-lg px-2.5 py-1.5 shadow-sm ring-1 ring-line">
        {/* The board's own name. It is the one label that must always be visible, because it is how
            you know you are in the right document. */}
        <span className="max-w-40 truncate text-[13px] font-medium text-ink">{boardName}</span>

        {users.length > 0 && (
          <ul className="flex items-center" aria-label={`${users.length} other people here`}>
            {users.slice(0, 5).map((u) => (
              <li key={u.id} className="-ml-1 first:ml-0">
                <span
                  title={u.name}
                  className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface text-[10px] font-semibold text-white"
                  style={{ backgroundColor: u.color }}
                >
                  {initials(u.name)}
                </span>
                {/* The name is available to assistive tech, not only as a tooltip. */}
                <span className="sr-only">{u.name} is on this board</span>
              </li>
            ))}
            {users.length > 5 && (
              <li className="-ml-1 flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface bg-quiet text-[10px] font-semibold text-sheet">
                +{users.length - 5}
              </li>
            )}
          </ul>
        )}

        <span
          className="flex items-center gap-1.5 text-[12px] text-graphite"
          role="status"
          aria-live="polite"
        >
          <span className={`h-2 w-2 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
          {STATUS_TEXT[status]}
        </span>
      </div>
    </div>
  )
}
