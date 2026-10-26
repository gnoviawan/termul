/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { createRoot, flushSync, type NativeRenderer } from '@gpuix/react'
import { createElement as h, useEffect, useRef, useSyncExternalStore } from 'react'
import type { ImperativePanelGroupHandle } from 'react-resizable-panels'
import { Panel, PanelGroup, PanelResizeHandle } from '../../src/compat/shims/resizable-panels'

const tree = () => ({ applyBatch: () => [] }) as unknown as NativeRenderer

/** A width store read through useSyncExternalStore, as zustand's hooks read the TOC settings. */
function widthStore(initial: number) {
  let width = initial
  const listeners = new Set<() => void>()
  return {
    get: () => width,
    set(next: number) {
      if (next === width) return
      width = next
      for (const l of listeners) l()
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
}

const GROUP_PX = 794

/**
 * EditorTocLayout's contract with the package: the outline panel's onResize
 * stores its width in pixels, and an effect lays the group out from the stored
 * width whenever the two disagree by half a percent or more.
 */
function Outline({
  store,
  group,
  resized
}: {
  store: ReturnType<typeof widthStore>
  group: { current: ImperativePanelGroupHandle | null }
  resized: number[]
}) {
  const width = useSyncExternalStore(store.subscribe, store.get)
  const size = (width / GROUP_PX) * 100
  const renders = useRef(0)
  renders.current++
  useEffect(() => {
    const current = group.current?.getLayout()[1]
    if (current === undefined || Math.abs(current - size) < 0.5) return
    group.current?.setLayout([100 - size, size])
  }, [size, group])
  return h(
    PanelGroup,
    { ref: group, direction: 'horizontal' },
    h(Panel, { defaultSize: 100 - size, minSize: 60 }),
    h(PanelResizeHandle, {}),
    h(Panel, {
      defaultSize: size,
      minSize: 20,
      maxSize: 40,
      onResize: (next: number, prev: number | undefined) => {
        resized.push(next)
        if (prev !== next) store.set(Math.round((next / 100) * GROUP_PX))
      }
    })
  )
}

function mount(initialWidth: number) {
  const store = widthStore(initialWidth)
  const group: { current: ImperativePanelGroupHandle | null } = { current: null }
  const resized: number[] = []
  const root = createRoot(tree())
  flushSync(() => root.render(h(Outline, { store, group, resized })))
  return { store, group, resized, root }
}

describe('the react-resizable-panels stand-in reports sizes as the package does', () => {
  test('setLayout calls onResize before it returns, with the new size', () => {
    const { group, resized, root } = mount(201)
    resized.length = 0
    group.current?.setLayout([70, 30])
    expect(resized).toEqual([30])
    root.unmount()
  })

  test('a drag that lands in the same render as the stored width settles instead of looping', () => {
    const { store, group, root } = mount(201)
    const at = (px: number) => [100 - (px / GROUP_PX) * 100, (px / GROUP_PX) * 100]
    flushSync(() => {
      store.set(211)
      group.current?.setLayout(at(221))
    })
    expect(store.get()).toBe(221)
    expect(Math.round(((group.current?.getLayout()[1] ?? 0) / 100) * GROUP_PX)).toBe(221)
    root.unmount()
  })
})
