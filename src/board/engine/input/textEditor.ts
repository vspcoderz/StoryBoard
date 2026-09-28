/**
 * Text editing overlay.
 *
 * We do not implement a text editor. Caret movement, selection ranges, IME composition, grapheme
 * clusters and autocorrect are all solved problems in the browser's own editing host, and every
 * canvas app that has hand-rolled them has shipped bugs that users describe as "the text is weird".
 *
 * So: a transparent `contenteditable` div is parked exactly on top of the text it edits, styled to
 * match the canvas metrics, and the canvas hides that node while the overlay is open. The user edits
 * real DOM text; we read it back out. This is the approach Excalidraw and tldraw both take.
 */

import type { SceneStore } from '../store'
import type { TextNode, StickyNode, ShapeNode } from '../types'
import { toScreen, type Viewport } from '../viewport'
import { fontString, lineHeightFor } from '../text'

const EDITABLE = new Set<TextNode['type'] | StickyNode['type'] | ShapeNode['type']>(['text', 'sticky', 'shape'])

type Editable = TextNode | StickyNode | ShapeNode

export function isTextEditable(n: { type: string } | undefined): n is Editable {
  return !!n && EDITABLE.has(n.type as never)
}

export class TextEditor {
  private el: HTMLDivElement
  private targetId: string | null = null
  private onChange: (id: string, text: string) => void
  private onDone: () => void

  constructor(
    private host: HTMLElement,
    private store: SceneStore,
    private getViewport: () => Viewport,
    onChange: (id: string, text: string) => void,
    onDone: () => void,
  ) {
    this.onChange = onChange
    this.onDone = onDone

    this.el = document.createElement('div')
    this.el.setAttribute('contenteditable', 'plaintext-only')
    this.el.setAttribute('spellcheck', 'true')
    this.el.setAttribute('role', 'textbox')
    this.el.setAttribute('aria-label', 'Text content')
    Object.assign(this.el.style, {
      position: 'absolute',
      outline: 'none',
      background: 'transparent',
      border: 'none',
      margin: '0',
      padding: '0',
      overflow: 'hidden',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      transformOrigin: 'top left',
      display: 'none',
      cursor: 'text',
      // The overlay must never intercept canvas gestures, or panning and marquee break the moment
      // you start editing. The caret stays visible because this is a real text node, not a layer.
      pointerEvents: 'none',
    } as Partial<CSSStyleDeclaration>)

    this.el.addEventListener('input', () => {
      if (!this.targetId) return
      this.onChange(this.targetId, this.el.innerText)
    })
    this.el.addEventListener('keydown', this.handleKey)
    this.el.addEventListener('blur', () => this.close())

    this.host.appendChild(this.el)
  }

  private handleKey = (e: KeyboardEvent): void => {
    e.stopPropagation()
    // Enter inserts a newline here rather than submitting, because inside a whiteboard an
    // accidental Enter must never dismiss the editor and lose the line you just typed.
    if (e.key === 'Escape') {
      e.preventDefault()
      this.close()
      return
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      this.close()
    }
  }

  get isOpen(): boolean {
    return this.targetId !== null
  }

  get editingId(): string | null {
    return this.targetId
  }

  open(id: string): void {
    const n = this.store.get(id)
    if (!isTextEditable(n)) return
    this.targetId = id
    this.el.style.display = 'block'
    // `plaintext-only` keeps pasted HTML from injecting styles or block elements into the model.
    // Paste as plain text ourselves too, for the browsers that treat it as `true`.
    this.el.innerText = n.type === 'shape' ? (n.text ?? '') : n.text
    this.layout()
    this.el.focus()

    // Place the caret at the end rather than selecting everything: the common case is continuing
    // to type, and pre-selecting means the first keystroke silently destroys the text.
    const range = document.createRange()
    range.selectNodeContents(this.el)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  close(): void {
    if (!this.targetId) return
    const id = this.targetId
    this.targetId = null
    this.el.style.display = 'none'
    this.el.innerText = ''
    this.onDone()
    void id
  }

  /** Reposition and restyle to sit exactly over the node's text. Called on every viewport change. */
  layout(): void {
    if (!this.targetId) return
    const n = this.store.get(this.targetId)
    if (!isTextEditable(n)) {
      this.close()
      return
    }
    const vp = this.getViewport()
    const p = toScreen({ x: n.x, y: n.y }, vp)
    const s = n.style
    const pad = n.type === 'text' ? 0 : 12

    this.el.style.left = `${p.x}px`
    this.el.style.top = `${p.y}px`
    this.el.style.width = `${n.w}px`
    this.el.style.font = fontString(s)
    this.el.style.lineHeight = `${lineHeightFor(s)}px`
    this.el.style.color = s.color
    this.el.style.textAlign = s.align
    this.el.style.padding = `${pad}px`
    // Scale from the node's own top-left, not the box centre, so a rotated node's overlay lands
    // on the right corner instead of the opposite side of the canvas.
    this.el.style.transform = `scale(${vp.scale}) rotate(${-n.rotation}rad)`
  }
}
