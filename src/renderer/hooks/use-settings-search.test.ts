import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsSearch } from './use-settings-search'

describe('useSettingsSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function setQueryAndDebounce(
    result: { current: ReturnType<typeof useSettingsSearch> },
    query: string
  ) {
    act(() => {
      result.current.setQuery(query)
    })
    act(() => {
      vi.advanceTimersByTime(120)
    })
  }

  it("matches entries containing query 'font'", () => {
    const { result } = renderHook(() => useSettingsSearch())

    setQueryAndDebounce(result, 'font')

    expect(result.current.matches({ label: 'Font Size' })).toBe(true)
    expect(result.current.matches({ label: 'Default Shell' })).toBe(false)
  })

  it('treats whitespace-only query as no-search', () => {
    const { result } = renderHook(() => useSettingsSearch())

    setQueryAndDebounce(result, '   ')

    expect(result.current.isSearching).toBe(false)
    expect(result.current.matches({ label: 'Font Size' })).toBe(true)
    expect(result.current.matches({ label: 'Default Shell' })).toBe(true)
  })

  it('does not throw on special characters in query', () => {
    const { result } = renderHook(() => useSettingsSearch())

    setQueryAndDebounce(result, '((')

    expect(() => {
      result.current.matches({ label: 'Font Size' })
    }).not.toThrow()
  })
})
