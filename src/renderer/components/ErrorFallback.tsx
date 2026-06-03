import { AlertTriangle, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Default fallback UI shown when an ErrorBoundary catches an error.
 * Exported as a separate component to satisfy react-refresh/only-export-components.
 */
export function ErrorFallback({
  error,
  onRetry,
  context
}: {
  error: Error
  onRetry: () => void
  context?: string
}): ReactNode {
  const ctxLabel = context ? ` in ${context}` : ''

  return (
    <div className="flex flex-col items-center justify-center h-full w-full p-6 bg-background text-center">
      <AlertTriangle className="w-10 h-10 text-destructive mb-4" />
      <h3 className="text-sm font-semibold text-foreground mb-1">Something went wrong{ctxLabel}</h3>
      <p className="text-xs text-muted-foreground mb-4 max-w-md">
        {error.message || 'An unexpected error occurred.'}
      </p>
      <button
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
      >
        <RefreshCw className="w-3 h-3" />
        Try Again
      </button>
    </div>
  )
}
