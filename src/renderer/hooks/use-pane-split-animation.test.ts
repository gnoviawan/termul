import { act, renderHook } from '@testing-library/react'
import type { RefObject } from 'react'
import type { ImperativePanelGroupHandle } from 'react-resizable-panels'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneNode } from '@/types/workspace.types'
import type { PaneDropInfo } from './use-pane-dnd'
import { PANE_DROP_FRESHNESS_MS, usePaneSplitAnimation } from './use-pane-split-animation'

let reducedMotion = false

vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>()
  return {
    ...actual,
    useReducedMotion: () => reducedMotion
  }
})

let rafCallbacks: FrameRequestCallback[] = []

function flushFrames(): void {
  const callbacks = rafCallbacks
  rafCallbacks = []
  for (const cb of callbacks) {
    cb(0)
  }
}

function leaf(id: string): PaneNode {
  return { type: 'leaf', id, tabs: [], activeTabId: null }
}

function createGroupRef(): {
  groupRef: RefObject<ImperativePanelGroupHandle | null>
  setLayout: ReturnType<typeof vi.fn>
} {
  const setLayout = vi.fn()
  const handle: ImperativePanelGroupHandle = {
    getId: () => 'group-1',
    getLayout: () => [],
    setLayout
  }
  return { groupRef: { current: handle }, setLayout }
}

interface HookProps {
  children: PaneNode[]
  sizes: number[]
  groupRef: RefObject<ImperativePanelGroupHandle | null>
  isDraggingRef: RefObject<boolean>
  lastDrop: PaneDropInfo | null
}

describe('usePaneSplitAnimation', () => {
  beforeEach(() => {
    reducedMotion = false
    rafCallbacks = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function baseProps(overrides: Partial<HookProps> = {}): HookProps {
    return {
      children: [leaf('pane-a'), leaf('pane-b')],
      sizes: [50, 50],
      isDraggingRef: { current: false },
      lastDrop: null,
      ...createGroupRef(),
      ...overrides
    }
  }

  it('tweens a drop-created group mount from ~minSize to the target layout', () => {
    const { groupRef, setLayout } = createGroupRef()
    const props = baseProps({
      groupRef,
      lastDrop: { targetPaneId: 'pane-a', position: 'right', at: Date.now() }
    })

    const { result } = renderHook((p: HookProps) => usePaneSplitAnimation(p), {
      initialProps: props
    })

    // Start layout applied pre-paint: new pane near minSize, sibling shrunk.
    expect(setLayout).toHaveBeenCalledWith([90, 10])
    expect(result.current.current).toBe(true)

    // Drive the tween to completion.
    vi.spyOn(performance, 'now').mockReturnValue(1e12)
    act(flushFrames)

    expect(setLayout).toHaveBeenLastCalledWith([50, 50])
    expect(result.current.current).toBe(false)
  })

  it('mirrors the start layout for a leading drop (new pane first)', () => {
    const { groupRef, setLayout } = createGroupRef()
    renderHook((p: HookProps) => usePaneSplitAnimation(p), {
      // A 'left'/'top' drop orders the tree [newLeaf, targetLeaf].
      initialProps: baseProps({
        groupRef,
        children: [leaf('pane-b'), leaf('pane-a')],
        lastDrop: { targetPaneId: 'pane-a', position: 'left', at: Date.now() }
      })
    })

    expect(setLayout).toHaveBeenCalledWith([10, 90])
  })

  it('does not tween a mount without a drop signal (fullscreen/restore remount)', () => {
    const { groupRef, setLayout } = createGroupRef()
    renderHook((p: HookProps) => usePaneSplitAnimation(p), {
      initialProps: baseProps({ groupRef, lastDrop: null })
    })

    expect(setLayout).not.toHaveBeenCalled()
  })

  it('does not tween when the drop is older than the freshness window', () => {
    const { groupRef, setLayout } = createGroupRef()
    renderHook((p: HookProps) => usePaneSplitAnimation(p), {
      initialProps: baseProps({
        groupRef,
        lastDrop: {
          targetPaneId: 'pane-a',
          position: 'right',
          at: Date.now() - PANE_DROP_FRESHNESS_MS - 50
        }
      })
    })

    expect(setLayout).not.toHaveBeenCalled()
  })

  it('does not tween for a center drop (pure tab move)', () => {
    const { groupRef, setLayout } = createGroupRef()
    renderHook((p: HookProps) => usePaneSplitAnimation(p), {
      initialProps: baseProps({
        groupRef,
        lastDrop: { targetPaneId: 'pane-a', position: 'center', at: Date.now() }
      })
    })

    expect(setLayout).not.toHaveBeenCalled()
  })

  it('does not tween a mount whose children do not contain the drop target', () => {
    const { groupRef, setLayout } = createGroupRef()
    renderHook((p: HookProps) => usePaneSplitAnimation(p), {
      initialProps: baseProps({
        groupRef,
        children: [leaf('pane-x'), leaf('pane-y')],
        lastDrop: { targetPaneId: 'pane-a', position: 'right', at: Date.now() }
      })
    })

    expect(setLayout).not.toHaveBeenCalled()
  })

  it('does not tween under prefers-reduced-motion', () => {
    reducedMotion = true
    const { groupRef, setLayout } = createGroupRef()
    renderHook((p: HookProps) => usePaneSplitAnimation(p), {
      initialProps: baseProps({
        groupRef,
        lastDrop: { targetPaneId: 'pane-a', position: 'right', at: Date.now() }
      })
    })

    expect(setLayout).not.toHaveBeenCalled()
  })

  it('does not tween while a resize-handle drag is active', () => {
    const { groupRef, setLayout } = createGroupRef()
    renderHook((p: HookProps) => usePaneSplitAnimation(p), {
      initialProps: baseProps({
        groupRef,
        isDraggingRef: { current: true },
        lastDrop: { targetPaneId: 'pane-a', position: 'right', at: Date.now() }
      })
    })

    expect(setLayout).not.toHaveBeenCalled()
  })

  it('tweens a same-direction insert on an existing group', () => {
    const { groupRef, setLayout } = createGroupRef()
    const isDraggingRef = { current: false }
    const initial = baseProps({ groupRef, isDraggingRef })

    const { rerender } = renderHook((p: HookProps) => usePaneSplitAnimation(p), {
      initialProps: initial
    })
    expect(setLayout).not.toHaveBeenCalled()

    // Drop commits: 'pane-c' spliced next to target 'pane-a'.
    const sizes = [100 / 3, 100 / 3, 100 / 3]
    rerender(
      baseProps({
        groupRef,
        isDraggingRef,
        children: [leaf('pane-a'), leaf('pane-c'), leaf('pane-b')],
        sizes,
        lastDrop: { targetPaneId: 'pane-a', position: 'right', at: Date.now() }
      })
    )

    // Siblings keep prior ratios scaled into the remaining space: 45/10/45.
    expect(setLayout).toHaveBeenCalledWith([45, 10, 45])

    vi.spyOn(performance, 'now').mockReturnValue(1e12)
    act(flushFrames)

    const lastCall = setLayout.mock.lastCall?.[0] as number[]
    for (const size of lastCall) {
      expect(size).toBeCloseTo(100 / 3)
    }
  })

  it('ignores child growth unrelated to the drop target group', () => {
    const { groupRef, setLayout } = createGroupRef()
    const isDraggingRef = { current: false }

    const { rerender } = renderHook((p: HookProps) => usePaneSplitAnimation(p), {
      initialProps: baseProps({ groupRef, isDraggingRef })
    })

    // Group grew but the drop targeted a leaf this group never contained.
    rerender(
      baseProps({
        groupRef,
        isDraggingRef,
        children: [leaf('pane-a'), leaf('pane-c'), leaf('pane-b')],
        sizes: [100 / 3, 100 / 3, 100 / 3],
        lastDrop: { targetPaneId: 'pane-elsewhere', position: 'right', at: Date.now() }
      })
    )

    expect(setLayout).not.toHaveBeenCalled()
  })

  it('ignores non-insert child changes (replacement keeps length)', () => {
    const { groupRef, setLayout } = createGroupRef()
    const isDraggingRef = { current: false }

    const { rerender } = renderHook((p: HookProps) => usePaneSplitAnimation(p), {
      initialProps: baseProps({ groupRef, isDraggingRef })
    })

    // Leaf -> nested split swaps one child id for a split id in this group:
    // same length, so no insert tween.
    rerender(
      baseProps({
        groupRef,
        isDraggingRef,
        children: [
          leaf('pane-a'),
          {
            type: 'split',
            id: 'split-9',
            direction: 'horizontal',
            children: [leaf('x'), leaf('y')],
            sizes: [50, 50]
          }
        ],
        sizes: [60, 40],
        lastDrop: { targetPaneId: 'pane-a', position: 'right', at: Date.now() }
      })
    )

    expect(setLayout).not.toHaveBeenCalled()
  })

  it('yields to a resize-handle drag that starts mid-tween (snaps to target first)', () => {
    const { groupRef, setLayout } = createGroupRef()
    const isDraggingRef = { current: false }

    const { result } = renderHook((p: HookProps) => usePaneSplitAnimation(p), {
      initialProps: baseProps({
        groupRef,
        isDraggingRef,
        lastDrop: { targetPaneId: 'pane-a', position: 'right', at: Date.now() }
      })
    })
    expect(setLayout).toHaveBeenCalledTimes(1) // start layout only

    // User grabs a handle before the next frame lands — the tween must not
    // leave the group parked at a mid-tween layout while the store holds
    // the committed target.
    isDraggingRef.current = true
    act(flushFrames)

    expect(setLayout).toHaveBeenCalledTimes(2)
    expect(setLayout).toHaveBeenLastCalledWith([50, 50])
    expect(result.current.current).toBe(false)
    expect(rafCallbacks).toHaveLength(0)
  })

  it('snaps to the committed target when a later commit cancels the tween', () => {
    const { groupRef, setLayout } = createGroupRef()
    const isDraggingRef = { current: false }

    const { rerender } = renderHook((p: HookProps) => usePaneSplitAnimation(p), {
      initialProps: baseProps({
        groupRef,
        isDraggingRef,
        lastDrop: { targetPaneId: 'pane-a', position: 'right', at: Date.now() }
      })
    })
    expect(setLayout).toHaveBeenCalledWith([90, 10]) // mount start layout

    // A later commit re-runs the effect before the first frame lands — the
    // cleanup must settle the group at the committed target, never at a
    // stale or mid-tween layout.
    rerender(
      baseProps({
        groupRef,
        isDraggingRef,
        lastDrop: { targetPaneId: 'pane-a', position: 'right', at: Date.now() }
      })
    )

    expect(setLayout).toHaveBeenLastCalledWith([50, 50])
  })

  it('tweens a net-zero add+remove when the drop collapses the source pane in the same commit', () => {
    const { groupRef, setLayout } = createGroupRef()
    const isDraggingRef = { current: false }

    const { rerender } = renderHook((p: HookProps) => usePaneSplitAnimation(p), {
      initialProps: baseProps({
        groupRef,
        isDraggingRef,
        children: [leaf('pane-src'), leaf('pane-a')],
        sizes: [50, 50]
      })
    })
    expect(setLayout).not.toHaveBeenCalled()

    // Drop on 'pane-a' moves a tab out of 'pane-src'; the store collapses
    // the emptied source pane and splices the new leaf beside the target —
    // the child COUNT is flat but the id set changed, so the insert tween
    // must still run.
    rerender(
      baseProps({
        groupRef,
        isDraggingRef,
        children: [leaf('pane-a'), leaf('pane-new')],
        sizes: [60, 40],
        lastDrop: { targetPaneId: 'pane-a', position: 'right', at: Date.now() }
      })
    )

    // Surviving sibling keeps its prior share scaled into the remaining
    // space: pane-a was 50/50 -> 90, new pane starts at minSize.
    expect(setLayout).toHaveBeenCalledWith([90, 10])
  })

  it('keeps the last length-matched sizes as the ratio base after a mismatched commit', () => {
    const { groupRef, setLayout } = createGroupRef()
    const isDraggingRef = { current: false }

    const { rerender } = renderHook((p: HookProps) => usePaneSplitAnimation(p), {
      initialProps: baseProps({
        groupRef,
        isDraggingRef,
        children: [leaf('pane-a'), leaf('pane-b')],
        sizes: [60, 40]
      })
    })

    // Mismatched commit: child count grew but the committed sizes array did
    // not — no tween, and prevSizes must keep the last VALID [60,40]
    // alignment rather than this length-2 layout for 3 children.
    rerender(
      baseProps({
        groupRef,
        isDraggingRef,
        children: [leaf('pane-a'), leaf('pane-b'), leaf('pane-c')],
        sizes: [50, 50],
        lastDrop: { targetPaneId: 'pane-a', position: 'right', at: Date.now() }
      })
    )
    expect(setLayout).not.toHaveBeenCalled()

    // Next insert scales surviving siblings from the [60,40]-era ratios:
    // a:60/100*90=54, b:40/100*90=36, c has no prior ratio -> 0, d new -> 10.
    rerender(
      baseProps({
        groupRef,
        isDraggingRef,
        children: [leaf('pane-a'), leaf('pane-b'), leaf('pane-c'), leaf('pane-d')],
        sizes: [25, 25, 25, 25],
        lastDrop: { targetPaneId: 'pane-a', position: 'right', at: Date.now() }
      })
    )

    expect(setLayout).toHaveBeenCalledWith([54, 36, 0, 10])
  })
})
