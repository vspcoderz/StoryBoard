/**
 * Viewport: the world ↔ screen transform, plus zoom clamping.
 *
 * Kept as a plain object with pure functions rather than a class so the render loop can read it
 * without allocating and tests can construct one without side effects.
 */

import type { Rect, Vec } from './geometry'
import { clamp } from './geometry'

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 32

export type Viewport = {
  /** World coordinate of the screen origin. */
  x: number
  y: number
  scale: number
}

export const viewport = (): Viewport => ({ x: 0, y: 0, scale: 1 })

export const toScreen = (p: Vec, vp: Viewport): Vec => ({
  x: (p.x - vp.x) * vp.scale,
  y: (p.y - vp.y) * vp.scale,
})

export const toWorld = (p: Vec, vp: Viewport): Vec => ({
  x: p.x / vp.scale + vp.x,
  y: p.y / vp.scale + vp.y,
})

export function zoomAt(vp: Viewport, screenPoint: Vec, factor: number): Viewport {
  const scale = clamp(vp.scale * factor, MIN_ZOOM, MAX_ZOOM)
  if (scale === vp.scale) return vp
  // Keep the world point under the cursor pinned. Without this, zooming walks the board away
  // from the pointer and it immediately feels wrong.
  const world = toWorld(screenPoint, vp)
  return { scale, x: world.x - screenPoint.x / scale, y: world.y - screenPoint.y / scale }
}

export function panBy(vp: Viewport, dxScreen: number, dyScreen: number): Viewport {
  return { ...vp, x: vp.x - dxScreen / vp.scale, y: vp.y - dyScreen / vp.scale }
}

/** The world-space rectangle currently visible, for culling. */
export function visibleWorldRect(vp: Viewport, width: number, height: number): Rect {
  return {
    x: vp.x,
    y: vp.y,
    w: width / vp.scale,
    h: height / vp.scale,
  }
}

/**
 * Size a canvas for the device pixel ratio.
 *
 * Every canvas in the engine goes through this. Getting it wrong is the difference between crisp
 * text and permanently blurry text, and it is invisible in a screenshot on a 1x display.
 */
export function fitCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number): CanvasRenderingContext2D {
  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.max(1, Math.round(cssW * dpr))
  const h = Math.max(1, Math.round(cssH * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}
