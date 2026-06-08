import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSettingsScrollSpy } from './use-settings-scroll-spy'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function createSection(container: HTMLElement, id: string, display = 'block'): HTMLElement {
  const element = document.createElement('section')
  element.setAttribute('data-settings-section', id)
  container.appendChild(element)

  vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
    const sectionId = (el as HTMLElement).getAttribute('data-settings-section')
    return {
      display: sectionId === id ? display : 'block'
    } as CSSStyleDeclaration
  })

  return element
}

describe('useSettingsScrollSpy', () => {
  it('returns the top-most visible section', () => {
    const container = document.createElement('div')
    const sectionA = createSection(container, 'section-a')
    const sectionB = createSection(container, 'section-b')

    let observerCallback: IntersectionObserverCallback | undefined

    class MockIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback
      }

      observe = vi.fn()
      disconnect = vi.fn()
      unobserve = vi.fn()
      root = null
      rootMargin = '0px'
      thresholds = [0]
      takeRecords = () => []
    }

    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)

    const { result } = renderHook(() =>
      useSettingsScrollSpy({
        container,
        sectionIds: ['section-a', 'section-b']
      })
    )

    expect(result.current).toBe('section-a')

    act(() => {
      observerCallback?.(
        [
          {
            target: sectionA,
            isIntersecting: true,
            boundingClientRect: { top: 120 }
          } as unknown as IntersectionObserverEntry,
          {
            target: sectionB,
            isIntersecting: true,
            boundingClientRect: { top: 40 }
          } as unknown as IntersectionObserverEntry
        ],
        {} as IntersectionObserver
      )
    })

    expect(result.current).toBe('section-b')
  })

  it('falls back to the first section id when none are visible', () => {
    const container = document.createElement('div')
    createSection(container, 'section-a')
    createSection(container, 'section-b')

    let observerCallback: IntersectionObserverCallback | undefined

    class MockIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback
      }

      observe = vi.fn()
      disconnect = vi.fn()
      unobserve = vi.fn()
      root = null
      rootMargin = '0px'
      thresholds = [0]
      takeRecords = () => []
    }

    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)

    const { result } = renderHook(() =>
      useSettingsScrollSpy({
        container,
        sectionIds: ['section-a', 'section-b']
      })
    )

    expect(result.current).toBe('section-a')

    act(() => {
      observerCallback?.(
        [
          {
            target: container.firstChild as HTMLElement,
            isIntersecting: false,
            boundingClientRect: { top: 0 }
          } as unknown as IntersectionObserverEntry
        ],
        {} as IntersectionObserver
      )
    })

    expect(result.current).toBe('section-a')
  })

  it('re-syncs observed targets when sectionIds changes', () => {
    const container = document.createElement('div')
    const sectionA = createSection(container, 'section-a')
    const sectionB = createSection(container, 'section-b')
    const sectionC = createSection(container, 'section-c')

    const observe = vi.fn()
    const disconnect = vi.fn()

    class MockIntersectionObserver {
      constructor(_callback: IntersectionObserverCallback) {}

      observe = observe
      disconnect = disconnect
      unobserve = vi.fn()
      root = null
      rootMargin = '0px'
      thresholds = [0]
      takeRecords = () => []
    }

    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)

    const { rerender } = renderHook(
      ({ sectionIds }) =>
        useSettingsScrollSpy({
          container,
          sectionIds
        }),
      {
        initialProps: {
          sectionIds: ['section-a', 'section-b']
        }
      }
    )

    expect(observe).toHaveBeenCalledWith(sectionA)
    expect(observe).toHaveBeenCalledWith(sectionB)
    expect(observe).not.toHaveBeenCalledWith(sectionC)

    observe.mockClear()
    disconnect.mockClear()

    rerender({ sectionIds: ['section-b', 'section-c'] })

    expect(disconnect).toHaveBeenCalled()
    expect(observe).toHaveBeenCalledWith(sectionB)
    expect(observe).toHaveBeenCalledWith(sectionC)
    expect(observe).not.toHaveBeenCalledWith(sectionA)
  })

  it('skips sections with display:none', () => {
    const container = document.createElement('div')
    const visibleSection = createSection(container, 'visible-section', 'block')
    const hiddenSection = createSection(container, 'hidden-section', 'none')

    const observe = vi.fn()

    class MockIntersectionObserver {
      constructor(_callback: IntersectionObserverCallback) {}

      observe = observe
      disconnect = vi.fn()
      unobserve = vi.fn()
      root = null
      rootMargin = '0px'
      thresholds = [0]
      takeRecords = () => []
    }

    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)

    renderHook(() =>
      useSettingsScrollSpy({
        container,
        sectionIds: ['visible-section', 'hidden-section']
      })
    )

    expect(observe).toHaveBeenCalledWith(visibleSection)
    expect(observe).not.toHaveBeenCalledWith(hiddenSection)
  })

  it('uses container as observer root with expected options', () => {
    const container = document.createElement('div')
    createSection(container, 'section-a')

    let observerOptions: IntersectionObserverInit | undefined

    class MockIntersectionObserver {
      constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        observerOptions = options
      }

      observe = vi.fn()
      disconnect = vi.fn()
      unobserve = vi.fn()
      root = null
      rootMargin = '0px'
      thresholds = [0]
      takeRecords = () => []
    }

    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)

    renderHook(() =>
      useSettingsScrollSpy({
        container,
        sectionIds: ['section-a']
      })
    )

    expect(observerOptions?.root).toBe(container)
    expect(observerOptions?.rootMargin).toBe('0px 0px -65% 0px')
    expect(observerOptions?.threshold).toEqual([0, 0.1, 0.25])
  })
})
