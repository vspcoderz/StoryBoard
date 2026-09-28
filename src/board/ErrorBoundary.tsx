'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Error boundary.
 *
 * A whiteboard holds someone's unfinished work. If a render throws, the correct behaviour is to say
 * so plainly and keep the document reachable — not to unmount the canvas and leave a blank page
 * that looks like data loss. The boundary is deliberately chatty about that, because "the app broke"
 * and "your work is gone" are very different messages and people assume the worst.
 */

type Props = { children: ReactNode; onReset?: () => void }
type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // In production this is where a reporter would go. Deliberately console-only for now: shipping
    // an error-reporting dependency to capture a boundary that has never fired would be silly.
    console.error('StoryBoard crashed', error, info.componentStack)
  }

  private reset = () => {
    this.setState({ error: null })
    this.props.onReset?.()
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex h-dvh items-center justify-center bg-desk p-8">
        <div className="max-w-md rounded-xl border border-line bg-surface p-6 shadow-sm">
          <h1 className="text-[17px] font-semibold text-ink">The board stopped working</h1>
          {/* Errors do not apologise and are never vague about what happened. */}
          <p className="mt-2 text-[13px] leading-relaxed text-graphite">
            Something went wrong while drawing. Your document is stored on the server, so reloading
            will bring it back — nothing you have written has been lost.
          </p>
          <pre className="mt-3 max-h-32 overflow-auto rounded-md bg-sheet p-2 text-[11px] text-graphite">
            {error.message}
          </pre>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={this.reset}
              className="rounded-md bg-brass px-3 py-2 text-[13px] font-medium text-sheet hover:opacity-90"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md border border-line bg-surface px-3 py-2 text-[13px] font-medium text-ink hover:bg-line-soft"
            >
              Reload the board
            </button>
          </div>
        </div>
      </div>
    )
  }
}
