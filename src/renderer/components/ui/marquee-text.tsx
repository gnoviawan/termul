import { useReducedMotion } from 'framer-motion'
import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export interface MarqueeTextProps extends React.ComponentProps<'span'> {
  text: string
}

/** Slowest and fastest full loops regardless of how far the text travels. */
const MARQUEE_MIN_MS = 6000
const MARQUEE_MAX_MS = 16000
/** Extra loop time per pixel of overflow, so long titles stay readable. */
const MARQUEE_MS_PER_PX = 30

/**
 * A row label that clips to its flex width and, when the text measurably
 * overflows, scrolls it on a slow scroll-pause-return loop so the tail stays
 * readable (tool-call titles differ mostly at the end). A fitting title renders
 * exactly a `truncate` span — the overflowed case under reduced motion does
 * too. Purely visual: callers keep the full text in the row's accessible name
 * or title attribute, so nothing here is duplicated for screen readers.
 */
export function MarqueeText({ text, className, ...props }: MarqueeTextProps): React.JSX.Element {
  const viewportRef = useRef<HTMLSpanElement>(null)
  const runnerRef = useRef<HTMLSpanElement>(null)
  const reducedMotion = useReducedMotion()
  // Overflow in px; 0 = fits (or unmeasured) → static truncate.
  const [overflow, setOverflow] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when text or styling classes change
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    let disposed = false
    const measure = (): void => {
      if (disposed) return
      // Measure the runner's own scrollWidth when mounted — transform-free,
      // so a mid-flight translateX cannot corrupt re-measures. The static
      // (truncate) span's scrollWidth is the same metric before it mounts.
      const content = runnerRef.current?.scrollWidth ?? el.scrollWidth
      setOverflow(Math.max(0, content - el.clientWidth))
    }
    measure()
    // Font swaps widen the text without resizing the element — RO alone misses
    // that, so re-measure on every loadingdone, not just the first paint.
    const fonts = document.fonts
    fonts?.addEventListener('loadingdone', measure)
    void fonts?.ready.then(measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (observer) observer.observe(el)
    return () => {
      disposed = true
      observer?.disconnect()
      fonts?.removeEventListener('loadingdone', measure)
    }
  }, [text, className])

  if (overflow > 0 && !reducedMotion) {
    const duration = Math.min(MARQUEE_MAX_MS, MARQUEE_MIN_MS + overflow * MARQUEE_MS_PER_PX)
    return (
      <span
        ref={viewportRef}
        data-slot="marquee-text"
        className={cn('min-w-0 flex-1 overflow-hidden whitespace-nowrap', className)}
        {...props}
      >
        <span
          ref={runnerRef}
          data-slot="marquee-text-runner"
          className="termul-marquee inline-block"
          style={
            {
              '--termul-marquee-distance': `${overflow}px`,
              '--termul-marquee-duration': `${duration}ms`
            } as CSSProperties
          }
        >
          {text}
        </span>
      </span>
    )
  }
  return (
    <span
      ref={viewportRef}
      data-slot="marquee-text"
      className={cn('min-w-0 flex-1 truncate', className)}
      {...props}
    >
      {text}
    </span>
  )
}
