/**
 * Freehand stroke capture.
 *
 * Pressure is the whole point of a drawing tool and there is no single source of it. A pen reports
 * real pressure. A mouse reports a constant 0.5 while a button is down, which would give every
 * mouse stroke the same dead uniform width and feel broken next to a pen. So: take real pressure
 * when it exists, and derive it from stroke velocity when it does not — fast strokes thin out, slow
 * strokes thicken, which is how a real pen behaves and what the hand expects.
 */

import type { Vec } from '../geometry'
import { clamp, dist } from '../geometry'
import type { StrokePoint } from '../render/draw'

/** World units per second that maps to the thinnest stroke. Tuned by feel, not by principle. */
const MAX_SPEED = 1800
const SMOOTHING = 0.35

export class StrokeCapture {
  private pts: StrokePoint[] = []
  private last: Vec | null = null
  private smoothedPressure = 0.5

  get length(): number {
    return this.pts.length
  }

  get isEmpty(): boolean {
    return this.pts.length === 0
  }

  points(): StrokePoint[] {
    return this.pts
  }

  /**
   * Add a point. `minDistance` thins the input stream — a 1000Hz pen fires far more events than we
   * need to store, and every extra point costs memory, index churn and a wider sync payload.
   */
  add(p: Vec, pointerType: string, pressure: number, minDistance = 0.6): boolean {
    if (this.last) {
      const d = dist(p, this.last)
      if (d < minDistance) return false

      if (pointerType === 'pen' && pressure > 0) {
        // Pens occasionally report 0 for a single frame while starting a stroke; treating that as
        // real pressure would produce a visible pinch at the start of every stroke.
        this.smoothedPressure += (pressure - this.smoothedPressure) * 0.5
      } else {
        const speed = d / (1 / 120)
        const target = clamp(1 - speed / MAX_SPEED, 0.25, 1)
        this.smoothedPressure += (target - this.smoothedPressure) * SMOOTHING
      }
    } else {
      this.smoothedPressure = pointerType === 'pen' && pressure > 0 ? pressure : 0.6
    }

    this.pts.push({ x: p.x, y: p.y, p: clamp(this.smoothedPressure, 0.05, 1) })
    this.last = p
    return true
  }

  /** Bounding box of the captured points, with a minimum so a single dot still has a box. */
  bounds(min = 8): { x: number; y: number; w: number; h: number } {
    if (this.pts.length === 0) return { x: 0, y: 0, w: min, h: min }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of this.pts) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
    return {
      x: minX - min / 2,
      y: minY - min / 2,
      w: Math.max(min, maxX - minX + min),
      h: Math.max(min, maxY - minY + min),
    }
  }

  /**
   * Normalize captured points into the 0..1 space a draw node stores.
   *
   * Storing normalized means moving a stroke is a single `x`/`y` update rather than rewriting every
   * point — which matters a great deal when that move has to be replicated to everyone else.
   */
  toNormalized(): { x: number; y: number; p: number }[] {
    const b = this.bounds()
    return this.pts.map((p) => ({
      x: (p.x - b.x) / b.w,
      y: (p.y - b.y) / b.h,
      p: p.p,
    }))
  }

  /** The normalized points plus the box they were normalized against, ready to become a node. */
  finish(): { x: number; y: number; w: number; h: number; points: { x: number; y: number; p: number }[] } {
    const b = this.bounds()
    return { ...b, points: this.toNormalized() }
  }
}
