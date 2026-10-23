import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { READ_ONLY_SERVER_REASON } from '@/lib/write-gate'
import { Box } from './internal/host'

interface WriteGateProps {
  gated: boolean
  focusable?: boolean
  className?: string
  children: ReactNode
}

/**
 * Wraps a disabled write control so the read-only reason is reachable. The
 * web uses `title` and an sr-only span; GPUIX has neither, so the reason is
 * the wrapper's accessible description. `[&>*]:pointer-events-none` cannot be
 * selected from here; the disabled child already ignores presses.
 */
export function WriteGate({ gated, focusable = true, className, children }: WriteGateProps) {
  if (!gated) return <>{children}</>
  return (
    <Box
      data-write-gate="read-only"
      title={READ_ONLY_SERVER_REASON}
      aria-description={READ_ONLY_SERVER_REASON}
      tabIndex={focusable ? 0 : undefined}
      className={cn(
        'inline-flex rounded [&>*]:pointer-events-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
    >
      {children}
    </Box>
  )
}

/** The web's sr-only reason; GPUIX carries it as the row's accessible description instead. */
export function WriteGateReason() {
  return null
}
