import { useCallback, useEffect, useState } from 'react'

export interface ScrollProgress {
  /** 0–100, rounded. */
  percent: number
  /** False when the document fits without scroll; the footer hides then. */
  canScroll: boolean
}

const NO_SCROLL: ScrollProgress = { percent: 0, canScroll: false }

export function readScrollProgress(element: HTMLElement): ScrollProgress {
  const range = element.scrollHeight - element.clientHeight
  if (range <= 1) {
    return NO_SCROLL
  }
  const ratio = Math.min(1, Math.max(0, element.scrollTop / range))
  return { percent: Math.round(ratio * 100), canScroll: true }
}

/**
 * Read progress of an editor scroll root (BlockNote scroll root or the
 * CodeMirror scroller). Updates on scroll and when the root or its
 * content changes size.
 */
export function useScrollProgress(
  element: HTMLElement | null,
  contentKey?: unknown
): {
  progress: ScrollProgress
  scrollToTop: () => void
} {
  const [progress, setProgress] = useState<ScrollProgress>(NO_SCROLL)

  // biome-ignore lint/correctness/useExhaustiveDependencies: contentKey re-reads after content edits
  useEffect(() => {
    if (!element) {
      setProgress(NO_SCROLL)
      return
    }

    let frame = 0
    const update = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const next = readScrollProgress(element)
        setProgress((previous) =>
          previous.percent === next.percent && previous.canScroll === next.canScroll
            ? previous
            : next
        )
      })
    }

    update()
    element.addEventListener('scroll', update, { passive: true })

    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update)
      observer.observe(element)
      for (const child of Array.from(element.children)) {
        observer.observe(child)
      }
    }

    return () => {
      cancelAnimationFrame(frame)
      element.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [element, contentKey])

  const scrollToTop = useCallback(() => {
    if (!element) return
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (typeof element.scrollTo === 'function') {
      element.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
    } else {
      element.scrollTop = 0
    }
  }, [element])

  return { progress, scrollToTop }
}
