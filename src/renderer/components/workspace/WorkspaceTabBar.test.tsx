import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceTab } from '@/stores/workspace-store'
import type { DragPayload } from '@/types/workspace.types'
import { WorkspaceTabBar } from './WorkspaceTabBar'

const mockSetActiveTab = vi.fn()
const mockSetActivePane = vi.fn()
const mockReorderTabsInPane = vi.fn()
const mockCloseTab = vi.fn()
const mockTogglePaneFullscreen = vi.fn()
const mockCloseFileIfIdle = vi.fn(() => true)
const mockRemoveBrowserTab = vi.fn()
const mockClearAnnotationsForTab = vi.fn()

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
    vi.fn((selector: (state: typeof mockWorkspaceStoreState) => unknown) =>
      selector(mockWorkspaceStoreState)
    ),
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
    vi.fn((selector: (state: typeof mockEditorStoreState) => unknown) =>
      selector(mockEditorStoreState)
    ),
    {
      getState: () => mockEditorStoreState
    }
  )
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: vi.fn(
    (
      selector: (state: {
        terminals: Array<{ id: string; name: string; shell: string }>
      }) => unknown
    ) =>
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

vi.mock('@/stores/browser-session-store', () => ({
  useBrowserSessionStore: Object.assign(
    vi.fn(
      (
        selector: (state: {
          getTab: (id: string) => { title: string; url: string } | null
        }) => unknown
      ) =>
        selector({
          getTab: () => ({ title: 'Docs', url: 'https://example.com' })
        })
    ),
    {
      getState: () => ({
        removeTab: mockRemoveBrowserTab
      })
    }
  )
}))

vi.mock('@/stores/annotation-store', () => ({
  useAnnotationStore: {
    getState: () => ({
      clearAnnotationsForTab: mockClearAnnotationsForTab
    })
  }
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

// Stub the Radix context-menu primitives. Every tab is wrapped in
// `<TabContextMenu>`; the real primitives render via a portal + pointer-based
// `onSelect` that is hard to drive from jsdom. This stateful stub opens the
// menu on `contextmenu`, renders `<ContextMenuContent>` only while open
// (so `findByText('Close Others')` is singular even with multiple editor
// tabs), closes on Escape, and wires `ContextMenuItem.onSelect` to a click so
// the existing tab-menu tests assert the close callbacks without the Radix
// portal/pointer plumbing.
vi.mock('@/components/ui/context-menu', async () => {
  const React = await import('react')
  const MenuCtx = React.createContext<{ open: boolean; setOpen: (o: boolean) => void }>({
    open: false,
    setOpen: () => {}
  })
  const ContextMenu = ({ children }: { children: React.ReactNode }) => {
    const [open, setOpen] = React.useState(false)
    React.useEffect(() => {
      if (!open) return
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setOpen(false)
      }
      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
    }, [open])
    return <MenuCtx.Provider value={{ open, setOpen }}>{children}</MenuCtx.Provider>
  }
  const ContextMenuTrigger = ({
    children,
    asChild
  }: {
    children: React.ReactNode
    asChild?: boolean
  }) => {
    const { setOpen } = React.useContext(MenuCtx)
    const merged = (e: React.MouseEvent) => {
      // F2: mirror Radix's composeEventHandlers({ checkForDefaultPrevented: true }) —
      // if the child's onContextMenu already called preventDefault, do NOT open.
      if (e.defaultPrevented) return
      e.preventDefault()
      setOpen(true)
    }
    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<{
        onContextMenu?: (e: React.MouseEvent) => void
      }>
      return React.cloneElement(child, {
        onContextMenu: (e: React.MouseEvent) => {
          child.props.onContextMenu?.(e)
          merged(e)
        }
      })
    }
    return <div onContextMenu={merged}>{children}</div>
  }
  const ContextMenuContent = ({ children }: { children: React.ReactNode }) => {
    const { open } = React.useContext(MenuCtx)
    if (!open) return null
    return <div role="menu">{children}</div>
  }
  const ContextMenuItem = ({
    children,
    disabled,
    onSelect,
    variant
  }: {
    children: React.ReactNode
    disabled?: boolean
    onSelect?: () => void
    variant?: 'default' | 'destructive'
  }) => (
    <div
      role="menuitem"
      data-disabled={disabled ? '' : undefined}
      data-variant={variant}
      onClick={() => {
        if (!disabled) onSelect?.()
      }}
    >
      {children}
    </div>
  )
  const ContextMenuSeparator = () => <hr />
  return {
    ContextMenu,
    ContextMenuTrigger,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator
  }
})

beforeEach(() => {
  mockSetActiveTab.mockReset()
  mockSetActivePane.mockReset()
  mockReorderTabsInPane.mockReset()
  mockCloseTab.mockReset()
  mockTogglePaneFullscreen.mockReset()
  mockCloseFileIfIdle.mockReset()
  mockRemoveBrowserTab.mockReset()
  mockClearAnnotationsForTab.mockReset()
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
    render(<WorkspaceTabBar paneId="pane-a" tabs={[]} activeTabId={null} onAddTerminal={vi.fn()} />)

    await flushShellEffect()

    expect(screen.getByTitle('Open terminal menu')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.queryByTitle('Close pane')).not.toBeInTheDocument()
    })
  })

  it('calls pane-scoped onAddTerminal when a shell is selected from the terminal menu', async () => {
    const onAddTerminal = vi.fn()

    render(
      <WorkspaceTabBar paneId="pane-a" tabs={[]} activeTabId={null} onAddTerminal={onAddTerminal} />
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
    render(<WorkspaceTabBar paneId="pane-a" tabs={[]} activeTabId={null} />)

    await flushShellEffect()

    expect(screen.getByTitle('Focus pane')).toBeInTheDocument()
    expect(screen.queryByTitle('Restore pane layout')).not.toBeInTheDocument()
  })

  it('renders restore button when pane is fullscreen', async () => {
    mockWorkspaceStoreState.fullscreenPaneId = 'pane-a'

    render(<WorkspaceTabBar paneId="pane-a" tabs={[]} activeTabId={null} />)

    await flushShellEffect()

    expect(screen.getByTitle('Restore pane layout')).toBeInTheDocument()
    expect(screen.queryByTitle('Focus pane')).not.toBeInTheDocument()
  })

  it('renders editor tab with non-jitter active style class', async () => {
    const tabs: WorkspaceTab[] = [{ type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' }]

    const { container } = render(
      <WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="edit-/a.ts" />
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

    render(<WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="edit-/a.ts" />)

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

    render(<WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="edit-/a.ts" />)

    await flushShellEffect()

    fireEvent.click(screen.getByTitle('Close tab'))

    expect(mockCloseFileIfIdle).toHaveBeenCalledWith('/a.ts')
    expect(mockCloseTab).not.toHaveBeenCalled()
  })

  it('renders the unsaved-changes indicator only on dirty editor tabs (GH-539)', async () => {
    mockEditorOpenFiles.set('/a.ts', { isDirty: true, operationStatus: 'idle' })
    mockEditorOpenFiles.set('/b.ts', { isDirty: false, operationStatus: 'idle' })
    const tabs: WorkspaceTab[] = [
      { type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' },
      { type: 'editor', id: 'edit-/b.ts', filePath: '/b.ts' }
    ]

    const { container } = render(
      <WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="edit-/a.ts" />
    )

    await flushShellEffect()

    const dirtyDots = container.querySelectorAll('.w-2.h-2.rounded-full.bg-primary')
    expect(dirtyDots.length).toBe(1)
  })

  it('routes Close Others through the dirty-aware close callback (GH-539)', async () => {
    mockEditorOpenFiles.set('/a.ts', { isDirty: false, operationStatus: 'idle' })
    mockEditorOpenFiles.set('/b.ts', { isDirty: true, operationStatus: 'idle' })
    mockEditorOpenFiles.set('/c.ts', { isDirty: true, operationStatus: 'idle' })
    const onCloseEditorTab = vi.fn()
    const tabs: WorkspaceTab[] = [
      { type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' },
      { type: 'editor', id: 'edit-/b.ts', filePath: '/b.ts' },
      { type: 'editor', id: 'edit-/c.ts', filePath: '/c.ts' }
    ]

    render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={tabs}
        activeTabId="edit-/a.ts"
        onCloseEditorTab={onCloseEditorTab}
      />
    )

    await flushShellEffect()

    const activeTabEl = screen.getByText('a.ts').closest('.group') as HTMLElement
    fireEvent.contextMenu(activeTabEl)
    fireEvent.click(await screen.findByText('Close Others'))

    expect(onCloseEditorTab).toHaveBeenCalledWith('/b.ts')
    expect(onCloseEditorTab).toHaveBeenCalledWith('/c.ts')
    expect(onCloseEditorTab).not.toHaveBeenCalledWith('/a.ts')
    // Dirty tabs must go through the upstream dialog path, never the
    // silent fallback close.
    expect(mockCloseFileIfIdle).not.toHaveBeenCalled()
    expect(mockCloseTab).not.toHaveBeenCalled()
  })

  it('routes Close All through the dirty-aware close callback (GH-539)', async () => {
    mockEditorOpenFiles.set('/a.ts', { isDirty: true, operationStatus: 'idle' })
    mockEditorOpenFiles.set('/b.ts', { isDirty: true, operationStatus: 'idle' })
    const onCloseEditorTab = vi.fn()
    const tabs: WorkspaceTab[] = [
      { type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' },
      { type: 'editor', id: 'edit-/b.ts', filePath: '/b.ts' }
    ]

    render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={tabs}
        activeTabId="edit-/a.ts"
        onCloseEditorTab={onCloseEditorTab}
      />
    )

    await flushShellEffect()

    const activeTabEl = screen.getByText('a.ts').closest('.group') as HTMLElement
    fireEvent.contextMenu(activeTabEl)
    fireEvent.click(await screen.findByText('Close All'))

    expect(onCloseEditorTab).toHaveBeenCalledWith('/a.ts')
    expect(onCloseEditorTab).toHaveBeenCalledWith('/b.ts')
    expect(mockCloseFileIfIdle).not.toHaveBeenCalled()
    expect(mockCloseTab).not.toHaveBeenCalled()
  })

  it('closes terminal tab on middle click without affecting regular click behavior', async () => {
    const onCloseTerminal = vi.fn()
    const tabs: WorkspaceTab[] = [{ type: 'terminal', id: 'tab-1', terminalId: 'term-1' }]

    const { container } = render(
      <WorkspaceTabBar
        paneId="pane-a"
        tabs={tabs}
        activeTabId="tab-1"
        onCloseTerminal={onCloseTerminal}
      />
    )

    await flushShellEffect()

    const tabEl = container.querySelector('[draggable="true"]') as HTMLElement
    expect(tabEl).toBeTruthy()

    fireEvent.click(tabEl)
    expect(mockSetActiveTab).toHaveBeenCalledWith('pane-a', 'tab-1')
    expect(onCloseTerminal).not.toHaveBeenCalled()

    fireEvent(tabEl, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(onCloseTerminal).toHaveBeenCalledWith('term-1', 'tab-1')
  })

  it('closes browser tab on middle click', async () => {
    const tabs: WorkspaceTab[] = [{ type: 'browser', id: 'browser-1', browserTabId: 'btab-1' }]

    const { container } = render(
      <WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="browser-1" />
    )

    await flushShellEffect()

    const tabEl = container.querySelector('[draggable="true"]') as HTMLElement
    expect(tabEl).toBeTruthy()

    fireEvent(tabEl, new MouseEvent('auxclick', { bubbles: true, button: 1 }))

    expect(mockRemoveBrowserTab).toHaveBeenCalledWith('btab-1')
    expect(mockClearAnnotationsForTab).toHaveBeenCalledWith('btab-1')
    expect(mockCloseTab).toHaveBeenCalledWith('pane-a', 'browser-1')
  })

  it('calls startTabDrag when dragging a terminal tab', async () => {
    const tabs: WorkspaceTab[] = [{ type: 'terminal', id: 'tab-1', terminalId: 'term-1' }]

    const { container } = render(
      <WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="tab-1" />
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
      <WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="tab-1" />
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
      <WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="tab-1" />
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
      <WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="tab-1" />
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
      <WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="tab-1" />
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
      <WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="tab-1" />
    )

    await flushShellEffect()

    const tabEls = container.querySelectorAll('[draggable="true"]')
    const draggedTab = tabEls[0] as HTMLElement // First tab (the one being dragged)

    // The dragged tab should have opacity-50 and scale classes
    expect(draggedTab.className).toContain('opacity-50')
    expect(draggedTab.className).toContain('scale-[0.98]')
  })
})
