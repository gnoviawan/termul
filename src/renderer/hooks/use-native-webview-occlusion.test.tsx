import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetNativeWebviewOcclusionForTests,
  useInterfaceOverlayOpen,
  useNativeWebviewOccluded,
  useNativeWebviewOcclusion
} from './use-native-webview-occlusion'

const { tauriRef } = vi.hoisted(() => ({ tauriRef: { current: true as boolean } }))

vi.mock('@/lib/tauri-runtime', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri-runtime')>('@/lib/tauri-runtime')
  return { ...actual, isTauriContext: () => tauriRef.current }
})

describe('useNativeWebviewOcclusion', () => {
  beforeEach(() => {
    tauriRef.current = true
    resetNativeWebviewOcclusionForTests()
  })

  afterEach(() => {
    resetNativeWebviewOcclusionForTests()
  })

  it('occludes while open and reveals on close', () => {
    const observer = renderHook(() => useNativeWebviewOccluded())
    const occluder = renderHook(({ open }) => useNativeWebviewOcclusion(open), {
      initialProps: { open: false }
    })
    expect(observer.result.current).toBe(false)

    occluder.rerender({ open: true })
    expect(observer.result.current).toBe(true)

    occluder.rerender({ open: false })
    expect(observer.result.current).toBe(false)
  })

  it('stays occluded until the last overlapping occluder closes', () => {
    const observer = renderHook(() => useNativeWebviewOccluded())
    const first = renderHook(() => useNativeWebviewOcclusion(true))
    const second = renderHook(() => useNativeWebviewOcclusion(true))
    expect(observer.result.current).toBe(true)

    first.unmount()
    expect(observer.result.current).toBe(true)

    second.unmount()
    expect(observer.result.current).toBe(false)
  })

  it('releases when the occluder unmounts while open', () => {
    const observer = renderHook(() => useNativeWebviewOccluded())
    const occluder = renderHook(() => useNativeWebviewOcclusion(true))
    expect(observer.result.current).toBe(true)
    act(() => occluder.unmount())
    expect(observer.result.current).toBe(false)
  })

  it('hides webviews for a docked occluder without reporting an interface overlay', () => {
    const occluded = renderHook(() => useNativeWebviewOccluded())
    const overlayOpen = renderHook(() => useInterfaceOverlayOpen())
    const docked = renderHook(() => useNativeWebviewOcclusion(true, 'docked'))
    expect(occluded.result.current).toBe(true)
    expect(overlayOpen.result.current).toBe(false)

    const overlay = renderHook(() => useNativeWebviewOcclusion(true))
    expect(overlayOpen.result.current).toBe(true)

    overlay.unmount()
    expect(overlayOpen.result.current).toBe(false)
    expect(occluded.result.current).toBe(true)

    docked.unmount()
    expect(occluded.result.current).toBe(false)
  })

  it('does nothing outside Tauri', () => {
    tauriRef.current = false
    const observer = renderHook(() => useNativeWebviewOccluded())
    renderHook(() => useNativeWebviewOcclusion(true))
    expect(observer.result.current).toBe(false)
  })
})
