import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceTab } from '@/stores/workspace-store'
import { framerMotionTestState, resetFramerMotionTestState } from '@/test-utils/mock-framer-motion'
import type { DragPayload } from '@/types/workspace.types'
import { KIND_PLURAL_LABELS, type TabContextMenuKind } from './tab-context-menu'
import { WorkspaceTabBar } from './WorkspaceTabBar'

const mockSetActiveTab = vi.fn()
const mockSetActivePane = vi.fn()
const mockReorderTabsInPane = vi.fn()
const mockCloseTab = vi.fn()
const mockRemoveTab = vi.fn()
const mockTogglePaneFullscreen = vi.fn()
const mockCloseFileIfIdle = vi.fn(() => true)
const mockRemoveBrowserTab = vi.fn()
const mockRequestCloseAgentChat = vi.hoisted(() => vi.fn())

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
  closeTab: mockCloseTab,
  removeTab: mockRemoveTab
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

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      sessions: {},
      agentStatus: {},
      launchingSessionIds: {},
      pendingPermissions: {},
      pendingQuestions: {},
      pendingElicitations: {}
    })
  ),
  isEphemeralAcpSession: () => false,
  useAgentIdentity: () => ({ name: 'Claude' }),
  useAgentTemplateId: () => null,
  useAgentIcon: () => null,
  useSessionIndexTitle: () => 'Chat 1'
}))

// Mutable so tests can mark a session as already-closing.
const mockAgentChatLifetimeState = vi.hoisted(() => ({
  closingSessionIds: {} as Record<string, true>
}))

vi.mock('@/stores/agent-chat-lifetime-store', () => ({
  useAgentChatLifetimeStore: vi.fn(
    (selector: (state: typeof mockAgentChatLifetimeState) => unknown) =>
      selector(mockAgentChatLifetimeState)
  )
}))

vi.mock('@/stores/git-status-store', () => ({
  useGitStatusStore: vi.fn((selector: (state: unknown) => unknown) => selector({ statuses: {} }))
}))

const mockCloseCanvas = vi.hoisted(() => vi.fn())

vi.mock('@/stores/canvas-store', () => ({
  useCanvasStore: Object.assign(
    vi.fn((selector: (state: { sessions: Record<string, unknown> }) => unknown) =>
      selector({ sessions: {} })
    ),
    {
      getState: () => ({
        closeCanvas: mockCloseCanvas,
        sessions: {}
      })
    }
  )
}))

vi.mock('@/hooks/use-agent-idle-shutdown', () => ({
  requestCloseAgentChat: mockRequestCloseAgentChat
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
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
// (so `findByText('Close Other Editors')` is singular even with multiple
// editor tabs), closes on Escape, and wires `ContextMenuItem.onSelect` to a
// click so the existing tab-menu tests assert the close callbacks without
// the Radix portal/pointer plumbing.
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
  const ContextMenuContent = ({
    children,
    className
  }: {
    children: React.ReactNode
    className?: string
  }) => {
    const { open } = React.useContext(MenuCtx)
    if (!open) return null
    return (
      <div role="menu" className={className}>
        {children}
      </div>
    )
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
  mockRemoveTab.mockReset()
  mockTogglePaneFullscreen.mockReset()
  mockCloseFileIfIdle.mockReset()
  mockRemoveBrowserTab.mockReset()
  mockRequestCloseAgentChat.mockReset()
  // Default: an idle chat closes immediately via the provided callback.
  mockRequestCloseAgentChat.mockImplementation((_sessionId: string, closeTab: () => void) =>
    closeTab()
  )
  tauriRef.current = true
  mockWorkspaceStoreState.fullscreenPaneId = null
  mockCloseFileIfIdle.mockReturnValue(true)
  mockEditorOpenFiles.clear()
  resetFramerMotionTestState()
  mockStartTabDrag.mockReset()
  mockSetReorderPreview.mockReset()
  mockClearReorderPreview.mockReset()
  mockHandleTabReorder.mockReset()
  mockAgentChatLifetimeState.closingSessionIds = {}
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
    expect(mockRemoveTab).toHaveBeenCalledWith('edit-/a.ts')
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
    expect(mockRemoveTab).not.toHaveBeenCalled()
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
    fireEvent.click(await screen.findByText('Close Other Editors'))

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
    fireEvent.click(await screen.findByText('Close All Editors'))

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
    expect(mockRemoveTab).toHaveBeenCalledWith('browser-1')
  })

  it('closes a canvas tab by routing canvas disposal (closeCanvas) before the tab removal', async () => {
    const tabs: WorkspaceTab[] = [
      { type: 'canvas', id: 'canvas-proj-7', projectId: 'proj-7', docPath: 'C:/proj/design.op' }
    ]

    render(<WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="canvas-proj-7" />)

    await flushShellEffect()

    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))

    // Canvas disposal: the daemon evict (canvas-store closeCanvas with the
    // tab's projectId) fires BEFORE the workspace tab is removed.
    expect(mockCloseCanvas).toHaveBeenCalledWith('proj-7')
    expect(mockRemoveTab).toHaveBeenCalledWith('canvas-proj-7')
    const closeCanvasOrder = mockCloseCanvas.mock.invocationCallOrder[0]
    const removeTabOrder = mockRemoveTab.mock.invocationCallOrder[0]
    expect(closeCanvasOrder).toBeGreaterThan(0)
    expect(removeTabOrder).toBeGreaterThan(0)
    expect(closeCanvasOrder).toBeLessThan(removeTabOrder)
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

  describe('unified tab context menu', () => {
    const terminalTab: WorkspaceTab = { type: 'terminal', id: 'tab-1', terminalId: 'term-1' }
    const editorTab: WorkspaceTab = { type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' }
    const browserTab: WorkspaceTab = { type: 'browser', id: 'browser-1', browserTabId: 'btab-1' }
    const gitTab1: WorkspaceTab = { type: 'git', id: 'git-1', cwd: '/repo' }
    const gitTab2: WorkspaceTab = { type: 'git', id: 'git-2', cwd: '/repo' }
    const gitHistoryTab: WorkspaceTab = { type: 'git-history', id: 'gh-1', cwd: '/repo' }
    const agentChatTab: WorkspaceTab = { type: 'agent-chat', id: 'ac-1', sessionId: 'session-1' }

    const TAB_LABEL: Array<{ kind: TabContextMenuKind; tab: WorkspaceTab; label: string }> = [
      { kind: 'terminal', tab: terminalTab, label: 'Terminal 1' },
      { kind: 'editor', tab: editorTab, label: 'a.ts' },
      { kind: 'browser', tab: browserTab, label: 'Docs' },
      { kind: 'git', tab: gitTab1, label: 'Git Changes' },
      { kind: 'git-history', tab: gitHistoryTab, label: 'Git History' },
      // No ACP session is seeded, so the tab falls back to the static label.
      { kind: 'agent-chat', tab: agentChatTab, label: 'Agent Chat' }
    ]

    const openMenuOn = async (label: string, index = 0) => {
      // Multiple same-kind tabs share a label ('Git Changes'), so index picks
      // which one receives the contextmenu event.
      const tabEl = screen.getAllByText(label)[index].closest('.group') as HTMLElement
      expect(tabEl).toBeTruthy()
      fireEvent.contextMenu(tabEl)
      return await screen.findByRole('menu')
    }

    it.each(TAB_LABEL)('shows the same core menu for the $kind tab', async ({
      kind,
      tab,
      label
    }) => {
      render(<WorkspaceTabBar paneId="pane-a" tabs={[tab]} activeTabId={tab.id} />)
      await flushShellEffect()

      const plural = KIND_PLURAL_LABELS[kind]
      const menu = await openMenuOn(label)

      const text = menu.textContent ?? ''
      const order = [
        'Close',
        `Close Other ${plural}`,
        `Close All ${plural}`,
        'Close Other Tabs',
        'Close All Tabs'
      ]
      let cursor = -1
      for (const item of order) {
        const idx = text.indexOf(item, cursor + 1)
        if (idx <= cursor) {
          throw new Error(`menu is missing or mis-orders "${item}" (menu text: ${text})`)
        }
        cursor = idx
      }

      // Single-tab pane: both "Close Other" items exist but are disabled.
      const otherKind = screen.getByText(`Close Other ${plural}`)
      const otherTabs = screen.getByText('Close Other Tabs')
      expect(otherKind).toHaveAttribute('data-disabled')
      expect(otherTabs).toHaveAttribute('data-disabled')

      // Width contract: the longest label ("Close Other Git History Tabs")
      // must fit without wrapping.
      expect(menu.className).toContain('w-max')
    })

    it('shows Rename only on terminal tabs and Copy Path only on editor tabs', async () => {
      const { rerender } = render(
        <WorkspaceTabBar paneId="pane-a" tabs={[terminalTab]} activeTabId="tab-1" />
      )
      await flushShellEffect()

      let menu = await openMenuOn('Terminal 1')
      expect(screen.getByText('Rename')).toBeInTheDocument()
      expect(screen.queryByText('Copy Path')).not.toBeInTheDocument()

      fireEvent.keyDown(document, { key: 'Escape' })
      rerender(<WorkspaceTabBar paneId="pane-a" tabs={[editorTab]} activeTabId="edit-/a.ts" />)
      await flushShellEffect()

      menu = await openMenuOn('a.ts')
      expect(menu).toBeTruthy()
      expect(screen.getByText('Copy Path')).toBeInTheDocument()
      expect(screen.queryByText('Rename')).not.toBeInTheDocument()
    })

    it('delegates kind-scoped Close Other to onCloseTabs with only other same-kind tabs', async () => {
      const onCloseTabs = vi.fn()
      const tabs: WorkspaceTab[] = [terminalTab, gitTab1, gitTab2, editorTab]

      render(
        <WorkspaceTabBar
          paneId="pane-a"
          tabs={tabs}
          activeTabId="git-1"
          onCloseTabs={onCloseTabs}
        />
      )
      await flushShellEffect()

      await openMenuOn('Git Changes')
      fireEvent.click(screen.getByText('Close Other Git Tabs'))

      expect(onCloseTabs).toHaveBeenCalledTimes(1)
      expect(onCloseTabs).toHaveBeenCalledWith([gitTab2])
    })

    it('delegates kind-scoped Close All to onCloseTabs including the current tab', async () => {
      const onCloseTabs = vi.fn()
      const tabs: WorkspaceTab[] = [terminalTab, gitTab1, gitTab2, editorTab]

      render(
        <WorkspaceTabBar
          paneId="pane-a"
          tabs={tabs}
          activeTabId="git-1"
          onCloseTabs={onCloseTabs}
        />
      )
      await flushShellEffect()

      await openMenuOn('Git Changes')
      fireEvent.click(screen.getByText('Close All Git Tabs'))

      expect(onCloseTabs).toHaveBeenCalledTimes(1)
      expect(onCloseTabs).toHaveBeenCalledWith([gitTab1, gitTab2])
    })

    it('delegates pane-scoped Close Other Tabs to onCloseTabs across all kinds', async () => {
      const onCloseTabs = vi.fn()
      const tabs: WorkspaceTab[] = [terminalTab, gitTab1, gitTab2, editorTab]

      render(
        <WorkspaceTabBar
          paneId="pane-a"
          tabs={tabs}
          activeTabId="git-1"
          onCloseTabs={onCloseTabs}
        />
      )
      await flushShellEffect()

      await openMenuOn('Git Changes')
      fireEvent.click(screen.getByText('Close Other Tabs'))

      expect(onCloseTabs).toHaveBeenCalledTimes(1)
      expect(onCloseTabs).toHaveBeenCalledWith([terminalTab, gitTab2, editorTab])
    })

    it('delegates Close All Tabs to onCloseTabs with every closable tab in the pane', async () => {
      const onCloseTabs = vi.fn()
      const ghostTerminalTab: WorkspaceTab = {
        type: 'terminal',
        id: 'ghost-tab',
        terminalId: 'term-ghost'
      }
      const tabs: WorkspaceTab[] = [terminalTab, gitTab1, editorTab, ghostTerminalTab]

      render(
        <WorkspaceTabBar
          paneId="pane-a"
          tabs={tabs}
          activeTabId="git-1"
          onCloseTabs={onCloseTabs}
        />
      )
      await flushShellEffect()

      await openMenuOn('Git Changes')
      fireEvent.click(screen.getByText('Close All Tabs'))

      // The ghost terminal tab renders null (no store record) and must not be
      // included in the close target list.
      expect(onCloseTabs).toHaveBeenCalledTimes(1)
      expect(onCloseTabs).toHaveBeenCalledWith([terminalTab, gitTab1, editorTab])
    })

    it('disables kind-scoped Close Other but enables pane Close Other Tabs in a mixed pane', async () => {
      const onCloseTabs = vi.fn()
      const tabs: WorkspaceTab[] = [gitTab1, terminalTab]

      render(
        <WorkspaceTabBar
          paneId="pane-a"
          tabs={tabs}
          activeTabId="git-1"
          onCloseTabs={onCloseTabs}
        />
      )
      await flushShellEffect()

      await openMenuOn('Git Changes')

      expect(screen.getByText('Close Other Git Tabs')).toHaveAttribute('data-disabled')
      const closeOtherTabs = screen.getByText('Close Other Tabs')
      expect(closeOtherTabs).not.toHaveAttribute('data-disabled')

      fireEvent.click(closeOtherTabs)
      expect(onCloseTabs).toHaveBeenCalledWith([terminalTab])
    })

    it('falls back to per-tab close when onCloseTabs is not wired', async () => {
      const tabs: WorkspaceTab[] = [gitTab1, gitTab2]

      render(<WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="git-1" />)
      await flushShellEffect()

      await openMenuOn('Git Changes')
      fireEvent.click(screen.getByText('Close All Git Tabs'))

      expect(mockRemoveTab).toHaveBeenCalledWith('git-1')
      expect(mockRemoveTab).toHaveBeenCalledWith('git-2')
    })

    it('disables the editor Close item while the file is saving', async () => {
      mockEditorOpenFiles.set('/a.ts', { isDirty: true, operationStatus: 'saving' })

      render(<WorkspaceTabBar paneId="pane-a" tabs={[editorTab]} activeTabId="edit-/a.ts" />)
      await flushShellEffect()

      await openMenuOn('a.ts')
      expect(screen.getByText('Close')).toHaveAttribute('data-disabled')
    })

    it('excludes a busy editor from bulk targets and disabled counts', async () => {
      mockEditorOpenFiles.set('/busy.ts', { isDirty: true, operationStatus: 'saving' })
      const busyEditor: WorkspaceTab = {
        type: 'editor',
        id: 'edit-/busy.ts',
        filePath: '/busy.ts'
      }
      const onCloseTabs = vi.fn()

      render(
        <WorkspaceTabBar
          paneId="pane-a"
          tabs={[editorTab, busyEditor]}
          activeTabId="edit-/a.ts"
          onCloseTabs={onCloseTabs}
        />
      )
      await flushShellEffect()

      await openMenuOn('a.ts')

      // The saving editor is unclosable, so no OTHER editor tab qualifies.
      expect(screen.getByText('Close Other Editors')).toHaveAttribute('data-disabled')

      fireEvent.click(screen.getByText('Close All Editors'))
      expect(onCloseTabs).toHaveBeenCalledWith([editorTab])
    })

    it('fires the shared Close item through the kind-specific close path', async () => {
      const onCloseTerminal = vi.fn()
      const tabs: WorkspaceTab[] = [terminalTab, gitTab1]

      render(
        <WorkspaceTabBar
          paneId="pane-a"
          tabs={tabs}
          activeTabId="git-1"
          onCloseTerminal={onCloseTerminal}
        />
      )
      await flushShellEffect()

      await openMenuOn('Git Changes')
      fireEvent.click(screen.getByText('Close'))
      expect(mockRemoveTab).toHaveBeenCalledWith('git-1')
      expect(onCloseTerminal).not.toHaveBeenCalled()

      fireEvent.keyDown(document, { key: 'Escape' })
      await openMenuOn('Terminal 1')
      fireEvent.click(screen.getByText('Close'))
      expect(onCloseTerminal).toHaveBeenCalledWith('term-1', 'tab-1')
    })

    it('disables Close and excludes an agent-chat tab already closing from bulk targets', async () => {
      mockAgentChatLifetimeState.closingSessionIds = { 'session-1': true }
      const onCloseTabs = vi.fn()
      const tabs: WorkspaceTab[] = [agentChatTab, gitTab1]

      render(
        <WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="ac-1" onCloseTabs={onCloseTabs} />
      )
      await flushShellEffect()

      await openMenuOn('Agent Chat')
      expect(screen.getByText('Close')).toHaveAttribute('data-disabled')
      expect(screen.getByText('Close Other Agent Chats')).toHaveAttribute('data-disabled')

      // Close All Tabs still targets the remaining closable tab only.
      fireEvent.click(screen.getByText('Close All Tabs'))
      expect(onCloseTabs).toHaveBeenCalledWith([gitTab1])
    })
  })

  describe('middle-click close', () => {
    const editorTab: WorkspaceTab = { type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' }
    const gitTab: WorkspaceTab = { type: 'git', id: 'git-1', cwd: '/repo' }
    const gitHistoryTab: WorkspaceTab = { type: 'git-history', id: 'gh-1', cwd: '/repo' }
    const agentChatTab: WorkspaceTab = { type: 'agent-chat', id: 'ac-1', sessionId: 'session-1' }

    const middleClick = (el: HTMLElement) => {
      fireEvent(el, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    }

    it('closes an editor tab on middle click', async () => {
      const onCloseEditorTab = vi.fn()
      render(
        <WorkspaceTabBar
          paneId="pane-a"
          tabs={[editorTab]}
          activeTabId="edit-/a.ts"
          onCloseEditorTab={onCloseEditorTab}
        />
      )
      await flushShellEffect()

      middleClick(screen.getByText('a.ts').closest('.group') as HTMLElement)

      expect(onCloseEditorTab).toHaveBeenCalledWith('/a.ts')
    })

    it('still closes an editor tab while the saved flash is showing', async () => {
      mockEditorOpenFiles.set('/a.ts', { isDirty: false, operationStatus: 'saved' })
      render(<WorkspaceTabBar paneId="pane-a" tabs={[editorTab]} activeTabId="edit-/a.ts" />)
      await flushShellEffect()

      middleClick(screen.getByText('a.ts').closest('.group') as HTMLElement)

      expect(mockCloseFileIfIdle).toHaveBeenCalledWith('/a.ts')
      expect(mockRemoveTab).toHaveBeenCalledWith('edit-/a.ts')
    })

    it('closes an editor tab via the close button while the saved flash is showing', async () => {
      mockEditorOpenFiles.set('/a.ts', { isDirty: false, operationStatus: 'saved' })
      render(<WorkspaceTabBar paneId="pane-a" tabs={[editorTab]} activeTabId="edit-/a.ts" />)
      await flushShellEffect()

      // The Check icon conveys 'saved' visually; the accessible name still
      // describes the close action.
      const savedButton = screen.getByTitle('Close a.ts')
      expect(savedButton).not.toBeDisabled()
      fireEvent.click(savedButton)

      expect(mockCloseFileIfIdle).toHaveBeenCalledWith('/a.ts')
      expect(mockRemoveTab).toHaveBeenCalledWith('edit-/a.ts')
    })

    it('does not close an editor tab on middle click while saving', async () => {
      mockEditorOpenFiles.set('/a.ts', { isDirty: true, operationStatus: 'saving' })
      const onCloseEditorTab = vi.fn()
      render(
        <WorkspaceTabBar
          paneId="pane-a"
          tabs={[editorTab]}
          activeTabId="edit-/a.ts"
          onCloseEditorTab={onCloseEditorTab}
        />
      )
      await flushShellEffect()

      middleClick(screen.getByText('a.ts').closest('.group') as HTMLElement)

      expect(onCloseEditorTab).not.toHaveBeenCalled()
      expect(mockCloseFileIfIdle).not.toHaveBeenCalled()
      expect(mockCloseTab).not.toHaveBeenCalled()
    })

    it('closes a git tab on middle click', async () => {
      const { container } = render(
        <WorkspaceTabBar paneId="pane-a" tabs={[gitTab]} activeTabId="git-1" />
      )
      await flushShellEffect()

      middleClick(container.querySelector('[draggable="true"]') as HTMLElement)

      expect(mockRemoveTab).toHaveBeenCalledWith('git-1')
    })

    it('ignores auxclick buttons other than middle (button !== 1)', async () => {
      const { container } = render(
        <WorkspaceTabBar paneId="pane-a" tabs={[gitTab]} activeTabId="git-1" />
      )
      await flushShellEffect()

      const tabEl = container.querySelector('[draggable="true"]') as HTMLElement
      fireEvent(tabEl, new MouseEvent('auxclick', { bubbles: true, button: 0 }))
      fireEvent(tabEl, new MouseEvent('auxclick', { bubbles: true, button: 2 }))

      expect(mockRemoveTab).not.toHaveBeenCalled()
    })

    it('closes a git-history tab on middle click', async () => {
      const { container } = render(
        <WorkspaceTabBar paneId="pane-a" tabs={[gitHistoryTab]} activeTabId="gh-1" />
      )
      await flushShellEffect()

      middleClick(container.querySelector('[draggable="true"]') as HTMLElement)

      expect(mockRemoveTab).toHaveBeenCalledWith('gh-1')
    })

    it('closes an agent-chat tab on middle click through requestCloseAgentChat', async () => {
      const { container } = render(
        <WorkspaceTabBar paneId="pane-a" tabs={[agentChatTab]} activeTabId="ac-1" />
      )
      await flushShellEffect()

      middleClick(container.querySelector('[draggable="true"]') as HTMLElement)

      expect(mockRequestCloseAgentChat).toHaveBeenCalledWith('session-1', expect.any(Function))
      expect(mockRemoveTab).toHaveBeenCalledWith('ac-1')
    })

    it('does not middle-click close a terminal tab while the rename input is editing', async () => {
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

      fireEvent.doubleClick(screen.getByText('Terminal 1'))
      const input = container.querySelector('input') as HTMLElement
      expect(input).toBeTruthy()

      const tabEl = container.querySelector('.group') as HTMLElement
      middleClick(tabEl)
      middleClick(input)

      expect(onCloseTerminal).not.toHaveBeenCalled()
    })
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
      // `layout !== undefined` keeps this scoped to tab wrappers — a
      // nested motion.div inside tab content can't masquerade as one.
      const all = framerMotionTestState.motionDivPropsLog.filter(
        (props) =>
          (props.className as string | undefined)?.includes('list-none') &&
          props.layout !== undefined
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

  // Spec I/O matrix — "Center drop" / "Tab add / close" rows: each keyed
  // tab wrapper carries mount/unmount motion so an added tab (center drop,
  // opened file, new terminal) grows width 0→auto with a fade and a removed
  // one shrinks out, instead of popping into/out of the bar.
  describe('tab mount grow-in / shrink-out', () => {
    const mountTabs: WorkspaceTab[] = [
      { type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' },
      { type: 'terminal', id: 'tab-1', terminalId: 'term-1' }
    ]

    function tabWrappers(): Array<Record<string, unknown>> {
      const all = framerMotionTestState.motionDivPropsLog.filter(
        (props) =>
          (props.className as string | undefined)?.includes('list-none') &&
          props.layout !== undefined
      )
      return all.slice(-mountTabs.length)
    }

    it('wraps the tab list in AnimatePresence with initial={false}', async () => {
      render(<WorkspaceTabBar paneId="pane-a" tabs={mountTabs} activeTabId="edit-/a.ts" />)

      await flushShellEffect()

      // The only AnimatePresence in this component is the tab-list gate —
      // initial={false} keeps pane remounts (project restore, fullscreen
      // toggle) from mass-animating the restored tabs.
      const presenceProps = framerMotionTestState.animatePresencePropsLog
      expect(presenceProps.length).toBeGreaterThan(0)
      for (const props of presenceProps) {
        expect(props.initial).toBe(false)
      }
    })

    it('each tab wrapper grows 0→auto + fades on enter and shrinks on exit', async () => {
      render(<WorkspaceTabBar paneId="pane-a" tabs={mountTabs} activeTabId="edit-/a.ts" />)

      await flushShellEffect()

      const wrappers = tabWrappers()
      expect(wrappers).toHaveLength(mountTabs.length)
      for (const props of wrappers) {
        expect(props.initial).toEqual({ width: 0, opacity: 0 })

        const animate = props.animate as {
          width: string
          opacity: number
          transition: { duration: number; ease: number[] }
        }
        expect(animate.width).toBe('auto')
        expect(animate.opacity).toBe(1)
        expect(animate.transition.duration).toBeLessThanOrEqual(0.2)
        expect(animate.transition.ease).toEqual([0.23, 1, 0.32, 1])

        const exit = props.exit as {
          width: number
          opacity: number
          transition: { duration: number; ease: number[] }
        }
        expect(exit.width).toBe(0)
        expect(exit.opacity).toBe(0)
        expect(exit.transition.duration).toBeLessThanOrEqual(0.15)
        expect(exit.transition.ease).toEqual([0.23, 1, 0.32, 1])

        // The wrapper must clip content during the width tween rather than
        // flex-clamp at min-content.
        const className = props.className as string
        expect(className).toContain('min-w-0')
        expect(className).toContain('overflow-hidden')
        expect(className).toContain('shrink-0')

        // Pointer-events are only suppressed mid-exit (useIsPresent) so a
        // click can't hit a stale tab id — a mounted tab stays interactive.
        expect(className).not.toContain('pointer-events-none')
      }
    })

    it('mounts instantly and exits with a zero-duration fade under prefers-reduced-motion', async () => {
      framerMotionTestState.reducedMotion.current = true

      render(<WorkspaceTabBar paneId="pane-a" tabs={mountTabs} activeTabId="edit-/a.ts" />)

      await flushShellEffect()

      const wrappers = tabWrappers()
      expect(wrappers).toHaveLength(mountTabs.length)
      for (const props of wrappers) {
        expect(props.initial).toBe(false)

        const exit = props.exit as { opacity: number; transition: { duration: number } }
        // Fade-only: no width tween under reduced motion.
        expect((exit as { width?: number }).width).toBeUndefined()
        expect(exit.opacity).toBe(0)
        expect(exit.transition.duration).toBe(0)
      }
    })
  })
})
