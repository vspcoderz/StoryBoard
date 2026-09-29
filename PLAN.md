# StoryBoard — Collaborative Story-Building Whiteboard

## Goal

A collaborative infinite-canvas whiteboard for building stories, on Vercel. Shapes, text,
freehand drawing, connectors, flowcharts, a full charting engine, and a story domain
(characters, scenes, beats, plot threads) — with real-time multi-user editing and live presence.

Not a general-purpose whiteboard with story features bolted on. A story tool that happens to
use a whiteboard. That decision drives everything below.

## Decisions

| # | Decision | Why | Rejected alternative |
|---|----------|-----|---------------------|
| 1 | **Custom canvas engine, from scratch** | Story objects (character, scene, beat, thread) become first-class node types instead of hacks. Full control of feel and look. Zero license risk. | tldraw SDK — source-available, **not** permissively licensed. Production needs a paid commercial key or it ships a "made with tldraw" watermark on canvas. Excalidraw embed — MIT, but inherits its own UI, injects global CSS/fonts, and its object model is generic. |
| 2 | **Yjs CRDT** for the document | Battle-tested, what tldraw and Excalidraw both converged on. Field-level conflict resolution per node is exactly the right granularity for a whiteboard. | Last-write-wins whole-board JSON — loses concurrent edits. OT — more server complexity, worse tooling. |
| 3 | **PartyKit on our own Cloudflare account** (cloud-prem) | A Yjs server is genuinely ~5 lines via `y-partykit`. Free platform fee. We own the data and the runtime. No per-seat or per-minute metering. | Liveblocks — less code, but Free caps at 3,000 collab min/mo, 10 conns/room, 10MB/room and forces a Liveblocks watermark until Pro ($30/mo). Supabase Realtime — one vendor for auth+db+realtime, but Free allows only **5 presence calls per client per 30s**, which wrecks live cursors. Vercel WebSockets (Public Beta, Jun 2026) — connections are instance-pinned and close at max duration, so authoritative state still can't live in function memory. |
| 4 | **Canvas 2D, no WebGL** | Text, dashed strokes, complex paths, and curves are all native and correct in Canvas 2D. Realistic object counts for story work (hundreds to low thousands) are fine with culling. | Pixi/Three/WebGL — an abstraction tax on text rendering, for a perf problem we won't have at this scale. Revisit only if a measured frame-time budget is blown. |
| 5 | **No React state library, no VDOM engine** | The canvas is imperative. React owns chrome only. A typed event-emitter + `useSyncExternalStore` covers it. | Zustand/Redux — a global store for a document that has its own CRDT state is redundant and would fight the Yjs origin model. |
| 6 | **`d3-scale` + `d3-shape` only** | Correct linear/log/time/band/point scales and curve generators are pure yak-shaving with zero product value. Both are MIT and tiny (~4KB + ~5KB). | Hand-rolling scales = days of work, no upside. Full `d3` = ~250KB+ of DOM manipulation we don't use. We hand-roll axes, ticks, legends, tooltips, and all mark rendering. |
| 7 | **Full scope, single plan, one deploy** | Explicitly chosen. Architecture fully designed up front; built in dependency order. | Phased release — rejected per request, but a hard checkpoint exists after the engine foundation (see Build order). |

## Architecture

```
 Browser (Next.js 16 App Router, React 19, TS, Tailwind 4)
 ┌─────────────────────────────────────────────────────────────┐
 │  UI chrome (React)          │  Engine (imperative, no React) │
 │  left rail / toolbar /      │  scene store, spatial index,   │
 │  inspector / palette        │  render loop, tools, input     │
 └──────────────┬──────────────┴───────────────┬────────────────┘
                │ useSyncExternalStore         │ Y.Map<Y.Map>
                │ (coarse events only)         │
                └──────────► scene store ◄──────┘
                             │
                    Y.Doc (one per board)
                             │ binary Yjs updates
                    YPartyKitProvider (awareness = presence)
                             │  WebSocket
 ┌───────────────────────────▼─────────────────────────────────┐
 │  PartyKit room  =  one per board                            │
 │  y-partykit onConnect(..., { persist: { mode: "snapshot" }, │
 │                              readOnly?: boolean })          │
 │  runs on Cloudflare Durable Objects (own account)           │
 └─────────────────────────────────────────────────────────────┘
                             │ periodic archive (safety net)
                    Vercel API route → object storage
```

### Vercel's actual role

- Next.js app + board list + board metadata CRUD (serverless, cheap, correct fit)
- Snapshot/archive API route
- **Not** the realtime transport. Realtime goes browser → PartyKit/Cloudflare directly. Never proxy a
  Yjs WebSocket through a Vercel function — the function dies at max duration and the socket with it.

## Data model

`Y.Map<Y.Map<any>>` keyed by node id. One nested `Y.Map` per node, so concurrent edits to *different
fields of the same node* merge instead of clobbering. This is the single most important structural
decision in the document model.

```ts
// ydoc.getMap('nodes'): nodeId -> Y.Map
type NodeBase = {
  id: string
  type: NodeType
  x: number; y: number          // world space
  w: number; h: number
  z: number                     // z-order via numeric sort + id tiebreak
  rotation: number              // radians
  opacity: number
  locked: boolean
  visible: boolean
  parentId: string | null       // group / frame nesting
}
```

**Z-order is a `z: number` field, not a `Y.Array`.** Reordering a Y.Array under concurrency produces
mangled orders; numeric sort with an id tiebreak is idempotent and can't corrupt.

### Node types

- **Shapes** — `rect`, `ellipse`, `diamond`, `pill`, `triangle`, `hexagon`, `cylinder`, `cloud`, `document`
- **Content** — `text` (rich runs), `sticky` (note + author + color), `image`
- **Lines** — `draw` (freehand points + pressure), `line`/`arrow` (polyline + heads), `connector` (bound to two node anchors, auto-routed)
- **Structure** — `frame` (labeled region — doubles as act/chapter), `group` (transform container)
- **Charts** — `chart` (see Chart engine)
- **Story** — `character`, `scene`, `beat`, `thread`, `location`

### Story node fields

- `character` — name, role, portrait, traits[], goal, flaw, arc (`flat|rise|fall|complex`), color, notes
- `scene` — title, povCharacterId, locationId, summary, chapterId (frame), order, status (`outline|draft|done`)
- `beat` — label, sceneId, timeLabel, kind (`action|dialogue|reaction|turning-point|climax`)
- `thread` — name, color, kind (`main|subplot|character`)
- `location` — name, description, image

**Typed edges.** Character relationships, scene→thread membership, and scene→beat ordering all reuse
the existing connector geometry with an added semantic payload (`threadId`, `kind`, `label`). The
lines get story-colored and story-labelled for free instead of needing a second edge system.

## Rendering

- Single `requestAnimationFrame` loop, devicePixelRatio-aware for crisp text.
- Viewport `{x, y, scale}` world↔screen transform.
- **Dirty-rectangle rendering** — mark bounds on change, repaint only those. This is the single
  biggest perf win during drag and it is not hard.
- **Uniform-grid spatial hash** rebuilt on node mutation, serving both viewport culling and hit
  testing. No dependency; O(1) queries; a 200-line data structure. Chosen over an R-tree because it
  is far easier to verify correct, and this workload is uniform-ish.
- Layer cache (static committed content on an offscreen canvas) is a documented upgrade point if
  frame times get tight — deliberately not built until measured.
- Text editing via a hidden `contenteditable` overlay positioned over the canvas, synced to the model
  on input. Same approach Excalidraw and tldraw use; the alternative (own caret/selection engine) is
  a multi-week mistake.

## Interaction

- Pointer Events with `getCoalescedEvents()` for pen smoothness.
- Tools: select, hand, shape, text, sticky, draw, connector, frame, chart.
- Selection: click, shift-add, marquee, select-all. Transform: 8 resize handles + rotate, with
  per-node delta transforms across a multi-selection.
- Snapping: edge/center alignment guides, grid snap, Figma-style smart guides.
- Full keyboard map + command palette.
- **Collab-critical rule:** during a drag, updates stay in a local preview overlay. Exactly **one**
  Yjs write on pointer-up. Continuous Yjs writes during a drag will flood the socket and make other
  people's cursors stutter. This is the #1 thing that separates a smooth collaborative canvas from a
  laggy one.
- Undo/redo via `Y.UndoManager` scoped with `trackedOrigins: new Set([LOCAL_ORIGIN])`, so I can't
  undo your edits — only my own.

## Story views

The document is read through four view modes. This is what makes it a story tool and not a whiteboard.

1. **Canvas** (default) — freeform, everything editable.
2. **Timeline** — scenes on a horizontal spine, plot threads as color-coded swimlanes, drag to reorder.
3. **Outline** — chapter → scene → beat tree, inline editable.
4. **Graph** — auto-laid-out character/relationship map (force or radial), typed edges.

## Chart engine

Full engine, per the decision above.

```ts
type ChartNode = {
  data:    { columns: {name, type:'string'|'number'|'date'}[], rows: Row[] }
  encoding: {
    mark: 'bar'|'line'|'area'|'pie'|'donut'|'scatter'|'point'
    x: string | { field, type:'linear'|'time'|'band'|'point' }
    y: string | { field, type, aggregate?:'sum'|'avg'|'count'|'min'|'max' }
    series?: string
  }
  config: { colors, legend, gridlines, axisLabels, stacked, smoothed, labels, tooltip }
}
```

`d3-scale` + `d3-shape` for scales and curves; we hand-roll tick generation, axes, legends, tooltips,
and all mark rendering on canvas. Data edited in an inline sheet view; charts can bind to story
metadata (e.g. tension per chapter) to stay domain-relevant.

## Security

- **Authorization is enforced in the PartyKit server**, via the `params: async () => ({ token })`
  client hook and a token check in `onConnect`. Hiding the UI is not access control.
- `readOnly: true` on the server for view-only share links.
- Board id is not a secret; the share token is. Random, high-entropy, rotatable.
- All input validated at the PartyKit boundary and again on import.
- Secrets in env vars only. Never in code, never client-side.

## Performance budget

| Metric | Target |
|---|---|
| Pan/zoom | 60fps with 2,000 visible nodes |
| Local drag | <50ms pointer→paint |
| Remote drag visible | <100ms |
| Cold join → interactive | <1.5s |
| Doc size | Compaction via snapshot mode; archive offload past ~8MB |

## Testing

Per house convention — `node:test`, `tsc --noEmit`, eslint flat config.

- **Unit (`node:test`, no canvas needed):** geometry, hit-testing, spatial index, rotation math,
  connector routing, scale/tick math, text measurement + wrapping, scene serialization, Yjs doc
  reducers.
- **Integration (Playwright, dev-only):** boot the app, draw a shape, type text, open two browser
  contexts and assert a node created in one appears in the other. This is the one flow that cannot be
  verified any other way, and Playwright is justified as a dev-only dependency.
- **Manual:** the perf budget table above, measured.

## App structure

```
src/
  app/                    Next.js routes + API routes
  board/engine/           the engine — zero React imports
    types.ts  geometry.ts  spatial.ts  text.ts  store.ts  connector.ts  snap.ts
    render/   renderer.ts  shapes.ts  connectors.ts  draw.ts
    tools/    registry.ts
    input/    pointer.ts  textEditor.ts  stroke.ts
  board/collab/           Yjs bridge, provider, presence
  board/ui/               left rail, inspector, presence bar
  board/views/            canvas / timeline / outline / graph  ← NOT BUILT
  story/                  domain types, templates               ← NOT BUILT
  lib/                    provider client, auth, share tokens   ← NOT BUILT
party/                    PartyKit server (deploys to Cloudflare)
```

The tree above is the target. Only the un-marked parts exist today — `PLAN.md` lists what is
actually built under **Status**, and the gap between the two is the remaining work, not a claim.

**React boundary rule:** the engine never imports React and never triggers a React render. It emits
coarse events (`selectionchange`, `toolchange`, `docstats`); chrome subscribes via
`useSyncExternalStore`. A re-render per frame is a bug, not a tuning issue.

**Chrome is a left rail, not a top navbar.**

## Build order

Full scope designed up front, but it still has to be *built* in dependency order. After **Step 3**
there is a **hard checkpoint**: the canvas feel is demonstrated, and if the interaction model is wrong
we change it before layers 4–8 exist to be rewritten.

1. Scaffold — Next 16 + TS + Tailwind 4, PartyKit, TypeScript aliases ✅
2. Engine foundation — geometry, viewport, render loop, dirty rects, spatial index, input ✅
3. ~~✅ CHECKPOINT~~ — skipped at user's request; combined into steps 1–2 above
4. Text engine + shapes + sticky + draw (pressure) ✅
5. Connectors, typed edges, frames, groups, snapping — **connectors + snapping done**, typed edges and
   grouping not started
6. Yjs document, PartyKit server, presence, undo/redo, share links — **collab core done**; share-link
   UI, `readOnly` and per-board tokens not started
7. Story domain — node types, templates, inspector
8. Chart engine
9. Timeline / outline / graph views
10. Chrome — rail, palette, command palette, inspector, panels
11. Export (PNG / SVG / JSON / Markdown), perf pass, hardening

## Spikes — unknowns to verify, not assume

- [ ] **PartyKit durability on cloud-prem.** Confirm the Yjs snapshot genuinely survives Worker
      eviction and redeploy, and find the practical per-document size ceiling. *Highest-risk item.*
- [ ] **Archive path.** The cloud-prem docs list KV/R2/D1 bindings as *future* work, so `y-partykit`'s
      custom `load()`/`callback` may not reach Cloudflare storage directly. Decide where the periodic
      archive actually lands (Vercel route → object storage) before Step 6.
- [ ] **Pointer/pressure behavior** across Linux, macOS, Windows for the `draw` tool.
- [ ] **Text layout under zoom** — measurement and wrap must be zoom-invariant and stay off the
      hot path.
- [ ] **Document growth** — measure real doc size for a full novel's worth of scenes and confirm the
      compaction + archive strategy holds.

## Verification

- [x] `tsc --noEmit` clean
- [x] `eslint` clean (flat config)
- [x] `node --test` unit suite green — 103/103
- [x] Canvas verified in a real browser — `npm run test:smoke`, 6/6 checks
- [x] Production build succeeds
- [ ] Playwright: two contexts, live co-edit verified
- [ ] Production deploy to Vercel
- [ ] PartyKit deployed to cloud-prem, board survives a full client disconnect cycle
- [ ] Perf budget table measured and met
- [ ] Auth check: an unauthorized token cannot read or write a board

## Status

**Steps 1, 2, 4, 6 built. Canvas visually verified 2026-09-29 — three real bugs found and fixed.**

Done: scaffold, engine foundation (geometry, viewport, render loop with dirty rects, spatial
index, two-stage hit testing), 9 shape kinds, text layout, sticky notes, pressure-aware freehand,
pointer state machine with preview-overlay commit, text editing overlay, left tool rail, and the
Yjs/PartyKit collaboration stack (nested `Y.Map` per node, `trackedOrigins` undo, presence,
`snapshot` persistence, constant-time token auth).

### First browser verification — 2026-09-29

The previous status note said the canvas had never been visually confirmed. It has now been driven
in a real browser via Playwright (`npm run test:smoke`, `test/smoke.mjs`). Screenshot:
`docs/verify-canvas-2026-09-29.png`. Three bugs that no static check could catch:

1. **Undo was a complete no-op.** `pushHistory()` ran in `afterCommit()`, i.e. *after* the mutation,
   so the undo stack stored post-edit state and restoring it changed nothing. Worse, the pointer
   path pushed twice (once via `commit`, once via `onTransientCommitted`), so the first undo popped
   a redundant entry. Fixed by capturing the undo point *before* mutating; the create path works
   because `snapshot` excludes transient nodes. Regression: `test/undo.test.ts`.
2. **Sticky note text never wrapped.** `drawSticky` passed `autoHeight: true`, which makes
   `layoutText` skip wrapping and return one long line, so note text overflowed and painted
   outside the note. Fixed to `false`. Regression: `test/sticky-wrap.test.ts`.
3. **The hover ring was dead code** — `hoverId` was computed in the pointer but never pushed to the
   renderer overlay. Noted, not yet fixed.

This is the argument for the browser harness existing at all: all 100 unit tests passed while undo
did nothing and notes overflowed. Pure-logic tests cannot see a render or a wiring bug.

### Connectors and snapping — 2026-09-29

Step 5 partially landed. `npm run test:smoke:connectors`, screenshot `docs/verify-connectors.png`.

Built: `connector.ts` (anchor resolution, elbow routing, path cleanup), `ConnectorNode`, the
`connector` tool and its rail icon, endpoint re-binding by dragging, orthogonal/straight routing,
arrowheads, labels knocked out of the line, and `snap.ts` (alignment guides + grid fallback).

Two design decisions that a later reader should not undo:

- **Connectors store node references, never points.** `fromId`/`toId` + a nullable side per end. That
  is what makes moving a node re-route the line for everyone, and what makes two people dragging the
  two ends conflict-free. A connector's `x/y/w/h` are *derived* — the bounding box of its route —
  and exist only so the spatial index can cull it.
- **Derived state is refreshed in exactly one place.** `afterChange()` runs at the end of every
  mutating store method. It was originally wired per-method, `addMany` was missed, and every
  connector created through a mutation kept `makeNode`'s 200×120 default: wrong culling box, and
  nonsense dimensions in the inspector. The screenshot caught it; the fix makes the omission
  structurally impossible rather than merely unlikely.

Deliberately excluded: resize handles and W/H inputs on connectors. Both invite an edit that the
next re-derivation silently reverts, which reads as the app ignoring you. Endpoints are dragged on
the canvas instead.

## Known gaps, carried forward

- **Undo without a bridge is snapshot-based.** O(whole scene) per entry, and it cannot distinguish my
  edits from a collaborator's. Ordering is now correct (see Status), but this path is still replaced
  wholesale by `Y.UndoManager` once a board is actually connected. Do not build features that depend
  on it. Note the default route never attaches a bridge, so local-only boards use this weaker path.
- **Rotation handles are not implemented.** Resize respects rotation, but there is no rotate handle
  or keyboard rotate yet. (`transform.rotateBy` exists and is unused.)
- **The hover ring never appears.** `PointerInput` computes `hoverId` but never calls
  `setOverlay({ hoverId })`, so `drawOverlays`' hover branch is unreachable. One-line fix; deferred
  because it is cosmetic and the task at hand is the collaboration layer.
- **Snapping and alignment guides ARE implemented** (see Status) and snap the whole selection as one
  box. Snapping a multi-selection is grid-fallback only in the sense that each axis is decided
  independently — a selection straddling two columns snaps to whichever is closer.
- **Connectors are implemented**; **typed edges and grouping are not** (step 5). A `GroupNode` type
  exists and the renderer draws its outline, but nothing creates or manages groups, and `parentId` is
  still unused. Frames render as labelled regions but are not containers either.
- **A connector endpoint drag has no browser test.** It is unit-tested for the store-level bind and
  unbind, and the gesture is wired, but no Playwright check yet drags an endpoint onto a third node.
  Do not assume it works.
- **`npm audit` reports 4 advisories**, all transitive through `partykit` → `miniflare` → `undici`
  (high) and `partykit` → `esbuild` (moderate). `partykit@0.0.115` is the latest release and
  `npm audit fix --force` "resolves" it by installing `partykit@0.0.0`, i.e. by deleting the
  package. Both land in the local dev toolchain, not the browser bundle or the deployed Worker.
  Accepted and documented; do not run `--force`. Revisit if partykit ships an update.

