/**
 * Node model.
 *
 * Every node carries a numeric `z` rather than living in an ordered collection. Yjs sequences
 * (Y.Array) corrupt their own order under concurrent reordering — two people dragging the same two
 * items in opposite directions produces a state neither of them asked for and that cannot be
 * repaired. A numeric sort with an id tiebreak is idempotent, so "broken" is impossible.
 *
 * `x`/`y` is the top-left corner and rotation is in radians about the node's center. Top-left rather
 * than center-origin because it makes the spatial index and marquee maths far less error-prone;
 * rotation is normalized to a single center so the two never disagree.
 */

export type ShapeKind =
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'pill'
  | 'triangle'
  | 'hexagon'
  | 'cylinder'
  | 'cloud'
  | 'document'

/** How a shape is filled and stroked. `null` fill means unfilled. */
export type Style = {
  fill: string | null
  stroke: string | null
  strokeWidth: number
  /** Dash pattern in world units, or null for solid. */
  dash: number[] | null
  /** Corner radius, used by rect/pill/document. */
  radius: number
  fontFamily: string
  fontSize: number
  color: string
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
}

export const DEFAULT_STYLE: Style = {
  fill: '#e8e6ff',
  stroke: '#4f46e5',
  strokeWidth: 2,
  dash: null,
  radius: 8,
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  fontSize: 16,
  color: '#1e1b4b',
  align: 'center',
  valign: 'middle',
}

export type NodeBase = {
  id: string
  x: number
  y: number
  w: number
  h: number
  z: number
  /** Radians, about the node center. Kept in [0, 2π) by the transform code. */
  rotation: number
  opacity: number
  locked: boolean
  visible: boolean
  parentId: string | null
  style: Style
}

export type ShapeNode = NodeBase & {
  type: 'shape'
  shape: ShapeKind
  /** Optional label. Shapes are text-capable, not text-only — a flowchart node has both. */
  text: string
}

export type TextNode = NodeBase & {
  type: 'text'
  text: string
  /** When true the box grows to fit the text instead of wrapping to `w`. */
  autoHeight: boolean
}

export type StickyNode = NodeBase & {
  type: 'sticky'
  text: string
  author: string | null
}

/** A freehand stroke. Points are normalized to 0..1 within the node's box. */
export type DrawNode = NodeBase & {
  type: 'draw'
  points: { x: number; y: number; p: number }[]
  /** Stroke width at pressure 1.0. Actual width scales with per-point pressure. */
  baseWidth: number
}

export type FrameNode = NodeBase & {
  type: 'frame'
  title: string
}

export type GroupNode = NodeBase & {
  type: 'group'
  childIds: string[]
}

export type BoardNode =
  | ShapeNode
  | TextNode
  | StickyNode
  | DrawNode
  | FrameNode
  | GroupNode

export type NodeType = BoardNode['type']

export function newId(): string {
  return crypto.randomUUID()
}

/** A fresh node with defaults filled in. Callers override what they care about. */
export function makeNode<T extends BoardNode>(partial: Partial<T> & Pick<T, 'type'>): T {
  return {
    id: newId(),
    x: 0,
    y: 0,
    w: 200,
    h: 120,
    z: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    parentId: null,
    style: { ...DEFAULT_STYLE },
    ...partial,
  } as T
}

/**
 * Axis-aligned bounds of a node, accounting for rotation. The spatial index and the renderer both
 * cull with this, so it must be a conservative superset of the drawn shape — never a subset, or
 * nodes vanish at the edge of the viewport.
 */
export function nodeBounds(
  n: Pick<NodeBase, 'x' | 'y' | 'w' | 'h' | 'rotation'>,
): { x: number; y: number; w: number; h: number } {
  if (!n.rotation) return { x: n.x, y: n.y, w: n.w, h: n.h }
  const cx = n.x + n.w / 2
  const cy = n.y + n.h / 2
  const hw = n.w / 2
  const hh = n.h / 2
  const cos = Math.cos(n.rotation)
  const sin = Math.sin(n.rotation)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [dx, dy] of [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ] as const) {
    const px = cx + dx * cos - dy * sin
    const py = cy + dx * sin + dy * cos
    if (px < minX) minX = px
    if (py < minY) minY = py
    if (px > maxX) maxX = px
    if (py > maxY) maxY = py
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}
