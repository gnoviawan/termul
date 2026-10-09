import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatEntryIcon } from '@/components/chat/ChatHistoryEntryRow'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import { mockSessionIndexEntry } from '@/lib/test-utils/acp'
import { _resetEphemeralSessionIdsForTesting, useAcpStore } from '@/stores/acp-store'
import { FRESH, seedOptionsSession } from '@/stores/acp-store/testkit'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useAgentChatUnreadStore } from '@/stores/agent-chat-unread-store'
import { MobileDrawerOpenSection } from './MobileDrawerOpenSection'

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
  // Canvas runtime sessions by project id (only `dirty` is read by the section).
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
  return {
    ...actual,
    useNavigate: () => mockNavigate
  }
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

type SectionProps = ComponentProps<typeof MobileDrawerOpenSection>

function renderSection(props: Partial<SectionProps> = {}, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <div>
        <h2 id="open-heading" tabIndex={-1}>
          Open
        </h2>
        <MobileDrawerOpenSection
          activeTabId={null}
          openHeadingId="open-heading"
          onNavigate={onNavigate}
          {...props}
        />
      </div>
    </MemoryRouter>
  )
}

function seedTabs(tabs: Array<Record<string, unknown>>, activeTabId: string | null = null): void {
  workspaceRef.current = {
    ...workspaceRef.current,
    leaves: [{ type: 'leaf', id: 'pane-1', tabs, activeTabId }],
    activePaneId: 'pane-1'
  }
}

const CHAT_TAB = { type: 'agent-chat', id: 'tab-1', sessionId: 's1' }

function seedChat(overrides: Parameters<typeof seedOptionsSession>[2] = {}): void {
  seedOptionsSession('s1', 'agent-1', { title: 'Hello chat', ...overrides })
}

function setTurn(busy: boolean): void {
  act(() => {
    const session = useAcpStore.getState().sessions.s1
    useAcpStore.setState({
      sessions: {
        s1: { ...session, activeTurn: busy, openTurnId: busy ? 'turn-1' : null }
      }
    })
  })
}

function addPendingPermission(): void {
  act(() => {
    useAcpStore.setState({
      pendingPermissions: {
        r1: { requestId: 'r1', agentId: 'agent-1', sessionId: 's1', options: [], toolCall: null }
      }
    })
  })
}

/** The visible (non-sr-only) status label inside a row button. */
function visibleLabel(row: HTMLElement, text: string): HTMLElement {
  const match = within(row)
    .getAllByText(text)
    .find((el) => !el.classList.contains('sr-only'))
  if (!match) throw new Error(`no visible "${text}" label`)
  return match
}

/** An acp catalog templateId whose bundled SVG exists (Gemini's spark icon). */
const TEMPLATE_GEMINI = 'gemini'
/** A second acp catalog templateId with a distinct bundled SVG (Claude). */
const TEMPLATE_CLAUDE = 'claude-acp'

function agentConfig(id: string, templateId: string): StoredAgentConfig {
  return { id, name: `Agent ${id}`, command: 'echo', args: [], env: {}, templateId }
}

/** The inline agent glyph's SVG markup inside `root` (null for the Bot fallback). */
function agentGlyphHtml(root: ParentNode): string | null {
  return root.querySelector('span[aria-hidden="true"][style*="width"]')?.innerHTML ?? null
}

/** What `ChatEntryIcon` draws for a config, rendered on its own as the oracle. */
function expectedGlyphHtml(agentConfigId: string): string | null {
  const { container, unmount } = render(
    <ChatEntryIcon agentId="agent-1" agentConfigId={agentConfigId} />
  )
  const html = agentGlyphHtml(container)
  unmount()
  return html
}

beforeEach(() => {
  onNavigate.mockReset()
  mockNavigate.mockReset()
  mockRemoveBrowserTab.mockReset()
  mockRequestCloseAgentChat.mockReset()
  mockCloseCanvas.mockReset().mockResolvedValue(undefined)
  mockLogFrontendError.mockReset()
  canvasRef.current = {}
  // Closing a chat completes immediately, like an idle chat does.
  mockRequestCloseAgentChat.mockImplementation((_sessionId: string, closeTab: () => void) =>
    closeTab()
  )
  workspaceRef.current.removeTab.mockReset()
  workspaceRef.current.setActiveTab.mockReset()
  workspaceRef.current.clearFullscreenPane.mockReset()
  workspaceRef.current.fullscreenPaneId = null
  terminalsRef.current = []
  editorRef.current.openFiles = new Map()
  browserTabsRef.current = new Map()
  useAcpStore.setState(FRESH)
  _resetEphemeralSessionIdsForTesting()
  useAgentChatLifetimeStore.setState({ closingSessionIds: {} })
  useAgentChatUnreadStore.setState({ unread: {} })
  seedTabs([CHAT_TAB], 'tab-1')
  seedChat()
})

describe('MobileDrawerOpenSection chat rows', () => {
  it('lists chats first, in a group labelled by the Open heading, before Terminals', () => {
    seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }, CHAT_TAB])
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
    renderSection()

    const group = screen.getByRole('group', { name: 'Open' })
    expect(within(group).getByRole('button', { name: 'Hello chat' })).toBeInTheDocument()
    const terminalsHeading = screen.getByRole('heading', { level: 3, name: 'Terminals' })
    expect(group.compareDocumentPosition(terminalsHeading)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('names an idle chat by its title alone and shows no status', () => {
    renderSection({ activeTabId: null })

    const row = screen.getByRole('button', { name: 'Hello chat' })
    expect(row.getAttribute('aria-label')).toBe('Hello chat')
    for (const title of ['Working', 'Needs you', 'New activity']) {
      expect(within(row).queryByTitle(title)).not.toBeInTheDocument()
      expect(within(row).queryByText(title)).not.toBeInTheDocument()
    }
  })

  it('shows the muted spinner and a Working label while a turn runs', () => {
    renderSection()
    setTurn(true)

    const row = screen.getByRole('button', { name: 'Hello chat, Working' })
    expect(within(row).getByTitle('Working')).toHaveClass('text-muted-foreground')
    expect(visibleLabel(row, 'Working')).toHaveClass('text-2xs', 'text-muted-foreground')
  })

  it('shows the warning glyph and a text-warning label when it needs you', () => {
    addPendingPermission()
    renderSection()

    const row = screen.getByRole('button', { name: 'Hello chat, Needs you' })
    expect(within(row).getByTitle('Needs you')).toHaveClass('text-warning')
    expect(visibleLabel(row, 'Needs you')).toHaveClass('text-2xs', 'text-warning')
  })

  it('shows Needs you alongside Working', () => {
    addPendingPermission()
    renderSection()
    setTurn(true)

    const row = screen.getByRole('button', { name: 'Hello chat, Needs you, Working' })
    expect(within(row).getByTitle('Needs you')).toBeInTheDocument()
    expect(within(row).getByTitle('Working')).toBeInTheDocument()
  })

  it('shows Closing, and nothing else, for a chat that is closing mid-turn', () => {
    seedChat({ activeTurn: true, openTurnId: 't1' })
    useAgentChatLifetimeStore.setState({ closingSessionIds: { s1: true } })
    renderSection()

    const row = screen.getByRole('button', { name: 'Hello chat, Closing' })
    expect(within(row).getByTitle('Closing. This chat stops when the turn finishes.')).toBeVisible()
    expect(within(row).queryByTitle('Working')).not.toBeInTheDocument()
    expect(visibleLabel(row, 'Closing')).toHaveClass('text-muted-foreground')
  })

  it('shows the primary-fill dot and New activity from the unread store', () => {
    useAgentChatUnreadStore.setState({ unread: { s1: true } })
    renderSection()

    const row = screen.getByRole('button', { name: 'Hello chat, New activity' })
    const dot = within(row).getByTitle('New activity').querySelector('span[aria-hidden="true"]')
    expect(dot).toHaveClass('bg-primary-fill')
    expect(visibleLabel(row, 'New activity')).toHaveClass('text-muted-foreground')

    // Clearing the flag (the chat was viewed) drops the label live.
    act(() => useAgentChatUnreadStore.getState().clearUnread('s1'))
    expect(screen.getByRole('button', { name: 'Hello chat' })).toBeInTheDocument()
  })

  it.each([
    ['a closed session', () => seedChat({ status: 'closed' })],
    [
      'a disconnected agent',
      () => useAcpStore.setState({ agentStatus: { 'agent-1': 'disconnected' } })
    ]
  ])('shows Needs you, never Failed, for %s', (_name, arrange) => {
    arrange()
    renderSection()

    expect(screen.getByRole('button', { name: 'Hello chat, Needs you' })).toBeInTheDocument()
    expect(screen.queryByText('Failed')).not.toBeInTheDocument()
  })

  it('shows the agent glyph, not the New chat icon', () => {
    const { container } = renderSection()

    const row = screen.getByRole('button', { name: 'Hello chat' })
    // agent-1 is unknown, so the AgentGlyph chokepoint renders its Bot fallback.
    expect(row.querySelector('svg[data-termul-icon="Bot"]')).toBeInTheDocument()
    expect(container.querySelector('[data-termul-icon="MessageSquarePlus"]')).toBeNull()
  })

  it("resolves the glyph through the row's own index entry config, not another chat's", () => {
    // Two chats on the same agent id, on different configs: the entry listed
    // first must not win for s1 (it would if the row dropped its agentConfigId).
    useAcpStore.setState({
      agentConfigs: [
        agentConfig('cfg-claude', TEMPLATE_CLAUDE),
        agentConfig('cfg-gemini', TEMPLATE_GEMINI)
      ],
      sessionIndex: [
        mockSessionIndexEntry({ id: 'other', agentId: 'agent-1', agentConfigId: 'cfg-claude' }),
        mockSessionIndexEntry({ id: 's1', agentId: 'agent-1', agentConfigId: 'cfg-gemini' })
      ]
    })
    const gemini = expectedGlyphHtml('cfg-gemini')
    const claude = expectedGlyphHtml('cfg-claude')
    expect(gemini).toBeTruthy()
    expect(claude).toBeTruthy()
    expect(gemini).not.toBe(claude)
    const { container } = renderSection()

    const row = screen.getByRole('button', { name: 'Hello chat' })
    expect(row.querySelector('svg[data-termul-icon="Bot"]')).toBeNull()
    expect(agentGlyphHtml(row)).toBe(gemini)
    expect(container.querySelector('[data-termul-icon="MessageSquarePlus"]')).toBeNull()
  })

  it('shows the persisted custom icon of the index entry config', () => {
    const svg = '<svg viewBox="0 0 8 8" data-custom-agent="yes"><circle cx="4" cy="4" r="3"/></svg>'
    useAcpStore.setState({
      agentConfigs: [{ ...agentConfig('cfg-custom', TEMPLATE_GEMINI), icon: svg }],
      sessionIndex: [
        mockSessionIndexEntry({ id: 's1', agentId: 'agent-1', agentConfigId: 'cfg-custom' })
      ]
    })
    renderSection()

    const row = screen.getByRole('button', { name: 'Hello chat' })
    expect(row.querySelector('svg[data-termul-icon="Bot"]')).toBeNull()
    expect(agentGlyphHtml(row)).toContain('<circle')
  })

  it('resolves the glyph and title from the index entry when the chat has no live session', () => {
    useAcpStore.setState({
      sessions: {},
      agentConfigs: [agentConfig('cfg-gemini', TEMPLATE_GEMINI)],
      sessionIndex: [
        mockSessionIndexEntry({
          id: 's1',
          title: 'Restored chat',
          agentId: 'agent-1',
          agentConfigId: 'cfg-gemini'
        })
      ]
    })
    renderSection()

    const row = screen.getByRole('button', { name: /^Restored chat/ })
    expect(row.querySelector('svg[data-termul-icon="Bot"]')).toBeNull()
    expect(agentGlyphHtml(row)).toBe(expectedGlyphHtml('cfg-gemini'))
  })

  it('falls back from the live title to the index title to Agent Chat', () => {
    seedChat({ title: null })
    useAcpStore.setState({
      sessionIndex: [mockSessionIndexEntry({ id: 's1', title: 'Index title' })]
    })
    const { unmount } = renderSection()
    expect(screen.getByRole('button', { name: 'Index title' })).toBeInTheDocument()
    unmount()

    useAcpStore.setState({ sessionIndex: [] })
    renderSection()
    expect(screen.getByRole('button', { name: 'Agent Chat' })).toBeInTheDocument()
  })

  it('marks only the active row: secondary fill, aria-current and the leading bar', () => {
    seedTabs([CHAT_TAB, { type: 'agent-chat', id: 'tab-2', sessionId: 's2' }], 'tab-1')
    seedOptionsSession('s2', 'agent-1', { title: 'Other chat' })
    renderSection({ activeTabId: 'tab-1' })

    const active = screen.getByRole('button', { name: 'Hello chat' })
    expect(active).toHaveAttribute('aria-current', 'page')
    expect(active).toHaveClass('bg-secondary', 'border-l-2', 'border-l-primary')

    const inactive = screen.getByRole('button', { name: 'Other chat' })
    expect(inactive).not.toHaveAttribute('aria-current')
    expect(inactive).toHaveClass('border-l-2', 'border-l-transparent')
    expect(inactive).not.toHaveClass('border-l-primary')
    expect(inactive).not.toHaveClass('bg-secondary')
  })

  it('holds the 44px floor: row at min-h-11, close at size-11, named for its chat', () => {
    renderSection()

    expect(screen.getByRole('button', { name: 'Hello chat' })).toHaveClass('min-h-11')
    const close = screen.getByRole('button', { name: 'Close Hello chat' })
    expect(close).toHaveClass('size-11')
    expect(close.className).not.toMatch(/\bsize-8\b/)
  })

  it('selecting a row activates its tab and navigates', () => {
    renderSection({ activeTabId: null })

    fireEvent.click(screen.getByRole('button', { name: 'Hello chat' }))

    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'tab-1')
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('defers activation until a different pane is active', () => {
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0)
        return 0
      })
    workspaceRef.current.activePaneId = 'pane-other'
    renderSection({ activeTabId: null })

    fireEvent.click(screen.getByRole('button', { name: 'Hello chat' }))

    expect(raf).toHaveBeenCalledTimes(1)
    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'tab-1')
    expect(onNavigate).toHaveBeenCalledTimes(1)
    raf.mockRestore()
  })

  it('renders no chat group when no chat is open', () => {
    seedTabs([])
    renderSection()

    expect(screen.queryByRole('group', { name: 'Open' })).not.toBeInTheDocument()
    // The Open heading stays with the Terminals empty line under it.
    expect(screen.getByText('No open terminals')).toBeInTheDocument()
  })
})

describe('MobileDrawerOpenSection terminals', () => {
  beforeEach(() => {
    seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }], 'term-t1')
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
  })

  it('has an h3 heading and a 44px New terminal button that navigates', () => {
    const onNewTerminal = vi.fn()
    renderSection({ onNewTerminal })

    expect(screen.getByRole('heading', { level: 3, name: 'Terminals' })).toHaveClass('label-group')
    const add = screen.getByRole('button', { name: 'New terminal' })
    expect(add).toHaveClass('size-11')

    fireEvent.click(add)
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNewTerminal).toHaveBeenCalledTimes(1)
  })

  it('says No open terminals when there are none', () => {
    seedTabs([])
    renderSection()

    expect(screen.getByText('No open terminals')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Terminals' })).not.toBeInTheDocument()
  })

  it('names the row actions after their terminal and holds 44px', () => {
    renderSection({ onRenameTerminal: vi.fn(), onCloseTerminal: vi.fn(), activeTabId: 'term-t1' })

    const row = screen.getByRole('group', { name: 'Terminals' })
    const select = within(row).getByRole('button', { name: 'zsh' })
    expect(select).toHaveClass('min-h-11', 'bg-secondary', 'border-l-primary')
    expect(select).toHaveAttribute('aria-current', 'page')
    expect(within(row).getByRole('button', { name: 'Rename zsh' })).toHaveClass('size-11')
    expect(within(row).getByRole('button', { name: 'Close zsh' })).toHaveClass('size-11')
  })

  it('omits the rename action when renaming is not threaded', () => {
    renderSection()

    expect(screen.queryByRole('button', { name: 'Rename zsh' })).not.toBeInTheDocument()
  })

  it('renames inline through a labelled text-base, 44px field', () => {
    const onRenameTerminal = vi.fn()
    renderSection({ onRenameTerminal })

    fireEvent.click(screen.getByRole('button', { name: 'Rename zsh' }))
    const input = screen.getByRole('textbox', { name: 'Rename zsh' })
    expect(input).toHaveValue('zsh')
    expect(input).toHaveClass('min-h-11', 'text-base')
    expect(input.className).not.toMatch(/\btext-xs\b/)
    expect(input).toHaveFocus()

    fireEvent.change(input, { target: { value: '  dev server  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRenameTerminal).toHaveBeenCalledWith('t1', 'dev server')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('cancels a rename with Escape and ignores an empty name', () => {
    const onRenameTerminal = vi.fn()
    renderSection({ onRenameTerminal })

    fireEvent.click(screen.getByRole('button', { name: 'Rename zsh' }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Rename zsh' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onRenameTerminal).not.toHaveBeenCalled()
  })

  it('falls back to a plain terminal label when the record is missing', () => {
    terminalsRef.current = []
    renderSection({ onRenameTerminal: vi.fn() })

    expect(screen.getByRole('button', { name: 'Terminal' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close terminal' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rename terminal' })).toBeInTheDocument()
  })
})

describe('MobileDrawerOpenSection tabs', () => {
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

  it('renders no Tabs heading when only chats and terminals are open', () => {
    renderSection()

    expect(screen.queryByRole('heading', { name: 'Tabs' })).not.toBeInTheDocument()
  })

  it('lists every non-chat, non-terminal tab with a labelled close under an h3', () => {
    seedAllTabTypes()
    renderSection()

    expect(screen.getByRole('heading', { level: 3, name: 'Tabs' })).toHaveClass('label-group')
    const group = screen.getByRole('group', { name: 'Tabs' })
    for (const label of ['a.ts', 'Git Changes', 'Git History', 'Example Site', 'Plan.op']) {
      expect(within(group).getByRole('button', { name: label })).toHaveClass('min-h-11')
      const close = within(group).getByRole('button', { name: `Close ${label}` })
      expect(close).toHaveClass('size-11')
    }
    // The chat and the terminal are not duplicated into Tabs.
    expect(within(group).queryByRole('button', { name: 'Hello chat' })).not.toBeInTheDocument()
  })

  it('gives the canvas row a label and the Edit2 icon (it rendered empty before)', () => {
    seedAllTabTypes()
    renderSection()

    const row = screen.getByRole('button', { name: 'Plan.op' })
    expect(row).toHaveTextContent('Plan.op')
    expect(row.querySelector('svg[data-termul-icon="Edit2"]')).toBeInTheDocument()
  })

  it('never renders a blank Tabs row for a tab kind it has no label for', () => {
    // A kind added to WorkspaceTab later fails to compile in `otherTabLabel`;
    // at runtime the row still gets a name instead of an empty button.
    seedTabs([{ type: 'future-kind', id: 'future-1' }])
    renderSection()

    const row = screen.getByRole('button', { name: 'Tab' })
    expect(row).toHaveTextContent('Tab')
    expect(screen.getByRole('button', { name: 'Close Tab' })).toBeInTheDocument()
  })

  it('hides the editor dirty dot from assistive tech and adds sr-only text', () => {
    seedAllTabTypes()
    editorRef.current.openFiles = new Map([['/proj/a.ts', { isDirty: true }]])
    renderSection()

    const dot = screen.getByTestId('editor-dirty-dot')
    expect(dot).toHaveAttribute('aria-hidden', 'true')
    expect(dot).not.toHaveAttribute('aria-label')
    const row = screen.getByRole('button', { name: /^a\.ts/ })
    expect(within(row).getByText(', unsaved changes')).toHaveClass('sr-only')
    expect(row).toHaveAccessibleName('a.ts, unsaved changes')
  })

  it('omits the dirty dot and its text for a clean file', () => {
    seedAllTabTypes()
    editorRef.current.openFiles = new Map([['/proj/a.ts', { isDirty: false }]])
    renderSection()

    expect(screen.queryByTestId('editor-dirty-dot')).not.toBeInTheDocument()
    expect(screen.queryByText(', unsaved changes')).not.toBeInTheDocument()
  })

  it('marks an active non-chat row like any other', () => {
    seedAllTabTypes()
    renderSection({ activeTabId: 'git-/proj' })

    const row = screen.getByRole('button', { name: 'Git Changes' })
    expect(row).toHaveAttribute('aria-current', 'page')
    expect(row).toHaveClass('bg-secondary', 'border-l-primary')
  })
})

describe('MobileDrawerOpenSection close routing', () => {
  function seedAllTabTypes(): void {
    seedTabs(
      [
        { type: 'terminal', id: 'term-t1', terminalId: 't1' },
        { type: 'editor', id: 'edit-/proj/a.ts', filePath: '/proj/a.ts' },
        { type: 'git', id: 'git-/proj', cwd: '/proj' },
        { type: 'git-history', id: 'git-history-/proj', cwd: '/proj' },
        { type: 'browser', id: 'browser-b1', browserTabId: 'b1' },
        { type: 'canvas', id: 'canvas-p1', projectId: 'p1', docPath: '/proj/Plan.op' },
        CHAT_TAB
      ],
      'tab-1'
    )
    browserTabsRef.current = new Map([
      ['b1', { id: 'b1', url: 'https://example.com/page', title: 'Example Site' }]
    ])
  }

  it('routes a dirty editor tab through the dirty guard, not removeTab', () => {
    seedAllTabTypes()
    const onCloseEditorTab = vi.fn()
    renderSection({ onCloseEditorTab })

    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))

    expect(onCloseEditorTab).toHaveBeenCalledWith('/proj/a.ts')
    expect(workspaceRef.current.removeTab).not.toHaveBeenCalled()
  })

  it('falls back to removeTab for an editor tab when no guard is threaded', () => {
    seedAllTabTypes()
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))

    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('edit-/proj/a.ts')
  })

  it('routes a terminal tab through the existing terminal close flow', () => {
    seedAllTabTypes()
    const onCloseTerminal = vi.fn()
    renderSection({ onCloseTerminal })

    // No terminal record: the label falls back to the plain "terminal" name.
    fireEvent.click(screen.getByRole('button', { name: 'Close terminal' }))

    expect(onCloseTerminal).toHaveBeenCalledWith('t1', 'term-t1')
    expect(workspaceRef.current.removeTab).not.toHaveBeenCalled()
  })

  it('removes git and git-history tabs directly', () => {
    seedAllTabTypes()
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Close Git Changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close Git History' }))

    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('git-/proj')
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('git-history-/proj')
  })

  it('tears down the session tab and the workspace tab for a browser tab', () => {
    seedAllTabTypes()
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Close Example Site' }))

    expect(mockRemoveBrowserTab).toHaveBeenCalledWith('b1')
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('browser-b1')
  })

  it('closes a canvas through closeCanvas once, before the plain removeTab', () => {
    seedAllTabTypes()
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Close Plan.op' }))

    expect(mockCloseCanvas).toHaveBeenCalledTimes(1)
    expect(mockCloseCanvas).toHaveBeenCalledWith('p1')
    expect(workspaceRef.current.removeTab).toHaveBeenCalledTimes(1)
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('canvas-p1')
    expect(mockCloseCanvas.mock.invocationCallOrder[0]).toBeLessThan(
      workspaceRef.current.removeTab.mock.invocationCallOrder[0]
    )
    // Not the browser teardown.
    expect(mockRemoveBrowserTab).not.toHaveBeenCalled()
  })

  it('closes an agent chat through requestCloseAgentChat, removing the tab when it completes', () => {
    seedAllTabTypes()
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Close Hello chat' }))

    expect(mockRequestCloseAgentChat).toHaveBeenCalledWith('s1', expect.any(Function))
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('tab-1')
  })

  it('leaves the tab in place while a running chat is still closing', () => {
    seedAllTabTypes()
    mockRequestCloseAgentChat.mockImplementation(() => {
      // A running turn: the close waits, so the tab callback is not invoked.
    })
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Close Hello chat' }))

    expect(workspaceRef.current.removeTab).not.toHaveBeenCalled()
  })

  it('does not navigate when a row is closed', () => {
    seedAllTabTypes()
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Close Git Changes' }))

    expect(onNavigate).not.toHaveBeenCalled()
  })
})

describe('MobileDrawerOpenSection returning to the workspace', () => {
  const NON_CHAT_ROWS = [
    { label: 'terminal', rowName: 'Terminal', tabId: 'term-t1' },
    { label: 'editor', rowName: 'a.ts', tabId: 'edit-/proj/a.ts' },
    { label: 'git', rowName: 'Git Changes', tabId: 'git-/proj' },
    { label: 'git-history', rowName: 'Git History', tabId: 'git-history-/proj' },
    { label: 'browser', rowName: 'Example Site', tabId: 'browser-b1' }
  ]

  function seedAllTabTypes(): void {
    seedTabs(
      [
        { type: 'terminal', id: 'term-t1', terminalId: 't1' },
        { type: 'editor', id: 'edit-/proj/a.ts', filePath: '/proj/a.ts' },
        { type: 'git', id: 'git-/proj', cwd: '/proj' },
        { type: 'git-history', id: 'git-history-/proj', cwd: '/proj' },
        { type: 'browser', id: 'browser-b1', browserTabId: 'b1' },
        CHAT_TAB
      ],
      'tab-1'
    )
    terminalsRef.current = [{ id: 't1', name: 'Terminal' }]
    browserTabsRef.current = new Map([
      ['b1', { id: 'b1', url: 'https://example.com/page', title: 'Example Site' }]
    ])
  }

  it.each(
    NON_CHAT_ROWS
  )('on /snapshots, tapping the $label row activates the tab, closes the drawer and returns to /', ({
    rowName,
    tabId
  }) => {
    seedAllTabTypes()
    renderSection({}, '/snapshots')

    fireEvent.click(screen.getByRole('button', { name: rowName }))

    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', tabId)
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('/')
  })

  it('on /snapshots, an agent-chat row does not navigate to / (setActiveTab owns /c/<id>)', () => {
    seedAllTabTypes()
    renderSection({}, '/snapshots')

    fireEvent.click(screen.getByRole('button', { name: 'Hello chat' }))

    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'tab-1')
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it.each([
    '/',
    '/c/s1'
  ])('on the workspace route %s, tapping any drawer row never navigates', (path) => {
    seedAllTabTypes()
    renderSection({}, path)

    for (const { rowName } of NON_CHAT_ROWS) {
      fireEvent.click(screen.getByRole('button', { name: rowName }))
    }
    fireEvent.click(screen.getByRole('button', { name: 'Hello chat' }))

    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledTimes(NON_CHAT_ROWS.length + 1)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  describe('a row in another pane on /snapshots', () => {
    let pendingFrames: FrameRequestCallback[]
    let raf: { mockRestore: () => void }

    beforeEach(() => {
      // Capture the deferred activation instead of running it, so each test
      // decides when the frame fires. Restored in afterEach so a failing
      // assertion cannot leak the stub into later tests.
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

    it('still returns to / after its deferred activation', () => {
      renderSection({}, '/snapshots')

      fireEvent.click(screen.getByRole('button', { name: 'Git Changes' }))
      for (const frame of pendingFrames) frame(0)

      expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-2', 'git-/proj')
      expect(mockNavigate).toHaveBeenCalledTimes(1)
      expect(mockNavigate).toHaveBeenCalledWith('/')
    })

    it('navigates only after the tab is active, never before the frame fires', () => {
      renderSection({}, '/snapshots')

      fireEvent.click(screen.getByRole('button', { name: 'Git Changes' }))

      // The drawer closes at once, but neither the activation nor the route
      // change has happened yet: the workspace route must not paint the
      // previously active leaf while the activation is still pending.
      expect(onNavigate).toHaveBeenCalledTimes(1)
      expect(pendingFrames).toHaveLength(1)
      expect(workspaceRef.current.setActiveTab).not.toHaveBeenCalled()
      expect(mockNavigate).not.toHaveBeenCalled()

      for (const frame of pendingFrames) frame(0)

      const [activation] = workspaceRef.current.setActiveTab.mock.invocationCallOrder
      const [navigation] = mockNavigate.mock.invocationCallOrder
      expect(activation).toBeLessThan(navigation)
    })
  })

  describe('while a pane is fullscreen', () => {
    let raf: { mockRestore: () => void }

    beforeEach(() => {
      // Run the deferred cross-pane activation at once; restored in afterEach
      // so a failing assertion cannot leak the stub into later tests.
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
            tabs: [{ type: 'git-history', id: 'git-history-/b', cwd: '/b' }],
            activeTabId: 'git-history-/b'
          }
        ],
        activePaneId: 'pane-1',
        fullscreenPaneId: 'pane-1'
      }
    })

    afterEach(() => {
      raf.mockRestore()
    })

    function tapRow(name: string): void {
      renderSection({}, '/')
      fireEvent.click(screen.getByRole('button', { name }))
    }

    it('leaves fullscreen before activating a tab in another leaf, so the view follows it', () => {
      tapRow('Git History')

      expect(workspaceRef.current.clearFullscreenPane).toHaveBeenCalledTimes(1)
      expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-2', 'git-history-/b')
      // Cleared first: with fullscreen still set, setActiveTab would keep
      // activePaneId on the fullscreen leaf.
      const [clearing] = workspaceRef.current.clearFullscreenPane.mock.invocationCallOrder
      const [activation] = workspaceRef.current.setActiveTab.mock.invocationCallOrder
      expect(clearing).toBeLessThan(activation)
    })

    it('keeps fullscreen when the row belongs to the fullscreen leaf', () => {
      tapRow('Git Changes')

      expect(workspaceRef.current.clearFullscreenPane).not.toHaveBeenCalled()
      expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'git-/a')
    })

    it('leaves a fullscreen leaf that is not the active one, even for a row in the active leaf', () => {
      // `loadProjectWorkspace` can keep a stale fullscreenPaneId, which would
      // otherwise hand activePaneId back to the fullscreen leaf.
      workspaceRef.current.fullscreenPaneId = 'pane-2'
      tapRow('Git Changes')

      expect(workspaceRef.current.clearFullscreenPane).toHaveBeenCalledTimes(1)
      expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'git-/a')
    })

    it('never touches fullscreen when no pane is fullscreen', () => {
      workspaceRef.current.fullscreenPaneId = null
      tapRow('Git History')

      expect(workspaceRef.current.clearFullscreenPane).not.toHaveBeenCalled()
      expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-2', 'git-history-/b')
    })
  })
})

describe('MobileDrawerOpenSection canvas rows', () => {
  beforeEach(() => {
    seedTabs([{ type: 'canvas', id: 'canvas-p1', projectId: 'p1', docPath: '/proj/Plan.op' }], null)
  })

  it('shows an aria-hidden dot and sr-only ", unsaved changes" for a dirty session', () => {
    canvasRef.current = { p1: { dirty: true } }
    renderSection()

    const dot = screen.getByTestId('canvas-dirty-dot')
    expect(dot).toHaveAttribute('aria-hidden', 'true')
    expect(dot).not.toHaveAttribute('aria-label')
    const row = screen.getByRole('button', { name: /^Plan\.op/ })
    expect(within(row).getByText(', unsaved changes')).toHaveClass('sr-only')
    expect(row).toHaveAccessibleName('Plan.op, unsaved changes')
  })

  it('draws the same dot as an unsaved editor row', () => {
    canvasRef.current = { p1: { dirty: true } }
    editorRef.current.openFiles = new Map([['/proj/a.ts', { isDirty: true }]])
    seedTabs(
      [
        { type: 'editor', id: 'edit-/proj/a.ts', filePath: '/proj/a.ts' },
        { type: 'canvas', id: 'canvas-p1', projectId: 'p1', docPath: '/proj/Plan.op' }
      ],
      null
    )
    renderSection()

    expect(screen.getByTestId('canvas-dirty-dot').className).toBe(
      screen.getByTestId('editor-dirty-dot').className
    )
  })

  it.each([
    ['a clean session', { p1: { dirty: false } }],
    ['no session', {}],
    ["another project's dirty session", { p2: { dirty: true } }]
  ])('shows neither the dot nor the text for %s', (_label, sessions) => {
    canvasRef.current = sessions
    renderSection()

    expect(screen.queryByTestId('canvas-dirty-dot')).not.toBeInTheDocument()
    expect(screen.queryByText(', unsaved changes')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Plan.op' })).toBeInTheDocument()
  })

  it('does not evict a canvas for any other tab kind', () => {
    seedTabs(
      [
        { type: 'git', id: 'git-/proj', cwd: '/proj' },
        { type: 'editor', id: 'edit-/proj/a.ts', filePath: '/proj/a.ts' }
      ],
      null
    )
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Close Git Changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))

    expect(mockCloseCanvas).not.toHaveBeenCalled()
  })
})

describe('MobileDrawerOpenSection confirm hand-off', () => {
  function seedCloseables(): void {
    seedTabs(
      [
        { type: 'terminal', id: 'term-t1', terminalId: 't1' },
        { type: 'editor', id: 'edit-/proj/a.ts', filePath: '/proj/a.ts' }
      ],
      null
    )
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
  }

  it('hands off once when closing a terminal opened the confirm', () => {
    seedCloseables()
    const onCloseTerminal = vi.fn(() => true)
    const onConfirmOpened = vi.fn()
    renderSection({ onCloseTerminal, onConfirmOpened })

    fireEvent.click(screen.getByRole('button', { name: 'Close zsh' }))

    expect(onCloseTerminal).toHaveBeenCalledWith('t1', 'term-t1')
    expect(onConfirmOpened).toHaveBeenCalledTimes(1)
  })

  it('stays put when closing a terminal needed no confirm', () => {
    seedCloseables()
    const onCloseTerminal = vi.fn(() => false)
    const onConfirmOpened = vi.fn()
    renderSection({ onCloseTerminal, onConfirmOpened })

    fireEvent.click(screen.getByRole('button', { name: 'Close zsh' }))

    expect(onCloseTerminal).toHaveBeenCalledTimes(1)
    expect(onConfirmOpened).not.toHaveBeenCalled()
  })

  it('hands off once when a dirty editor tab opened its confirm', () => {
    seedCloseables()
    const onCloseEditorTab = vi.fn(() => true)
    const onConfirmOpened = vi.fn()
    renderSection({ onCloseEditorTab, onConfirmOpened })

    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))

    expect(onCloseEditorTab).toHaveBeenCalledWith('/proj/a.ts')
    expect(onConfirmOpened).toHaveBeenCalledTimes(1)
  })

  it('stays put for a clean editor tab, a refused close or a missing handler', () => {
    seedCloseables()
    const onConfirmOpened = vi.fn()
    renderSection({ onCloseEditorTab: vi.fn(() => false), onConfirmOpened })

    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))
    // No terminal handler is threaded at all.
    fireEvent.click(screen.getByRole('button', { name: 'Close zsh' }))

    expect(onConfirmOpened).not.toHaveBeenCalled()
  })

  it('never hands off for rows that close without a confirm', () => {
    seedTabs(
      [
        { type: 'git', id: 'git-/proj', cwd: '/proj' },
        { type: 'canvas', id: 'canvas-p1', projectId: 'p1', docPath: '/proj/Plan.op' },
        { type: 'browser', id: 'browser-b1', browserTabId: 'b1' },
        CHAT_TAB
      ],
      null
    )
    const onConfirmOpened = vi.fn()
    renderSection({ onConfirmOpened, onCloseTerminal: vi.fn(() => true) })

    for (const name of [
      'Close Git Changes',
      'Close Plan.op',
      'Close Browser',
      'Close Hello chat'
    ]) {
      fireEvent.click(screen.getByRole('button', { name }))
    }

    expect(onConfirmOpened).not.toHaveBeenCalled()
  })
})

describe('MobileDrawerOpenSection focus after a row closes', () => {
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

  /** The terminal close flow without a confirm: the layout removes the tab. */
  const closeTerminalNow = (_terminalId: string, tabId: string): boolean => {
    workspaceRef.current.removeTab(tabId)
    return false
  }

  /**
   * The mocked stores do not re-render the section, so the test re-renders it
   * after each close; `headingFocusable: false` renders an Open heading that
   * cannot take focus, to reach the section-root fallback.
   */
  function setup(
    tabs: Array<Record<string, unknown>>,
    props: Partial<SectionProps> = {},
    headingFocusable = true
  ) {
    seedTabs(tabs, null)
    const ui = (): React.JSX.Element => (
      <MemoryRouter>
        <div>
          <h2 id="open-heading" tabIndex={headingFocusable ? -1 : undefined}>
            Open
          </h2>
          <button type="button">elsewhere</button>
          <MobileDrawerOpenSection
            activeTabId={null}
            openHeadingId="open-heading"
            onNavigate={onNavigate}
            {...props}
          />
        </div>
      </MemoryRouter>
    )
    const view = render(ui())
    return { ...view, update: () => view.rerender(ui()) }
  }

  /** Focus a row's close button, press it, and re-render the section. */
  function closeFocused(name: string, update: () => void): void {
    const close = screen.getByRole('button', { name })
    close.focus()
    expect(close).toHaveFocus()
    fireEvent.click(close)
    update()
    expect(close.isConnected).toBe(false)
  }

  const sectionRoot = (): HTMLElement | null =>
    screen.getByRole('button', { name: 'New terminal' }).closest('[tabindex="-1"]')

  it('makes the section root and both group headings programmatically focusable', () => {
    seedTabs([...TERMINAL_TABS, { type: 'git', id: 'git-/proj', cwd: '/proj' }], null)
    renderSection()

    expect(screen.getByRole('heading', { level: 3, name: 'Terminals' })).toHaveAttribute(
      'tabindex',
      '-1'
    )
    expect(screen.getByRole('heading', { level: 3, name: 'Tabs' })).toHaveAttribute(
      'tabindex',
      '-1'
    )
    expect(sectionRoot()).toHaveClass('outline-none')
  })

  it('moves focus to the next terminal row, not the previous one', () => {
    const { update } = setup(TERMINAL_TABS, { onCloseTerminal: closeTerminalNow })

    closeFocused('Close beta', update)

    expect(screen.getByRole('button', { name: 'gamma' })).toHaveFocus()
  })

  it('moves focus to the next row from the first terminal too', () => {
    const { update } = setup(TERMINAL_TABS, { onCloseTerminal: closeTerminalNow })

    closeFocused('Close alpha', update)

    expect(screen.getByRole('button', { name: 'beta' })).toHaveFocus()
  })

  it('falls back to the Terminals heading when the last terminal row closes', () => {
    const { update } = setup(TERMINAL_TABS, { onCloseTerminal: closeTerminalNow })

    closeFocused('Close gamma', update)

    expect(screen.getByRole('heading', { level: 3, name: 'Terminals' })).toHaveFocus()
  })

  it('falls back to the Terminals heading when the only terminal closes', () => {
    const { update } = setup([TERMINAL_TABS[0]], { onCloseTerminal: closeTerminalNow })

    closeFocused('Close alpha', update)

    expect(screen.getByRole('heading', { level: 3, name: 'Terminals' })).toHaveFocus()
    expect(screen.getByText('No open terminals')).toBeInTheDocument()
  })

  it('does not cross groups: the next row is in the same group', () => {
    const { update } = setup([TERMINAL_TABS[0], { type: 'git', id: 'git-/proj', cwd: '/proj' }], {
      onCloseTerminal: closeTerminalNow
    })

    closeFocused('Close alpha', update)

    // The Git row is in another group: the Terminals heading takes focus.
    expect(screen.getByRole('heading', { level: 3, name: 'Terminals' })).toHaveFocus()
  })

  it('moves focus to the next Tabs row, then to the section root once the group is gone', () => {
    const { update } = setup([
      { type: 'git', id: 'git-/proj', cwd: '/proj' },
      { type: 'git-history', id: 'git-history-/proj', cwd: '/proj' }
    ])

    closeFocused('Close Git Changes', update)
    expect(screen.getByRole('button', { name: 'Git History' })).toHaveFocus()

    closeFocused('Close Git History', update)
    expect(screen.queryByRole('heading', { name: 'Tabs' })).not.toBeInTheDocument()
    expect(sectionRoot()).toHaveFocus()
  })

  it('follows the same rule for an editor row closed through the dirty guard', () => {
    editorRef.current.openFiles = new Map()
    const onCloseEditorTab = vi.fn((filePath: string) => {
      workspaceRef.current.removeTab(`edit-${filePath}`)
      return false
    })
    const { update } = setup(
      [
        { type: 'editor', id: 'edit-/proj/a.ts', filePath: '/proj/a.ts' },
        { type: 'editor', id: 'edit-/proj/b.ts', filePath: '/proj/b.ts' }
      ],
      { onCloseEditorTab }
    )

    closeFocused('Close a.ts', update)

    expect(screen.getByRole('button', { name: 'b.ts' })).toHaveFocus()
  })

  it('moves focus to the next chat row, then to the Open heading', () => {
    seedOptionsSession('s2', 'agent-1', { title: 'Second chat' })
    const { update } = setup([CHAT_TAB, { type: 'agent-chat', id: 'tab-2', sessionId: 's2' }])

    closeFocused('Close Hello chat', update)
    expect(screen.getByRole('button', { name: 'Second chat' })).toHaveFocus()

    closeFocused('Close Second chat', update)
    expect(screen.getByRole('heading', { level: 2, name: 'Open' })).toHaveFocus()
  })

  it('falls back to the section root when the group heading cannot take focus', () => {
    const { update } = setup([CHAT_TAB], {}, false)

    closeFocused('Close Hello chat', update)

    expect(screen.getByRole('heading', { level: 2, name: 'Open' })).not.toHaveFocus()
    expect(sectionRoot()).toHaveFocus()
  })

  it('does not steal focus the user already moved elsewhere', () => {
    const { update } = setup(TERMINAL_TABS, { onCloseTerminal: closeTerminalNow })
    const close = screen.getByRole('button', { name: 'Close alpha' })
    close.focus()

    fireEvent.click(close)
    screen.getByRole('button', { name: 'elsewhere' }).focus()
    update()

    expect(screen.getByRole('button', { name: 'elsewhere' })).toHaveFocus()
  })

  it('leaves focus alone while a close has not completed, and lands it when it does', () => {
    const deferred: { finish: (() => void) | null } = { finish: null }
    mockRequestCloseAgentChat.mockImplementation((_sessionId: string, closeTab: () => void) => {
      deferred.finish = closeTab
    })
    seedOptionsSession('s2', 'agent-1', { title: 'Second chat' })
    const { update } = setup([CHAT_TAB, { type: 'agent-chat', id: 'tab-2', sessionId: 's2' }])
    const close = screen.getByRole('button', { name: 'Close Hello chat' })
    close.focus()

    fireEvent.click(close)
    update()

    // Still Closing: the row, and focus on its close button, stay.
    expect(close.isConnected).toBe(true)
    expect(close).toHaveFocus()
    expect(mockLogFrontendError).not.toHaveBeenCalled()

    act(() => deferred.finish?.())
    update()

    expect(close.isConnected).toBe(false)
    expect(screen.getByRole('button', { name: 'Second chat' })).toHaveFocus()
  })

  it('leaves focus alone when a terminal close is refused (kill failed)', () => {
    const { update } = setup(TERMINAL_TABS, { onCloseTerminal: vi.fn(() => false) })
    const close = screen.getByRole('button', { name: 'Close alpha' })
    close.focus()

    fireEvent.click(close)
    update()

    expect(close.isConnected).toBe(true)
    expect(close).toHaveFocus()
  })

  it('registers nothing when the close opened a confirm: the drawer is closing', () => {
    const onConfirmOpened = vi.fn()
    const { update } = setup(TERMINAL_TABS, {
      onCloseTerminal: vi.fn(() => true),
      onConfirmOpened
    })
    const close = screen.getByRole('button', { name: 'Close alpha' })
    close.focus()

    fireEvent.click(close)
    expect(onConfirmOpened).toHaveBeenCalledTimes(1)
    // The confirmed close lands later, after the drawer is gone from view.
    workspaceRef.current.removeTab('term-t1')
    update()

    expect(document.body).toHaveFocus()
    expect(screen.getByRole('button', { name: 'beta' })).not.toHaveFocus()
  })

  it('logs at info when no focus target takes focus', () => {
    const { update } = setup(TERMINAL_TABS, { onCloseTerminal: closeTerminalNow })
    const close = screen.getByRole('button', { name: 'Close alpha' })
    close.focus()
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => {})

    fireEvent.click(close)
    update()
    focusSpy.mockRestore()

    expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
    expect(mockLogFrontendError).toHaveBeenCalledWith(expect.objectContaining({ level: 'info' }))
  })
})

describe('MobileDrawerOpenSection focus after a rename ends', () => {
  beforeEach(() => {
    seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }], null)
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
  })

  function startRenaming(onRenameTerminal: SectionProps['onRenameTerminal']): HTMLElement {
    renderSection({ onRenameTerminal })
    fireEvent.click(screen.getByRole('button', { name: 'Rename zsh' }))
    return screen.getByRole('textbox', { name: 'Rename zsh' })
  }

  it('Enter commits and returns focus to that row’s Rename button', () => {
    const onRenameTerminal = vi.fn()
    const input = startRenaming(onRenameTerminal)

    fireEvent.change(input, { target: { value: 'dev server' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRenameTerminal).toHaveBeenCalledTimes(1)
    expect(onRenameTerminal).toHaveBeenCalledWith('t1', 'dev server')
    expect(screen.getByRole('button', { name: 'Rename zsh' })).toHaveFocus()
  })

  it('Escape cancels without renaming and returns focus to the Rename button', () => {
    const onRenameTerminal = vi.fn()
    const input = startRenaming(onRenameTerminal)

    fireEvent.change(input, { target: { value: 'dev server' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onRenameTerminal).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rename zsh' })).toHaveFocus()
  })

  it('Enter cancels the key’s default, so the same key press cannot activate the Rename button that took focus', () => {
    const input = startRenaming(vi.fn())

    // Focus moves to the Rename button inside this very keydown. A browser then
    // fires the key's keypress on the focused button, and Enter on a button
    // clicks it: the field would reopen straight after it closed. Cancelling
    // the keydown suppresses that keypress (fireEvent returns false when a
    // handler called preventDefault).
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
    expect(screen.getByRole('button', { name: 'Rename zsh' })).toHaveFocus()
  })

  it('Enter with an empty name still ends the rename and returns focus', () => {
    const onRenameTerminal = vi.fn()
    const input = startRenaming(onRenameTerminal)

    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRenameTerminal).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Rename zsh' })).toHaveFocus()
  })

  it('a blur commits but does not move focus', () => {
    const onRenameTerminal = vi.fn()
    const input = startRenaming(onRenameTerminal)

    fireEvent.change(input, { target: { value: 'dev server' } })
    fireEvent.blur(input)

    expect(onRenameTerminal).toHaveBeenCalledWith('t1', 'dev server')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rename zsh' })).not.toHaveFocus()
    expect(document.body).toHaveFocus()
  })

  it('a blur after the user moved on leaves their focus where it is', () => {
    const onRenameTerminal = vi.fn()
    startRenaming(onRenameTerminal)
    const close = screen.getByRole('button', { name: 'Close zsh' })

    // Moving focus blurs the input: the unchanged name commits, focus stays put.
    act(() => close.focus())

    expect(onRenameTerminal).toHaveBeenCalledTimes(1)
    expect(onRenameTerminal).toHaveBeenCalledWith('t1', 'zsh')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(close).toHaveFocus()
  })

  it('commits once even when Enter is followed by a blur', () => {
    const onRenameTerminal = vi.fn()
    const input = startRenaming(onRenameTerminal)

    fireEvent.change(input, { target: { value: 'dev server' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)

    expect(onRenameTerminal).toHaveBeenCalledTimes(1)
  })
})
