import { useReducedMotion } from 'framer-motion'
import { useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

interface ThinkingStatusProps {
  /** The line to show. A change runs the thinking-state swap. */
  text: string
  /** Shimmer while this state holds. False after the line settles. */
  shimmer: boolean
  className?: string
}

function readCssTimeMs(name: string, fallbackMs: number): number {
  if (typeof document === 'undefined') return fallbackMs
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : fallbackMs
}

/**
 * Status line that shimmers while a state holds, then swaps to the next
 * line (transitions.dev thinking states). The live line stays in flow so
 * the row hugs the current label. The outgoing line floats over it.
 */
export function ThinkingStatus({
  text,
  shimmer,
  className
}: ThinkingStatusProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const [current, setCurrent] = useState(text)
  const [outgoing, setOutgoing] = useState<string | null>(null)
  const [entering, setEntering] = useState(false)
  const incomingRef = useRef<HTMLSpanElement>(null)

  if (text !== current || (reduced && (outgoing !== null || entering))) {
    if (reduced || text === current) {
      setOutgoing(null)
      setEntering(false)
      if (text !== current) setCurrent(text)
    } else {
      setOutgoing(current)
      setCurrent(text)
      setEntering(true)
    }
  }

  useLayoutEffect(() => {
    if (!entering) return
    const el = incomingRef.current
    // Keep the shimmer text on the live line, and restart the timer when it changes.
    if (el) el.dataset.text = current
    const gap = readCssTimeMs('--think-gap', 50)
    const release = (): void => {
      if (el) void el.offsetWidth
      setEntering(false)
    }
    const releaseTimer = window.setTimeout(release, gap)
    return () => {
      window.clearTimeout(releaseTimer)
    }
  }, [entering, current])

  // Separate from the entry effect: the entry timer clearing at `gap` must not
  // cancel the outgoing span's removal, which is scheduled for swap + gap.
  useLayoutEffect(() => {
    if (outgoing === null) return
    const gap = readCssTimeMs('--think-gap', 50)
    const swap = readCssTimeMs('--think-swap', 150)
    const doneTimer = window.setTimeout(() => setOutgoing(null), swap + gap)
    return () => {
      window.clearTimeout(doneTimer)
    }
  }, [outgoing])

  return (
    <span className={cn('t-think is-start', !shimmer && 'is-settled', className)}>
      {outgoing != null && (
        <span className="t-think-text is-exit" data-text={outgoing} aria-hidden="true">
          {outgoing}
        </span>
      )}
      <span
        ref={incomingRef}
        className={cn('t-think-text', entering && 'is-enter-start')}
        data-text={current}
      >
        {current}
      </span>
    </span>
  )
}
