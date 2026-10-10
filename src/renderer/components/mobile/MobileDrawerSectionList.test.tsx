import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileDrawerSectionList } from './MobileDrawerSectionList'

const {
  workspaceRef,
  terminalsRef,
  editorRef,
  browserTabsRef,
  mockNavigate,
  mockRemoveBrowserTab,
  mockRequestCloseAgentChat
} = vi.hoisted(() => ({
  // Mutable workspace state so each test can seed the tab types it needs.
  workspaceRef: {
    current: {
      leaves: [] as Array<{
        type: 'leaf'
        id: string
        tabs: Array<Record<string, unknown>>
        activeTabId: string | null
      }>,
      activePaneId: 'pane-1',
      fullscreenPaneId: null as string | null,
      removeTab: vi.fn(),
      setActiveTab: vi.fn(),
      clearFullscreenPane: vi.fn()
    }
  },
  terminalsRef: { current: [] as Array<{ id: string; name: string }> },
  editorRef: { current: { openFiles: new Map<string, { isDirty: boolean }>() } },
  browserTabsRef: { current: new Map<string, unknown>() },
  mockNavigate: vi.fn(),
  mockRemoveBrowserTab: vi.fn(),
  mockRequestCloseAgentChat: vi.fn()
}))

const { canvasRef, mockCloseCanvas, mockLogFrontendError } = vi.hoisted(() => ({
  // Canvas runtime sessions by project id (only `dirty` is read by the list).
  canvasRef: { current: {} as Record<string, { dirty: boolean }> },
  mockCloseCanvas: vi.fn(),
  mockLogFrontendError: vi.fn()
}))

vi.mock('@/stores/canvas-store', () => ({
  useCanvasStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) => sel({ sessions: canvasRef.current })),
    { getState: () => ({ sessions: canvasRef.current, closeCanvas: mockCloseCanvas }) }
  )
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLogFrontendError }))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock('@/stores/workspace-store', () => ({
  getAllLeafPanes: () => workspaceRef.current.leaves,
  useWorkspaceStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) =>
      sel({
        root: { leaves: workspaceRef.current.leaves },
        activePaneId: workspaceRef.current.activePaneId,
        removeTab: workspaceRef.current.removeTab,
        setActiveTab: workspaceRef.current.setActiveTab
      })
    ),
    { getState: () => workspaceRef.current }
  )
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: Object.assign(
    vi.fn((sel: (s: { terminals: unknown[] }) => unknown) =>
      sel({ terminals: terminalsRef.current })
    ),
    { getState: () => ({ terminals: terminalsRef.current }) }
  )
}))

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: Object.assign(
    vi.fn((sel: (s: { openFiles: Map<string, { isDirty: boolean }> }) => unknown) =>
      sel({ openFiles: editorRef.current.openFiles })
    ),
    { getState: () => ({ openFiles: editorRef.current.openFiles }) }
  )
}))

vi.mock('@/stores/browser-session-store', () => ({
  useBrowserSessionStore: Object.assign(
    vi.fn((sel: (s: { tabs: Map<string, unknown>; removeTab: unknown }) => unknown) =>
      sel({ tabs: browserTabsRef.current, removeTab: mockRemoveBrowserTab })
    ),
    { getState: () => ({ tabs: browserTabsRef.current, removeTab: mockRemoveBrowserTab }) }
  )
}))

vi.mock('@/hooks/use-agent-idle-shutdown', () => ({
  requestCloseAgentChat: mockRequestCloseAgentChat
}))

const onNavigate = vi.fn()

type ListProps = ComponentProps<typeof MobileDrawerSectionList>

const HEADINGS = { terminals: 'Terminals', editors: 'Editors' } as const

function ui(
  props: Partial<ListProps> = {},
  path = '/',
  headingFocusable = true
): React.JSX.Element {
  const section = props.section ?? 'terminals'
  return (
    <MemoryRouter initialEntries={[path]}>
      <div>
        <h2 id="list-heading" tabIndex={headingFocusable ? -1 : undefined}>
          {HEADINGS[section]}
        </h2>
        <button type="button">elsewhere</button>
        <MobileDrawerSectionList
          section={section}
          headingId="list-heading"
          activeTabId={null}
          onNavigate={onNavigate}
          {...props}
        />
      </div>
    </MemoryRouter>
  )
}

function renderList(props: Partial<ListProps> = {}, path = '/', headingFocusable = true) {
  const view = render(ui(props, path, headingFocusable))
  return { ...view, update: () => view.rerender(ui(props, path, headingFocusable)) }
}

function seedTabs(tabs: Array<Record<string, unknown>>, activeTabId: string | null = null): void {
  workspaceRef.current = {
    ...workspaceRef.current,
    leaves: [{ type: 'leaf', id: 'pane-1', tabs, activeTabId }],
    activePaneId: 'pane-1'
  }
}

const CHAT_TAB = { type: 'agent-chat', id: 'tab-1', sessionId: 's1' }

function seedAllTabTypes(): void {
  seedTabs(
    [
      { type: 'terminal', id: 'term-t1', terminalId: 't1' },
      { type: 'editor', id: 'edit-/proj/a.ts', filePath: '/proj/a.ts' },
      { type: 'git', id: 'git-/proj', cwd: '/proj' },
      { type: 'git-history', id: 'git-history-/proj', cwd: '/proj' },
      { type: 'browser', id: 'browser-b1', browserTabId: 'b1' },
      { type: 'canvas', id: 'canvas-p1', projectId: 'p1', docPath: '/proj/docs/Plan.op' },
      CHAT_TAB
    ],
    'tab-1'
  )
  browserTabsRef.current = new Map([
    ['b1', { id: 'b1', url: 'https://example.com/page', title: 'Example Site' }]
  ])
}

beforeEach(() => {
  onNavigate.mockReset()
  mockNavigate.mockReset()
  mockRemoveBrowserTab.mockReset()
  mockRequestCloseAgentChat.mockReset()
  mockCloseCanvas.mockReset().mockResolvedValue(undefined)
  mockLogFrontendError.mockReset()
  canvasRef.current = {}
  workspaceRef.current.removeTab.mockReset()
  workspaceRef.current.setActiveTab.mockReset()
  workspaceRef.current.clearFullscreenPane.mockReset()
  workspaceRef.current.fullscreenPaneId = null
  terminalsRef.current = []
  editorRef.current.openFiles = new Map()
  browserTabsRef.current = new Map()
  seedTabs([])
})

describe('MobileDrawerSectionList terminals', () => {
  beforeEach(() => {
    seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }, CHAT_TAB], 'term-t1')
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
  })

  it('lists only terminals, in a group labelled by the drawer heading', () => {
    renderList()

    const group = screen.getByRole('group', { name: 'Terminals' })
    expect(within(group).getByRole('button', { name: 'zsh' })).toBeInTheDocument()
    expect(within(group).getAllByRole('button', { name: /^(zsh|Rename|Close)/ })).toHaveLength(2)
  })

  it('says No open terminals when there are none', () => {
    seedTabs([CHAT_TAB])
    renderList()

    expect(screen.getByText('No open terminals')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Terminals' })).not.toBeInTheDocument()
  })

  it('marks the active row as a full-width pill and holds the 44px floor', () => {
    renderList({ onRenameTerminal: vi.fn(), onCloseTerminal: vi.fn(), activeTabId: 'term-t1' })

    const group = screen.getByRole('group', { name: 'Terminals' })
    const select = within(group).getByRole('button', { name: 'zsh' })
    expect(select).toHaveClass('min-h-11', 'min-w-0', 'rounded-full', 'bg-secondary', 'text-base')
    expect(select).toHaveAttribute('aria-current', 'page')
    expect(within(group).getByRole('button', { name: 'Rename zsh' })).toHaveClass('size-11')
    expect(within(group).getByRole('button', { name: 'Close zsh' })).toHaveClass('size-11')
  })

  it('truncates a long name so the row actions stay in place', () => {
    terminalsRef.current = [{ id: 't1', name: 'x'.repeat(80) }]
    renderList({ onCloseTerminal: vi.fn() })

    const label = screen.getByText('x'.repeat(80))
    expect(label).toHaveClass('truncate', 'min-w-0')
  })

  it('omits the rename action when renaming is not threaded', () => {
    renderList()

    expect(screen.queryByRole('button', { name: 'Rename zsh' })).not.toBeInTheDocument()
  })

  it('renames inline through a labelled text-base, 44px field', () => {
    const onRenameTerminal = vi.fn()
    renderList({ onRenameTerminal })

    fireEvent.click(screen.getByRole('button', { name: 'Rename zsh' }))
    const input = screen.getByRole('textbox', { name: 'Rename zsh' })
    expect(input).toHaveValue('zsh')
    expect(input).toHaveClass('min-h-11', 'text-base')
    expect(input).toHaveFocus()

    fireEvent.change(input, { target: { value: '  dev server  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRenameTerminal).toHaveBeenCalledWith('t1', 'dev server')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('falls back to a plain terminal label when the record is missing', () => {
    terminalsRef.current = []
    renderList({ onRenameTerminal: vi.fn() })

    expect(screen.getByRole('button', { name: 'Terminal' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close terminal' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rename terminal' })).toBeInTheDocument()
  })

  it('selecting a row activates its tab and navigates', () => {
    renderList()

    fireEvent.click(screen.getByRole('button', { name: 'zsh' }))

    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'term-t1')
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('routes a close through the existing terminal close flow', () => {
    const onCloseTerminal = vi.fn()
    renderList({ onCloseTerminal })

    fireEvent.click(screen.getByRole('button', { name: 'Close zsh' }))

    expect(onCloseTerminal).toHaveBeenCalledWith('t1', 'term-t1')
    expect(workspaceRef.current.removeTab).not.toHaveBeenCalled()
    expect(onNavigate).not.toHaveBeenCalled()
  })
})

describe('MobileDrawerSectionList editors', () => {
  it('lists editors, Git Changes, browser and canvas tabs, never Git History, chats or terminals', () => {
    seedAllTabTypes()
    renderList({ section: 'editors' })

    const group = screen.getByRole('group', { name: 'Editors' })
    for (const label of ['a.ts', 'Git Changes', 'Example Site', 'Plan.op']) {
      expect(within(group).getByRole('button', { name: label })).toHaveClass('min-h-11')
      expect(within(group).getByRole('button', { name: `Close ${label}` })).toHaveClass('size-11')
    }
    expect(within(group).queryByRole('button', { name: 'Git History' })).not.toBeInTheDocument()
    expect(within(group).queryByRole('button', { name: /terminal/i })).not.toBeInTheDocument()
  })

  it('says No open editors when there are none', () => {
    seedTabs([CHAT_TAB, { type: 'git-history', id: 'git-history-/proj', cwd: '/proj' }])
    renderList({ section: 'editors' })

    expect(screen.getByText('No open editors')).toBeInTheDocument()
  })

  it('gives the canvas row a label and the Edit2 icon', () => {
    seedAllTabTypes()
    renderList({ section: 'editors' })

    const row = screen.getByRole('button', { name: 'Plan.op' })
    expect(row.querySelector('svg[data-termul-icon="Edit2"]')).toBeInTheDocument()
  })

  it('hides the dirty dot from assistive tech and adds sr-only text', () => {
    seedAllTabTypes()
    editorRef.current.openFiles = new Map([['/proj/a.ts', { isDirty: true }]])
    canvasRef.current = { p1: { dirty: true } }
    renderList({ section: 'editors' })

    const dot = screen.getByTestId('editor-dirty-dot')
    expect(dot).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('button', { name: /^a\.ts/ })).toHaveAccessibleName(
      'a.ts, unsaved changes'
    )
    expect(screen.getByRole('button', { name: /^Plan\.op/ })).toHaveAccessibleName(
      'Plan.op, unsaved changes'
    )
    expect(screen.getByTestId('canvas-dirty-dot').className).toBe(dot.className)
  })

  it('omits the dirty dot for a clean file', () => {
    seedAllTabTypes()
    renderList({ section: 'editors' })

    expect(screen.queryByTestId('editor-dirty-dot')).not.toBeInTheDocument()
    expect(screen.queryByText(', unsaved changes')).not.toBeInTheDocument()
  })

  it('routes each close through its guarded path', () => {
    seedAllTabTypes()
    const onCloseEditorTab = vi.fn(() => false)
    renderList({ section: 'editors', onCloseEditorTab })

    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))
    expect(onCloseEditorTab).toHaveBeenCalledWith('/proj/a.ts')
    expect(workspaceRef.current.removeTab).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Close Example Site' }))
    expect(mockRemoveBrowserTab).toHaveBeenCalledWith('b1')
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('browser-b1')

    fireEvent.click(screen.getByRole('button', { name: 'Close Plan.op' }))
    expect(mockCloseCanvas).toHaveBeenCalledWith('p1')
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('canvas-p1')

    fireEvent.click(screen.getByRole('button', { name: 'Close Git Changes' }))
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('git-/proj')
  })

  it('on /snapshots, tapping a row activates the tab and returns to /', () => {
    seedAllTabTypes()
    renderList({ section: 'editors' }, '/snapshots')

    fireEvent.click(screen.getByRole('button', { name: 'Git Changes' }))

    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'git-/proj')
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('/')
  })
})

describe('MobileDrawerSectionList fullscreen and other panes', () => {
  let raf: { mockRestore: () => void }

  beforeEach(() => {
    raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    workspaceRef.current = {
      ...workspaceRef.current,
      leaves: [
        {
          type: 'leaf',
          id: 'pane-1',
          tabs: [{ type: 'git', id: 'git-/a', cwd: '/a' }],
          activeTabId: 'git-/a'
        },
        {
          type: 'leaf',
          id: 'pane-2',
          tabs: [{ type: 'editor', id: 'edit-/b.ts', filePath: '/b.ts' }],
          activeTabId: 'edit-/b.ts'
        }
      ],
      activePaneId: 'pane-1',
      fullscreenPaneId: 'pane-1'
    }
  })

  afterEach(() => {
    raf.mockRestore()
  })

  it('leaves fullscreen before activating a tab in another leaf', () => {
    renderList({ section: 'editors' })
    fireEvent.click(screen.getByRole('button', { name: 'b.ts' }))

    expect(workspaceRef.current.clearFullscreenPane).toHaveBeenCalledTimes(1)
    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-2', 'edit-/b.ts')
    const [clearing] = workspaceRef.current.clearFullscreenPane.mock.invocationCallOrder
    const [activation] = workspaceRef.current.setActiveTab.mock.invocationCallOrder
    expect(clearing).toBeLessThan(activation)
  })

  it('keeps fullscreen when the row belongs to the fullscreen leaf', () => {
    renderList({ section: 'editors' })
    fireEvent.click(screen.getByRole('button', { name: 'Git Changes' }))

    expect(workspaceRef.current.clearFullscreenPane).not.toHaveBeenCalled()
    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'git-/a')
  })
})

describe('MobileDrawerSectionList a row in another pane on /snapshots', () => {
  let pendingFrames: FrameRequestCallback[]
  let raf: { mockRestore: () => void }

  beforeEach(() => {
    // Hold the deferred activation instead of running it, so each test decides
    // when the frame fires.
    pendingFrames = []
    raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        pendingFrames.push(callback)
        return pendingFrames.length
      })
    workspaceRef.current = {
      ...workspaceRef.current,
      leaves: [
        { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
        {
          type: 'leaf',
          id: 'pane-2',
          tabs: [{ type: 'git', id: 'git-/proj', cwd: '/proj' }],
          activeTabId: null
        }
      ],
      activePaneId: 'pane-1'
    }
  })

  afterEach(() => {
    raf.mockRestore()
  })

  it('activates and navigates only once the frame fires, activation first', () => {
    renderList({ section: 'editors' }, '/snapshots')

    fireEvent.click(screen.getByRole('button', { name: 'Git Changes' }))

    // The drawer closes at once, but neither the activation nor the route
    // change has happened yet.
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(pendingFrames).toHaveLength(1)
    expect(workspaceRef.current.setActiveTab).not.toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()

    for (const frame of pendingFrames) frame(0)

    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-2', 'git-/proj')
    expect(mockNavigate).toHaveBeenCalledWith('/')
    const [activation] = workspaceRef.current.setActiveTab.mock.invocationCallOrder
    const [navigation] = mockNavigate.mock.invocationCallOrder
    expect(activation).toBeLessThan(navigation)
  })
})

describe('MobileDrawerSectionList confirm hand-off', () => {
  beforeEach(() => {
    seedTabs([
      { type: 'terminal', id: 'term-t1', terminalId: 't1' },
      { type: 'editor', id: 'edit-/proj/a.ts', filePath: '/proj/a.ts' }
    ])
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
  })

  it('hands off once when closing a terminal opened the confirm', () => {
    const onConfirmOpened = vi.fn()
    renderList({ onCloseTerminal: vi.fn(() => true), onConfirmOpened })

    fireEvent.click(screen.getByRole('button', { name: 'Close zsh' }))

    expect(onConfirmOpened).toHaveBeenCalledTimes(1)
  })

  it('stays put when closing a terminal needed no confirm', () => {
    const onConfirmOpened = vi.fn()
    renderList({ onCloseTerminal: vi.fn(() => false), onConfirmOpened })

    fireEvent.click(screen.getByRole('button', { name: 'Close zsh' }))

    expect(onConfirmOpened).not.toHaveBeenCalled()
  })

  it('hands off once when a dirty editor tab opened its confirm', () => {
    const onConfirmOpened = vi.fn()
    renderList({ section: 'editors', onCloseEditorTab: vi.fn(() => true), onConfirmOpened })

    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))

    expect(onConfirmOpened).toHaveBeenCalledTimes(1)
  })
})

describe('MobileDrawerSectionList focus after a row closes', () => {
  const TERMINAL_TABS = [
    { type: 'terminal', id: 'term-t1', terminalId: 't1' },
    { type: 'terminal', id: 'term-t2', terminalId: 't2' },
    { type: 'terminal', id: 'term-t3', terminalId: 't3' }
  ]

  beforeEach(() => {
    terminalsRef.current = [
      { id: 't1', name: 'alpha' },
      { id: 't2', name: 'beta' },
      { id: 't3', name: 'gamma' }
    ]
    // Closing drops the tab from the (mocked) workspace tree, as the store would.
    workspaceRef.current.removeTab.mockImplementation((tabId: string) => {
      const leaf = workspaceRef.current.leaves[0]
      seedTabs(
        leaf.tabs.filter((tab) => tab.id !== tabId),
        leaf.activeTabId
      )
    })
  })

  const closeTerminalNow = (_terminalId: string, tabId: string): boolean => {
    workspaceRef.current.removeTab(tabId)
    return false
  }

  /** Focus a row's close button, press it, and re-render the list. */
  function closeFocused(name: string, update: () => void): void {
    const close = screen.getByRole('button', { name })
    close.focus()
    expect(close).toHaveFocus()
    fireEvent.click(close)
    update()
    expect(close.isConnected).toBe(false)
  }

  it('moves focus to the next terminal row, not the previous one', () => {
    seedTabs(TERMINAL_TABS)
    const { update } = renderList({ onCloseTerminal: closeTerminalNow })

    closeFocused('Close beta', update)

    expect(screen.getByRole('button', { name: 'gamma' })).toHaveFocus()
  })

  it('falls back to the section heading when the last row closes', () => {
    seedTabs(TERMINAL_TABS)
    const { update } = renderList({ onCloseTerminal: closeTerminalNow })

    closeFocused('Close gamma', update)

    expect(screen.getByRole('heading', { name: 'Terminals' })).toHaveFocus()
  })

  it('falls back to the list root when the heading cannot take focus', () => {
    seedTabs([{ type: 'git', id: 'git-/proj', cwd: '/proj' }])
    const { update, container } = renderList({ section: 'editors' }, '/', false)

    closeFocused('Close Git Changes', update)

    expect(container.querySelector('div[tabindex="-1"]')).toHaveFocus()
  })

  it('follows the same rule for an editor row closed through the dirty guard', () => {
    const onCloseEditorTab = vi.fn((filePath: string) => {
      workspaceRef.current.removeTab(`edit-${filePath}`)
      return false
    })
    seedTabs([
      { type: 'editor', id: 'edit-/proj/a.ts', filePath: '/proj/a.ts' },
      { type: 'editor', id: 'edit-/proj/b.ts', filePath: '/proj/b.ts' }
    ])
    const { update } = renderList({ section: 'editors', onCloseEditorTab })

    closeFocused('Close a.ts', update)

    expect(screen.getByRole('button', { name: 'b.ts' })).toHaveFocus()
  })

  it('does not steal focus the user already moved elsewhere', () => {
    seedTabs(TERMINAL_TABS)
    const { update } = renderList({ onCloseTerminal: closeTerminalNow })
    const close = screen.getByRole('button', { name: 'Close alpha' })
    close.focus()

    fireEvent.click(close)
    screen.getByRole('button', { name: 'elsewhere' }).focus()
    update()

    expect(screen.getByRole('button', { name: 'elsewhere' })).toHaveFocus()
  })

  it('leaves focus alone when a terminal close is refused (kill failed)', () => {
    seedTabs(TERMINAL_TABS)
    const { update } = renderList({ onCloseTerminal: vi.fn(() => false) })
    const close = screen.getByRole('button', { name: 'Close alpha' })
    close.focus()

    fireEvent.click(close)
    update()

    expect(close).toHaveFocus()
  })

  it('registers nothing when the close opened a confirm: the drawer is closing', () => {
    seedTabs(TERMINAL_TABS)
    const onConfirmOpened = vi.fn()
    const { update } = renderList({ onCloseTerminal: vi.fn(() => true), onConfirmOpened })
    const close = screen.getByRole('button', { name: 'Close alpha' })
    close.focus()

    fireEvent.click(close)
    workspaceRef.current.removeTab('term-t1')
    update()

    expect(document.body).toHaveFocus()
  })

  it('logs at info when no focus target takes focus', () => {
    seedTabs(TERMINAL_TABS)
    const { update } = renderList({ onCloseTerminal: closeTerminalNow })
    const close = screen.getByRole('button', { name: 'Close alpha' })
    close.focus()
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => {})

    fireEvent.click(close)
    update()
    focusSpy.mockRestore()

    expect(mockLogFrontendError).toHaveBeenCalledWith(expect.objectContaining({ level: 'info' }))
  })
})

describe('MobileDrawerSectionList focus after a rename ends', () => {
  beforeEach(() => {
    seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }])
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
  })

  function startRenaming(onRenameTerminal: ListProps['onRenameTerminal']): HTMLElement {
    renderList({ onRenameTerminal })
    fireEvent.click(screen.getByRole('button', { name: 'Rename zsh' }))
    return screen.getByRole('textbox', { name: 'Rename zsh' })
  }

  it('Enter commits and returns focus to that row’s Rename button', () => {
    const onRenameTerminal = vi.fn()
    const input = startRenaming(onRenameTerminal)

    fireEvent.change(input, { target: { value: 'dev server' } })
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)

    expect(onRenameTerminal).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Rename zsh' })).toHaveFocus()
  })

  it('Escape cancels without renaming and returns focus to the Rename button', () => {
    const onRenameTerminal = vi.fn()
    const input = startRenaming(onRenameTerminal)

    fireEvent.change(input, { target: { value: 'dev server' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onRenameTerminal).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Rename zsh' })).toHaveFocus()
  })

  it('commits once when Enter is followed by the blur of the unmounting field', () => {
    const onRenameTerminal = vi.fn()
    const input = startRenaming(onRenameTerminal)

    fireEvent.change(input, { target: { value: 'dev server' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)

    expect(onRenameTerminal).toHaveBeenCalledTimes(1)
  })

  it('does not commit when Escape is followed by a blur', () => {
    const onRenameTerminal = vi.fn()
    const input = startRenaming(onRenameTerminal)

    fireEvent.change(input, { target: { value: 'dev server' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)

    expect(onRenameTerminal).not.toHaveBeenCalled()
  })

  it('a blur after the user moved on commits once and leaves their focus', () => {
    const onRenameTerminal = vi.fn()
    startRenaming(onRenameTerminal)
    const close = screen.getByRole('button', { name: 'Close zsh' })

    act(() => close.focus())

    expect(onRenameTerminal).toHaveBeenCalledTimes(1)
    expect(onRenameTerminal).toHaveBeenCalledWith('t1', 'zsh')
    expect(close).toHaveFocus()
  })
})
