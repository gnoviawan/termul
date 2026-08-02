import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SessionConfigOption } from '@/lib/acp-api'
import { skillToken } from '@/lib/skill-tokens'
import type { AcpSession } from '@/stores/acp-store'
import { ChatInputBar } from './ChatInputBar'

const T = skillToken

function clickMenuOption(name: string | RegExp): void {
  const dialog = screen.getByRole('dialog')
  fireEvent.pointerDown(within(dialog).getByText(name))
}

const {
  mockSetConfig,
  mockSetMode,
  mockSetModel,
  mockMcpCount,
  mockReadDir,
  mockSkills,
  mockToastError
} = vi.hoisted(() => ({
  mockSetConfig: vi.fn(),
  mockSetMode: vi.fn(),
  mockSetModel: vi.fn(),
  // Story 1.8 review (verification-gap #8): override-able MCP server count for
  // the read-only badge. 0 by default (badge hidden); tests set it to render.
  mockMcpCount: { current: 0 },
  mockReadDir: vi.fn(),
  // Override-able skills list (defaults to [] — web/no-skills parity). Skill
  // tests push entries here so useAgentSkills surfaces them in the slash menu.
  // `path` is required so the wire prompt can cite it (desktop always has one).
  mockSkills: {
    current: [] as Array<{
      name: string
      description: string
      scope: string
      path: string
    }>
  },
  mockToastError: vi.fn()
}))

vi.mock('@tauri-apps/plugin-fs', () => ({ readDir: mockReadDir }))

vi.mock('sonner', () => ({
  toast: { error: mockToastError, success: vi.fn() }
}))

vi.mock('@/hooks/use-agent-skills', async () => {
  // Use the real (sync) buildPromptWithLoadedSkills so the wire framing is
  // exercised end-to-end — no mock needed now that paths are captured at pick
  // time (no IPC read at send). Only useAgentSkills is overridden for the
  // override-able skills list.
  const actual = await vi.importActual<typeof import('@/hooks/use-agent-skills')>(
    '@/hooks/use-agent-skills'
  )
  return { ...actual, useAgentSkills: () => ({ skills: mockSkills.current }) }
})

vi.mock('@/stores/acp-store', () => ({
  useAgentIdentity: () => ({ name: 'Cursor', templateId: 'cursor' }),
  useSessionUsage: () => null,
  useAcpMessages: () => [],
  // Story 1.8: ChatInputBar reads the global MCP server count for the read-only
  // MCP badge. The selector reads the hoisted `mockMcpCount.current` so a test
  // can override the count (default 0 → badge hidden).
  useAcpStore: (selector: (s: { mcpServers: unknown[] }) => unknown) =>
    selector({ mcpServers: Array.from({ length: mockMcpCount.current }) })
}))

const { persistenceStore, fakePersistenceApi } = vi.hoisted(() => {
  const persistenceStore = new Map<string, unknown>()
  const api = {
    readFails: false,
    read: vi.fn(async (key: string) => {
      // Faithful to the real persistenceApi, which never throws to callers —
      // a storage-layer failure surfaces as a non-throwing `success:false`.
      if (api.readFails) return { success: false, code: 'READ_ERROR', error: 'storage unavailable' }
      return persistenceStore.has(key)
        ? { success: true, data: persistenceStore.get(key) }
        : { success: false, code: 'KEY_NOT_FOUND', error: `Key not found: ${key}` }
    }),
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
  return { ...actual, persistenceApi: fakePersistenceApi }
})

beforeEach(() => {
  persistenceStore.clear()
  fakePersistenceApi.readFails = false
  // Start each test from a clean skill slate (web/no-skills default). Skill
  // tests override mockSkills.current.
  mockSkills.current = []
})

function option(
  id: string,
  name: string,
  category: string,
  currentValue: string,
  options: Array<{ value: string; name: string }>
): SessionConfigOption {
  return {
    id,
    name,
    category,
    type: 'select',
    currentValue,
    options
  }
}

function session(): AcpSession {
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
        { id: 'plan', name: 'Plan' },
        { id: 'ask', name: 'Ask' }
      ]
    },
    models: null,
    configOptions: [],
    lastError: null,
    createdAt: 1
  }
}

describe('ChatInputBar config controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses model config and native Agent/mode picker without duplicate Agent chips', async () => {
    const s = session()
    const configOptions = [
      option('model', 'Model', 'model', 'composer', [
        { value: 'composer', name: 'composer-2.5' },
        { value: 'sonnet', name: 'sonnet-4.5' }
      ]),
      option('mode', 'Agent', 'mode', 'agent', [
        { value: 'agent', name: 'Agent' },
        { value: 'plan', name: 'Plan' },
        { value: 'ask', name: 'Ask' }
      ])
    ]

    render(
      <TooltipProvider>
        <ChatInputBar
          session={s}
          busy={false}
          disabled={false}
          onSend={vi.fn()}
          onSendBlocks={vi.fn()}
          onCancel={vi.fn()}
          commands={[]}
          configOptions={configOptions}
          modes={s.modes}
          onSetConfig={mockSetConfig}
          onSetMode={mockSetMode}
          onSetModel={mockSetModel}
        />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'composer-2.5' }))
    clickMenuOption('sonnet-4.5')
    expect(mockSetConfig).toHaveBeenCalledWith('model', 'sonnet')

    mockSetConfig.mockClear()
    expect(screen.getAllByRole('button', { name: /^Agent$/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /^Agent$/ }))
    clickMenuOption('Plan')
    expect(mockSetMode).toHaveBeenCalledWith('plan')
    expect(mockSetConfig).not.toHaveBeenCalled()
  })

  it('searches and scroll-limits large active-chat model menus', async () => {
    const s = session()
    const configOptions = [
      option('model', 'Model', 'model', 'gpt-54-mini-fast', [
        { value: 'gpt-54-mini-fast', name: 'OpenAI/GPT-5.4 mini Fast' },
        { value: 'gpt-55', name: 'OpenAI/GPT-5.5' },
        { value: 'gpt-55-fast', name: 'OpenAI/GPT-5.5 Fast' },
        { value: 'gpt-55-pro', name: 'OpenAI/GPT-5.5 Pro' },
        { value: 'grok-420-non-reasoning', name: 'xAI/Grok 4.20 (Non-Reasoning)' },
        { value: 'grok-420-reasoning', name: 'xAI/Grok 4.20 (Reasoning)' },
        { value: 'grok-43', name: 'xAI/Grok 4.3' },
        { value: 'big-pickle', name: 'OpenCode Zen/Big Pickle' }
      ])
    ]

    render(
      <TooltipProvider>
        <ChatInputBar
          session={s}
          busy={false}
          disabled={false}
          onSend={vi.fn()}
          onSendBlocks={vi.fn()}
          onCancel={vi.fn()}
          commands={[]}
          configOptions={configOptions}
          modes={s.modes}
          onSetConfig={mockSetConfig}
          onSetMode={mockSetMode}
          onSetModel={mockSetModel}
        />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI/GPT-5.4 mini Fast' }))

    expect(screen.getByLabelText('Search models')).toBeInTheDocument()
    expect(screen.getByTestId('config-chip-model-options')).toHaveClass(
      'max-h-[180px]',
      'overflow-y-auto'
    )

    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'grok 4.3' } })

    expect(screen.getByText('xAI/Grok 4.3')).toBeInTheDocument()
    expect(screen.queryByText('OpenAI/GPT-5.5 Pro')).not.toBeInTheDocument()
    clickMenuOption('xAI/Grok 4.3')
    expect(mockSetConfig).toHaveBeenCalledWith('model', 'grok-43')
  })

  it('uses native ACP session models when configOptions has no model option', async () => {
    const s = session()
    s.models = {
      currentModelId: 'kiro/claude-opus-4-8',
      availableModels: [
        { modelId: 'kiro/claude-opus-4-8', name: 'kiro/Claude Opus 4.8' },
        { modelId: 'openrouter/gpt-5.5', name: 'OpenRouter/GPT-5.5' }
      ]
    }

    render(
      <TooltipProvider>
        <ChatInputBar
          session={s}
          busy={false}
          disabled={false}
          onSend={vi.fn()}
          onSendBlocks={vi.fn()}
          onCancel={vi.fn()}
          commands={[]}
          configOptions={[]}
          modes={s.modes}
          onSetConfig={mockSetConfig}
          onSetMode={mockSetMode}
          onSetModel={mockSetModel}
        />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'kiro/Claude Opus 4.8' }))
    clickMenuOption('OpenRouter/GPT-5.5')

    expect(mockSetModel).toHaveBeenCalledWith('openrouter/gpt-5.5')
    expect(mockSetConfig).not.toHaveBeenCalled()
  })
})

describe('ChatInputBar MCP badge (Story 1.8)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMcpCount.current = 0
  })

  it('hides the MCP badge when no MCP servers are configured', () => {
    mockMcpCount.current = 0
    renderInputBar()
    // The badge returns null at count 0 — no "MCP servers attached" text.
    expect(screen.queryByText(/MCP servers attached/i)).not.toBeInTheDocument()
  })

  it('renders the MCP badge with the count when MCP servers are configured', () => {
    mockMcpCount.current = 2
    renderInputBar()
    // The badge pill shows the count + the sr-only label.
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText(/MCP servers attached/i)).toBeInTheDocument()
  })

  it('prefers the switched session MCP count over the global registry', () => {
    mockMcpCount.current = 5
    renderInputBar({ session: { ...session(), mcpServerCount: 2 } })
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.queryByText('5')).not.toBeInTheDocument()
  })
})

function renderInputBar(props: Partial<ComponentProps<typeof ChatInputBar>> = {}) {
  const s = session()
  return render(
    <TooltipProvider>
      <ChatInputBar
        session={s}
        busy={false}
        disabled={false}
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

describe('ChatInputBar file mentions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadDir.mockImplementation(async (path: string) => {
      if (path === '/work') return [{ name: 'src', isDirectory: true }]
      if (path === '/work/src') return [{ name: 'auth.ts', isDirectory: false }]
      return []
    })
  })

  it('stages a selected @ file and sends it as a resource link block', async () => {
    const onSendBlocks = vi.fn()
    renderInputBar({ onSendBlocks })

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'fix @auth' } })

    const option = await screen.findByRole('option', { name: /auth\.ts/ })
    fireEvent.mouseDown(option)

    expect(textarea).toHaveValue('fix ')
    expect(screen.getByText('auth.ts')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(onSendBlocks).toHaveBeenCalledWith([
        { type: 'text', text: 'fix' },
        {
          type: 'resource_link',
          uri: 'file:///work/src/auth.ts',
          name: 'auth.ts',
          mimeType: 'text/typescript'
        }
      ])
    })
  })
})

describe('ChatInputBar morph button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows a single stop button while busy with an empty composer', () => {
    renderInputBar({ busy: true })

    expect(screen.getByRole('button', { name: 'Cancel turn' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Queue message' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument()
  })

  it('morphs to a single queue send button when the user types during a turn', async () => {
    renderInputBar({ busy: true })

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'follow up' } })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Queue message' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Cancel turn' })).not.toBeInTheDocument()
    })
  })

  it('accepts a drop whose file is exposed only through dataTransfer.items', async () => {
    renderInputBar({ imageCapable: true })
    const file = new File(['screenshot'], 'screenshot.png', { type: 'image/png' })
    const dataTransfer = {
      files: [] as unknown as FileList,
      items: [{ kind: 'file', getAsFile: () => file }]
    } as unknown as DataTransfer

    fireEvent.drop(screen.getByRole('textbox'), { dataTransfer })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'screenshot.png' })).toBeInTheDocument()
    })
  })
})

describe('ChatInputBar command chip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function selectSlashOption(name: string | RegExp): void {
    const listbox = screen.getByRole('listbox')
    fireEvent.mouseDown(within(listbox).getByText(name))
  }

  it('renders a command chip when a slash command is selected from the menu', async () => {
    const commands = [{ name: 'compact', description: 'Compact the conversation' }]
    renderInputBar({ commands })

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/' } })

    // Menu should open as a listbox
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    // Select the command
    selectSlashOption('/compact')

    // Command chip should appear
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove /compact command' })).toBeInTheDocument()
    })

    // Textarea should be cleared
    expect(textarea).toHaveValue('')
  })

  it('prepends the command to the prompt on send', async () => {
    const onSend = vi.fn()
    const commands = [{ name: 'compact', description: 'Compact' }]
    renderInputBar({ commands, onSend })

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/' } })

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    selectSlashOption('/compact')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove /compact command' })).toBeInTheDocument()
    })

    // Type a message
    fireEvent.change(textarea, { target: { value: 'hello' } })

    // Send
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('/compact hello')
    })
  })

  it('removes the command chip when the X button is clicked', async () => {
    const commands = [{ name: 'compact', description: 'Compact' }]
    renderInputBar({ commands })

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/' } })

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    selectSlashOption('/compact')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove /compact command' })).toBeInTheDocument()
    })

    // Click remove
    fireEvent.click(screen.getByRole('button', { name: 'Remove /compact command' }))

    // Chip should be gone
    expect(
      screen.queryByRole('button', { name: 'Remove /compact command' })
    ).not.toBeInTheDocument()
  })

  it('opens the slash menu when / is typed with an active command chip', async () => {
    const commands = [
      { name: 'compact', description: 'Compact' },
      { name: 'clear', description: 'Clear' }
    ]
    renderInputBar({ commands })

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/' } })

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    selectSlashOption('/compact')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove /compact command' })).toBeInTheDocument()
    })

    // Type / again to re-open the menu
    fireEvent.change(textarea, { target: { value: '/' } })

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })
  })

  it('updates the command chip when a different command is selected', async () => {
    const commands = [
      { name: 'compact', description: 'Compact' },
      { name: 'clear', description: 'Clear' }
    ]
    renderInputBar({ commands })

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/' } })

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    selectSlashOption('/compact')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove /compact command' })).toBeInTheDocument()
    })

    // Type / again to re-open the menu
    fireEvent.change(textarea, { target: { value: '/' } })

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    // Select a different command
    selectSlashOption('/clear')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove /clear command' })).toBeInTheDocument()
    })
    expect(
      screen.queryByRole('button', { name: 'Remove /compact command' })
    ).not.toBeInTheDocument()
  })

  it('sends just the command when no message is typed', async () => {
    const onSend = vi.fn()
    const commands = [{ name: 'compact', description: 'Compact' }]
    renderInputBar({ commands, onSend })

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/' } })

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    selectSlashOption('/compact')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove /compact command' })).toBeInTheDocument()
    })

    // Send with just the command chip (no text)
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('/compact')
    })
  })

  it('clears active command when externally seeded text is applied', async () => {
    const onSend = vi.fn()
    const commands = [{ name: 'compact', description: 'Compact' }]
    const { rerender } = renderInputBar({ commands, onSend })

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/' } })

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    selectSlashOption('/compact')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove /compact command' })).toBeInTheDocument()
    })

    // Externally seed text (e.g. editing a message)
    rerender(
      <TooltipProvider>
        <ChatInputBar
          session={session()}
          busy={false}
          disabled={false}
          onSend={onSend}
          onSendBlocks={vi.fn()}
          onCancel={vi.fn()}
          commands={commands}
          configOptions={[]}
          modes={session().modes}
          onSetConfig={mockSetConfig}
          onSetMode={mockSetMode}
          onSetModel={mockSetModel}
          seedText="edited message"
          seedNonce={1}
        />
      </TooltipProvider>
    )

    // Command chip should be gone after seeding
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Remove /compact command' })
      ).not.toBeInTheDocument()
    })

    // Textarea should have the seeded text
    expect(screen.getByRole('textbox')).toHaveValue('edited message')

    // Send should use only the seeded text (no command prefix)
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('edited message')
    })
  })

  it('opens the slash menu at a mid-text slash (canonical any-position trigger)', async () => {
    const commands = [{ name: 'compact', description: 'Compact' }]
    renderInputBar({ commands })

    const textarea = screen.getByRole('textbox')
    // Type text before the slash so the trigger is mid-text, not leading.
    // This is the canonical behavior the AgentLauncher was drifting from
    // (it used the leading-only `isSlashTrigger`).
    fireEvent.change(textarea, { target: { value: 'hello /' } })

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })
  })
})

describe('ChatInputBar draft persistence', () => {
  beforeEach(() => {
    persistenceStore.clear()
    fakePersistenceApi.readFails = false
  })

  it('restores an unsent draft into the composer on mount', async () => {
    persistenceStore.set('chat-draft/p1/session-1', 'half-typed message')
    renderInputBar()
    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue('half-typed message')
    })
  })

  it('clears the draft on send', async () => {
    persistenceStore.set('chat-draft/p1/session-1', 'send me')
    const onSend = vi.fn()
    renderInputBar({ onSend })

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue('send me')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('send me')
      // The composer emptied (clear-on-send) → the persisted draft was deleted.
      expect(persistenceStore.has('chat-draft/p1/session-1')).toBe(false)
    })
  })

  it('does not crash when storage is empty', () => {
    // No draft persisted → empty composer, current behavior, no throw.
    renderInputBar()
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('does not crash when storage is unavailable', async () => {
    fakePersistenceApi.readFails = true
    renderInputBar()
    // read returns a non-throwing failure → degrade to empty, no crash.
    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue('')
    })
  })

  it('does not persist the seeded text as a draft while editing a message', async () => {
    vi.useFakeTimers()
    try {
      renderInputBar({ seedText: 'edited message', seedNonce: 1 })
      // Advance well past the 400ms debounce — seeding must never schedule a
      // draft write (the write effect early-returns while seedNonce is set).
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(400)
      expect(fakePersistenceApi.writeDebounced).not.toHaveBeenCalled()
      expect(persistenceStore.has('chat-draft/p1/session-1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists typed text via writeDebounced after the 400ms debounce', async () => {
    vi.useFakeTimers()
    try {
      renderInputBar()
      // Flush the hydrate read so hydratedRef flips true before typing.
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      const textarea = screen.getByRole('textbox')
      fireEvent.change(textarea, { target: { value: 'typed draft' } })

      fakePersistenceApi.writeDebounced.mockClear()
      await vi.advanceTimersByTimeAsync(400)
      expect(fakePersistenceApi.writeDebounced).toHaveBeenCalledWith(
        'chat-draft/p1/session-1',
        'typed draft'
      )
      expect(persistenceStore.get('chat-draft/p1/session-1')).toBe('typed draft')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ChatInputBar skill chips (inline tokens)', () => {
  const SKILL_GIT = {
    name: 'git-worktree',
    description: 'Isolated worktree',
    scope: 'project',
    path: '/home/u/.agents/skills/git-worktree/SKILL.md'
  }
  const SKILL_REVIEW = {
    name: 'release-version',
    description: 'Cut a release',
    scope: 'global',
    path: '/home/u/.agents/skills/release-version/SKILL.md'
  }

  function selectSlashOption(name: string | RegExp): void {
    const listbox = screen.getByRole('listbox')
    fireEvent.mouseDown(within(listbox).getByText(name))
  }

  /** The transparent-textarea overlay renders the chip name as a visible span;
   *  `findByText` already retries until the overlay paints, so await it
   *  directly (no `waitFor(expect(...))` wrapper needed). */
  async function findChip(name: string): Promise<HTMLElement> {
    return screen.findByText(name, { ignore: 'option' })
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('splices a skill token inline at the caret when a skill is picked mid-sentence', async () => {
    mockSkills.current = [SKILL_GIT]
    renderInputBar()

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'use this skill /' } })
    // Move the caret to the end so the slash trigger matches the trailing `/`.
    fireEvent.keyUp(textarea, { key: 'ArrowRight' })

    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    selectSlashOption('/git-worktree')

    // The `/` filter text is removed and a token is spliced inline; the
    // transparent-textarea overlay renders the chip name as a visible span.
    await findChip('git-worktree')
    // The textarea value now carries the token (filter text removed).
    expect(textarea).toHaveValue(`use this skill ${T('git-worktree')} `)
  })

  it('renders two inline chips when two distinct skills are picked at their positions', async () => {
    mockSkills.current = [SKILL_GIT, SKILL_REVIEW]
    renderInputBar()

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'use this /' } })
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    selectSlashOption('/git-worktree')

    await findChip('git-worktree')

    // Re-open the menu after the chip + trailing space, then pick a second skill.
    fireEvent.change(textarea, { target: { value: `${T('git-worktree')} then do /` } })
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    selectSlashOption('/release-version')

    await findChip('release-version')
    // Both chips are present; the value carries two tokens.
    expect(textarea).toHaveValue(`${T('git-worktree')} then do ${T('release-version')} `)
  })

  it('allows the same skill inline at multiple positions (no dedupe of tokens)', async () => {
    mockSkills.current = [SKILL_GIT]
    renderInputBar()

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'first /' } })
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    selectSlashOption('/git-worktree')

    await findChip('git-worktree')

    // Pick the same skill again — the second pick splices a second token (the
    // wire header dedupes by name, but inline positions are preserved).
    fireEvent.change(textarea, { target: { value: `${T('git-worktree')} again /` } })
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    selectSlashOption('/git-worktree')

    await waitFor(() =>
      expect(textarea).toHaveValue(`${T('git-worktree')} again ${T('git-worktree')} `)
    )
  })

  it('removes a whole chip token on Backspace when the caret is immediately after it', async () => {
    mockSkills.current = [SKILL_GIT]
    renderInputBar()

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'use this /' } })
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    selectSlashOption('/git-worktree')

    await findChip('git-worktree')
    const valueWithToken = `use this ${T('git-worktree')} `
    expect(textarea).toHaveValue(valueWithToken)

    // Place the caret right after the trailing space (the splicer's position).
    const caret = valueWithToken.length
    fireEvent.select(textarea, {
      target: { selectionStart: caret, selectionEnd: caret }
    })
    fireEvent.keyDown(textarea, { key: 'Backspace' })

    // The whole chip token + the trailing space are removed; the preceding text
    // ("use this ") stays and the caret lands at the end of it.
    await waitFor(() => expect(textarea).toHaveValue('use this '))
  })

  it('falls through to the default one-char backspace when the caret is in plain text', async () => {
    mockSkills.current = [SKILL_GIT]
    renderInputBar()

    const textarea = screen.getByRole('textbox')
    // Plain text, no tokens; caret at the end.
    fireEvent.change(textarea, { target: { value: 'hello world' } })
    const caret = 'hello world'.length
    fireEvent.select(textarea, { target: { selectionStart: caret, selectionEnd: caret } })

    fireEvent.keyDown(textarea, { key: 'Backspace' })
    // Default backspace is NOT preventDefault'd here (the browser would delete
    // one char); the React handler returns without mutating the value. The
    // textarea value is unchanged by our handler — the DOM input event would
    // do the actual deletion, which fireEvent.keyDown does not simulate.
    expect(textarea).toHaveValue('hello world')
  })

  it('emits display (token) + wire (path-framed) blocks on send, then clears the token', async () => {
    const onSendBlocks = vi.fn()
    mockSkills.current = [SKILL_GIT]
    renderInputBar({ onSendBlocks })

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'use this /' } })
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    selectSlashOption('/git-worktree')

    await findChip('git-worktree')
    // Type after the chip + trailing space.
    fireEvent.change(textarea, {
      target: { value: `${T('git-worktree')} and then` }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    const wireText = `# Agent Skills\n\ngit-worktree: /home/u/.agents/skills/git-worktree/SKILL.md\n\n---\n\n(git-worktree) and then`
    const displayText = `${T('git-worktree')} and then`
    await waitFor(() =>
      expect(onSendBlocks).toHaveBeenCalledWith(
        [{ type: 'text', text: wireText }],
        [{ type: 'text', text: displayText }]
      )
    )
    // Wire never carries a bare `/git-worktree` command token — only the cited
    // skills/git-worktree/SKILL.md path (preceded by `s`, not whitespace) and
    // the inline `(git-worktree)` replacement. Whitespace-bounded so the path
    // isn't mistaken for a command.
    expect(onSendBlocks.mock.calls[0]![0][0]!.text).not.toMatch(/(^|\s)\/git-worktree(?=\s|$)/)
    // The token is cleared after send.
    await waitFor(() => expect(textarea).toHaveValue(''))
  })

  it('blocks send and toasts when a selected skill has no path (web parity gap)', async () => {
    const onSendBlocks = vi.fn()
    const onSend = vi.fn()
    // A skill surfaced without a path (e.g. a future web skill with no parity
    // route) — the renderer Block If halts the send with a clear error.
    mockSkills.current = [{ name: 'pathless', description: 'no path', scope: 'project', path: '' }]
    renderInputBar({ onSendBlocks, onSend })

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'use this /' } })
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    selectSlashOption('/pathless')

    await findChip('pathless')
    fireEvent.change(textarea, { target: { value: `${T('pathless')} hi` } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    // The toast names the missing path; no message is sent.
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining('missing a path'))
    expect(onSend).not.toHaveBeenCalled()
    expect(onSendBlocks).not.toHaveBeenCalled()
  })

  it('shows no Skills section and no chips when no skills are available (web parity)', async () => {
    mockSkills.current = []
    renderInputBar()

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/' } })

    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    expect(screen.queryByText('Skills')).not.toBeInTheDocument()
  })

  it('re-renders inline chips when the composer is seeded with token text (edit a sent message)', async () => {
    // Editing a user message that carried skill tokens re-seeds the composer
    // with the raw token text; the transparent-textarea overlay must re-render
    // the chips inline (MessageActions.onEdit passes the token text verbatim).
    mockSkills.current = [SKILL_GIT]
    const seeded = `use this ${T('git-worktree')} then`
    const { rerender } = renderInputBar()

    rerender(
      <TooltipProvider>
        <ChatInputBar
          session={session()}
          busy={false}
          disabled={false}
          onSend={vi.fn()}
          onSendBlocks={vi.fn()}
          onCancel={vi.fn()}
          commands={[]}
          configOptions={[]}
          modes={session().modes}
          onSetConfig={mockSetConfig}
          onSetMode={mockSetMode}
          onSetModel={mockSetModel}
          seedText={seeded}
          seedNonce={1}
        />
      </TooltipProvider>
    )

    // The textarea value carries the tokens; the overlay re-renders the chip.
    await waitFor(() => expect(screen.getByText('git-worktree')).toBeInTheDocument())
    expect(screen.getByRole('textbox')).toHaveValue(seeded)
  })
})
