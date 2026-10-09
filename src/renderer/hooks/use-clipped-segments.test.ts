import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useClippedSegments } from './use-clipped-segments'

type Callback = (entries: Array<{ target: Element; isIntersecting: boolean }>) => void

class FakeObserver {
  static instances: FakeObserver[] = []
  observed: Element[] = []
  disconnected = false

  constructor(
    readonly callback: Callback,
    readonly options: IntersectionObserverInit
  ) {
    FakeObserver.instances.push(this)
  }

  observe(element: Element): void {
    this.observed.push(element)
  }

  disconnect(): void {
    this.disconnected = true
  }

  report(...entries: Array<{ target: Element; isIntersecting: boolean }>): void {
    this.callback(entries)
  }
}

const latest = (): FakeObserver => {
  const observer = FakeObserver.instances.at(-1)
  if (!observer) throw new Error('no observer was created')
  return observer
}

function mountNode(): HTMLElement {
  const node = document.createElement('div')
  document.body.appendChild(node)
  return node
}

describe('useClippedSegments', () => {
  beforeEach(() => {
    FakeObserver.instances = []
    vi.stubGlobal('IntersectionObserver', FakeObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  function setup(keys: string[]) {
    const nav = mountNode()
    const nodes = new Map(keys.map((key) => [key, mountNode()]))
    const view = renderHook(({ list }) => useClippedSegments(list), {
      initialProps: { list: keys }
    })
    act(() => {
      for (const [key, node] of nodes) view.result.current.segmentRef(key)(node)
      view.result.current.rootRef(nav)
    })
    return { nav, nodes, ...view }
  }

  it('reports nothing clipped and creates no observer until the container mounts', () => {
    const { result } = renderHook(() => useClippedSegments(['/a']))

    expect(result.current.clipped.size).toBe(0)
    expect(FakeObserver.instances).toHaveLength(0)
  })

  it('observes every segment against the container, with threshold 0', () => {
    const { nav, nodes } = setup(['/a', '/a/b'])

    const observer = latest()
    expect(observer.options.root).toBe(nav)
    expect(observer.options.threshold).toBe(0)
    expect(observer.observed).toEqual([nodes.get('/a'), nodes.get('/a/b')])
  })

  it('marks a segment that lies fully outside the clip box, and releases it once visible', () => {
    const { nodes, result } = setup(['/a', '/a/b'])
    const first = nodes.get('/a') as HTMLElement
    const second = nodes.get('/a/b') as HTMLElement

    act(() => latest().report({ target: first, isIntersecting: false }))
    expect(result.current.clipped).toEqual(new Set(['/a']))

    act(() => latest().report({ target: second, isIntersecting: true }))
    expect(result.current.clipped).toEqual(new Set(['/a']))

    act(() => latest().report({ target: first, isIntersecting: true }))
    expect(result.current.clipped.size).toBe(0)
  })

  it('keeps the same set instance when a report changes nothing', () => {
    const { nodes, result } = setup(['/a'])
    const first = nodes.get('/a') as HTMLElement
    act(() => latest().report({ target: first, isIntersecting: false }))
    const before = result.current.clipped

    act(() => latest().report({ target: first, isIntersecting: false }))

    expect(result.current.clipped).toBe(before)
  })

  it('ignores a report for an element it does not track', () => {
    const { result } = setup(['/a'])

    act(() => latest().report({ target: mountNode(), isIntersecting: false }))

    expect(result.current.clipped.size).toBe(0)
  })

  it('re-observes when the segment list changes and drops keys that left', () => {
    const { nodes, result, rerender } = setup(['/a', '/a/b'])
    const first = nodes.get('/a') as HTMLElement
    const second = nodes.get('/a/b') as HTMLElement
    act(() => latest().report({ target: first, isIntersecting: false }))
    const previous = latest()

    // Navigating up: `/a/b` leaves the list and its element unmounts.
    act(() => {
      result.current.segmentRef('/a/b')(null)
    })
    rerender({ list: ['/a'] })

    expect(previous.disconnected).toBe(true)
    expect(latest()).not.toBe(previous)
    expect(latest().observed).toEqual([first])
    expect(second.isConnected).toBe(true)
    expect(result.current.clipped).toEqual(new Set(['/a']))

    // `/a` left as well.
    rerender({ list: [] })
    expect(result.current.clipped.size).toBe(0)
  })

  it('does not re-observe while the list content is unchanged', () => {
    const { rerender } = setup(['/a', '/a/b'])
    const count = FakeObserver.instances.length

    rerender({ list: ['/a', '/a/b'] })

    expect(FakeObserver.instances).toHaveLength(count)
  })

  it('disconnects when the container unmounts and clears the set', () => {
    const { nodes, result } = setup(['/a'])
    act(() => latest().report({ target: nodes.get('/a') as HTMLElement, isIntersecting: false }))
    const observer = latest()

    act(() => result.current.rootRef(null))

    expect(observer.disconnected).toBe(true)
    expect(result.current.clipped.size).toBe(0)
  })

  it('disconnects on unmount', () => {
    const { unmount } = setup(['/a'])
    const observer = latest()

    unmount()

    expect(observer.disconnected).toBe(true)
  })

  it('hands out one stable ref function per key', () => {
    const { result } = renderHook(() => useClippedSegments(['/a']))

    expect(result.current.segmentRef('/a')).toBe(result.current.segmentRef('/a'))
    expect(result.current.segmentRef('/a')).not.toBe(result.current.segmentRef('/b'))
  })

  it('without IntersectionObserver every segment stays tabbable', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const nav = mountNode()
    const node = mountNode()
    const { result } = renderHook(() => useClippedSegments(['/a']))

    act(() => {
      result.current.segmentRef('/a')(node)
      result.current.rootRef(nav)
    })

    expect(result.current.clipped.size).toBe(0)
    expect(FakeObserver.instances).toHaveLength(0)
  })
})
