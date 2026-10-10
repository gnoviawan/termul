import { useCallback, useEffect, useRef, useState } from 'react'

const NO_SEGMENTS: ReadonlySet<string> = new Set()

type SegmentRef = (node: HTMLElement | null) => void

interface UseClippedSegments {
  /** Callback ref for the clipping container (the `<nav>`). */
  rootRef: (node: HTMLElement | null) => void
  /** Callback ref for the segment `key`; keep the same function between renders. */
  segmentRef: (key: string) => SegmentRef
  /** Keys of the segments that lie fully outside the container's clip box. */
  clipped: ReadonlySet<string>
}

/**
 * Which of a container's segments are fully clipped away (the Files
 * breadcrumb, which clips from the left with `overflow-x-clip`).
 *
 * A clipped control still takes keyboard focus and cannot be scrolled into view
 * (`overflow: clip` has no scroll position), so Tab would land on something
 * unseen. The caller marks the returned keys `tabIndex={-1}`; they become
 * tabbable again as soon as they intersect the container.
 *
 * Observes each segment with an `IntersectionObserver` rooted at the container
 * (the root's clip box is what a descendant is intersected against). The
 * container is held in state through a callback ref, so the observer follows
 * the container's mount and the segment list. Without `IntersectionObserver`
 * nothing is ever reported clipped: every segment stays tabbable.
 */
export function useClippedSegments(segmentKeys: readonly string[]): UseClippedSegments {
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const [clipped, setClipped] = useState<ReadonlySet<string>>(NO_SEGMENTS)
  const elements = useRef(new Map<string, HTMLElement>())
  const refs = useRef(new Map<string, SegmentRef>())

  const rootRef = useCallback((node: HTMLElement | null): void => setRoot(node), [])

  const segmentRef = useCallback((key: string): SegmentRef => {
    let ref = refs.current.get(key)
    if (!ref) {
      ref = (node) => {
        if (node) elements.current.set(key, node)
        else elements.current.delete(key)
      }
      refs.current.set(key, ref)
    }
    return ref
  }, [])

  // The caller rebuilds the list every render and its content rarely changes:
  // a joined string is the stable re-observe trigger.
  const signature = segmentKeys.join('\u0000')

  useEffect(() => {
    if (!root || typeof IntersectionObserver === 'undefined') {
      setClipped((prev) => (prev.size === 0 ? prev : NO_SEGMENTS))
      return
    }
    const keys = new Set(signature ? signature.split('\u0000') : [])
    // Drop keys that left the list; the observer reports the rest below.
    setClipped((prev) => {
      const kept = [...prev].filter((key) => keys.has(key))
      return kept.length === prev.size ? prev : new Set(kept)
    })
    const keyOf = new Map<Element, string>()
    const observer = new IntersectionObserver(
      (entries) => {
        setClipped((prev) => {
          const next = new Set(prev)
          for (const entry of entries) {
            const key = keyOf.get(entry.target)
            if (key === undefined) continue
            if (entry.isIntersecting) next.delete(key)
            else next.add(key)
          }
          const unchanged = next.size === prev.size && [...next].every((key) => prev.has(key))
          return unchanged ? prev : next
        })
      },
      { root, threshold: 0 }
    )
    for (const key of keys) {
      const element = elements.current.get(key)
      if (!element) continue
      keyOf.set(element, key)
      observer.observe(element)
    }
    return () => observer.disconnect()
  }, [root, signature])

  return { rootRef, segmentRef, clipped }
}
