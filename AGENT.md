# AGENT.md — StoryBoard

Collaborative story-building whiteboard. Infinite canvas + shapes + text + freehand + charts,
real-time multi-user, hosted on Vercel with a PartyKit/Cloudflare Yjs server.

The full architecture, data model, rationale and build order live in `PLAN.md`. Read it before
touching engine code. This file is the short version: the rules you must not break.

## Stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript** + **Tailwind 4** — `src/` layout, `@/*` alias
- **Canvas 2D** for the board. No WebGL, no Pixi, no Three.
- **Yjs** for the CRDT document, **y-partykit** for the server, **PartyKit** deployed to our own
  Cloudflare account (cloud-prem)
- **d3-scale** + **d3-shape** only. No full d3.
- Package manager: **npm** (not pnpm). Node 26.

## Commands

```bash
npm run dev          # dev server
npm run build        # production build
npm run lint         # eslint (flat config)
npx tsc --noEmit     # typecheck
node --test          # unit tests (node:test, no canvas)
npx playwright test  # integration tests (dev-only dep)
```

**All four of lint, typecheck, and tests must pass before claiming anything is done.** Run them,
show the output. "Should work" means unfinished.

## Hard rules

### 1. The engine never imports React

`src/board/engine/**` is imperative and framework-free. It emits coarse events
(`selectionchange`, `toolchange`, `docstats`) and React subscribes via `useSyncExternalStore`.

A React re-render per animation frame is a bug, not a tuning problem. If you find yourself putting
per-frame state in React, the design is wrong — fix the design.

### 2. One Yjs write per interaction, not per frame

During a drag, mutations live in a **local preview overlay**. Exactly one write to the CRDT on
pointer-up. Stream Yjs updates during a drag and every other user's cursor stutters.

Same rule for cursor/presence: throttle and batch awareness updates. Never sync them per frame.

### 3. Undo only your own changes

`Y.UndoManager` must be constructed with `trackedOrigins: new Set([LOCAL_ORIGIN])`. Without it a user
can undo a collaborator's work. All local mutations go through `ydoc.transact(fn, LOCAL_ORIGIN)`.

### 4. Z-order is a number, not a Y.Array

Nodes carry a `z: number`, sorted with an id tiebreak. Reordering a `Y.Array` under concurrency
mangles the order irrecoverably. Do not "fix" this into an array.

### 5. One nested Y.Map per node

`yNodes: Y.Map<Y.Map>` — id to node. This is what lets two people edit different fields of the same
node concurrently without clobbering. Flattening a node into plain JSON breaks merge semantics.

### 6. Authorization is enforced server-side

Hiding a control in the UI is not access control. Board access is checked in the PartyKit
`onConnect` via the token passed through `params: async () => ({ token })`. Share links use
`readOnly: true` on the server. Board ids are not secrets; share tokens are, and they rotate.

### 7. Persistence is explicit

PartyKit keeps the Yjs doc in memory only while a client is connected — **on disconnect the state
may be lost**. The server must pass `persist: { mode: "snapshot" }`. Never ship without it.

### 8. Secrets in env vars only

Never in source, never prefixed `NEXT_PUBLIC_`. Server-side keys stay server-side.

## Conventions

- **Explain *why*, and name the rejected alternative.** Comments should record the decision and what
  it replaced, not restate the code. `PLAN.md` follows this style; match it.
- **Document the gap rather than guessing.** If something is unknown or unverified, write it down
  as a spike in `PLAN.md`. Do not paper over it with a confident guess.
- **No new dependency without a justification comment.** New deps are attack surface and
  maintenance. The existing set is deliberate — see `PLAN.md` Decisions.
- **No unrequested refactors.** Fix the task, move on. Note the smell rather than sprawling.
- **Unit-test pure logic with `node:test`**: geometry, hit-testing, spatial index, rotation math,
  connector routing, scale/tick math, text measurement and wrapping, scene serialization, doc
  reducers. These need no canvas and must not drag one in.

## UI conventions

- **Chrome is a left rail, not a top navbar.** No navbar. No tabs as primary navigation.
- Tool palette, inspector and panels all hang off the rail.
- The canvas is the product. Chrome stays out of the way.
