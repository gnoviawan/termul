import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTocSettingsStore } from './toc-settings-store'
import { DEFAULT_TOC_SETTINGS } from '@/types/settings'

describe('toc-settings-store', () => {
  beforeEach(() => {
    useTocSettingsStore.setState({
      settings: { ...DEFAULT_TOC_SETTINGS },
      isLoaded: false
    })
  })

  it('initializes with default settings', () => {
    const { result } = renderHook(() => useTocSettingsStore())

    expect(result.current.settings).toEqual(DEFAULT_TOC_SETTINGS)
    expect(result.current.isLoaded).toBe(false)
  })

  it('toggles visibility', () => {
    const { result } = renderHook(() => useTocSettingsStore())

    act(() => {
      result.current.toggleVisibility()
    })

    expect(result.current.settings.isVisible).toBe(!DEFAULT_TOC_SETTINGS.isVisible)
  })

  it('clamps width and max heading level', () => {
    const { result } = renderHook(() => useTocSettingsStore())

    act(() => {
      result.current.setWidth(999)
      result.current.setMaxHeadingLevel(9)
    })

    expect(result.current.settings.width).toBe(350)
    expect(result.current.settings.maxHeadingLevel).toBe(6)

    act(() => {
      result.current.setWidth(10)
      result.current.setMaxHeadingLevel(0)
    })

    expect(result.current.settings.width).toBe(150)
    expect(result.current.settings.maxHeadingLevel).toBe(1)
  })

  it('marks settings as loaded', () => {
    const { result } = renderHook(() => useTocSettingsStore())

    act(() => {
      result.current.setLoaded(true)
    })

    expect(result.current.isLoaded).toBe(true)
  })
})
