import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFramerMotionTestState } from '@/test-utils/mock-framer-motion'
import type { SplitNode } from '@/types/workspace.types'
import { PaneRenderer } from './PaneRenderer'

/**
 * Spec I/O matrix — edge-drop tween must not feed store writes back into
 * `updatePaneSizes` (feedback loop). The fake panel group below stands in
 * for react-resizable-panels: its imperative `setLayout` re-fires the
 * registered `onLayout`, exactly like the real `ImperativePanelGroupHandle`.
 */
const { updatePaneSizes, dndState, groupHandle } = vi.hoisted(() => ({
  updatePaneSizes: vi.fn(),
  dndState: {
    lastDrop: null as {
      targetPaneId: string
      position: 'left' | 'right' | 'top' | 'bottom' | 'center'
      at: number
    } | null
  },
  groupHandle: {
    onLayout: null as null | ((sizes: number[]) => void),
    setLayoutCalls: [] as number[][]
  }
}))

vi.mock('@/components/ui/resizable', async () => {
  const React = await import('react')
  type GroupProps = {
    id?: string
    onLayout?: (sizes: number[]) => void
    children?: React.ReactNode
  }
  const ResizablePanelGroup = React.forwardRef<
    import('react-resizable-panels').ImperativePanelGroupHandle,
    GroupProps
  >(function ResizablePanelGroup(props, ref) {
    React.useImperativeHandle(
      ref,
      (): import('react-resizable-panels').ImperativePanelGroupHandle => {
        groupHandle.onLayout = props.onLayout ?? null
        return {
          getId: () => props.id ?? 'group',
          getLayout: () => [],
          setLayout: (layout: number[]) => {
            groupHandle.setLayoutCalls.push([...layout])
            // Real handle contract: imperative setLayout re-fires onLayout —
            // the component's tween guard must suppress the resulting write.
            props.onLayout?.(layout)
          }
        }
      },
      [props.onLayout]
    )
    return <div data-testid="panel-group">{props.children}</div>
  })
  const ResizablePanel = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  )
  const ResizableHandle = () => <div data-testid="resize-handle" />
  return { ResizablePanelGroup, ResizablePanel, ResizableHandle }
})

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: { updatePaneSizes: typeof updatePaneSizes }) => unknown) =>
      selector({ updatePaneSizes }),
    { getState: () => ({ updatePaneSizes }) }
  )
}))

vi.mock('@/hooks/use-pane-dnd', () => ({
  usePaneDnd: () => ({ lastDrop: dndState.lastDrop })
}))

// Pane internals are irrelevant to the layout-tween guard.
vi.mock('@/components/workspace/PaneContent', () => ({
  PaneContent: () => <div data-testid="pane-content" />
}))

vi.mock('framer-motion', async (importOriginal) => {
  const { installFramerMotionMock } = await import('@/test-utils/mock-framer-motion')
  return installFramerMotionMock(importOriginal)
})

let rafCallbacks: FrameRequestCallback[] = []

function flushFrames(): void {
  const callbacks = rafCallbacks
  rafCallbacks = []
  for (const cb of callbacks) {
    cb(0)
  }
}

const splitNode: SplitNode = {
  type: 'split',
  id: 'split-1',
  direction: 'horizontal',
  children: [
    { type: 'leaf', id: 'pane-a', tabs: [], activeTabId: null },
    { type: 'leaf', id: 'pane-b', tabs: [], activeTabId: null }
  ],
  sizes: [50, 50]
}

describe('PaneRenderer — tween onLayout guard', () => {
  beforeEach(() => {
    updatePaneSizes.mockReset()
    dndState.lastDrop = null
    groupHandle.onLayout = null
    groupHandle.setLayoutCalls = []
    resetFramerMotionTestState()
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

  it('suppresses updatePaneSizes while the drop tween drives setLayout, then resumes writes', () => {
    dndState.lastDrop = { targetPaneId: 'pane-a', position: 'right', at: Date.now() }

    render(<PaneRenderer node={splitNode} />)

    // Mount tween: the start layout is applied imperatively and its
    // onLayout echo must NOT be written into the store — the store already
    // holds the committed sizes.
    expect(groupHandle.setLayoutCalls).toEqual([[90, 10]])
    expect(groupHandle.onLayout).toBeTypeOf('function')
    expect(updatePaneSizes).not.toHaveBeenCalled()

    // Drive the tween to completion — every frame's onLayout echo stays
    // suppressed through the final setLayout.
    vi.spyOn(performance, 'now').mockReturnValue(1e12)
    act(flushFrames)

    expect(groupHandle.setLayoutCalls.at(-1)).toEqual([50, 50])
    expect(updatePaneSizes).not.toHaveBeenCalled()

    // Tween finished — real layouts (resize drags) write to the store again.
    act(() => {
      groupHandle.onLayout?.([60, 40])
    })
    expect(updatePaneSizes).toHaveBeenCalledWith('split-1', [60, 40])
  })

  it('writes layouts normally for a non-drop mount (no tween armed)', () => {
    render(<PaneRenderer node={splitNode} />)

    // No fresh lastDrop → no start layout applied.
    expect(groupHandle.setLayoutCalls).toEqual([])

    act(() => {
      groupHandle.onLayout?.([70, 30])
    })
    expect(updatePaneSizes).toHaveBeenCalledWith('split-1', [70, 30])
  })
})
