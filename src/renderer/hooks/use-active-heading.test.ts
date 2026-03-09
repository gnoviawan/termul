import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { getActiveHeadingFromVisibleRange, useCodeMirrorActiveHeading } from './use-active-heading'
import type { TocHeading } from './use-toc-headings'

const headings: TocHeading[] = [
  { id: 'heading-line-1', level: 1, text: 'Title', line: 1 },
  { id: 'heading-line-4', level: 2, text: 'Section', line: 4 },
  { id: 'heading-line-8', level: 3, text: 'Details', line: 8 }
]

describe('use-active-heading', () => {
  it('returns the first heading when no visible range is available', () => {
    expect(getActiveHeadingFromVisibleRange(headings, undefined)).toBe('heading-line-1')
  })

  it('returns the nearest heading at or above the visible line', () => {
    expect(getActiveHeadingFromVisibleRange(headings, { startLine: 1, endLine: 5 })).toBe('heading-line-1')
    expect(getActiveHeadingFromVisibleRange(headings, { startLine: 6, endLine: 10 })).toBe('heading-line-4')
    expect(getActiveHeadingFromVisibleRange(headings, { startLine: 10, endLine: 12 })).toBe('heading-line-8')
  })

  it('returns undefined when there are no headings', () => {
    expect(getActiveHeadingFromVisibleRange([], { startLine: 1, endLine: 2 })).toBeUndefined()
  })

  it('computes active heading in the CodeMirror hook', () => {
    const { result, rerender } = renderHook(
      ({ visibleRange }) => useCodeMirrorActiveHeading({ headings, visibleRange }),
      {
        initialProps: {
          visibleRange: { startLine: 2, endLine: 5 }
        }
      }
    )

    expect(result.current).toBe('heading-line-1')

    rerender({ visibleRange: { startLine: 8, endLine: 12 } })

    expect(result.current).toBe('heading-line-8')
  })
})
