import type React from 'react'
import { cn } from '@/lib/utils'
import { READ_ONLY_SERVER_REASON } from '@/lib/write-gate'
import { FOCUS_RING_CLASS } from './panel-styles'

interface WriteGateProps {
  /** True when the control must render disabled with the read-only reason. */
  gated: boolean
  /** Make the wrapper a tab stop so keyboard users reach the reason (default
   * true). Menu rows pass `false`: the row itself owns focus handling and
   * renders `WriteGateReason` inside itself. */
  focusable?: boolean
  className?: string
  children: React.ReactNode
}

/** Wraps a disabled write control so the reason is exposed on hover (`title`,
 * which disabled controls would otherwise swallow) and on focus (focusable
 * wrapper plus an sr-only description). Renders children untouched when the
 * control is not gated. */
export function WriteGate({ gated, focusable = true, className, children }: WriteGateProps) {
  if (!gated) {
    return <>{children}</>
  }
  return (
    <span
      data-write-gate="read-only"
      title={READ_ONLY_SERVER_REASON}
      tabIndex={focusable ? 0 : undefined}
      className={cn('inline-flex rounded [&>*]:pointer-events-none', FOCUS_RING_CLASS, className)}
    >
      {children}
      {focusable ? <WriteGateReason /> : null}
    </span>
  )
}

/** Screen-reader description of the read-only reason. Menu rows render it
 * inside the row (`focusable={false}` skips the wrapper's own copy) so the
 * menuitem itself carries the explanation. */
export function WriteGateReason() {
  return <span className="sr-only">{READ_ONLY_SERVER_REASON}</span>
}
