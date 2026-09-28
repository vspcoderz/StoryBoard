/**
 * Text measurement and layout.
 *
 * The hard lesson from every canvas app ever written: text is the part you do not hand-roll. Caret
 * movement, selection ranges, IME composition and grapheme clusters are a browser's job. So we do
 * not build a text editor — we measure and lay out text ourselves, then hand the *editing* to a
 * hidden `contenteditable` positioned over the canvas. Everything below is measurement only.
 *
 * Measurement runs on its own offscreen context, never the render context. Sharing one context
 * would mean mutating `ctx.font` mid-frame to measure a string, which invalidates the render
 * state we just set up.
 */

import type { Style } from './types'

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const LINE_HEIGHT_RATIO = 1.25

/** CSS font shorthand. Order matters: weight/size/family, or the browser silently ignores it. */
export function fontString(style: Style): string {
  return `400 ${style.fontSize}px ${style.fontFamily}`
}

export function lineHeightFor(style: Style): number {
  return Math.round(style.fontSize * LINE_HEIGHT_RATIO)
}

export function measure(ctx: Ctx2D, text: string, style: Style): number {
  ctx.font = fontString(style)
  return ctx.measureText(text).width
}

/** Width of the widest single character — the floor for auto-sizing and minimum box width. */
function widestChar(ctx: Ctx2D, style: Style): number {
  ctx.font = fontString(style)
  let best = 0
  for (const ch of 'MW@#%mw') best = Math.max(best, ctx.measureText(ch).width)
  return best
}

/**
 * Break a single line to fit `maxWidth`.
 *
 * Splits on spaces, and force-breaks any single token that is itself too long. That second case is
 * why this is not `text.split(' ')` — a pasted URL in a narrow text box must wrap rather than
 * overflow or vanish.
 */
function breakToken(ctx: Ctx2D, token: string, style: Style, maxWidth: number): string[] {
  const out: string[] = []
  let line = ''
  for (const ch of token) {
    const attempt = line + ch
    if (line && ctx.measureText(attempt).width > maxWidth) {
      out.push(line)
      line = ch
    } else {
      line = attempt
    }
  }
  if (line) out.push(line)
  return out
}

/** Word-wrap `text` to `maxWidth`, honouring explicit newlines. */
export function wrapText(ctx: Ctx2D, text: string, style: Style, maxWidth: number): string[] {
  ctx.font = fontString(style)
  if (maxWidth <= 0) return text.split('\n')
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('')
      continue
    }
    const words = paragraph.split(/(\s+)/).filter((s) => s !== '')
    let line = ''
    for (const word of words) {
      const attempt = line + word
      if (ctx.measureText(attempt).width > maxWidth) {
        // Flush first, but only if there is something to flush. Testing the width unconditionally
        // is what makes an over-long *first* token (a pasted URL) get force-broken instead of
        // overflowing — guarding on `line` being non-empty silently skipped exactly that case.
        if (line) lines.push(line.trimEnd())
        if (ctx.measureText(word).width > maxWidth) {
          const parts = breakToken(ctx, word, style, maxWidth)
          for (let i = 0; i < parts.length - 1; i++) lines.push(parts[i])
          line = parts[parts.length - 1]
        } else {
          line = word.trimStart()
        }
      } else {
        line = attempt
      }
    }
    lines.push(line.trimEnd())
  }
  return lines
}

export type TextLayout = {
  lines: string[]
  /** Natural width of the widest wrapped line. */
  width: number
  height: number
  lineHeight: number
  fontSize: number
}

/**
 * Lay text out inside a box.
 *
 * `autoHeight` means the box is sized to the content instead of the content being fitted to the
 * box. This is the difference between a text box that feels like a text editor and one that fights
 * you, so both behaviours need to exist.
 */
export function layoutText(
  ctx: Ctx2D,
  text: string,
  style: Style,
  boxW: number,
  boxH: number,
  autoHeight: boolean,
): TextLayout {
  ctx.font = fontString(style)
  const lineHeight = lineHeightFor(style)

  if (autoHeight) {
    const lines = text.split('\n')
    const width = Math.max(widestChar(ctx, style), ...lines.map((l) => ctx.measureText(l).width))
    return { lines, width, height: lines.length * lineHeight, lineHeight, fontSize: style.fontSize }
  }

  const lines = wrapText(ctx, text, style, boxW)
  const width = Math.max(0, ...lines.map((l) => ctx.measureText(l).width))
  return { lines, width, height: lines.length * lineHeight, lineHeight, fontSize: style.fontSize }
}

/** Offset of the first baseline within a line box, so text sits optically centred. */
export function baselineOffset(style: Style, lineHeight: number): number {
  return (lineHeight + style.fontSize * 0.7) / 2
}

/** Pixel offset of (line, column) in laid-out text. Used to place the editing caret overlay. */
export function offsetOf(
  ctx: Ctx2D,
  layout: TextLayout,
  style: Style,
  line: number,
  column: number,
): { x: number; y: number } {
  ctx.font = fontString(style)
  const text = layout.lines[Math.min(Math.max(line, 0), layout.lines.length - 1)] ?? ''
  return {
    x: ctx.measureText(text.slice(0, column)).width,
    y: line * layout.lineHeight + baselineOffset(style, layout.lineHeight),
  }
}
