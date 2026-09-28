/**
 * Realtime client.
 *
 * Connects straight to PartyKit, never through a Vercel function. A Yjs socket proxied through a
 * serverless function dies when the function hits its maximum duration, taking the document with it,
 * so the transport is deliberately a separate origin from the app.
 *
 * The connection is lazy and failure-tolerant. A board must open and be fully usable whether or not
 * the socket ever comes up — being unable to read your own story because a network is down is a far
 * worse failure than editing alone for a moment.
 */

import * as Y from 'yjs'
import YPartyKitProvider from 'y-partykit/provider'
import type { BridgeStatus } from './ydoc'

export type Connection = {
  doc: Y.Doc
  provider: YPartyKitProvider
  destroy: () => void
}

export function partyHost(): string {
  // Public by design: it identifies a deployment, not a user. The share token is the secret, and
  // it travels in the query string for the server to verify.
  const host = process.env.NEXT_PUBLIC_PARTYKIT_HOST
  if (!host) return 'localhost:1999'
  return host.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

export function connect(boardId: string, token: string | null): Connection {
  const doc = new Y.Doc()
  const provider = new YPartyKitProvider(partyHost(), boardId, doc, {
    connect: true,
    params: () => (token ? { token } : {}),
  })
  return {
    doc,
    provider,
    destroy: () => {
      provider.destroy()
      doc.destroy()
    },
  }
}

type StatusFn = (s: BridgeStatus) => void

/**
 * Map provider connection state onto our three states.
 *
 * `connecting` is a distinct state from `disconnected` on purpose: the UI has to be able to say
 * "reconnecting" and offer a retry, which is a different message from "you are offline".
 */
export function watchStatus(provider: YPartyKitProvider, fn: StatusFn): () => void {
  const onStatusEvent = ({ status }: { status: string }) => {
    fn(status === 'connected' ? 'connected' : status === 'disconnected' ? 'disconnected' : 'connecting')
  }
  const onError = () => fn('disconnected')
  provider.on('status', onStatusEvent)
  provider.on('connection-error', onError)
  fn(provider.wsconnected ? 'connected' : 'connecting')
  return () => {
    provider.off('status', onStatusEvent)
    provider.off('connection-error', onError)
  }
}

/** A random share token. The board id is not secret; this is. */
export function newShareToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
