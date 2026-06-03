import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logFrontendError } from '@/lib/log-api'
import { ErrorFallback } from './ErrorFallback'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Optional fallback UI. Receives the error and a retry callback. */
  fallback?: (error: Error, retry: () => void) => ReactNode
  /** Optional context label for error logging (e.g. "Terminal Pane") */
  context?: string
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
 * <ErrorBoundary context="Terminal Pane">
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
