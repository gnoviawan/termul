import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkspaceTabBar } from './WorkspaceTabBar'
import type { WorkspaceTab } from '@/stores/workspace-store'
import type { DragPayload } from '@/types/workspace.types'

const mockSetActiveTab = vi.fn()
const mockSetActivePane = vi.fn()
const mockReorderTabsInPane = vi.fn()
const mockCloseTab = vi.fn()
const mockTogglePaneFullscreen = vi.fn()
const mockCloseFileIfIdle = vi.fn(() => true)

const mockWorkspaceStoreState = {
  fullscreenPaneId: null as string | null,
  setActiveTab: mockSetActiveTab,
  setActivePane: mockSetActivePane,
  togglePaneFullscreen: mockTogglePaneFullscreen,
  reorderTabsInPane: mockReorderTabsInPane,
  closeTab: mockCloseTab
}

const mockEditorOpenFiles = new Map<string, { isDirty: boolean; operationStatus?: string }>()
const mockEditorStoreState = {
  openFiles: mockEditorOpenFiles,
  closeFileIfIdle: mockCloseFileIfIdle
}

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: Object.assign(
    vi.fn((selector: (state: typeof mockWorkspaceStoreState) => unknown) => selector(mockWorkspaceStoreState)),
    {
      getState: () => mockWorkspaceStoreState
    }
  ),
  useFullscreenPaneId: () => mockWorkspaceStoreState.fullscreenPaneId,
  useLeafCount: () => 3,
  editorTabId: (filePath: string) => `edit-${filePath}`
}))

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: Object.assign(
    vi.fn((selector: (state: typeof mockEditorStoreState) => unknown) => selector(mockEditorStoreState)),
    {
      getState: () => mockEditorStoreState
    }
  )
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: vi.fn((selector: (state: { terminals: Array<{ id: string; name: string; shell: string }> }) => unknown) =>
    selector({
      terminals: [
        { id: 'term-1', name: 'Terminal 1', shell: 'bash' },
        { id: 'term-2', name: 'Terminal 2', shell: 'zsh' },
        { id: 'term-3', name: 'Terminal 3', shell: 'bash' }
      ]
    })
  ),
  useProjectsWithActivity: () => [],
  useProjectsWithErrors: () => new Set()
}))

const mockStartTabDrag = vi.hoisted(() => vi.fn())
const mockSetReorderPreview = vi.hoisted(() => vi.fn())
const mockClearReorderPreview = vi.hoisted(() => vi.fn())
const mockHandleTabReorder = vi.hoisted(() => vi.fn())

interface MockPaneDndValue {
  startTabDrag: typeof mockStartTabDrag
  dragPayload: DragPayload | null
  reorderPreview: { paneId: string; targetTabId: string; position: 'before' | 'after' } | null
  setReorderPreview: typeof mockSetReorderPreview
  clearReorderPreview: typeof mockClearReorderPreview
  handleTabReorder: typeof mockHandleTabReorder
}

const mockUsePaneDnd = vi.hoisted(() =>
  vi.fn<() => MockPaneDndValue>(() => ({
    startTabDrag: mockStartTabDrag,
    dragPayload: null,
    reorderPreview: null,
    setReorderPreview: mockSetReorderPreview,
    clearReorderPreview: mockClearReorderPreview,
    handleTabReorder: mockHandleTabReorder
  }))
)

vi.mock('@/hooks/use-pane-dnd', () => ({
  usePaneDnd: mockUsePaneDnd
}))

const mockShellApiGetAvailableShells = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    success: true,
    data: {
      default: { name: 'bash', displayName: 'Bash', path: '/bin/bash' },
      available: [{ name: 'bash', displayName: 'Bash', path: '/bin/bash' }]
    }
  })
)

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    shellApi: {
      getAvailableShells: mockShellApiGetAvailableShells
    },
    clipboardApi: {
      writeText: vi.fn()
    }
  }
})

beforeEach(() => {
  mockSetActiveTab.mockReset()
  mockSetActivePane.mockReset()
  mockReorderTabsInPane.mockReset()
  mockCloseTab.mockReset()
  mockTogglePaneFullscreen.mockReset()
  mockCloseFileIfIdle.mockReset()
  mockWorkspaceStoreState.fullscreenPaneId = null
  mockCloseFileIfIdle.mockReturnValue(true)
  mockEditorOpenFiles.clear()
  mockStartTabDrag.mockReset()
  mockSetReorderPreview.mockReset()
  mockClearReorderPreview.mockReset()
  mockHandleTabReorder.mockReset()
  mockUsePaneDnd.mockReset()
  mockUsePaneDnd.mockReturnValue({
    startTabDrag: mockStartTabDrag,
    dragPayload: null,
    reorderPreview: null,
    setReorderPreview: mockSetReorderPreview,
    clearReorderPreview: mockClearReorderPreview,
    handleTabReorder: mockHandleTabReorder
  })

  mockShellApiGetAvailableShells.mockResolvedValue({
    success: true,
    data: {
      default: { name: 'bash', displayName: 'Bash', path: '/bin/bash' },
      available: [{ name: 'bash', displayName: 'Bash', path: '/bin/bash' }]
    }
  })
})

async function flushShellEffect(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('WorkspaceTabBar', () => {
  it('shows pane plus action and no pane-close side control', async () => {
    render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={[]}
        activeTabId={null}
        onAddTerminal={vi.fn()}
      />
    )

    await flushShellEffect()

    expect(screen.getByTitle('Open terminal menu')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.queryByTitle('Close pane')).not.toBeInTheDocument()
    })
  })

  it('calls pane-scoped onAddTerminal when a shell is selected from the terminal menu', async () => {
    const onAddTerminal = vi.fn()

    render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={[]}
        activeTabId={null}
        onAddTerminal={onAddTerminal}
      />
    )

    await flushShellEffect()

    fireEvent.click(screen.getByTitle('Open terminal menu'))
    fireEvent.click(screen.getByText('Bash'))

    expect(onAddTerminal).toHaveBeenCalledTimes(1)
    expect(onAddTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'bash', displayName: 'Bash', path: '/bin/bash' })
    )
  })

  it('calls pane-scoped onAddBrowserTab when browser action is clicked', async () => {
    const onAddBrowserTab = vi.fn()

    render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={[]}
        activeTabId={null}
        onAddBrowserTab={onAddBrowserTab}
      />
    )

    await flushShellEffect()

    fireEvent.click(screen.getByTitle('New Browser Tab'))

    expect(onAddBrowserTab).toHaveBeenCalledTimes(1)
  })

  it('renders fullscreen focus button when leafCount > 1', async () => {
    render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={[]}
        activeTabId={null}
      />
    )

    await flushShellEffect()

    expect(screen.getByTitle('Focus pane')).toBeInTheDocument()
    expect(screen.queryByTitle('Restore pane layout')).not.toBeInTheDocument()
  })

  it('renders restore button when pane is fullscreen', async () => {
    mockWorkspaceStoreState.fullscreenPaneId = 'pane-a'

    render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={[]}
        activeTabId={null}
      />
    )

    await flushShellEffect()

    expect(screen.getByTitle('Restore pane layout')).toBeInTheDocument()
    expect(screen.queryByTitle('Focus pane')).not.toBeInTheDocument()
  })

  it('renders editor tab with non-jitter active style class', async () => {
    const tabs: WorkspaceTab[] = [{ type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' }]

    const { container } = render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={tabs}
        activeTabId="edit-/a.ts"
      />
    )

    await flushShellEffect()

    const tabEl = container.querySelector('.border-b-primary') as HTMLElement
    expect(tabEl).toBeTruthy()
    expect(tabEl.className).toContain('border-b-2')
    expect(tabEl.className).toContain('border-b-primary')
    expect(tabEl.className).not.toContain('border-t-2')
  })

  it('uses onCloseEditorTab callback when closing editor tab', async () => {
    const onCloseEditorTab = vi.fn()
    const tabs: WorkspaceTab[] = [{ type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' }]

    render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={tabs}
        activeTabId="edit-/a.ts"
        onCloseEditorTab={onCloseEditorTab}
      />
    )

    await flushShellEffect()

    const tabCloseButton = screen.getByTitle('Close tab')

    fireEvent.click(tabCloseButton)

    expect(onCloseEditorTab).toHaveBeenCalledWith('/a.ts')
    expect(mockCloseTab).not.toHaveBeenCalled()
  })

  it('uses the fallback close path when no onCloseEditorTab callback is provided', async () => {
    const tabs: WorkspaceTab[] = [{ type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' }]

    render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={tabs}
        activeTabId="edit-/a.ts"
      />
    )

    await flushShellEffect()

    fireEvent.click(screen.getByTitle('Close tab'))

    expect(mockCloseFileIfIdle).toHaveBeenCalledWith('/a.ts')
    expect(mockCloseTab).toHaveBeenCalledWith('pane-a', 'edit-/a.ts')
  })

  it('does not close editor tabs while the file is saving', async () => {
    mockEditorOpenFiles.set('/a.ts', { isDirty: true, operationStatus: 'saving' })
    const onCloseEditorTab = vi.fn()
    const tabs: WorkspaceTab[] = [{ type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' }]

    render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={tabs}
        activeTabId="edit-/a.ts"
        onCloseEditorTab={onCloseEditorTab}
      />
    )

    await flushShellEffect()

    const savingButton = screen.getByTitle('Saving file')
    expect(savingButton).toBeDisabled()
    fireEvent.click(savingButton)

    expect(onCloseEditorTab).not.toHaveBeenCalled()
    expect(mockCloseFileIfIdle).not.toHaveBeenCalled()
    expect(mockCloseTab).not.toHaveBeenCalled()
  })

  it('does not remove the workspace tab when fallback closeFileIfIdle returns false', async () => {
    mockCloseFileIfIdle.mockReturnValue(false)
    const tabs: WorkspaceTab[] = [{ type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' }]

    render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={tabs}
        activeTabId="edit-/a.ts"
      />
    )

    await flushShellEffect()

    fireEvent.click(screen.getByTitle('Close tab'))

    expect(mockCloseFileIfIdle).toHaveBeenCalledWith('/a.ts')
    expect(mockCloseTab).not.toHaveBeenCalled()
  })

  it.skip('calls startTabDrag when dragging a terminal tab', async () => {})

  it.skip('shows drop indicator on left side when dragging over left half of tab', async () => {})

  it.skip('shows drop indicator on right side when dragging over right half of tab', async () => {})

  it.skip('calls handleTabReorder when dropping on a tab', async () => {})

  it.skip('does not show drop indicator when dragging from different pane', async () => {})

  it.skip('applies opacity and scale to dragged tab', async () => {})
})