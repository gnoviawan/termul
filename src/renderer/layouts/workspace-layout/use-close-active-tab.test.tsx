import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceTab } from '@/stores/workspace-store'
import { useCloseActiveTab } from './use-close-active-tab'
import { useEditorTabClose } from './use-editor-tab-close'

const {
  menuListeners,
  openFiles,
  mockCloseFileIfIdle,
  mockRemoveTab,
  mockRemoveBrowserTab,
  mockUnmountCanvas,
  mockCloseAgentChat
} = vi.hoisted(() => ({
  menuListeners: new Map<string, () => void>(),
  openFiles: new Map<string, { isDirty: boolean; operationStatus?: string }>(),
  mockCloseFileIfIdle: vi.fn(),
  mockRemoveTab: vi.fn(),
  mockRemoveBrowserTab: vi.fn(),
  mockUnmountCanvas: vi.fn(),
  mockCloseAgentChat: vi.fn()
}))

vi.mock('@/lib/tauri-event', () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    menuListeners.set(event, handler)
    return () => menuListeners.delete(event)
  })
}))
vi.mock('@/stores/editor-store', () => ({
  useEditorStore: {
    getState: () => ({ openFiles, closeFileIfIdle: mockCloseFileIfIdle })
  }
}))
vi.mock('@/stores/workspace-store', () => ({
  editorTabId: (filePath: string) => `edit-${filePath}`,
  useWorkspaceStore: { getState: () => ({ removeTab: mockRemoveTab }) }
}))
vi.mock('@/stores/browser-session-store', () => ({
  useBrowserSessionStore: { getState: () => ({ removeTab: mockRemoveBrowserTab }) }
}))
vi.mock('@/stores/canvas-store', () => ({
  useCanvasStore: { getState: () => ({ unmountCanvas: mockUnmountCanvas }) }
}))
vi.mock('@/lib/agent-chat-close', () => ({ closeAgentChat: mockCloseAgentChat }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn().mockResolvedValue(undefined) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

async function closeActiveTabFromMenu(activeTab: WorkspaceTab) {
  const handleCloseTerminal = vi.fn()
  const { result } = renderHook(() => {
    const editorTabClose = useEditorTabClose()
    const closeActive = useCloseActiveTab({
      activeTab,
      isAgentLauncherOpen: false,
      closeEditorTab: editorTabClose.handleCloseEditorTab
    })
    closeActive.handleCloseTerminalRef.current = handleCloseTerminal
    return editorTabClose
  })
  await act(async () => {})
  act(() => {
    menuListeners.get('menu:close-tab')?.()
  })
  return { dirtyCloseFilePath: result.current.dirtyCloseFilePath, handleCloseTerminal }
}

const editorTab: WorkspaceTab = { type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' }

beforeEach(() => {
  menuListeners.clear()
  openFiles.clear()
  mockCloseFileIfIdle.mockReset().mockReturnValue(true)
  mockRemoveTab.mockReset()
  mockRemoveBrowserTab.mockReset()
  mockUnmountCanvas.mockReset().mockResolvedValue(undefined)
  mockCloseAgentChat
    .mockReset()
    .mockImplementation((_id: string, closeTab: () => void) => closeTab())
})

describe('useCloseActiveTab (menu Close Tab)', () => {
  it('closes a clean editor and removes its tab', async () => {
    openFiles.set('/a.ts', { isDirty: false, operationStatus: 'idle' })

    const { dirtyCloseFilePath } = await closeActiveTabFromMenu(editorTab)

    expect(dirtyCloseFilePath).toBeNull()
    expect(mockCloseFileIfIdle).toHaveBeenCalledWith('/a.ts')
    expect(mockRemoveTab).toHaveBeenCalledWith('edit-/a.ts')
  })

  it('opens the dirty-file confirm for a dirty editor and keeps the tab', async () => {
    openFiles.set('/a.ts', { isDirty: true, operationStatus: 'idle' })

    const { dirtyCloseFilePath } = await closeActiveTabFromMenu(editorTab)

    expect(dirtyCloseFilePath).toBe('/a.ts')
    expect(mockCloseFileIfIdle).not.toHaveBeenCalled()
    expect(mockRemoveTab).not.toHaveBeenCalled()
  })

  it('refuses a dirty editor mid-save without opening the confirm', async () => {
    openFiles.set('/a.ts', { isDirty: true, operationStatus: 'saving' })

    const { dirtyCloseFilePath } = await closeActiveTabFromMenu(editorTab)

    expect(dirtyCloseFilePath).toBeNull()
    expect(mockCloseFileIfIdle).not.toHaveBeenCalled()
    expect(mockRemoveTab).not.toHaveBeenCalled()
  })

  it('removes an editor tab whose file is absent from openFiles', async () => {
    mockCloseFileIfIdle.mockReturnValue(false)

    await closeActiveTabFromMenu(editorTab)

    expect(mockRemoveTab).toHaveBeenCalledWith('edit-/a.ts')
  })

  it('routes a terminal through the terminal close flow', async () => {
    const { handleCloseTerminal } = await closeActiveTabFromMenu({
      type: 'terminal',
      id: 'term-t1',
      terminalId: 't1'
    })

    expect(handleCloseTerminal).toHaveBeenCalledWith('t1', 'term-t1')
    expect(mockRemoveTab).not.toHaveBeenCalled()
  })

  it('tears down a browser tab like the tab close button', async () => {
    await closeActiveTabFromMenu({ type: 'browser', id: 'browser-b1', browserTabId: 'b1' })

    expect(mockRemoveBrowserTab).toHaveBeenCalledWith('b1')
    expect(mockRemoveTab).toHaveBeenCalledWith('browser-b1')
  })

  it('leaves a canvas tab open', async () => {
    await closeActiveTabFromMenu({
      type: 'canvas',
      id: 'canvas-p1',
      projectId: 'p1',
      docPath: '/p/Plan.op'
    })

    expect(mockUnmountCanvas).not.toHaveBeenCalled()
    expect(mockRemoveTab).not.toHaveBeenCalled()
  })
})
