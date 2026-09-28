/**
 * Tool registry.
 *
 * A tool is a pure description of "what a drag on empty canvas will create". Keeping creation here
 * rather than in the pointer state machine means the tool palette, keyboard shortcuts and the
 * pointer handler all agree on the same defaults without any of them duplicating the rule.
 */

import type { ShapeKind } from '../types'
import { DEFAULT_STYLE, makeNode, type BoardNode, type Style } from '../types'

export type Tool =
  | { kind: 'select' }
  | { kind: 'hand' }
  | { kind: 'shape'; shape: ShapeKind }
  | { kind: 'text' }
  | { kind: 'sticky' }
  | { kind: 'draw' }
  | { kind: 'frame' }

export type ToolDef = {
  tool: Tool
  label: string
  /** Single-key shortcut, lowercase. */
  key: string
  cursor: string
  style: Partial<Style>
  size: { w: number; h: number }
}

const SHAPE_CURSOR = 'crosshair'

const shapeDef = (shape: ShapeKind, label: string, key: string, size: { w: number; h: number }): ToolDef => ({
  tool: { kind: 'shape', shape },
  label,
  key,
  cursor: SHAPE_CURSOR,
  style: {},
  size,
})

export const TOOLS: ToolDef[] = [
  { tool: { kind: 'select' }, label: 'Select', key: 'v', cursor: 'default', style: {}, size: { w: 0, h: 0 } },
  { tool: { kind: 'hand' }, label: 'Pan', key: 'h', cursor: 'grab', style: {}, size: { w: 0, h: 0 } },
  shapeDef('rect', 'Rectangle', 'r', { w: 200, h: 140 }),
  shapeDef('ellipse', 'Ellipse', 'o', { w: 180, h: 180 }),
  shapeDef('diamond', 'Decision', 'd', { w: 220, h: 140 }),
  shapeDef('pill', 'Pill', 'p', { w: 180, h: 72 }),
  shapeDef('triangle', 'Triangle', 't', { w: 180, h: 140 }),
  shapeDef('hexagon', 'Hexagon', 'x', { w: 200, h: 160 }),
  shapeDef('cylinder', 'Database', 'y', { w: 200, h: 160 }),
  shapeDef('cloud', 'Cloud', 'c', { w: 220, h: 160 }),
  shapeDef('document', 'Document', 'm', { w: 200, h: 160 }),
  {
    tool: { kind: 'text' },
    label: 'Text',
    key: 't2',
    cursor: 'text',
    style: { fill: null, stroke: null, color: '#1e1b4b', fontSize: 20, align: 'left', valign: 'top' },
    size: { w: 260, h: 40 },
  },
  {
    tool: { kind: 'sticky' },
    label: 'Sticky note',
    key: 'n',
    cursor: 'copy',
    style: { fill: '#fde68a', stroke: '#d97706', color: '#422006', align: 'left', valign: 'top', radius: 4 },
    size: { w: 180, h: 180 },
  },
  {
    tool: { kind: 'draw' },
    label: 'Draw',
    key: 'b',
    cursor: 'crosshair',
    style: { color: '#1e1b4b' },
    size: { w: 0, h: 0 },
  },
  {
    tool: { kind: 'frame' },
    label: 'Frame',
    key: 'f',
    cursor: SHAPE_CURSOR,
    style: { fill: 'rgba(255,255,255,0.55)', stroke: '#a5a5c8' },
    size: { w: 640, h: 480 },
  },
]

export const toolByKey = (key: string): ToolDef | undefined =>
  TOOLS.find((t) => t.key === key)

export const toolDef = (tool: Tool): ToolDef =>
  TOOLS.find((t) => JSON.stringify(t.tool) === JSON.stringify(tool)) ?? TOOLS[0]

/** Merge a tool's style defaults under the shared defaults, without mutating DEFAULT_STYLE. */
export function styleFor(tool: Tool): Style {
  return { ...DEFAULT_STYLE, ...toolDef(tool).style }
}

/**
 * Build the node a drag should create.
 *
 * `x`/`y` is the world-space top-left; the caller has already normalised the drag rect.
 */
export function createNode(tool: Tool, rect: { x: number; y: number; w: number; h: number }, z: number): BoardNode | null {
  const style = styleFor(tool)
  switch (tool.kind) {
    case 'shape':
      return makeNode({
        type: 'shape',
        shape: tool.shape,
        text: '',
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        z,
        style,
      })
    case 'text':
      return makeNode({
        type: 'text',
        text: '',
        autoHeight: true,
        x: rect.x,
        y: rect.y,
        w: Math.max(rect.w, 40),
        h: Math.max(rect.h, 24),
        z,
        style,
      })
    case 'sticky':
      return makeNode({ type: 'sticky', text: '', author: null, x: rect.x, y: rect.y, w: rect.w, h: rect.h, z, style })
    case 'frame':
      return makeNode({ type: 'frame', title: 'Frame', x: rect.x, y: rect.y, w: rect.w, h: rect.h, z, style })
    default:
      return null
  }
}
