/**
 * Chat transport.
 *
 * A second PartyKit room per board, deliberately separate from the board's own room. See the header
 * of `model.ts` for why: a busy conversation would otherwise rewrite the board document on every
 * message, forcing a full board re-projection and growing the board's snapshot for changes nobody is
 * looking at on the canvas.
 *
 * Failure-tolerant in the same way the board transport is. Chat must never be the reason a board
 * fails to open, and a dropped socket must not lose messages: Yjs queues them locally and they go
 * out on reconnect. That is the property that makes the room usable on a train.
 */

import * as Y from 'yjs'
import YPartyKitProvider from 'y-partykit/provider'
import { partyHost } from '../board/collab/provider'
import { ChatDoc } from './model'
import type { BridgeStatus } from '../board/collab/ydoc'

/** Room name for a board's conversation. Namespaced so it can never collide with a board room. */
export function chatRoom(boardId: string): string {
  return `chat_${boardId}`
}

export type ChatConnection = {
  chat: ChatDoc
  provider: YPartyKitProvider
  destroy: () => void
}

export function connectChat(boardId: string, token: string | null): ChatConnection {
  const doc = new Y.Doc()
  const provider = new YPartyKitProvider(partyHost(), chatRoom(boardId), doc, {
    connect: true,
    params: () => (token ? { token } : {}),
  })
  const chat = new ChatDoc(doc)
  return {
    chat,
    provider,
    destroy: () => {
      provider.destroy()
      chat.destroy()
      doc.destroy()
    },
  }
}

/**
 * Share the chat room's awareness channel, so the room shows who is in it.
 *
 * Deliberately the chat room's awareness and not the board's. Board presence is "who is looking at
 * the canvas"; chat presence is "who is in the conversation", and they are different sets — someone
 * can be reading along without having the board open.
 */
export function watchChatPresence(
  provider: YPartyKitProvider,
  onUsers: (users: { clientId: number; user: unknown }[]) => void,
): () => void {
  const emit = () => {
    const users: { clientId: number; user: unknown }[] = []
    provider.awareness?.getStates().forEach((state, clientId) => {
      if (clientId === provider.awareness.clientID) return
      if (state && typeof state === 'object' && 'user' in state) {
        users.push({ clientId, user: (state as { user: unknown }).user })
      }
    })
    onUsers(users)
  }
  provider.awareness?.on('change', emit)
  emit()
  return () => {
    provider.awareness?.off('change', emit)
  }
}

/** Announce who we are in the chat room's awareness. */
export function setChatPresence(provider: YPartyKitProvider, user: unknown): void {
  provider.awareness?.setLocalStateField('user', user)
}

export type { BridgeStatus as ChatStatus }
