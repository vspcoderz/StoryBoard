/**
 * Transform maths: resizing selections.
 *
 * The subtle part is that a node's `x`/`y`/`w`/`h` is its *unrotated* box in world space, while the
 * selection outline is an axis-aligned union of rotated boxes. Resizing from the union's handles
 * therefore has to work in the union's frame for multi-selects, but in the node's own frame for a
 * single rotated node — otherwise dragging the east handle of a 45°-rotated rect squashes it along
 * the wrong axis and the rotation visibly drifts.
 */

import type { Rect, Vec } from './geometry'
import { normAngle, worldToLocal, localToWorld, rectCenter, clamp } from './geometry'

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export type Handle = {
  id: HandleId
  /** Unit-square position within the selection box, used for hit testing and handle placement. */
  fx: number
  fy: number
  cursor: string
  /** Which axes this handle moves. */
  ax: -1 | 0 | 1
  ay: -1 | 0 | 1
}

export const HANDLES: Handle[] = [
  { id: 'nw', fx: 0, fy: 0, cursor: 'nwse-resize', ax: -1, ay: -1 },
  { id: 'n', fx: 0.5, fy: 0, cursor: 'ns-resize', ax: 0, ay: -1 },
  { id: 'ne', fx: 1, fy: 0, cursor: 'nesw-resize', ax: 1, ay: -1 },
  { id: 'e', fx: 1, fy: 0.5, cursor: 'ew-resize', ax: 1, ay: 0 },
  { id: 'se', fx: 1, fy: 1, cursor: 'nwse-resize', ax: 1, ay: 1 },
  { id: 's', fx: 0.5, fy: 1, cursor: 'ns-resize', ax: 0, ay: 1 },
  { id: 'sw', fx: 0, fy: 1, cursor: 'nesw-resize', ax: -1, ay: 1 },
  { id: 'w', fx: 0, fy: 0.5, cursor: 'ew-resize', ax: -1, ay: 0 },
]

export const MIN_SIZE = 8

/** Which handle is within `tol` screen pixels of a point, given the selection box in screen space. */
export function handleAt(
  box: Rect,
  p: Vec,
  tol: number,
): Handle | null {
  for (const h of HANDLES) {
    const hx = box.x + box.w * h.fx
    const hy = box.y + box.h * h.fy
    if (Math.abs(p.x - hx) <= tol && Math.abs(p.y - hy) <= tol) return h
  }
  return null
}

/**
 * Resize an axis-aligned box by dragging `handle` to `pointer`.
 *
 * `fromCenter` (alt-drag) keeps the centre fixed, which is how every design tool lets you grow a
 * shape symmetrically.
 */
export function resizeRect(
  start: Rect,
  handle: HandleId,
  pointer: Vec,
  opts: { min?: number; fromCenter?: boolean } = {},
): Rect {
  const min = opts.min ?? MIN_SIZE
  const h = HANDLES.find((x) => x.id === handle)!
  const c = rectCenter(start)
  let left = start.x
  let right = start.x + start.w
  let top = start.y
  let bottom = start.y + start.h

  if (h.ax !== 0) {
    const edge = h.ax < 0 ? pointer.x : pointer.x
    if (h.ax < 0) left = Math.min(edge, right - min)
    else right = Math.max(edge, left + min)
  }
  if (h.ay !== 0) {
    const edge = pointer.y
    if (h.ay < 0) top = Math.min(edge, bottom - min)
    else bottom = Math.max(edge, top + min)
  }

  if (opts.fromCenter) {
    // Symmetric about the original centre: whatever the pointer does to one edge, mirror on the other.
    if (h.ax !== 0) {
      if (h.ax < 0) {
        const w = clamp(c.x - pointer.x, min, (c.x - start.x) * 2 || min)
        left = c.x - w
        right = c.x + w
      } else {
        const w = clamp(pointer.x - c.x, min, (start.x + start.w - c.x) * 2 || min)
        left = c.x - w
        right = c.x + w
      }
    }
    if (h.ay !== 0) {
      if (h.ay < 0) {
        const hgt = clamp(c.y - pointer.y, min, (c.y - start.y) * 2 || min)
        top = c.y - hgt
        bottom = c.y + hgt
      } else {
        const hgt = clamp(pointer.y - c.y, min, (start.y + start.h - c.y) * 2 || min)
        top = c.y - hgt
        bottom = c.y + hgt
      }
    }
  }

  return { x: left, y: top, w: right - left, h: bottom - top }
}

/** Map a box from one frame into another proportionally. This is how multi-select scaling works. */
export function remapRect(r: Rect, from: Rect, to: Rect): Rect {
  if (from.w === 0 || from.h === 0) return { ...to }
  const fx = (r.x - from.x) / from.w
  const fy = (r.y - from.y) / from.h
  return {
    x: to.x + fx * to.w,
    y: to.y + fy * to.h,
    w: (r.w / from.w) * to.w,
    h: (r.h / from.h) * to.h,
  }
}

/** Resize one node in its own rotated frame, so the rotation is preserved exactly. */
export function resizeRotated(
  box: Rect,
  rotation: number,
  handle: HandleId,
  pointer: Vec,
  opts: { min?: number } = {},
): Rect {
  if (!rotation) return resizeRect(box, handle, pointer, opts)
  const localStart: Rect = { x: -box.w / 2, y: -box.h / 2, w: box.w, h: box.h }
  const localPointer = worldToLocal(pointer, box, rotation)
  const next = resizeRect(localStart, handle, localPointer, opts)
  // Local-space centre moves as the box resizes; convert that offset back to world.
  const localOffset = {
    x: next.x + next.w / 2,
    y: next.y + next.h / 2,
  }
  const worldOffset = localToWorld(localOffset, box, rotation)
  const c = rectCenter(box)
  return {
    x: c.x + (worldOffset.x - c.x) - next.w / 2,
    y: c.y + (worldOffset.y - c.y) - next.h / 2,
    w: next.w,
    h: next.h,
  }
}

/** Snap a value to a grid, but only when the grid is coarse enough to be useful at this zoom. */
export function snap(value: number, grid: number): number {
  if (grid <= 0) return value
  return Math.round(value / grid) * grid
}

export function rotateBy(current: number, delta: number): number {
  return normAngle(current + delta)
}
