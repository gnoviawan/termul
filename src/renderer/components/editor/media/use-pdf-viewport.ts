import { type RefObject, useEffect, useState } from 'react'

/** Pages within one viewport height above or below the visible area get painted. */
const RENDER_MARGIN = '100% 0px'

/** Client width of `ref`, ignoring the 0 a hidden (`display: none`) tab reports. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/**
 * Page numbers whose `[data-pdf-page]` slot inside `rootRef` is near the
 * viewport. Re-observes when the page count changes, since that adds or drops
 * slots.
 */
export function useNearPages(
  rootRef: RefObject<HTMLElement | null>,
  pageCount: number
): ReadonlySet<number> {
  const [near, setNear] = useState<ReadonlySet<number>>(() => new Set())
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page count means new slots to observe
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new IntersectionObserver(
      (entries) => {
        setNear((previous) => {
          const next = new Set(previous)
          for (const entry of entries) {
            const page = Number((entry.target as HTMLElement).dataset.pdfPage)
            if (entry.isIntersecting) next.add(page)
            else next.delete(page)
          }
          return next
        })
      },
      { root, rootMargin: RENDER_MARGIN }
    )
    for (const slot of root.querySelectorAll('[data-pdf-page]')) observer.observe(slot)
    return () => observer.disconnect()
  }, [rootRef, pageCount])
  return near
}

export interface PdfScrollAnchor {
  page: number
  /** How far the viewport top sits into `page`, as a fraction of its height. */
  fraction: number
}

function slotAt(root: HTMLElement, page: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-pdf-page="${page}"]`)
}

/** The page under the top edge of the viewport; `root` must be the slots' offsetParent. */
export function locateScrollAnchor(root: HTMLElement, pageCount: number): PdfScrollAnchor {
  let low = 1
  let high = pageCount
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if ((slotAt(root, mid)?.offsetTop ?? 0) <= root.scrollTop) low = mid
    else high = mid - 1
  }
  const slot = slotAt(root, low)
  const fraction =
    slot && slot.offsetHeight > 0 ? (root.scrollTop - slot.offsetTop) / slot.offsetHeight : 0
  return { page: low, fraction }
}

export function scrollToAnchor(root: HTMLElement, anchor: PdfScrollAnchor): void {
  const slot = slotAt(root, anchor.page)
  if (slot) root.scrollTop = slot.offsetTop + anchor.fraction * slot.offsetHeight
}

export function isScrolledToEnd(root: HTMLElement): boolean {
  return (
    root.scrollHeight > root.clientHeight &&
    root.scrollTop + root.clientHeight >= root.scrollHeight - 1
  )
}
