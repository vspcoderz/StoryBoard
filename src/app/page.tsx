import { ErrorBoundary } from '@/board/ErrorBoundary'
import { BoardView } from '@/board/BoardView'

export default function Page() {
  return (
    <ErrorBoundary>
      <BoardView />
    </ErrorBoundary>
  )
}
