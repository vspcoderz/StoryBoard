/**
 * The left tool rail.
 *
 * A rail, not a navbar and not tabs. Tools are a mode switch, and mode switchers belong on the left
 * edge where the pointer already is. Nothing here reads per-frame state.
 *
 * Accessibility notes that are not decoration:
 * - 40px targets, above the 28px desktop default, because a toolbar you miss while aiming at a
 *   canvas is worse than a slightly chunky one.
 * - `aria-pressed` on every tool, so a screen reader announces which mode is active rather than
 *   leaving the user to infer it from the highlight.
 * - Grouped by role with a real `role="group"` and a label. A vertical stack of twenty unlabelled
 *   buttons is a wall of noise to anyone navigating by keyboard.
 */

'use client'

import type { ComponentType } from 'react'
import { TOOLS, type Tool } from '@/board/engine/tools/registry'
import {
  IconCloud,
  IconCylinder,
  IconDiamond,
  IconDocument,
  IconDraw,
  IconEllipse,
  IconFit,
  IconFrame,
  IconConnector,
  IconHand,
  IconHexagon,
  IconPill,
  IconRect,
  IconRedo,
  IconSelect,
  IconSticky,
  IconText,
  IconTriangle,
  IconUndo,
} from './icons'

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  select: IconSelect,
  hand: IconHand,
  rect: IconRect,
  ellipse: IconEllipse,
  diamond: IconDiamond,
  pill: IconPill,
  triangle: IconTriangle,
  hexagon: IconHexagon,
  cylinder: IconCylinder,
  cloud: IconCloud,
  document: IconDocument,
  text: IconText,
  sticky: IconSticky,
  draw: IconDraw,
  frame: IconFrame,
  connector: IconConnector,
}

const keyOf = (t: Tool): string => (t.kind === 'shape' ? t.shape : t.kind)

/** Split so the two groups can each carry a label without a heading eating vertical space. */
const PRIMARY = [
  'select',
  'hand',
  'rect',
  'ellipse',
  'diamond',
  'connector',
  'sticky',
  'text',
  'draw',
  'frame',
]
const SECONDARY = ['triangle', 'hexagon', 'cylinder', 'cloud', 'document', 'pill']

type Props = {
  tool: Tool
  onTool: (t: Tool) => void
  onUndo: () => void
  onRedo: () => void
  onFit: () => void
  canUndo: boolean
  canRedo: boolean
}

function ToolButton({
  def,
  active,
  onClick,
}: {
  def: (typeof TOOLS)[number]
  active: boolean
  onClick: () => void
}) {
  const k = keyOf(def.tool)
  const Icon = ICONS[k] ?? IconRect
  return (
    <button
      type="button"
      title={`${def.label}  ·  ${def.key}`}
      aria-label={def.label}
      aria-pressed={active}
      aria-keyshortcuts={def.key}
      onClick={onClick}
      className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
        active
          ? 'bg-brass text-sheet'
          : 'text-graphite hover:bg-line-soft hover:text-ink'
      }`}
    >
      <Icon />
    </button>
  )
}

export function ToolRail({ tool, onTool, onUndo, onRedo, onFit, canUndo, canRedo }: Props) {
  const active = keyOf(tool)
  const byKey = new Map(TOOLS.map((d) => [keyOf(d.tool), d]))
  const render = (keys: string[]) =>
    keys
      .map((k) => byKey.get(k))
      .filter((d): d is (typeof TOOLS)[number] => !!d)
      .map((def) => (
        <ToolButton
          key={keyOf(def.tool)}
          def={def}
          active={keyOf(def.tool) === active}
          onClick={() => onTool(def.tool)}
        />
      ))

  return (
    <aside
      aria-label="Tools"
      className="flex w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-line bg-desk py-2"
    >
      <div role="group" aria-label="Drawing tools" className="flex flex-col items-center gap-1">
        {render(PRIMARY)}
      </div>

      <div className="my-1 h-px w-7 bg-line" />

      <div role="group" aria-label="More shapes" className="flex flex-col items-center gap-1">
        {render(SECONDARY)}
      </div>

      <div className="my-1 h-px w-7 bg-line" />

      <div role="group" aria-label="History and view" className="flex flex-col items-center gap-1">
        <button
          type="button"
          title="Undo  ·  ⌘Z"
          aria-label="Undo"
          aria-keyshortcuts="Meta+Z"
          disabled={!canUndo}
          onClick={onUndo}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent"
        >
          <IconUndo />
        </button>
        <button
          type="button"
          title="Redo  ·  ⌘⇧Z"
          aria-label="Redo"
          aria-keyshortcuts="Meta+Shift+Z"
          disabled={!canRedo}
          onClick={onRedo}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent"
        >
          <IconRedo />
        </button>
        <button
          type="button"
          title="Zoom to fit  ·  1"
          aria-label="Zoom to fit"
          aria-keyshortcuts="1"
          onClick={onFit}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-graphite hover:bg-line-soft hover:text-ink"
        >
          <IconFit />
        </button>
      </div>
    </aside>
  )
}
