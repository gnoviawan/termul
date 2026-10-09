import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_TOC_SETTINGS } from '@/types/settings'
import { useTocSettingsStore } from './toc-settings-store'

describe('toc-settings-store', () => {
  beforeEach(() => {
    useTocSettingsStore.setState({
      settings: { ...DEFAULT_TOC_SETTINGS },
      isLoaded: false,
      loadFailed: false,
      collapsedByFile: {}
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

    expect(result.current.settings.width).toBe(360)
    expect(result.current.settings.maxHeadingLevel).toBe(6)

    act(() => {
      result.current.setWidth(10)
      result.current.setMaxHeadingLevel(0)
    })

    expect(result.current.settings.width).toBe(180)
    expect(result.current.settings.maxHeadingLevel).toBe(1)
  })

  it('sanitizes malformed persisted settings', () => {
    const { result } = renderHook(() => useTocSettingsStore())

    act(() => {
      result.current.setSettings({
        isVisible: 'yes' as unknown as boolean,
        maxHeadingLevel: Number.NaN,
        width: Number.POSITIVE_INFINITY
      })
    })

    expect(result.current.settings).toEqual(DEFAULT_TOC_SETTINGS)
  })

  it('marks settings as loaded', () => {
    const { result } = renderHook(() => useTocSettingsStore())

    act(() => {
      result.current.setLoaded(true)
    })

    expect(result.current.isLoaded).toBe(true)
  })

  it('keeps collapsed outline keys per file and toggles them', () => {
    const { toggleCollapsedKey, setCollapsedKeys } = useTocSettingsStore.getState()

    act(() => {
      toggleCollapsedKey('/a.md', '1:Intro:0')
      toggleCollapsedKey('/b.md', '2:Setup:0')
    })
    expect(useTocSettingsStore.getState().collapsedByFile).toEqual({
      '/a.md': ['1:Intro:0'],
      '/b.md': ['2:Setup:0']
    })

    act(() => {
      toggleCollapsedKey('/a.md', '1:Intro:0')
      setCollapsedKeys('/b.md', ['x', 'x', 'y'])
    })
    expect(useTocSettingsStore.getState().collapsedByFile).toEqual({ '/b.md': ['x', 'y'] })

    act(() => {
      setCollapsedKeys('/b.md', [])
    })
    expect(useTocSettingsStore.getState().collapsedByFile).toEqual({})
  })
})
