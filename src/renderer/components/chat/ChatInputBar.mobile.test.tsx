/**
 * Mobile web shell composer: the one-row toolbar, the "Add to chat" sheet and
 * the context ring. `ChatInputBar.test.tsx` owns the desktop behaviour and never
 * sets the mobile shell, so everything here is gated on `useMobileWebShell()`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { SessionConfigOption, SessionUsage } from '@/lib/acp-api'
import type { AcpSession } from '@/stores/acp-store'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import { ChatInputBar } from './ChatInputBar'
import { CHAT_COMPACT_LABEL } from './chat-layout'
import { getComposerValue, setComposerValue } from './composer/chat-composer-test-helpers'

// jsdom omits `document.elementFromPoint`; ProseMirror's drop handler calls it.
if (typeof document.elementFromPoint !== 'function') {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => null,
    configurable: true,
    writable: true
  })
}

const {
  mockShell,
  mockSetConfig,
  mockSetMode,
  mockSetModel,
  mockSetMcpServerEnabled,
  mockLoadMcpTools,
  mockToastError,
  mockLogError,
  mockPickFiles,
  mockUsage,
  mockMessages,
  mockMcp,
  mockAgentConfigs,
  mockConfigToLiveAgent,
  mockSwitching,
  mockSessionAgentId,
  mockAgentOptionsCache,
  mockRecents
} = vi.hoisted(() => ({
  // Mutable so a test can flip back to the desktop shell.
  mockShell: { current: true },
  mockSetConfig: vi.fn(),
  mockSetMode: vi.fn(),
  mockSetModel: vi.fn(),
  mockSetMcpServerEnabled: vi.fn(async () => {}),
  mockLoadMcpTools: vi.fn(async () => {}),
  mockToastError: vi.fn(),
  mockLogError: vi.fn(async () => {}),
  mockPickFiles: vi.fn(async (): Promise<File[] | null> => null),
  mockUsage: { current: null as null | Record<string, unknown> },
  mockMessages: { current: [] as Array<{ id: string; role: string }> },
  mockMcp: {
    servers: [] as Array<{ id: string; type: string; name: string; enabled: boolean }>,
    probeStatus: {} as Record<string, string>
  },
  mockAgentConfigs: { current: [] as StoredAgentConfig[] },
  mockConfigToLiveAgent: { current: {} as Record<string, string> },
  mockSwitching: { current: null as { toConfigId: string; status: 'pending' } | null },
  mockSessionAgentId: { current: 'agent-1' as string },
  mockAgentOptionsCache: { current: {} as Record<string, unknown> },
  mockRecents: {
    current: [{ relPath: 'src/app.ts', absPath: '/work/src/app.ts', name: 'app.ts' }]
  }
}))

vi.mock('@/hooks/use-mobile-web-shell', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/use-mobile-web-shell')>(
    '@/hooks/use-mobile-web-shell'
  )
  return { ...actual, useMobileWebShell: () => mockShell.current }
})

vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => false }))

vi.mock('sonner', () => ({
  toast: { error: mockToastError, success: vi.fn() }
}))

vi.mock('@/lib/log-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/log-api')>('@/lib/log-api')
  return { ...actual, logFrontendError: mockLogError }
})

vi.mock('@/lib/composer-attachments-io', async () => {
  const actual = await vi.importActual<typeof import('@/lib/composer-attachments-io')>(
    '@/lib/composer-attachments-io'
  )
  return { ...actual, pickAttachmentFilesBrowser: mockPickFiles }
})

vi.mock('@/hooks/use-agent-skills', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/use-agent-skills')>(
    '@/hooks/use-agent-skills'
  )
  return { ...actual, useAgentSkills: () => ({ skills: [] }) }
})

vi.mock('@/stores/acp-store', () => {
  const state = () => ({
    mcpServers: mockMcp.servers,
    setMcpServerEnabled: mockSetMcpServerEnabled,
    mcpProbeStatus: mockMcp.probeStatus,
    mcpProbeError: {} as Record<string, string | undefined>,
    mcpTools: {} as Record<string, unknown[]>,
    mcpToolsLoaded: {} as Record<string, boolean>,
    mcpProbing: {} as Record<string, boolean>,
    loadMcpTools: mockLoadMcpTools,
    agentConfigs: mockAgentConfigs.current,
    saveAgentConfig: vi.fn(async () => {}),
    armAgentSwitch: vi.fn(async () => true),
    setSwitchPendingOption: vi.fn(async () => {}),
    agentOptionsCache: mockAgentOptionsCache.current,
    prepareChat: vi.fn(),
    cancelAgentSwitch: vi.fn(),
    cancelPrompt: vi.fn(async () => {}),
    sessions: {
      'session-1': { agentId: mockSessionAgentId.current, switching: mockSwitching.current }
    },
    configToLiveAgent: mockConfigToLiveAgent.current,
    sessionIndex: []
  })
  const useAcpStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state())
  useAcpStore.getState = state
  useAcpStore.subscribe = () => () => {}
  return {
    useAgentTemplateId: (_agentId: string | null, agentConfigId?: string) =>
      agentConfigId
        ? (mockAgentConfigs.current.find((c) => c.id === agentConfigId)?.templateId ?? 'cursor')
        : 'claude-acp',
    useAgentIcon: () => null,
    useSessionUsage: () => mockUsage.current,
    useAcpMessages: () => mockMessages.current,
    useAcpStore
  }
})

const { persistenceStore, fakePersistenceApi } = vi.hoisted(() => {
  const persistenceStore = new Map<string, unknown>()
  const api = {
    read: vi.fn(async (key: string) =>
      persistenceStore.has(key)
        ? { success: true, data: persistenceStore.get(key) }
        : { success: false, code: 'KEY_NOT_FOUND', error: `Key not found: ${key}` }
    ),
    write: vi.fn(async (key: string, data: unknown) => {
      persistenceStore.set(key, data)
      return { success: true, data: undefined }
    }),
    writeDebounced: vi.fn(async (key: string, data: unknown) => {
      persistenceStore.set(key, data)
      return { success: true, data: undefined }
    }),
    delete: vi.fn(async (key: string) => {
      persistenceStore.delete(key)
      return { success: true, data: undefined }
    }),
    flushPendingWrites: vi.fn(async () => ({ success: true, data: undefined }))
  }
  return { persistenceStore, fakePersistenceApi: api }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    persistenceApi: fakePersistenceApi,
    filesystemApi: {
      ...actual.filesystemApi,
      searchFileNamesStreamStart: vi.fn(async () => ({ success: true as const })),
      searchFileNamesStreamCancel: vi.fn(async () => ({ success: true as const })),
      onSearchFileNamesBatch: vi.fn(() => () => {}),
      onSearchFileNamesDone: vi.fn(() => () => {})
    }
  }
})

// A recent file makes the bare-`@` mention menu render a real listbox.
vi.mock('@/hooks/use-mention-recents', () => ({
  useMentionRecents: () => ({ recents: mockRecents.current, pushRecent: vi.fn() })
}))

vi.mock('@/hooks/use-resolved-supported-acp-agents', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agents/supported-acp-agents')>(
    '@/lib/agents/supported-acp-agents'
  )
  return {
    useResolvedSupportedAcpAgents: (configs: readonly StoredAgentConfig[]) =>
      actual.buildSupportedAcpAgents(configs, 'linux-x86_64')
  }
})

vi.mock('@/lib/acp-api', () => ({
  acpApi: { installAcpAgent: vi.fn(async () => ({ command: 'claude', args: ['acp'] })) }
}))

// Destroy lingering Tiptap editors before the next test mounts a fresh one.
afterEach(() => {
  for (const el of Array.from(document.querySelectorAll('[data-composer-editor="true"]'))) {
    const editor = (el as HTMLElement & { __composerEditor?: Editor | null }).__composerEditor
    if (editor && !editor.isDestroyed) editor.destroy()
  }
  cleanup()
  useOverlayStackStore.setState({ stack: [] })
})

const CLAUDE_CONFIG: StoredAgentConfig = {
  id: 'acp-registry:claude-acp',
  configId: 'acp-registry:claude-acp',
  name: 'Claude Code',
  command: 'claude',
  args: [],
  env: {},
  allowTerminal: false,
  templateId: 'claude-acp'
}

const CURSOR_CONFIG: StoredAgentConfig = {
  id: 'acp-registry:cursor',
  configId: 'acp-registry:cursor',
  name: 'Cursor',
  command: 'cursor-agent',
  args: [],
  env: {},
  allowTerminal: false,
  templateId: 'cursor'
}

/** 40K of a 190K conversation window: 21%, above the 1% display floor. */
const USAGE: SessionUsage = {
  used: 50_000,
  size: 200_000,
  baselineUsed: 10_000,
  updatedAt: 1,
  source: 'reported'
}

beforeEach(() => {
  vi.clearAllMocks()
  persistenceStore.clear()
  mockShell.current = true
  mockUsage.current = { ...USAGE }
  mockMessages.current = [{ id: 'm1', role: 'user' }]
  mockMcp.servers = []
  mockMcp.probeStatus = {}
  mockAgentConfigs.current = [CLAUDE_CONFIG, CURSOR_CONFIG]
  mockConfigToLiveAgent.current = { 'acp-registry:claude-acp\0/work': 'agent-1' }
  mockSwitching.current = null
  mockSessionAgentId.current = 'agent-1'
  mockAgentOptionsCache.current = {}
  useOverlayStackStore.setState({ stack: [] })
})

function session(overrides: Partial<AcpSession> = {}): AcpSession {
  return {
    id: 'session-1',
    agentId: 'agent-1',
    cwd: '/work',
    projectId: 'p1',
    status: 'active',
    title: null,
    activeTurn: false,
    openTurnId: null,
    modes: {
      currentModeId: 'agent',
      availableModes: [
        { id: 'agent', name: 'Agent' },
        { id: 'plan', name: 'Plan' }
      ]
    },
    models: {
      currentModelId: 'opus',
      availableModels: [
        { modelId: 'opus', name: 'Opus 5.5' },
        { modelId: 'sonnet', name: 'Sonnet 5.5' }
      ]
    },
    configOptions: [],
    lastError: null,
    createdAt: 1,
    ...overrides
  }
}

function selectOption(
  id: string,
  name: string,
  category: string,
  currentValue: string,
  values: string[]
): SessionConfigOption {
  return {
    id,
    name,
    category,
    type: 'select',
    currentValue,
    options: values.map((value) => ({ value, name: value }))
  }
}

const THOUGHT = selectOption('thought_level', 'Thought level', 'thought_level', 'Medium', [
  'Low',
  'Medium',
  'High'
])

function renderBar(props: Partial<ComponentProps<typeof ChatInputBar>> = {}) {
  const s = props.session ?? session()
  return render(
    <TooltipProvider>
      <ChatInputBar
        session={s}
        busy={false}
        disabled={false}
        embedCapable
        onSend={vi.fn()}
        onSendBlocks={vi.fn()}
        onCancel={vi.fn()}
        commands={[]}
        configOptions={[]}
        modes={s.modes}
        onSetConfig={mockSetConfig}
        onSetMode={mockSetMode}
        onSetModel={mockSetModel}
        {...props}
      />
    </TooltipProvider>
  )
}

function plusButton(): HTMLElement {
  // `hidden`: while the sheet is open Radix marks everything outside it aria-hidden.
  return screen.getByRole('button', { name: 'Add to chat', hidden: true })
}

function openSheet(): HTMLElement {
  fireEvent.click(plusButton())
  return screen.getByRole('dialog', { name: 'Add to chat' })
}

function editorEl(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-composer-editor="true"]')
  if (!el) throw new Error('composer editor not mounted')
  return el
}

function editor(): Editor {
  const handle = editorEl() as HTMLElement & { __composerEditor?: Editor | null }
  if (!handle.__composerEditor) throw new Error('composer editor handle missing')
  return handle.__composerEditor
}

/** ProseMirror's own focus is synchronous (Tiptap's `commands.focus` defers to rAF). */
function focusEditor(): void {
  act(() => {
    editor().view.focus()
  })
}

function overlayIds(): string[] {
  return useOverlayStackStore.getState().stack.map((entry) => entry.id)
}

function mobileRow(container: HTMLElement): HTMLElement {
  const rows = container.querySelectorAll<HTMLElement>('[data-composer-toolbar-row="mobile"]')
  expect(rows).toHaveLength(1)
  return rows[0]
}

/** Visible label, or the aria-label when there is one. */
function nameOf(el: Element): string {
  return el.getAttribute('aria-label') ?? el.textContent?.trim() ?? ''
}

/** The combined model, effort and agent pill that opens the selector sheet. */
const PILL_NAME = 'Opus 5.5. Switch agent. Currently Claude Code'

/** Let Radix's setTimeout(0) unmount auto-focus run. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

describe('mobile composer: one-row toolbar', () => {
  it('renders exactly one row: Add to chat, model, mode, context ring, send', () => {
    const { container } = renderBar()
    const row = mobileRow(container)

    expect(row.className).toContain('flex min-w-0 flex-1 items-center gap-2')
    expect(row.closest('[data-chat-composer="true"]')).not.toBeNull()
    expect(within(row).getAllByRole('button').map(nameOf)).toEqual([
      'Add to chat',
      PILL_NAME,
      'Agent',
      'Context 21 percent used',
      'Send message'
    ])
    for (const stale of ['1', '2', 'single']) {
      expect(container.querySelector(`[data-composer-toolbar-row="${stale}"]`)).toBeNull()
    }
    expect(container.querySelector('[data-chat-composer-context-strip]')).toBeNull()
  })

  it('keeps Attach and MCP out of the toolbar (they live in the sheet) and effort in the pill', () => {
    mockMcp.servers = [{ id: 'github', type: 'stdio', name: 'github', enabled: true }]
    renderBar({ configOptions: [THOUGHT] })

    expect(screen.queryByRole('button', { name: 'Attach files' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /MCP servers/ })).not.toBeInTheDocument()
    // The effort is part of the one selector pill, not a chip of its own.
    expect(screen.queryByRole('button', { name: 'Medium' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Opus 5\.5\. Medium\./ })).toBeInTheDocument()
  })

  it('shows the agent glyph and model name on the selector pill and names the agent for assistive tech', () => {
    renderBar()

    const pill = screen.getByRole('button', { name: PILL_NAME })
    expect(pill.querySelector('svg')).not.toBeNull()
    expect(within(pill).getByText('Opus 5.5')).toBeInTheDocument()
  })

  it('names the armed switch target while an agent switch is armed', () => {
    mockSwitching.current = { toConfigId: 'acp-registry:cursor', status: 'pending' }
    renderBar()

    expect(
      screen.getByRole('button', {
        name: 'Opus 5.5. Switch to Cursor on next send. Cancel to keep Claude Code'
      })
    ).toBeInTheDocument()
  })

  it('truncates the model label first and lets the mode label go icon-only at 360px', () => {
    renderBar()

    // The pill can shrink (`min-w-0` from ComposerPill) and its model label
    // truncates; the wrapper around the pill shrinks with it.
    const pill = screen.getByRole('button', { name: PILL_NAME })
    expect(pill).toHaveClass('min-w-0')
    const modelLabel = within(pill).getByText('Opus 5.5')
    expect(modelLabel.tagName).toBe('SPAN')
    expect(modelLabel).toHaveClass('truncate')
    expect(pill.parentElement).toHaveClass('min-w-0')

    const modeChip = screen.getByRole('button', { name: 'Agent' })
    expect(modeChip).toHaveClass('shrink-0')
    const modeLabel = within(modeChip).getByText('Agent')
    expect(modeLabel).toHaveClass(CHAT_COMPACT_LABEL)
    expect(CHAT_COMPACT_LABEL).toBe('@max-[361px]:sr-only')

    expect(plusButton()).toHaveClass('shrink-0')
    expect(screen.getByRole('button', { name: /Context \d+ percent used/ })).toHaveClass('shrink-0')
    expect(screen.getByRole('button', { name: 'Send message' }).parentElement).toHaveClass(
      'shrink-0'
    )
  })

  it('opens the model selector as a bottom sheet from the pill', async () => {
    renderBar()

    fireEvent.click(screen.getByRole('button', { name: PILL_NAME }))
    const sheet = await screen.findByRole('dialog', { name: 'Model and agent' })
    expect(sheet).toHaveAttribute('data-sheet')
    expect(within(sheet).getByText('Sonnet 5.5')).toBeInTheDocument()
  })

  it('opens the Agent SelectorModal from the mode chip', () => {
    renderBar()

    fireEvent.click(screen.getByRole('button', { name: 'Agent' }))
    const dialog = screen.getByRole('dialog', { name: 'Agent' })
    expect(within(dialog).getByText('Plan')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByText('Plan'))
    expect(mockSetMode).toHaveBeenCalledWith('plan')
  })

  it('caps the mode SelectorModal at 80dvh', () => {
    renderBar()

    fireEvent.click(screen.getByRole('button', { name: 'Agent' }))
    const modal = screen.getByRole('dialog', { name: 'Agent' })
    expect(modal.className).toContain('max-h-[80dvh]')
    expect(modal.className).not.toContain('max-h-[80vh]')
  })

  it('hides the context ring when usage is missing, bootstrap-only or under 1%', () => {
    for (const [usage, messages] of [
      [null, [{ id: 'm1', role: 'user' }]],
      [{ ...USAGE }, [{ id: 'm1', role: 'assistant' }]],
      [{ ...USAGE, used: 10_100 }, [{ id: 'm1', role: 'user' }]]
    ] as const) {
      mockUsage.current = usage as Record<string, unknown> | null
      mockMessages.current = [...messages]
      const { unmount } = renderBar()

      expect(screen.queryByRole('button', { name: /Context \d+ percent used/ })).toBeNull()
      // Radix portals a sheet to `document.body`, outside the render container.
      expect(document.querySelector('[data-sheet]')).toBeNull()
      expect(overlayIds()).toEqual([])
      unmount()
    }
  })

  it('opens the context details sheet from the ring', async () => {
    renderBar()

    const ring = screen.getByRole('button', { name: 'Context 21 percent used' })
    fireEvent.click(ring)
    const sheet = screen.getByRole('dialog', { name: 'Context window' })
    expect(within(sheet).getByText('21% conversation used')).toBeInTheDocument()
    expect(overlayIds()).toEqual(['context-details-sheet'])

    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(overlayIds()).toEqual([])
    await waitFor(() => expect(ring).toHaveFocus())
  })

  it('renders no mobile row and keeps the desktop toolbar when the shell is not mobile', () => {
    mockShell.current = false
    const { container } = renderBar()

    expect(container.querySelector('[data-composer-toolbar-row="mobile"]')).toBeNull()
    expect(container.querySelector('[data-composer-toolbar-row="single"]')).not.toBeNull()
    expect(container.querySelector('[data-chat-composer-context-strip]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add to chat' })).not.toBeInTheDocument()
    // The desktop ring sits in the editor row, outside any toolbar row.
    const ring = screen.getByRole('button', { name: /Context \d+ percent used/ })
    expect(ring.closest('[data-composer-toolbar]')).toBeNull()
  })
})

describe('mobile composer: Send, Queue and Stop (AC9)', () => {
  it('sends the draft from the row when idle', async () => {
    const onSend = vi.fn()
    renderBar({ onSend })
    setComposerValue('hello')

    const send = await screen.findByRole('button', { name: 'Send message' })
    await waitFor(() => expect(send).toBeEnabled())
    fireEvent.click(send)

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello'))
  })

  it('queues the draft while a turn is busy', async () => {
    const onSend = vi.fn()
    const onCancel = vi.fn()
    renderBar({ onSend, onCancel, busy: true })
    setComposerValue('hello')

    const queue = await screen.findByRole('button', { name: 'Queue message' })
    await waitFor(() => expect(queue).toBeEnabled())
    fireEvent.click(queue)

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello'))
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('cancels the turn when busy with an empty draft', () => {
    const onSend = vi.fn()
    const onCancel = vi.fn()
    renderBar({ onSend, onCancel, busy: true })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel turn' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
  })
})

describe('mobile composer: Add to chat sheet', () => {
  it('opens a bottom sheet, blurs the editor and registers the overlay', () => {
    renderBar()
    focusEditor()
    expect(editorEl()).toHaveFocus()

    const sheet = openSheet()

    expect(sheet).toHaveAttribute('data-sheet')
    expect(sheet.className).toContain('max-h-[85dvh]')
    expect(sheet.className).toContain('overflow-y-auto')
    expect(sheet.className).toContain('overscroll-contain')
    expect(sheet.className).toContain('pb-[max(0.5rem,env(safe-area-inset-bottom))]')
    expect(editorEl()).not.toHaveFocus()
    expect(overlayIds()).toEqual(['composer-add-sheet'])

    expect(within(sheet).getByRole('heading', { level: 2, name: 'Add to chat' })).toHaveClass(
      'text-base'
    )
    expect(within(sheet).getByRole('button', { name: 'Attach files' })).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Mention file' })).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Commands' })).toBeInTheDocument()
    expect(
      within(sheet).getByRole('heading', { level: 3, name: 'MCP servers' })
    ).toBeInTheDocument()
  })

  it('does not describe itself with a second string', () => {
    renderBar()
    expect(openSheet()).not.toHaveAttribute('aria-describedby')
  })

  it('carries no chat options: the selector pill owns the agent, effort and the other options', () => {
    renderBar({ configOptions: [THOUGHT] })
    const sheet = openSheet()

    expect(within(sheet).queryByRole('heading', { name: 'Chat options' })).not.toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: 'Medium' })).not.toBeInTheDocument()
    expect(within(sheet).queryByText('Opus 5.5')).not.toBeInTheDocument()
  })

  it.each([
    [
      'the close button',
      (sheet: HTMLElement) => fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
    ],
    ['Escape', (sheet: HTMLElement) => fireEvent.keyDown(sheet, { key: 'Escape' })],
    [
      'closeTopmostOverlay (system back)',
      () => {
        act(() => {
          expect(useOverlayStackStore.getState().closeTopmostOverlay()).toBe(true)
        })
      }
    ]
  ])('closes with %s, removes the overlay entry and returns focus to the + button', async (_name, close) => {
    renderBar()
    const plus = plusButton()
    const sheet = openSheet()
    expect(overlayIds()).toEqual(['composer-add-sheet'])

    close(sheet)

    expect(screen.queryByRole('dialog', { name: 'Add to chat' })).not.toBeInTheDocument()
    expect(overlayIds()).toEqual([])
    await waitFor(() => expect(plus).toHaveFocus())
  })
})

describe('mobile composer: Mention file and Commands', () => {
  it('Mention on an empty draft focuses the editor, inserts @ and opens the mention listbox', async () => {
    renderBar()
    openSheet()

    fireEvent.click(screen.getByRole('button', { name: 'Mention file' }))

    // Focus lands in the same tap, before the sheet's own focus restore runs.
    expect(screen.queryByRole('dialog', { name: 'Add to chat' })).not.toBeInTheDocument()
    expect(editorEl()).toHaveFocus()
    await settle()
    expect(editorEl()).toHaveFocus()
    expect(getComposerValue()).toBe('@')
    expect(overlayIds()).toEqual([])
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
  })

  it('keeps focus in the editor while the sheet still plays its exit animation', async () => {
    // In a browser the closing sheet stays mounted until `animationend`, so its
    // focus trap must already be released when the editor takes focus. jsdom has
    // no CSS animations: report one for the sheet so Radix's Presence waits.
    const realGetComputedStyle = window.getComputedStyle.bind(window)
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const style = realGetComputedStyle(el, pseudo)
      if (!(el instanceof Element) || !el.hasAttribute('data-sheet')) return style
      // A getter: Radix keeps the style object it read on mount.
      return Object.create(style, {
        animationName: {
          get: () => (el.getAttribute('data-state') === 'closed' ? 'sheet-out' : 'sheet-in')
        }
      })
    })
    try {
      renderBar()
      openSheet()

      fireEvent.click(screen.getByRole('button', { name: 'Mention file' }))

      // Still mounted and closing, yet the editor already owns focus.
      const closing = document.querySelector('[data-sheet]')
      expect(closing).toHaveAttribute('data-state', 'closed')
      expect(editorEl()).toHaveFocus()
      expect(getComposerValue()).toBe('@')

      // jsdom has no AnimationEvent, so stamp the name on a plain event.
      const animationEnd = new Event('animationend', { bubbles: true })
      Object.defineProperty(animationEnd, 'animationName', { value: 'sheet-out' })
      await act(async () => {
        closing?.dispatchEvent(animationEnd)
      })
      await settle()

      expect(document.querySelector('[data-sheet]')).toBeNull()
      expect(editorEl()).toHaveFocus()
    } finally {
      spy.mockRestore()
    }
  })

  it('still returns focus to + on a later dismissal after a successful Mention', async () => {
    renderBar()
    const plus = plusButton()
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Mention file' }))
    await settle()
    expect(editorEl()).toHaveFocus()

    // The same sheet instance opens again and closes by Escape: the earlier
    // "keep focus in the editor" hand-off must not leak into this dismissal.
    const sheet = openSheet()
    fireEvent.keyDown(sheet, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Add to chat' })).not.toBeInTheDocument()
    await waitFor(() => expect(plus).toHaveFocus())
  })

  it('Mention adds a separating space after text without trailing whitespace', async () => {
    renderBar()
    setComposerValue('fix the bug')
    openSheet()

    fireEvent.click(screen.getByRole('button', { name: 'Mention file' }))

    expect(getComposerValue()).toBe('fix the bug @')
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
  })

  it('Mention does not add a second space after trailing whitespace', () => {
    renderBar()
    setComposerValue('fix ')
    openSheet()

    fireEvent.click(screen.getByRole('button', { name: 'Mention file' }))

    expect(getComposerValue()).toBe('fix @')
  })

  it('Commands on an empty draft inserts / and opens the slash listbox with focus in the editor', async () => {
    renderBar({ commands: [{ name: 'compact', description: 'Compact' }] })
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Commands' }))

    expect(editorEl()).toHaveFocus()
    await settle()
    expect(editorEl()).toHaveFocus()
    expect(getComposerValue()).toBe('/')
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
  })

  it('Commands appends after existing text', async () => {
    renderBar({ commands: [{ name: 'compact', description: 'Compact' }] })
    setComposerValue('hello')
    openSheet()

    fireEvent.click(screen.getByRole('button', { name: 'Commands' }))

    expect(getComposerValue()).toBe('hello /')
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
  })

  it('with the editor gone it closes the sheet, returns focus to +, logs a warning and keeps the draft', async () => {
    const onSend = vi.fn()
    renderBar({ onSend })
    setComposerValue('keep me')
    const plus = plusButton()
    openSheet()
    act(() => {
      editor().destroy()
    })

    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Mention file' }))
    ).not.toThrow()

    expect(screen.queryByRole('dialog', { name: 'Add to chat' })).not.toBeInTheDocument()
    await waitFor(() => expect(plus).toHaveFocus())
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', source: 'composer-add-sheet' })
    )
    expect(mockToastError).not.toHaveBeenCalled()
    // The logged line names the trigger but never the draft.
    for (const [payload] of mockLogError.mock.calls as unknown as Array<[{ message: string }]>) {
      expect(payload.message).not.toContain('keep me')
    }
    // The draft state is untouched: it still enables Send.
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
  })
})

describe('mobile composer: Attach files', () => {
  it('opens the picker synchronously from the tap, closes the sheet and previews the file', async () => {
    let sheetOpenAtPick: boolean | null = null
    mockPickFiles.mockImplementationOnce(async () => {
      sheetOpenAtPick = document.querySelector('[data-sheet]') !== null
      return [new File(['hello'], 'notes.txt', { type: 'text/plain' })]
    })
    renderBar()
    const plus = plusButton()
    openSheet()

    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))

    // Called inside the tap handler, while the sheet was still mounted.
    expect(mockPickFiles).toHaveBeenCalledTimes(1)
    expect(sheetOpenAtPick).toBe(true)
    expect(screen.queryByRole('dialog', { name: 'Add to chat' })).not.toBeInTheDocument()
    expect(await screen.findByText('notes.txt')).toBeInTheDocument()
    await waitFor(() => expect(plus).toHaveFocus())
  })

  it('keeps the existing toast when the picker fails', async () => {
    mockPickFiles.mockRejectedValueOnce(new Error('blocked'))
    renderBar()
    openSheet()

    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Failed to open file picker'))
  })
})

describe('mobile composer: closed session', () => {
  it('keeps + enabled, drops Attach, disables Mention, Commands and the selector pill, keeps MCP switches usable', () => {
    mockMcp.servers = [{ id: 'github', type: 'stdio', name: 'github', enabled: true }]
    renderBar({ disabled: true, configOptions: [THOUGHT] })

    expect(plusButton()).toBeEnabled()
    expect(screen.getByTestId('agent-model-selector-trigger')).toBeDisabled()
    const sheet = openSheet()

    expect(within(sheet).queryByRole('button', { name: 'Attach files' })).not.toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Mention file' })).toBeDisabled()
    expect(within(sheet).getByRole('button', { name: 'Commands' })).toBeDisabled()
    expect(within(sheet).getByRole('switch', { name: 'Disable github' })).toBeEnabled()
  })
})

describe('mobile composer: MCP servers in the sheet', () => {
  it('lists each server with its status and a switch, then the next-chat footnote', () => {
    mockMcp.servers = [
      { id: 'github', type: 'stdio', name: 'github', enabled: true },
      { id: 'playwright', type: 'stdio', name: 'playwright', enabled: true }
    ]
    mockMcp.probeStatus = { github: 'connected', playwright: 'disconnected' }
    renderBar()
    const sheet = openSheet()

    expect(within(sheet).getByText('2 attached to this session.')).toBeInTheDocument()
    expect(within(sheet).getByText('Connected')).toBeInTheDocument()
    expect(within(sheet).getByText('Disconnected')).toBeInTheDocument()
    expect(within(sheet).getByRole('switch', { name: 'Disable github' })).toBeInTheDocument()
    expect(within(sheet).getByRole('switch', { name: 'Disable playwright' })).toBeInTheDocument()
    expect(within(sheet).getByText('Takes effect on the next chat.')).toBeInTheDocument()
    // The sheet scrolls, so the list drops the popover's nested 300px scroller.
    const list = within(sheet).getAllByRole('list')[0]
    expect(list).not.toHaveClass('max-h-[300px]')
    expect(list).not.toHaveClass('overflow-y-auto')
  })

  it('toggles a server through the store action', () => {
    mockMcp.servers = [{ id: 'github', type: 'stdio', name: 'github', enabled: true }]
    renderBar()
    const sheet = openSheet()

    fireEvent.click(within(sheet).getByRole('switch', { name: 'Disable github' }))

    expect(mockSetMcpServerEnabled).toHaveBeenCalledWith('github', false)
  })

  it('shows the existing toast when a toggle is rejected', async () => {
    mockMcp.servers = [{ id: 'github', type: 'stdio', name: 'github', enabled: true }]
    mockSetMcpServerEnabled.mockRejectedValueOnce(new Error('nope'))
    renderBar()
    const sheet = openSheet()

    fireEvent.click(within(sheet).getByRole('switch', { name: 'Disable github' }))

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        'Could not update the MCP server. Your previous setting was restored.'
      )
    )
  })

  it('shows the heading and the empty line, with no rows and no footnote, when none are attached', () => {
    renderBar()
    const sheet = openSheet()

    expect(within(sheet).getByRole('heading', { name: 'MCP servers' })).toBeInTheDocument()
    expect(within(sheet).getByText('No servers attached yet.')).toBeInTheDocument()
    expect(within(sheet).queryByRole('listitem')).not.toBeInTheDocument()
    expect(within(sheet).queryByText('Takes effect on the next chat.')).not.toBeInTheDocument()
  })
})
