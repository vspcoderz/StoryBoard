/**
 * PartyKit room — one Yjs document per board.
 *
 * Deployed with `partykit deploy` against our own Cloudflare account (cloud-prem). Two things here
 * are load-bearing, not decoration:
 *
 * 1. `persist: { mode: 'snapshot' }` is set explicitly. PartyKit's default keeps the document in
 *    memory only while a client is connected, and its own docs are blunt about it: when all clients
 *    disconnect, the state may be lost. Without this line, everyone who closes their laptop loses
 *    their board. We also deploy to our own account because PartyKit's managed free tier clears
 *    storage every 24 hours.
 * 2. Authorisation happens here, in `onBeforeConnect`, before the socket is allowed to read or
 *    write anything. Hiding a control in the UI is not access control — anyone can open devtools and
 *    speak to the socket directly.
 *
 * The token rule is deliberately simple: a matching token grants access. Accounts land later without
 * changing this seam, because the check is already in the right place.
 */

import type * as Party from 'partykit/server'
import { onConnect } from 'y-partykit'

type Env = {
  /** Share token for boards that require one. Absent means an open board. */
  STORYBOARD_TOKEN?: string
}

/** Closed with this when the token does not match, so the client can say "not permitted". */
export const UNAUTHORISED = 4401

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export default class StoryBoardRoom implements Party.Server {
  constructor(readonly room: Party.Room) {}

  async onBeforeConnect(
    connection: Party.Connection,
    context: Party.ConnectionContext,
  ): Promise<Response | undefined> {
    const env = this.room.env as Env
    const expected = env.STORYBOARD_TOKEN
    if (!expected) return undefined // no token configured: open board, fine for local work

    const token = new URL(context.request.url).searchParams.get('token')
    if (!token || !timingSafeEqual(token, expected)) {
      connection.close(UNAUTHORISED, 'Not authorised for this board')
      return new Response('Not authorised', { status: 401 })
    }
    return undefined
  }

  onConnect(connection: Party.Connection): void | Promise<void> {
    return onConnect(connection, this.room, {
      persist: { mode: 'snapshot' },
    })
  }
}
