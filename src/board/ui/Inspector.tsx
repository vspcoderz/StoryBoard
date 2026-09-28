/**
 * Inspector — properties for the current selection.
 *
 * This is where a story tool earns its keep. A generic whiteboard stops at "here is a rectangle"; a
 * story tool has to answer "what kind of thing is this, and what does it mean to the plot".
 *
 * Every control is a real labelled form element. Placeholder-as-label is the single most common
 * accessibility failure in a panel like this, and it disappears the moment you start typing.
 */

'use client'

import { useEffect, useState } from 'react'
import type { Editor } from '../engine/editor'
import type { BoardNode, ShapeKind } from '../engine/types'

const SHAPE_LABEL: Record<ShapeKind, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  diamond: 'Decision',
  pill: 'Pill',
  triangle: 'Triangle',
  hexagon: 'Hexagon',
  cylinder: 'Database',
  cloud: 'Cloud',
  document: 'Document',
}

const TYPE_LABEL: Record<BoardNode['type'], string> = {
  shape: 'Shape',
  text: 'Text',
  sticky: 'Sticky note',
  draw: 'Drawing',
  frame: 'Frame',
  group: 'Group',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-graphite">{label}</span>
      {children}
    </label>
  )
}

const inputClass =
  'w-full rounded-md border border-line bg-sheet px-2 py-1.5 text-[13px] text-ink placeholder:text-quiet focus:border-brass'

export function Inspector({ editor, selection }: { editor: Editor | null; selection: string[] }) {
  const [node, setNode] = useState<BoardNode | null>(null)

  // Re-read the selected node when the selection changes or the document does. Cheap: this is one
  // object, and reading it on a timer would be a lie about when it is current.
  useEffect(() => {
    if (!editor) return
    const read = () => {
      const id = selection[0]
      setNode(id ? (editor.store.get(id) ?? null) : null)
    }
    read()
    return editor.store.on(read)
  }, [editor, selection])

  if (!editor) return null

  if (selection.length === 0) {
    return (
      <aside
        aria-label="Properties"
        className="flex w-64 shrink-0 flex-col gap-3 border-l border-line bg-desk p-3"
      >
        <h2 className="text-[11px] font-semibold text-graphite">Properties</h2>
        {/* An empty panel is an invitation to act, not an apology. */}
        <p className="text-[13px] leading-relaxed text-graphite">
          Select something to edit it. Press{' '}
          <kbd className="rounded border border-line bg-surface px-1 text-[11px]">1</kbd> to fit the
          whole board on screen, and hold <kbd className="rounded border border-line bg-surface px-1 text-[11px]">Space</kbd> to
          pan.
        </p>
      </aside>
    )
  }

  if (selection.length > 1) {
    return (
      <aside
        aria-label="Properties"
        className="flex w-64 shrink-0 flex-col gap-3 border-l border-line bg-desk p-3"
      >
        <h2 className="text-[11px] font-semibold text-graphite">{selection.length} selected</h2>
        <button
          type="button"
          onClick={() => editor.deleteSelection()}
          className="rounded-md border border-line bg-surface px-3 py-2 text-[13px] font-medium text-vermilion hover:bg-vermilion-wash"
        >
          Delete selection
        </button>
        <p className="text-[12px] text-graphite">Drag to move them together. Arrow keys nudge; hold Shift for larger steps.</p>
      </aside>
    )
  }

  if (!node) return null
  const s = node.style

  const patch = (p: Record<string, unknown>) => editor.patch(node.id, p)
  const patchStyle = (p: Record<string, unknown>) => patch({ style: { ...s, ...p } })

  return (
    <aside
      aria-label="Properties"
      className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l border-line bg-desk p-3"
    >
      <div>
        <h2 className="text-[11px] font-semibold text-graphite">Properties</h2>
        <p className="text-[13px] text-ink">
          {node.type === 'shape' ? SHAPE_LABEL[node.shape] : TYPE_LABEL[node.type]}
        </p>
      </div>

      {node.type !== 'draw' && node.type !== 'frame' && (
        <Field label="Text">
          <textarea
            className={`${inputClass} min-h-16 resize-y`}
            value={'text' in node ? (node.text as string) : ''}
            placeholder="Add a label"
            onChange={(e) => patch({ text: e.target.value })}
          />
        </Field>
      )}

      {node.type === 'shape' && (
        <Field label="Shape">
          <select
            className={inputClass}
            value={node.shape}
            onChange={(e) => patch({ shape: e.target.value as ShapeKind })}
          >
            {Object.entries(SHAPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Width">
          <input
            type="number"
            className={inputClass}
            value={Math.round(node.w)}
            onChange={(e) => patch({ w: Math.max(1, Number(e.target.value) || 1) })}
          />
        </Field>
        <Field label="Height">
          <input
            type="number"
            className={inputClass}
            value={Math.round(node.h)}
            onChange={(e) => patch({ h: Math.max(1, Number(e.target.value) || 1) })}
          />
        </Field>
      </div>

      <Field label="Fill">
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Fill colour"
            className="h-8 w-9 cursor-pointer rounded border border-line bg-sheet"
            value={s.fill ?? '#ffffff'}
            onChange={(e) => patchStyle({ fill: e.target.value })}
          />
          <button
            type="button"
            className="rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-graphite hover:text-ink"
            onClick={() => patchStyle({ fill: null })}
          >
            None
          </button>
        </div>
      </Field>

      <Field label="Outline">
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Outline colour"
            className="h-8 w-9 cursor-pointer rounded border border-line bg-sheet"
            value={s.stroke ?? '#000000'}
            onChange={(e) => patchStyle({ stroke: e.target.value })}
          />
          <input
            type="number"
            aria-label="Outline width"
            className={inputClass}
            value={s.strokeWidth}
            min={0}
            max={24}
            onChange={(e) => patchStyle({ strokeWidth: Math.max(0, Number(e.target.value) || 0) })}
          />
        </div>
      </Field>

      {node.type === 'text' || node.type === 'shape' || node.type === 'sticky' ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Size">
              <input
                type="number"
                className={inputClass}
                value={s.fontSize}
                min={8}
                max={96}
                onChange={(e) => patchStyle({ fontSize: Math.max(8, Number(e.target.value) || 8) })}
              />
            </Field>
            <Field label="Align">
              <select
                className={inputClass}
                value={s.align}
                onChange={(e) => patchStyle({ align: e.target.value })}
              >
                <option value="left">Left</option>
                <option value="center">Centre</option>
                <option value="right">Right</option>
              </select>
            </Field>
          </div>

          <Field label="Text colour">
            <input
              type="color"
              aria-label="Text colour"
              className="h-8 w-full cursor-pointer rounded border border-line bg-sheet"
              value={s.color}
              onChange={(e) => patchStyle({ color: e.target.value })}
            />
          </Field>
        </>
      ) : null}

      {node.type === 'frame' && (
        <Field label="Title">
          <input
            className={inputClass}
            value={node.title}
            onChange={(e) => patch({ title: e.target.value })}
          />
        </Field>
      )}

      <button
        type="button"
        onClick={() => editor.deleteSelection()}
        className="mt-1 rounded-md border border-line bg-surface px-3 py-2 text-[13px] font-medium text-vermilion hover:bg-vermilion-wash"
      >
        Delete
      </button>
    </aside>
  )
}
