/**
 * Exact hit testing.
 *
 * The spatial index answers "which nodes *could* be under this point" using axis-aligned boxes, and
 * that is the right trade for culling — but it is wrong for clicking. A diamond's bounding box has
 * four empty corners, and a triangle's has three, so an AABB-only test makes roughly a third of a
 * diamond clickable when nothing is drawn there. Catching that on a flowchart is maddening: you
 * keep grabbing the node you can see around.
 *
 * So this is a two-stage test. The index narrows the field cheaply, then every candidate is
 * confirmed against its real outline. The expensive part only ever runs on a handful of nodes.
 */

import type { Vec } from './geometry'
import { nodeBounds, type BoardNode } from './types'
import { worldToLocal } from './geometry'
import { distToStroke } from './render/draw'
import { hitShapeLocal } from './render/shapes'

/**
 * Does `p` hit this node's drawn area?
 *
 * `tolerance` is in world units and should come from screen pixels divided by zoom, so a thin
 * stroke stays clickable when zoomed out — at 10% zoom a 2px line is a fifth of a world unit and
 * would otherwise be impossible to grab.
 */
export function hitNode(node: BoardNode, p: Vec, tolerance: number): boolean {
  if (!node.visible) return false

  switch (node.type) {
    case 'shape': {
      const local = worldToLocal(p, node, node.rotation)
      return hitShapeLocal(node.shape, node.w, node.h, node.style.radius, local.x, local.y, tolerance)
    }
    case 'draw': {
      // Freehand has no interior, so it hits by proximity to the path itself.
      const local = worldToLocal(p, node, node.rotation)
      const pts = node.points.map((q) => ({ x: (q.x - 0.5) * node.w, y: (q.y - 0.5) * node.h }))
      if (pts.length === 0) return false
      const half = (node.baseWidth * (node.style.strokeWidth || 1)) / 2
      return distToStroke(pts, local) <= half + tolerance
    }
    case 'frame':
    case 'group':
      // Frames and groups are containers: you select them by their border or their contents, so a
      // filled test would swallow every click on the story laid out inside them.
      return hitBorder(nodeBounds(node), p, tolerance)
    default: {
      const b = nodeBounds(node)
      return (
        p.x >= b.x - tolerance &&
        p.x <= b.x + b.w + tolerance &&
        p.y >= b.y - tolerance &&
        p.y <= b.y + b.h + tolerance
      )
    }
  }
}

/** Within tolerance of a box's edge, but not inside it. */
function hitBorder(b: { x: number; y: number; w: number; h: number }, p: Vec, tolerance: number): boolean {
  const inside =
    p.x >= b.x - tolerance && p.x <= b.x + b.w + tolerance && p.y >= b.y - tolerance && p.y <= b.y + b.h + tolerance
  if (!inside) return false
  const nearLeft = Math.abs(p.x - b.x) <= tolerance
  const nearRight = Math.abs(p.x - (b.x + b.w)) <= tolerance
  const nearTop = Math.abs(p.y - b.y) <= tolerance
  const nearBottom = Math.abs(p.y - (b.y + b.h)) <= tolerance
  return nearLeft || nearRight || nearTop || nearBottom
}
