import { useEffect, useMemo, useState } from 'react'
import type { TocHeading } from '@/hooks/use-toc-headings'

function getActiveHeadingForLine(headings: TocHeading[], lineNumber: number): string | undefined {
  let activeHeadingId: string | undefined

  for (const heading of headings) {
    if (heading.line === undefined) {
      continue
    }

    if (heading.line <= lineNumber) {
      activeHeadingId = heading.id
      continue
    }

    break
  }

  return activeHeadingId ?? headings[0]?.id
}

export function getActiveHeadingFromVisibleRange(
  headings: TocHeading[],
  visibleRange?: { startLine: number; endLine: number }
): string | undefined {
  if (!headings.length) {
    return undefined
  }

  if (!visibleRange) {
    return headings[0]?.id
  }

  return getActiveHeadingForLine(headings, visibleRange.startLine)
}

interface UseCodeMirrorActiveHeadingOptions {
  headings: TocHeading[]
  visibleRange?: { startLine: number; endLine: number }
}

export function useCodeMirrorActiveHeading({
  headings,
  visibleRange
}: UseCodeMirrorActiveHeadingOptions): string | undefined {
  return useMemo(
    () => getActiveHeadingFromVisibleRange(headings, visibleRange),
    [headings, visibleRange]
  )
}

interface UseBlockNoteActiveHeadingOptions {
  headings: TocHeading[]
  container: HTMLElement | null
  isEnabled?: boolean
}

export function useBlockNoteActiveHeading({
  headings,
  container,
  isEnabled = true
}: UseBlockNoteActiveHeadingOptions): string | undefined {
  const [activeHeadingId, setActiveHeadingId] = useState<string | undefined>(headings[0]?.id)

  useEffect(() => {
    setActiveHeadingId(headings[0]?.id)
  }, [headings])

  useEffect(() => {
    if (!isEnabled || !container || !headings.length) {
      return
    }

    const headingIds = new Set(headings.map((heading) => heading.blockId ?? heading.id))
    const visibleHeadings = new Map<string, number>()

    const updateActiveHeading = (): void => {
      const next = Array.from(visibleHeadings.entries())
        .sort((a, b) => a[1] - b[1])
        .map(([headingId]) => headingId)[0]

      if (next) {
        setActiveHeadingId(next)
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const element = entry.target as HTMLElement
          const headingId = element.dataset.id

          if (!headingId) {
            return
          }

          if (entry.isIntersecting) {
            visibleHeadings.set(headingId, entry.boundingClientRect.top)
          } else {
            visibleHeadings.delete(headingId)
          }
        })

        updateActiveHeading()
      },
      {
        root: container,
        threshold: [0, 0.1, 0.25],
        rootMargin: '0px 0px -65% 0px'
      }
    )

    const elements = Array.from(
      container.querySelectorAll<HTMLElement>('[data-node-type="blockContainer"][data-id]')
    ).filter((element) => {
      const elementId = element.dataset.id
      const isHeadingBlock = !!element.querySelector('[data-content-type="heading"]')
      return !!elementId && isHeadingBlock && headingIds.has(elementId)
    })

    elements.forEach((element) => observer.observe(element))

    return () => {
      observer.disconnect()
      visibleHeadings.clear()
    }
  }, [container, headings, isEnabled])

  return activeHeadingId
}
