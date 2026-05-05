import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkspaceTabBar } from './WorkspaceTabBar'
import type { WorkspaceTab } from '@/stores/workspace-store'
import type { DragPayload } from '@/types/workspace.types'

const mockSetActiveTab = vi.fn()
const mockSetActivePane = vi.fn()
const mockReorderTabsInPane = vi.fn()
const mockCloseTab = vi.fn()
const mockCloseFileIfIdle = vi.fn(() => true)

const mockWorkspaceStoreState = {
  setActiveTab: mockSetActiveTab,
  setActivePane: mockSetActivePane,
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
  )
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

beforeEach(() => {
  mockSetActiveTab.mockReset()
  mockSetActivePane.mockReset()
  mockReorderTabsInPane.mockReset()
  mockCloseTab.mockReset()
  mockCloseFileIfIdle.mockReset()
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

  vi.stubGlobal('api', {
    shell: {
      getAvailableShells: vi.fn().mockResolvedValue({
        success: true,
        data: {
          default: { name: 'bash', displayName: 'Bash', path: '/bin/bash' },
          available: [{ name: 'bash', displayName: 'Bash', path: '/bin/bash' }]
        }
      })
    },
    clipboard: {
      writeText: vi.fn()
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
        onNewTerminal={vi.fn()}
      />
    )

    await flushShellEffect()

    expect(screen.getByTitle('New terminal (default shell)')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.queryByTitle('Close pane')).not.toBeInTheDocument()
    })
  })

  it('calls pane-scoped onNewTerminal when plus is clicked', async () => {
    const onNewTerminal = vi.fn()

    render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={[]}
        activeTabId={null}
        onNewTerminal={onNewTerminal}
      />
    )

    await flushShellEffect()

    fireEvent.click(screen.getByTitle('New terminal (default shell)'))

    expect(onNewTerminal).toHaveBeenCalledTimes(1)
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

  it('calls startTabDrag when dragging a terminal tab', async () => {
    const tabs: WorkspaceTab[] = [{ type: 'terminal', id: 'tab-1', terminalId: 'term-1' }]

    const { container } = render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={tabs}
        activeTabId="tab-1"
      />
    )

    await flushShellEffect()

    const tabEl = container.querySelector('[draggable="true"]') as HTMLElement
    expect(tabEl).toBeTruthy()

    fireEvent.dragStart(tabEl, {
      dataTransfer: {
        setData: vi.fn(),
        effectAllowed: null
      }
    })

    expect(mockStartTabDrag).toHaveBeenCalledWith('tab-1', 'pane-a', expect.anything())
  })

  it('shows drop indicator on left side when dragging over left half of tab', async () => {
    // Mock dragPayload to indicate we're dragging a tab from the same pane
    mockUsePaneDnd.mockReturnValue({
      startTabDrag: mockStartTabDrag,
      dragPayload: { type: 'tab', tabId: 'tab-3', sourcePaneId: 'pane-a' },
      reorderPreview: null,
      setReorderPreview: mockSetReorderPreview,
      clearReorderPreview: mockClearReorderPreview,
      handleTabReorder: mockHandleTabReorder
    })

    const tabs: WorkspaceTab[] = [
      { type: 'terminal', id: 'tab-1', terminalId: 'term-1' },
      { type: 'terminal', id: 'tab-2', terminalId: 'term-2' }
    ]

    const { container } = render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={tabs}
        activeTabId="tab-1"
      />
    )

    await flushShellEffect()

    const tabEls = container.querySelectorAll('[draggable="true"]')
    const targetTab = tabEls[1] as HTMLElement // Second tab

    // Mock getBoundingClientRect to return a known width
    targetTab.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      right: 200,
      bottom: 40,
      width: 200,
      height: 40,
      x: 0,
      y: 0,
      toJSON: vi.fn()
    }))

    // Create drag event and set clientX manually
    const dragEvent = createEvent.dragOver(targetTab, {
      dataTransfer: { dropEffect: null }
    })
    Object.defineProperty(dragEvent, 'clientX', { value: 50, writable: false })
    Object.defineProperty(dragEvent, 'clientY', { value: 20, writable: false })
    fireEvent(targetTab, dragEvent)

    expect(mockSetReorderPreview).toHaveBeenCalledWith('pane-a', 'tab-2', 'before')
  })

  it('shows drop indicator on right side when dragging over right half of tab', async () => {
    // Mock dragPayload to indicate we're dragging a tab from the same pane
    mockUsePaneDnd.mockReturnValue({
      startTabDrag: mockStartTabDrag,
      dragPayload: { type: 'tab', tabId: 'tab-3', sourcePaneId: 'pane-a' },
      reorderPreview: null,
      setReorderPreview: mockSetReorderPreview,
      clearReorderPreview: mockClearReorderPreview,
      handleTabReorder: mockHandleTabReorder
    })

    const tabs: WorkspaceTab[] = [
      { type: 'terminal', id: 'tab-1', terminalId: 'term-1' },
      { type: 'terminal', id: 'tab-2', terminalId: 'term-2' }
    ]

    const { container } = render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={tabs}
        activeTabId="tab-1"
      />
    )

    await flushShellEffect()

    const tabEls = container.querySelectorAll('[draggable="true"]')
    const targetTab = tabEls[1] as HTMLElement // Second tab

    // Mock getBoundingClientRect to return a known width
    targetTab.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      right: 200,
      bottom: 40,
      width: 200,
      height: 40,
      x: 0,
      y: 0,
      toJSON: vi.fn()
    }))

    // Drag over right half (x = 150, which is > 100)
    fireEvent.dragOver(targetTab, {
      clientX: 150,
      clientY: 20,
      dataTransfer: { dropEffect: null }
    })

    expect(mockSetReorderPreview).toHaveBeenCalledWith('pane-a', 'tab-2', 'after')
  })

  it('calls handleTabReorder when dropping on a tab', async () => {
    // Mock dragPayload to indicate we're dragging a tab from the same pane
    mockUsePaneDnd.mockReturnValue({
      startTabDrag: mockStartTabDrag,
      dragPayload: { type: 'tab', tabId: 'tab-1', sourcePaneId: 'pane-a' },
      reorderPreview: null,
      setReorderPreview: mockSetReorderPreview,
      clearReorderPreview: mockClearReorderPreview,
      handleTabReorder: mockHandleTabReorder
    })

    const tabs: WorkspaceTab[] = [
      { type: 'terminal', id: 'tab-1', terminalId: 'term-1' },
      { type: 'terminal', id: 'tab-2', terminalId: 'term-2' }
    ]

    const { container } = render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={tabs}
        activeTabId="tab-1"
      />
    )

    await flushShellEffect()

    const tabEls = container.querySelectorAll('[draggable="true"]')
    const targetTab = tabEls[1] as HTMLElement // Second tab

    // Mock getBoundingClientRect to return a known width
    targetTab.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      right: 200,
      bottom: 40,
      width: 200,
      height: 40,
      x: 0,
      y: 0,
      toJSON: vi.fn()
    }))

    // Drop on right half
    fireEvent.drop(targetTab, {
      clientX: 150,
      clientY: 20
    })

    expect(mockHandleTabReorder).toHaveBeenCalledWith('pane-a', 'tab-2', 'after')
  })

  it('does not show drop indicator when dragging from different pane', async () => {
    // Mock dragPayload to indicate we're dragging a tab from a different pane
    mockUsePaneDnd.mockReturnValue({
      startTabDrag: mockStartTabDrag,
      dragPayload: { type: 'tab', tabId: 'tab-3', sourcePaneId: 'pane-b' },
      reorderPreview: null,
      setReorderPreview: mockSetReorderPreview,
      clearReorderPreview: mockClearReorderPreview,
      handleTabReorder: mockHandleTabReorder
    })

    const tabs: WorkspaceTab[] = [
      { type: 'terminal', id: 'tab-1', terminalId: 'term-1' },
      { type: 'terminal', id: 'tab-2', terminalId: 'term-2' }
    ]

    const { container } = render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={tabs}
        activeTabId="tab-1"
      />
    )

    await flushShellEffect()

    const tabEls = container.querySelectorAll('[draggable="true"]')
    const targetTab = tabEls[1] as HTMLElement

    fireEvent.dragOver(targetTab, {
      clientX: 50,
      clientY: 20,
      dataTransfer: { dropEffect: null }
    })

    // Should NOT call setReorderPreview when dragging from different pane
    expect(mockSetReorderPreview).not.toHaveBeenCalled()
  })

  it('applies opacity and scale to dragged tab', async () => {
    // Mock dragPayload to indicate tab-1 is being dragged
    mockUsePaneDnd.mockReturnValue({
      startTabDrag: mockStartTabDrag,
      dragPayload: { type: 'tab', tabId: 'tab-1', sourcePaneId: 'pane-a' },
      reorderPreview: null,
      setReorderPreview: mockSetReorderPreview,
      clearReorderPreview: mockClearReorderPreview,
      handleTabReorder: mockHandleTabReorder
    })

    const tabs: WorkspaceTab[] = [
      { type: 'terminal', id: 'tab-1', terminalId: 'term-1' },
      { type: 'terminal', id: 'tab-2', terminalId: 'term-2' }
    ]

    const { container } = render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={tabs}
        activeTabId="tab-1"
      />
    )

    await flushShellEffect()

    const tabEls = container.querySelectorAll('[draggable="true"]')
    const draggedTab = tabEls[0] as HTMLElement // First tab (the one being dragged)

    // The dragged tab should have opacity-50 and scale classes
    expect(draggedTab.className).toContain('opacity-50')
    expect(draggedTab.className).toContain('scale-[0.98]')
  })
})