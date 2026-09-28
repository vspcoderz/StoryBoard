/**
 * The left tool rail.
 *
 * A rail, not a navbar and not tabs. It is a fixed vertical strip: tools are a mode switch, and mode
 * switchers belong on the left edge where the pointer already is. Everything here is coarse state
 * only — no per-frame React.
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
}

const keyOf = (t: Tool): string => (t.kind === 'shape' ? t.shape : t.kind)

type Props = {
  tool: Tool
  onTool: (t: Tool) => void
  onUndo: () => void
  onRedo: () => void
  onFit: () => void
}

export function ToolRail({ tool, onTool, onUndo, onRedo, onFit }: Props) {
  const active = keyOf(tool)
  return (
    <aside className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-neutral-200 bg-white py-2">
      {TOOLS.map((def) => {
        const k = keyOf(def.tool)
        const Icon = ICONS[k] ?? IconRect
        const isActive = k === active
        return (
          <button
            key={k}
            type="button"
            title={`${def.label}  ·  ${def.key}`}
            aria-label={def.label}
            aria-pressed={isActive}
            onClick={() => onTool(def.tool)}
            className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
              isActive
                ? 'bg-indigo-600 text-white'
                : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'
            }`}
          >
            <Icon />
          </button>
        )
      })}

      <div className="my-1 h-px w-7 bg-neutral-200" />

      <button
        type="button"
        title="Undo  ·  ⌘Z"
        aria-label="Undo"
        onClick={onUndo}
        className="flex h-10 w-10 items-center justify-center rounded-lg text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
      >
        <IconUndo />
      </button>
      <button
        type="button"
        title="Redo  ·  ⌘⇧Z"
        aria-label="Redo"
        onClick={onRedo}
        className="flex h-10 w-10 items-center justify-center rounded-lg text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
      >
        <IconRedo />
      </button>
      <button
        type="button"
        title="Zoom to fit  ·  1"
        aria-label="Zoom to fit"
        onClick={onFit}
        className="flex h-10 w-10 items-center justify-center rounded-lg text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
      >
        <IconFit />
      </button>
    </aside>
  )
}
