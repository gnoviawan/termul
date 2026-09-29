import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceTab } from '@/stores/workspace-store'
import { framerMotionTestState, resetFramerMotionTestState } from '@/test-utils/mock-framer-motion'
import type { DragPayload } from '@/types/workspace.types'
import { WorkspaceTabBar } from './WorkspaceTabBar'

const mockSetActiveTab = vi.fn()
const mockSetActivePane = vi.fn()
const mockReorderTabsInPane = vi.fn()
const mockCloseTab = vi.fn()
const mockTogglePaneFullscreen = vi.fn()
const mockCloseFileIfIdle = vi.fn(() => true)
const mockRemoveBrowserTab = vi.fn()

// Story 8 (web honesty): the tab-bar globe button (New Browser Tab) is
// desktop-only. Mutable ref defaults to desktop so the existing browser-tab
// test keeps running in desktop mode; the web-mode test flips it.
const { tauriRef } = vi.hoisted(() => ({ tauriRef: { current: true as boolean } }))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => tauriRef.current
}))

// Spec I/O matrix — "Tab reorder" row: the shared framer-motion mock records
// every motion.div's props so the per-tab FLIP wrapper (layout="position")
// and its reduced-motion opt-out are assertable without pixel measurements.
vi.mock('framer-motion', async (importOriginal) => {
  const { installFramerMotionMock } = await import('@/test-utils/mock-framer-motion')
  return installFramerMotionMock(importOriginal)
})

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
  useProjectsWithErrors: () => new Set<string>()
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
  tauriRef.current = true
  mockWorkspaceStoreState.fullscreenPaneId = null
  mockCloseFileIfIdle.mockReturnValue(true)
  mockEditorOpenFiles.clear()
  resetFramerMotionTestState()
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

  // Story 8 (web honesty): the New Browser Tab globe button is desktop-only —
  // on the web client it must be absent (browser tabs are native child
  // webviews), while the terminal menu stays available.
  it('hides the New Browser Tab globe button on web', async () => {
    const onAddBrowserTab = vi.fn()
    const prev = tauriRef.current
    tauriRef.current = false
    try {
      render(
        <WorkspaceTabBar
          paneId="pane-a"
          tabs={[]}
          activeTabId={null}
          onAddTerminal={vi.fn()}
          onAddBrowserTab={onAddBrowserTab}
        />
      )

      await flushShellEffect()

      expect(screen.queryByTitle('New Browser Tab')).not.toBeInTheDocument()
      expect(screen.getByTitle('Open terminal menu')).toBeInTheDocument()
      expect(onAddBrowserTab).not.toHaveBeenCalled()
    } finally {
      tauriRef.current = prev
    }
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

    const tabEl = screen.getByText('a.ts').closest('.group') as HTMLElement
    expect(tabEl).toBeTruthy()
    expect(tabEl.className).toContain('bg-background')
    expect(tabEl.className).not.toContain('border-b-primary')
    expect(tabEl.className).not.toContain('border-b-2')
    expect(container.querySelector('.h-9')?.className).not.toContain('border-b')
  })

  it('reserves close-button space only on the active tab', async () => {
    const tabs: WorkspaceTab[] = [
      { type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' },
      { type: 'editor', id: 'edit-/b.ts', filePath: '/b.ts' }
    ]

    render(<WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="edit-/a.ts" />)

    await flushShellEffect()

    const activeClose = screen.getByText('a.ts').closest('.group')?.querySelector('button')
    const idleTab = screen.getByText('b.ts').closest('.group')
    const idleReveal = idleTab?.querySelector('.grid')
    const idleSlide = idleReveal?.querySelector('.translate-x-2')

    expect(activeClose?.className).toContain('inline-flex')
    expect(activeClose?.parentElement?.className).toContain('ml-3')
    expect(activeClose?.closest('.grid')).toBeNull()
    expect(screen.getByText('a.ts').className).toContain('ml-2')

    expect(idleReveal?.className).toContain('grid-cols-[0fr]')
    expect(idleReveal?.className).toContain('pointer-fine:group-hover:grid-cols-[1fr]')
    expect(idleReveal?.className).toContain('motion-reduce:transition-none')
    expect(idleSlide?.className).toContain('pointer-fine:group-hover:translate-x-0')
    expect(idleSlide?.className).toContain('opacity-0')
    expect(idleTab?.querySelector('button')).toHaveAttribute('tabindex', '-1')
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

    const dirtyDots = container.querySelectorAll('.w-2.h-2.rounded-full.bg-primary-fill')
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

  // Spec I/O matrix — "Tab reorder" row: each keyed tab item renders inside
  // a motion.div carrying layout="position" so reorder commits FLIP-slide;
  // reduced motion turns the layout tween off entirely.
  describe('tab reorder FLIP wrappers', () => {
    const reorderTabs: WorkspaceTab[] = [
      { type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' },
      { type: 'editor', id: 'edit-/b.ts', filePath: '/b.ts' },
      { type: 'terminal', id: 'tab-1', terminalId: 'term-1' }
    ]

    function tabWrappers(): Array<Record<string, unknown>> {
      // The props log accumulates one entry per wrapper per render (the
      // shells effect re-renders the bar) — take the latest batch of N,
      // which reflects the committed props of the last render pass.
      const all = framerMotionTestState.motionDivPropsLog.filter(
        (props) => (props.className as string | undefined) === 'list-none h-full'
      )
      return all.slice(-reorderTabs.length)
    }

    it('wraps each tab item in a motion.div with layout="position" and an ease-out slide', async () => {
      render(<WorkspaceTabBar paneId="pane-a" tabs={reorderTabs} activeTabId="edit-/a.ts" />)

      await flushShellEffect()

      // One FLIP wrapper per tab; its DOM element encloses the tab content.
      const wrappers = tabWrappers()
      expect(wrappers).toHaveLength(reorderTabs.length)
      for (const props of wrappers) {
        expect(props.layout).toBe('position')
        const layoutTransition = (
          props.transition as { layout?: { duration: number; ease: number[] } }
        ).layout
        expect(layoutTransition?.duration).toBeLessThanOrEqual(0.25)
        expect(layoutTransition?.ease).toEqual([0.23, 1, 0.32, 1])
      }

      // Every tab's content lives inside its .list-none wrapper element.
      for (const name of ['a.ts', 'b.ts']) {
        expect(screen.getByText(name).closest('.list-none')).toBeTruthy()
      }
    })

    it('passes layout={false} to every tab wrapper under prefers-reduced-motion', async () => {
      framerMotionTestState.reducedMotion.current = true

      render(<WorkspaceTabBar paneId="pane-a" tabs={reorderTabs} activeTabId="edit-/a.ts" />)

      await flushShellEffect()

      const wrappers = tabWrappers()
      expect(wrappers).toHaveLength(reorderTabs.length)
      for (const props of wrappers) {
        expect(props.layout).toBe(false)
      }
    })
  })
})
