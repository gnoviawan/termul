import type { ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from '@/components/icons'
import { Button } from '@/components/ui/button'

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
      <h3 className="text-sm font-semibold text-foreground mb-1">
        This view hit an error{ctxLabel}
      </h3>
      <p className="text-xs text-muted-foreground mb-4 max-w-md">
        {error.message || 'No further detail is available.'}
      </p>
      <Button type="button" size="sm" onClick={onRetry}>
        <RefreshCw />
        Try again
      </Button>
    </div>
  )
}
