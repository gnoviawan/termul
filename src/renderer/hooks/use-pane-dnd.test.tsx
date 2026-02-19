import { describe, expect, it, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { PaneDndProvider, usePaneDnd } from './use-pane-dnd'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useEditorStore } from '@/stores/editor-store'
import type { WorkspaceTab } from '@/stores/workspace-store'

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: {
    getState: vi.fn()
  },
  editorTabId: (filePath: string) => `edit-${filePath}`
}))

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: {
    getState: vi.fn()
  }
}))

function createDragEvent(payload?: unknown): React.DragEvent {
  const data = payload === undefined ? '' : JSON.stringify(payload)
  const dataTransfer = {
    setData: vi.fn(),
    getData: vi.fn().mockReturnValue(data),
    effectAllowed: 'move'
  } as unknown as DataTransfer

  return {
    dataTransfer,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  } as unknown as React.DragEvent
}

describe('use-pane-dnd routing', () => {
  const moveTabToPane = vi.fn()
  const moveTabToNewSplit = vi.fn()
  const addTabToPane = vi.fn()
  const splitPane = vi.fn()
  const openFile = vi.fn()

  beforeEach(() => {
    moveTabToPane.mockReset()
    moveTabToNewSplit.mockReset()
    addTabToPane.mockReset()
    splitPane.mockReset()
    openFile.mockReset()

    ;(useWorkspaceStore.getState as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      moveTabToPane,
      moveTabToNewSplit,
      addTabToPane,
      splitPane
    })

    ;(useEditorStore.getState as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      openFile
    })
  })

  it('routes center tab drop to moveTabToPane', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PaneDndProvider>{children}</PaneDndProvider>
    )

    const { result } = renderHook(() => usePaneDnd(), { wrapper })

    const event = createDragEvent({
      type: 'tab',
      tabId: 'tab-1',
      sourcePaneId: 'pane-a'
    })

    act(() => {
      result.current.handleDrop('pane-b', 'center', event)
    })

    expect(moveTabToPane).toHaveBeenCalledWith('tab-1', 'pane-a', 'pane-b')
    expect(moveTabToNewSplit).not.toHaveBeenCalled()
  })

  it('routes edge tab drop to moveTabToNewSplit', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PaneDndProvider>{children}</PaneDndProvider>
    )

    const { result } = renderHook(() => usePaneDnd(), { wrapper })

    const event = createDragEvent({
      type: 'tab',
      tabId: 'tab-1',
      sourcePaneId: 'pane-a'
    })

    act(() => {
      result.current.handleDrop('pane-b', 'left', event)
    })

    expect(moveTabToNewSplit).toHaveBeenCalledWith('tab-1', 'pane-a', 'pane-b', 'left')
    expect(moveTabToPane).not.toHaveBeenCalled()
  })

  it('routes center file drop to addTabToPane after openFile', async () => {
    openFile.mockResolvedValue(undefined)

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PaneDndProvider>{children}</PaneDndProvider>
    )

    const { result } = renderHook(() => usePaneDnd(), { wrapper })

    const event = createDragEvent({ type: 'file', filePath: '/project/src/app.ts' })

    act(() => {
      result.current.handleDrop('pane-b', 'center', event)
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(openFile).toHaveBeenCalledWith('/project/src/app.ts')
    expect(addTabToPane).toHaveBeenCalledWith('pane-b', {
      type: 'editor',
      id: 'edit-/project/src/app.ts',
      filePath: '/project/src/app.ts'
    } satisfies WorkspaceTab)
    expect(splitPane).not.toHaveBeenCalled()
  })

  it('routes edge file drop to splitPane with position', async () => {
    openFile.mockResolvedValue(undefined)

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PaneDndProvider>{children}</PaneDndProvider>
    )

    const { result } = renderHook(() => usePaneDnd(), { wrapper })

    const event = createDragEvent({ type: 'file', filePath: '/project/src/app.ts' })

    act(() => {
      result.current.handleDrop('pane-b', 'top', event)
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(splitPane).toHaveBeenCalledWith(
      'pane-b',
      'vertical',
      {
        type: 'editor',
        id: 'edit-/project/src/app.ts',
        filePath: '/project/src/app.ts'
      },
      'top'
    )
    expect(addTabToPane).not.toHaveBeenCalled()
  })

  it('ignores malformed payload without mutating store actions', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PaneDndProvider>{children}</PaneDndProvider>
    )

    const { result } = renderHook(() => usePaneDnd(), { wrapper })

    const event = createDragEvent('not-json')
    ;(event.dataTransfer.getData as unknown as ReturnType<typeof vi.fn>).mockReturnValue('{invalid')

    act(() => {
      result.current.handleDrop('pane-b', 'center', event)
    })

    expect(moveTabToPane).not.toHaveBeenCalled()
    expect(moveTabToNewSplit).not.toHaveBeenCalled()
    expect(addTabToPane).not.toHaveBeenCalled()
    expect(splitPane).not.toHaveBeenCalled()
  })

  it('sets and clears shared preview target', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PaneDndProvider>{children}</PaneDndProvider>
    )

    const { result } = renderHook(() => usePaneDnd(), { wrapper })

    act(() => {
      result.current.setPreviewTarget('pane-a', 'right')
    })

    expect(result.current.previewTarget).toEqual({ paneId: 'pane-a', position: 'right' })

    act(() => {
      result.current.clearPreviewTarget('pane-b')
    })

    expect(result.current.previewTarget).toEqual({ paneId: 'pane-a', position: 'right' })

    act(() => {
      result.current.clearPreviewTarget('pane-a', 'right')
    })

    expect(result.current.previewTarget).toBeNull()
  })
})
