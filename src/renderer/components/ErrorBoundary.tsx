import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logFrontendError } from '@/lib/log-api'
import { ErrorFallback } from './ErrorFallback'

export type ErrorBoundaryContext = 'appRoot' | 'terminalPane' | 'editorPane'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Optional fallback UI. Receives the error and a retry callback. */
  fallback?: (error: Error, retry: () => void) => ReactNode
  /** Stable context key used for logging and localized fallback UI. */
  context?: ErrorBoundaryContext
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * React ErrorBoundary that catches rendering errors in its subtree.
 *
 * Usage:
 * ```tsx
 * <ErrorBoundary context="terminalPane">
 *   <PaneContent ... />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const ctx = this.props.context ?? 'Unknown'
    console.error(`[ErrorBoundary:${ctx}] Rendering error:`, error)
    console.error(`[ErrorBoundary:${ctx}] Component stack:`, errorInfo.componentStack)
    void logFrontendError({
      source: `ErrorBoundary:${ctx}`,
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack ?? undefined
    })
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleRetry)
      }

      return (
        <ErrorFallback
          error={this.state.error}
          onRetry={this.handleRetry}
          context={this.props.context}
        />
      )
    }

    return this.props.children
  }
}
