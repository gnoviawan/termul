import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { SessionConfigOption } from '@/lib/acp-api'
import { findBundledIconByKey } from '@/lib/agents/agent-icon-catalog'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { SKILL_PAD_DEFAULT } from '@/lib/composer/doc-to-prompt'
import { commandToken, fileToken, skillToken } from '@/lib/skill-tokens'
import { useProjectStore } from '@/stores/project-store'
import { ChatInputBar } from './ChatInputBar'
import {
  getComposerValue,
  pressComposerKey,
  setComposerCaret,
  setComposerValue
} from './composer/chat-composer-test-helpers'

// jsdom omits `document.elementFromPoint`. ProseMirror's native drop handler
// (`editHandlers.drop` → `view.posAtCoords`) calls it; without a stub the
// file-drop test throws an unhandled exception that fails the run even though
// the host's `onDrop` already staged the file. Returning `null` makes
// ProseMirror's drop handler a noop (coords resolve to nothing) — the host
// owns attachment staging either way.
if (typeof document.elementFromPoint !== 'function') {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => null,
    configurable: true,
    writable: true
  })
}

/** Padded token form — matches what `docToDisplayText` re-emits (pills carry the
 *  `\uE002<pad>\uE003` block for on-disk draft byte-stability) and what
 *  `handleSelect` splices (`insertSkillToken(..., SKILL_PAD_DEFAULT)`). Editor
 *  value assertions use this so they match the editor's serialized output. */
const PT = (name: string): string => skillToken(name, SKILL_PAD_DEFAULT)

function clickMenuOption(name: string | RegExp): void {
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByText(name))
}

const {
  mockSetConfig,
  mockSetMode,
  mockSetModel,
  mockMcpCount,
  mockSetMcpServerEnabled,
  mockLoadMcpTools,
  mockRespondPermission,
  mockSkills,
  mockToastError,
  mockIsTauri,
  mockStreamApi,
  // Story 4 (spec-in-chat-agent-switch): override-able store seams for the
  // in-chat agent switcher. Defaults mirror an idle live chat with a resolved
  // current agent and two switch targets.
  mockAgentConfigs,
  mockSwitching,
  mockSessionAgentId,
  mockArmAgentSwitch,
  mockCancelAgentSwitch,
  mockCancelPrompt,
  mockSaveAgentConfig,
  batchCb,
  doneCb
} = vi.hoisted(() => {
  const batch = { current: null as null | ((e: never) => void) }
  const done = { current: null as null | ((e: never) => void) }
  return {
    mockSetConfig: vi.fn(),
    mockSetMode: vi.fn(),
    mockSetModel: vi.fn(),
    // Story 1.8 review (verification-gap #8): override-able MCP server count for
    // the read-only badge. 0 by default (badge hidden); tests set it to render.
    mockMcpCount: { current: 0 },
    // Stable mocks for the chatbox popover's per-server toggle + probe actions
    // (introduced alongside the status/tools/chatbox-toggle work). Reused across
    // renders so call assertions hold.
    mockSetMcpServerEnabled: vi.fn(async () => {}),
    mockLoadMcpTools: vi.fn(async () => {}),
    mockRespondPermission: vi.fn(async () => {}),
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
    mockToastError: vi.fn(),
    // Desktop/web gate for the @-mention stream. Defaults to false (web parity);
    // the file-mentions describe flips it true to exercise the ripgrep stream.
    mockIsTauri: vi.fn(() => false),
    // Streaming filename-search stubs (mirror use-composer-mentions.test.tsx).
    // Callbacks are captured into refs so tests can emit synthetic batches/done.
    batchCb: batch,
    doneCb: done,
    mockStreamApi: {
      searchFileNamesStreamStart: vi.fn(async () => ({ success: true as const })),
      searchFileNamesStreamCancel: vi.fn(async () => ({ success: true as const })),
      onSearchFileNamesBatch: vi.fn((cb: (e: never) => void) => {
        batch.current = cb
        return () => {
          batch.current = null
        }
      }),
      onSearchFileNamesDone: vi.fn((cb: (e: never) => void) => {
        done.current = cb
        return () => {
          done.current = null
        }
      })
    },
    // Story 4 (spec-in-chat-agent-switch): the in-chat switcher's store
    // seams. `mockAgentConfigs` seeds the store's persisted-config list;
    // `mockSwitching` seeds `session.switching` (armed state); the rest are
    // the arm/cancel/cancelPrompt/saveAgentConfig action spies.
    mockAgentConfigs: {
      current: [
        {
          id: 'acp-registry:cursor',
          configId: 'acp-registry:cursor',
          name: 'Cursor',
          command: 'cursor-agent',
          args: [],
          env: {},
          allowTerminal: false,
          templateId: 'cursor'
        },
        {
          id: 'acp-registry:claude-acp',
          configId: 'acp-registry:claude-acp',
          name: 'Claude Agent',
          command: 'claude',
          args: [],
          env: {},
          allowTerminal: false,
          templateId: 'claude-acp'
        }
      ] as StoredAgentConfig[]
    },
    mockSwitching: { current: null as { toConfigId: string; status: 'pending' } | null },
    // Override-able store session agent id (defaults to the live agent; the
    // empty-row test clears it).
    mockSessionAgentId: { current: 'agent-1' as string },
    mockArmAgentSwitch: vi.fn(async () => true),
    mockCancelAgentSwitch: vi.fn(),
    mockCancelPrompt: vi.fn(async () => {}),
    mockSaveAgentConfig: vi.fn(async () => {})
  }
})

vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: mockIsTauri }))

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

vi.mock('@/stores/acp-store', () => {
  // Story 4: the switcher's Cancel-then-switch path reads
  // `useAcpStore.getState`/`subscribe` (waitForTurnClear); build the mock as a
  // state object + selector fn with those attached, matching the real store's
  // callable-with-state API surface.
  const state = () => ({
    mcpServers: Array.from({ length: mockMcpCount.current }, (_, i) => ({
      id: `mcp-${i}`,
      type: 'stdio',
      name: `MCP ${i + 1}`,
      command: 'npx',
      enabled: true
    })),
    setMcpServerEnabled: mockSetMcpServerEnabled,
    mcpProbeStatus: {} as Record<string, string>,
    mcpProbeError: {} as Record<string, string | undefined>,
    mcpTools: {} as Record<string, unknown[]>,
    mcpToolsLoaded: {} as Record<string, boolean>,
    mcpProbing: {} as Record<string, boolean>,
    loadMcpTools: mockLoadMcpTools,
    respondPermission: mockRespondPermission,
    agentConfigs: mockAgentConfigs.current,
    saveAgentConfig: mockSaveAgentConfig,
    armAgentSwitch: mockArmAgentSwitch,
    cancelAgentSwitch: mockCancelAgentSwitch,
    cancelPrompt: mockCancelPrompt,
    sessions: {
      'session-1': {
        agentId: mockSessionAgentId.current,
        switching: mockSwitching.current
      }
    },
    configToLiveAgent: { 'acp-registry:cursor\0/work': 'agent-1' },
    sessionIndex: []
  })
  const listeners = new Set<() => void>()
  const useAcpStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state())
  useAcpStore.getState = state
  useAcpStore.subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return {
    // Armed-switch icon: the composer passes `session.switching.toConfigId`
    // so the glyph follows the TARGET while armed — mirror the real
    // selectors' configId-first precedence (acp-store useAgentTemplateId/
    // useAgentIcon).
    useAgentTemplateId: (_agentId: string | null, agentConfigId?: string) =>
      agentConfigId
        ? (mockAgentConfigs.current.find((c) => c.id === agentConfigId)?.templateId ?? 'cursor')
        : 'cursor',
    useAgentIcon: (_agentId: string | null, agentConfigId?: string) =>
      agentConfigId
        ? (mockAgentConfigs.current.find((c) => c.id === agentConfigId)?.icon ?? null)
        : null,
    useSessionUsage: () => null,
    useAcpMessages: () => [],
    // Story 1.8: ChatInputBar reads the global MCP server count for the
    // read-only MCP badge; Story 4 added the switcher's seams above
    // (agentConfigs/switching/arm/cancel/cancelPrompt/saveAgentConfig).
    useAcpStore
  }
})

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
  return {
    ...actual,
    persistenceApi: fakePersistenceApi,
    filesystemApi: { ...actual.filesystemApi, ...mockStreamApi }
  }
})

// Story 4 (spec-in-chat-agent-switch): the composer's agent control resolves
// entries through `useResolvedSupportedAcpAgents` (host catalog) and installs
// through `acpApi.installAcpAgent`. Both are mocked so the picker tests stay
// hermetic and can drive the install-then-arm flow synchronously.
const { mockResolvedAgents, mockInstallAcpAgent } = vi.hoisted(() => ({
  // Override-able resolved-entry list; defaults to null → the real
  // buildSupportedAcpAgents derivation over the mock persisted configs.
  mockResolvedAgents: { current: null as null | readonly SupportedAcpAgentEntry[] },
  mockInstallAcpAgent: vi.fn(async () => ({ command: 'claude', args: ['acp'] }))
}))

vi.mock('@/hooks/use-resolved-supported-acp-agents', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agents/supported-acp-agents')>(
    '@/lib/agents/supported-acp-agents'
  )
  return {
    useResolvedSupportedAcpAgents: (configs: readonly StoredAgentConfig[]) =>
      mockResolvedAgents.current ?? actual.buildSupportedAcpAgents(configs, 'linux-x86_64')
  }
})

vi.mock('@/lib/acp-api', () => ({
  acpApi: {
    installAcpAgent: mockInstallAcpAgent
  }
}))

beforeEach(() => {
  persistenceStore.clear()
  fakePersistenceApi.readFails = false
  // Start each test from a clean skill slate (web/no-skills default). Skill
  // tests override mockSkills.current.
  mockSkills.current = []
})

// Destroy lingering Tiptap/ProseMirror editors after each test. React's
// `useEditor` cleanup destroys the editor on unmount, but ProseMirror's
// `EditorView` can leave dangling `MutationObserver`/rAF callbacks in jsdom;
// destroying explicitly (via the test-only `__composerEditor` handle) is a
// best-effort release before the next test mounts a fresh editor. The handle
// is gone after React unmounts, so this is a no-op when cleanup already ran —
// it mainly guards against a half-mounted editor surviving into the next test.
afterEach(() => {
  const els = document.querySelectorAll('[data-composer-editor="true"]')
  for (const el of Array.from(els)) {
    const handle = el as HTMLElement & {
      __composerEditor?: { destroy?: () => void; isDestroyed?: boolean } | null
    }
    const editor = handle.__composerEditor
    if (editor && typeof editor.destroy === 'function' && !editor.isDestroyed) {
      editor.destroy()
    }
  }
  cleanup()
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

  it('renders worktree context below the composer without keyboard helper text', () => {
    renderInputBar({
      session: {
        ...session(),
        cwd: '/work/.termul/worktrees/abcd1234',
        worktreePath: '/work/.termul/worktrees/abcd1234',
        worktreeBranch: 'chat/abcd1234'
      }
    })

    const composer = document.querySelector('[data-chat-composer="true"]')
    const contextStrip = document.querySelector('[data-chat-composer-context-strip="true"]')

    expect(composer).toBeInTheDocument()
    expect(contextStrip).toBeInTheDocument()
    expect(composer).not.toContainElement(contextStrip)
    expect(screen.getByText('Worktree')).toBeInTheDocument()
    expect(screen.getByText('chat/abcd1234')).toBeInTheDocument()
    expect(screen.queryByText(/Shift\+Enter/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/to send|to queue|newline/i)).not.toBeInTheDocument()
  })

  describe('local context strip', () => {
    const initialProjects = useProjectStore.getState().projects
    afterEach(() => {
      useProjectStore.setState({ projects: initialProjects })
    })

    function seedProject(fields: { gitBranch?: string; isGitRepo?: boolean }): void {
      useProjectStore.setState({
        projects: [{ id: 'p1', name: 'Project', color: 'blue', path: '/work', ...fields }]
      })
    }

    it('shows the project branch in Local mode', () => {
      seedProject({ gitBranch: 'main', isGitRepo: true })
      renderInputBar()

      expect(screen.getByText('Local')).toBeInTheDocument()
      expect(screen.getByText('main')).toBeInTheDocument()
    })

    it('shows Detached HEAD when a git project has no branch', () => {
      seedProject({ isGitRepo: true })
      renderInputBar()

      expect(screen.getByText('Detached HEAD')).toBeInTheDocument()
    })

    it('shows no branch for a project that is not a git repo', () => {
      seedProject({ isGitRepo: false })
      renderInputBar()

      expect(screen.getByText('Local')).toBeInTheDocument()
      expect(screen.queryByText('Detached HEAD')).not.toBeInTheDocument()
    })
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

    const modelPill = screen.getByRole('button', { name: /composer-2\.5/ })
    expect(modelPill.querySelector('svg')).toBeTruthy()

    fireEvent.click(modelPill)
    fireEvent.click(screen.getByRole('button', { name: /^Model,/ }))
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

    fireEvent.click(screen.getByRole('button', { name: /OpenAI\/GPT-5\.4 mini Fast/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Model,/ }))

    expect(screen.getByLabelText('Search models')).toBeInTheDocument()
    expect(screen.getByTestId('config-chip-model-options')).toHaveClass(
      'max-h-64',
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

    fireEvent.click(screen.getByRole('button', { name: /kiro\/Claude Opus 4\.8/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Model,/ }))
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

  it('hides the compact MCP icon when no MCP servers are configured', () => {
    mockMcpCount.current = 0
    renderInputBar()
    expect(screen.queryByRole('img', { name: /MCP servers/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/MCP servers attached/i)).not.toBeInTheDocument()
  })

  it('renders the MCP badge with the count when MCP servers are configured', () => {
    mockMcpCount.current = 2
    renderInputBar()
    // The badge is now an icon-only popover trigger (#643): the count lives
    // only in the trigger's aria-label — no bare text node.
    expect(
      screen.getByRole('button', {
        name: 'MCP servers — 2 attached. Click to manage per-server enable/disable.'
      })
    ).toBeInTheDocument()
  })

  it('prefers the switched session MCP count over the global registry', () => {
    mockMcpCount.current = 5
    renderInputBar({ session: { ...session(), mcpServerCount: 2 } })
    // The session-scoped count (2) wins over the global registry (5); the
    // trigger's aria-label carries the session count.
    expect(
      screen.getByRole('button', {
        name: 'MCP servers — 2 attached. Click to manage per-server enable/disable.'
      })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: 'MCP servers — 5 attached. Click to manage per-server enable/disable.'
      })
    ).not.toBeInTheDocument()
  })
})

describe('ChatInputBar agent switch chip (Story 4, spec-in-chat-agent-switch)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSwitching.current = null
    mockResolvedAgents.current = null
    mockSessionAgentId.current = 'agent-1'
  })

  it('renders the agent switch control in the right chip cluster', async () => {
    renderInputBar()
    // The trigger joins the toolbar's right cluster and shows the current
    // agent (resolved via the mock store's reuse-key map → Cursor config).
    const trigger = await screen.findByRole('button', {
      name: /Switch agent\. Currently Cursor/
    })
    expect(trigger).toHaveTextContent('Cursor')
    // It lives inside the composer toolbar (the modelChip/agentModeChip family).
    expect(trigger.closest('[data-composer-toolbar]')).not.toBeNull()
  })

  it('opens the provider list from the combined pill when the session has no model', async () => {
    renderInputBar()
    const trigger = await screen.findByRole('button', {
      name: /Switch agent\. Currently Cursor/
    })
    fireEvent.click(trigger)
    expect(await screen.findByLabelText('Search agents to switch to')).toBeInTheDocument()
  })

  it('shows the armed target on the chip while session.switching is set', async () => {
    mockSwitching.current = { toConfigId: 'acp-registry:claude-acp', status: 'pending' }
    renderInputBar()

    const trigger = await screen.findByRole('button', {
      name: /Switch to Claude Agent on next send/
    })
    expect(trigger).toHaveTextContent('→ Claude Agent')
    expect(screen.getByTestId('agent-switch-cancel')).toBeInTheDocument()
  })

  it('model chip glyph follows the armed TARGET config, not the live agent (armed-icon regression)', async () => {
    // Regression for the "Devin icon on an OpenCode model list" report: while
    // `session.switching` is armed the composer's option chips are the
    // target's launcher — the glyph must resolve `switching.toConfigId` →
    // that config's templateId, not `session.agentId` → the source agent.
    mockSwitching.current = { toConfigId: 'acp-registry:claude-acp', status: 'pending' }
    const s = {
      ...session(),
      models: {
        currentModelId: 'm1',
        availableModels: [
          { modelId: 'm1', name: 'Model One' },
          { modelId: 'm2', name: 'Model Two' }
        ]
      }
    }
    const { container } = renderInputBar({ session: s })

    // The model chip's leading AgentGlyph carries the armed target's
    // templateId → its bundled `acp:claude-acp` catalog icon, never the
    // source session's `acp:cursor`.
    const modelChip = await screen.findByRole('button', { name: /Model One/ })
    const glyphSvg = modelChip.querySelector('svg')
    expect(glyphSvg).not.toBeNull()
    expect(container.innerHTML).not.toContain('devin.svg')
    // The armed target (claude-acp) has a bundled icon distinct from the
    // source (cursor); whichever SVG rendered, it must be the claude one —
    // assert via the catalog's own fetch so the check survives icon edits.
    const claudeSvg = findBundledIconByKey('acp:claude-acp')?.svg ?? ''
    const cursorSvg = findBundledIconByKey('acp:cursor')?.svg ?? ''
    expect(claudeSvg.length).toBeGreaterThan(0)
    expect(modelChip.innerHTML).toContain('svg')
    // Claude's SVG must be the one painted inside the chip.
    const claudePathSig = claudeSvg.match(/d="([^"]{20,60})/)?.[1]
    expect(claudePathSig).toBeTruthy()
    expect(modelChip.innerHTML).toContain(claudePathSig)
    const cursorPathSig = cursorSvg.match(/d="([^"]{20,60})/)?.[1]
    if (cursorPathSig) expect(modelChip.innerHTML).not.toContain(cursorPathSig)
  })

  it('disables the agent switch control for a closed session (chips disabled pattern)', async () => {
    renderInputBar({ disabled: true })
    const trigger = await screen.findByRole('button', {
      name: /Switch agent\. Currently Cursor/
    })
    expect(trigger).toBeDisabled()
  })

  it('cancel affordance clears the armed switch', async () => {
    mockSwitching.current = { toConfigId: 'acp-registry:claude-acp', status: 'pending' }
    renderInputBar()

    await screen.findByRole('button', { name: /Switch to Claude Agent on next send/ })
    fireEvent.click(screen.getByTestId('agent-switch-cancel'))
    expect(mockCancelAgentSwitch).toHaveBeenCalledWith('session-1')
  })

  it('keeps the agent control row when no modes and no model chip exist (narrow-mode presence regression)', async () => {
    // The exact regression: modes=none AND model=none AND no config options.
    // Row 1 must still mount for the agent control — keyed on the session's
    // live agent id (cheap, non-circular), NOT on a presence flag only the
    // mounted picker could set true (that circularity hid the chip forever).
    const s = { ...session(), modes: null, models: null }
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
          modes={null}
          onSetConfig={mockSetConfig}
          onSetMode={mockSetMode}
          onSetModel={mockSetModel}
        />
      </TooltipProvider>
    )

    // The switch control renders inside a chip-row container (row 1 in
    // narrow mode / the single row in wide mode — jsdom defaults to wide,
    // which was ALSO susceptible via the removed dead guard).
    const trigger = await screen.findByRole('button', {
      name: /Switch agent\. Currently Cursor/
    })
    const row = trigger.closest('[data-composer-toolbar-row]')
    expect(row).not.toBeNull()
    expect(row?.querySelector('[data-testid="agent-model-selector-trigger"]')).not.toBeNull()
  })

  it('renders no chip row when the store session has no agent and no modes/model exist', async () => {
    // The store's session record lacks an agent id (cold placeholder) — the
    // picker nulls itself and row 1 has no content, so no empty container
    // renders.
    mockSessionAgentId.current = ''
    const s = { ...session(), agentId: '', modes: null, models: null }
    const { container } = render(
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
          modes={null}
          onSetConfig={mockSetConfig}
          onSetMode={mockSetMode}
          onSetModel={mockSetModel}
        />
      </TooltipProvider>
    )
    // Wait out the async draft hydration, then assert no trigger and no
    // chip-row container rendered for it.
    await act(async () => {})
    expect(container.querySelector('[data-testid="agent-switch-trigger"]')).toBeNull()
    expect(container.querySelector('[data-composer-toolbar-row]')).toBeNull()
  })

  it('no presence callback crash when the control unmounts (cleanup leg)', () => {
    const { unmount } = renderInputBar()
    expect(() => unmount()).not.toThrow()
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

describe('ChatInputBar placeholder', () => {
  it('prompts for commands and file mentions in the empty editor', async () => {
    renderInputBar()

    await waitFor(() => {
      expect(document.querySelector('[data-composer-editor="true"] p')).toHaveAttribute(
        'data-placeholder',
        'Ask anything… (/ for commands, @ for files)'
      )
    })
  })
})

describe('ChatInputBar permission approval', () => {
  const permission: PendingPermission = {
    requestId: 'permission-1',
    agentId: 'agent-1',
    sessionId: 'session-1',
    toolCall: { title: 'Approve Spec' },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Decline', kind: 'reject_once' }
    ]
  }

  beforeEach(() => {
    mockRespondPermission.mockClear()
  })

  it('keeps the request visible in the composer when the user clicks outside it', () => {
    const { container } = renderInputBar({ permission })
    const prompt = screen.getByTestId('permission-prompt')
    const composer = container.querySelector('[data-chat-composer="true"]')

    expect(composer).toContainElement(prompt)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(document.body)

    expect(screen.getByTestId('permission-prompt')).toBeInTheDocument()
    expect(mockRespondPermission).not.toHaveBeenCalled()
  })

  it('sends the selected option back to the agent', async () => {
    renderInputBar({ permission })

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))

    await waitFor(() => {
      expect(mockRespondPermission).toHaveBeenCalledWith('permission-1', 'allow-once')
    })
  })

  it('keeps an explicit cancel action when the agent offers no choices', async () => {
    renderInputBar({ permission: { ...permission, options: [] } })

    expect(
      screen.getByText(
        'The agent provided no choices. Cancel the request to keep this action blocked.'
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }))

    await waitFor(() => {
      expect(mockRespondPermission).toHaveBeenCalledWith('permission-1', undefined)
    })
  })
})

describe('ChatInputBar file mentions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockIsTauri.mockReturnValue(true)
    mockStreamApi.searchFileNamesStreamStart.mockResolvedValue({ success: true as const })
    mockStreamApi.searchFileNamesStreamCancel.mockResolvedValue({ success: true as const })
    mockStreamApi.onSearchFileNamesBatch.mockClear()
    mockStreamApi.onSearchFileNamesDone.mockClear()
    batchCb.current = null
    doneCb.current = null
  })

  afterEach(() => {
    vi.useRealTimers()
    mockIsTauri.mockReturnValue(false)
  })

  /** Drive the ripgrep stream: advance the debounce, emit a batch + done. */
  async function driveStream(files: Array<{ path: string; ignored: boolean }>): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90)
    })
    const batch = batchCb.current as unknown as
      | ((e: {
          searchId: string
          files: Array<{ path: string; ignored: boolean }>
          truncated?: boolean
        }) => void)
      | null
    const sid = mockStreamApi.searchFileNamesStreamStart.mock.calls[0]?.[0] as string
    batch?.({ searchId: sid, files })
    const done = doneCb.current as unknown as
      | ((e: {
          searchId: string
          truncated: boolean
          totalFiles: number
          code?: string
          error?: string
        }) => void)
      | null
    done?.({ searchId: sid, truncated: false, totalFiles: files.length })
    vi.useRealTimers()
    await act(async () => {})
  }

  it('renders an inline FileChip on @ file pick (not in the attachment bar)', async () => {
    renderInputBar()

    setComposerValue('fix @auth')
    await driveStream([{ path: 'src/auth.ts', ignored: false }])

    fireEvent.click(screen.getByRole('option', { name: /auth\.ts/ }))

    // The @filter text is removed and a file token is spliced IN at the caret.
    // The FileChip renders inline (the file pill's name span shows "auth.ts").
    await waitFor(() => expect(screen.getByText('auth.ts')).toBeInTheDocument())
    const value = getComposerValue()
    const ft = fileToken('auth.ts', '/work/src/auth.ts')
    expect(value).toBe(`fix ${ft} `)

    // NO entry in the attachment bar (the mention did not hoist to
    // AttachmentPreviewGroup — only drag/drop/paste/OS-picker files appear
    // there). The file exists only as an inline pill in the editor.
    const removeButtons = screen.queryAllByRole('button', { name: /Remove / })
    expect(removeButtons).toHaveLength(0)
  })

  it('sends the wire text + resource_link block on submit (display keeps tokens)', async () => {
    const onSendBlocks = vi.fn()
    renderInputBar({ onSendBlocks })

    setComposerValue('fix @auth')
    await driveStream([{ path: 'src/auth.ts', ignored: false }])
    fireEvent.click(screen.getByRole('option', { name: /auth\.ts/ }))
    await waitFor(() => expect(screen.getByText('auth.ts')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    const ft = fileToken('auth.ts', '/work/src/auth.ts')
    await waitFor(() => {
      // Wire: text with tokens replaced by (display) + resource_link block.
      expect(onSendBlocks).toHaveBeenCalledWith(
        [
          { type: 'text', text: 'fix (auth.ts)' },
          {
            type: 'resource_link',
            uri: 'file:///work/src/auth.ts',
            name: 'auth.ts',
            mimeType: 'text/typescript'
          }
        ],
        // Display: raw token text so the timeline renders an inline FileChip.
        [{ type: 'text', text: `fix ${ft} ` }]
      )
    })
    // The composer value is cleared after send.
    expect(getComposerValue()).toBe('')
  })

  it('dedupes the same file mentioned twice into one resource_link block', async () => {
    vi.useRealTimers()
    const onSendBlocks = vi.fn()
    renderInputBar({ onSendBlocks })

    // Splice two file tokens for the same path directly into the editor value.
    const ft = fileToken('auth.ts', '/work/src/auth.ts')
    setComposerValue(`${ft} and again ${ft} `)

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      const blocks = onSendBlocks.mock.calls[0]?.[0] as
        | Array<{
            type: string
            uri?: string
          }>
        | undefined
      expect(blocks).toBeDefined()
      const resourceLinks = blocks!.filter(
        (b) => b.type === 'resource_link' && b.uri === 'file:///work/src/auth.ts'
      )
      expect(resourceLinks).toHaveLength(1)
    })
  })

  it('renders a file pill + skill pill together (visually distinct)', async () => {
    vi.useRealTimers()
    mockSkills.current = [
      {
        name: 'git-worktree',
        description: 'Isolated worktree',
        scope: 'project',
        path: '/home/u/.agents/skills/git-worktree/SKILL.md'
      }
    ]
    renderInputBar()

    const st = skillToken('git-worktree', SKILL_PAD_DEFAULT)
    const ft = fileToken('auth.ts', '/work/src/auth.ts')
    setComposerValue(`use ${st} on ${ft} `)

    // Both pills render inline with their respective chip names.
    await waitFor(() => expect(screen.getByText('git-worktree')).toBeInTheDocument())
    expect(screen.getByText('auth.ts')).toBeInTheDocument()
    // The skill chip's Sparkles icon + the file chip's File icon both present.
    expect(document.querySelector('svg[data-termul-icon="Sparkles"]')).not.toBeNull()
    expect(document.querySelector('svg[data-termul-icon="File"]')).not.toBeNull()
  })

  it('backspace removes a whole file pill + trailing space', async () => {
    vi.useRealTimers()
    renderInputBar()
    // Wait for the Tiptap editor to mount (useEditor initializes in an effect).
    await waitFor(() =>
      expect(document.querySelector('[data-composer-editor="true"]')).not.toBeNull()
    )

    const ft = fileToken('auth.ts', '/work/src/auth.ts')
    setComposerValue(`fix ${ft} `)
    // Place the caret right after the trailing space.
    setComposerCaret(`fix ${ft} `.length)

    pressComposerKey('Backspace')

    // The whole file token + trailing space is removed; the value is "fix ".
    await waitFor(() => expect(getComposerValue()).toBe('fix '))
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

    setComposerValue('follow up')

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

  async function selectSlashOption(name: string | RegExp): Promise<void> {
    // Click in the same wait as the open check. The menu can close on the
    // next tick after the caret settles, so a later getByRole misses it.
    await waitFor(
      () => {
        const listbox = screen.getByRole('listbox')
        fireEvent.click(within(listbox).getByText(name))
      },
      { timeout: 5000 }
    )
  }

  it('renders an inline command pill when a slash command is selected from the menu', async () => {
    const commands = [{ name: 'compact', description: 'Compact the conversation' }]
    renderInputBar({ commands })

    setComposerValue('/')

    // Menu should open as a listbox
    // Select the command
    await selectSlashOption('/compact')

    // Command pill should render inline (the CommandPill NodeView renders the
    // SkillChip with name prefixed by `/` so the visible text is `/compact`).
    await waitFor(() => {
      expect(screen.getByText('/compact')).toBeInTheDocument()
    })
  })

  it('sends the command-prefixed wire with token display blocks on send', async () => {
    const onSendBlocks = vi.fn()
    const commands = [{ name: 'compact', description: 'Compact' }]
    renderInputBar({ commands, onSendBlocks })

    setComposerValue('/')

    await selectSlashOption('/compact')

    // Command pill renders inline.
    await waitFor(() => expect(screen.getByText('/compact')).toBeInTheDocument())

    // Append text after the pill + trailing space (the value carries the
    // command token, so we append to it — `setComposerValue` replaces the
    // whole value, losing the pill, so we build the full value with the token).
    setComposerValue(`${commandToken('compact')} hello`)

    // Send
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    // Wire: `/compact hello` (byte-identical to the plain-prefix path).
    // Display: the raw token text so the timeline renders the command chip.
    await waitFor(() => {
      expect(onSendBlocks).toHaveBeenCalledWith(
        [{ type: 'text', text: '/compact hello' }],
        [{ type: 'text', text: `${commandToken('compact')} hello` }]
      )
    })
  })

  it('removes the command pill on Backspace when the caret is immediately after it', async () => {
    const commands = [{ name: 'compact', description: 'Compact' }]
    renderInputBar({ commands })

    setComposerValue('/')

    await selectSlashOption('/compact')

    await waitFor(() => expect(screen.getByText('/compact')).toBeInTheDocument())

    // The value carries the command token + trailing space. Place the caret
    // after the trailing space + dispatch Backspace — the editor's keymap
    // removes the whole atom pill node.
    const valueWithToken = `${commandToken('compact')} `
    expect(getComposerValue()).toBe(valueWithToken)
    setComposerCaret(valueWithToken.length)
    pressComposerKey('Backspace')

    // The whole pill + trailing space are removed.
    await waitFor(() => {
      expect(screen.queryByText('/compact')).not.toBeInTheDocument()
    })
  })

  it('opens the slash menu when / is typed with an active command pill', async () => {
    const commands = [
      { name: 'compact', description: 'Compact' },
      { name: 'clear', description: 'Clear' }
    ]
    renderInputBar({ commands })

    setComposerValue('/')

    await selectSlashOption('/compact')

    await waitFor(() => expect(screen.getByText('/compact')).toBeInTheDocument())

    // Type / again to re-open the menu (the value carries the command token +
    // trailing space + the new `/`).
    setComposerValue(`${commandToken('compact')} /`)

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })
  })

  it('rejects a second command pick (single-command invariant)', async () => {
    const commands = [
      { name: 'compact', description: 'Compact' },
      { name: 'clear', description: 'Clear' }
    ]
    renderInputBar({ commands })

    setComposerValue('/')

    await selectSlashOption('/compact')

    await waitFor(() => expect(screen.getByText('/compact')).toBeInTheDocument())

    // Type / again to re-open the menu, then select a different command.
    setComposerValue(`${commandToken('compact')} /`)

    await selectSlashOption('/clear')

    // The second command is rejected — the single-command invariant keeps the
    // existing `/compact` pill. The `/clear` pill must NOT render (the
    // rejection is a no-op, not a replace). The slash menu may list `/compact`
    // as an option (filter matches), so we assert at least one `/compact`
    // element is present (the pill). And critically, the `/clear` pill must
    // NOT have been inserted — its text must not appear in the editor's pill
    // area. The menu still shows `/clear` as a listbox option, so we scope
    // the absence check to the editor's data-composer-editor subtree.
    await waitFor(() => {
      expect(screen.getAllByText('/compact').length).toBeGreaterThanOrEqual(1)
    })
    const editor = document.querySelector('[data-composer-editor="true"]')
    expect(editor).not.toBeNull()
    expect(
      editor!.querySelector('[data-command-pill="true"][data-command-name="clear"]')
    ).toBeNull()
    expect(
      editor!.querySelector('[data-command-pill="true"][data-command-name="compact"]')
    ).not.toBeNull()
  })

  it('sends just the command (token display) when no message is typed', async () => {
    const onSendBlocks = vi.fn()
    const commands = [{ name: 'compact', description: 'Compact' }]
    renderInputBar({ commands, onSendBlocks })

    setComposerValue('/')

    await selectSlashOption('/compact')

    await waitFor(() => expect(screen.getByText('/compact')).toBeInTheDocument())

    // Send with just the command pill (no text after it).
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(onSendBlocks).toHaveBeenCalledWith(
        [{ type: 'text', text: '/compact' }],
        [{ type: 'text', text: commandToken('compact') }]
      )
    })
  })

  it('splits display (token) from wire when a command pill is sent with an image attachment', async () => {
    const onSendBlocks = vi.fn()
    const commands = [{ name: 'compact', description: 'Compact' }]
    renderInputBar({ commands, onSendBlocks, imageCapable: true })

    // Stage an image attachment via drag-drop (the attachment-bar path).
    const file = new File(['screenshot'], 'screenshot.png', { type: 'image/png' })
    const dataTransfer = {
      files: [] as unknown as FileList,
      items: [{ kind: 'file', getAsFile: () => file }]
    } as unknown as DataTransfer
    fireEvent.drop(screen.getByRole('textbox'), { dataTransfer })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'screenshot.png' })).toBeInTheDocument()
    })

    setComposerValue('/')

    await selectSlashOption('/compact')

    await waitFor(() => expect(screen.getByText('/compact')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    // Wire: `/<name> ` prefix + the image block (byte-identical to the
    // pre-token plain-prefix path). Display: raw token text + the image
    // block so the timeline renders the command chip inline.
    const imageBlock = { type: 'image', mimeType: 'image/png', data: 'c2NyZWVuc2hvdA==' }
    await waitFor(() => {
      expect(onSendBlocks).toHaveBeenCalledWith(
        [{ type: 'text', text: '/compact ' }, imageBlock],
        [{ type: 'text', text: commandToken('compact') }, imageBlock]
      )
    })
  })

  it('clears the command pill when externally seeded text is applied', async () => {
    const onSend = vi.fn()
    const commands = [{ name: 'compact', description: 'Compact' }]
    const { rerender } = renderInputBar({ commands, onSend })

    setComposerValue('/')

    await selectSlashOption('/compact')

    await waitFor(() => expect(screen.getByText('/compact')).toBeInTheDocument())

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

    // Command pill should be gone after seeding
    await waitFor(() => {
      expect(screen.queryByText('/compact')).not.toBeInTheDocument()
    })

    // Editor should carry the seeded text
    await waitFor(() => expect(getComposerValue()).toBe('edited message'))

    // Send should use only the seeded text (no command prefix)
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('edited message')
    })
  })

  it('opens the slash menu at a mid-text slash (canonical any-position trigger)', async () => {
    const commands = [{ name: 'compact', description: 'Compact' }]
    renderInputBar({ commands })

    // Type text before the slash so the trigger is mid-text, not leading.
    // This is the canonical behavior the AgentLauncher was drifting from
    // (it used the leading-only `isSlashTrigger`).
    setComposerValue('hello /')

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
      expect(getComposerValue()).toBe('half-typed message')
    })
  })

  it('clears the draft on send', async () => {
    persistenceStore.set('chat-draft/p1/session-1', 'send me')
    const onSend = vi.fn()
    renderInputBar({ onSend })

    await waitFor(() => {
      expect(getComposerValue()).toBe('send me')
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
    expect(getComposerValue()).toBe('')
  })

  it('does not crash when storage is unavailable', async () => {
    fakePersistenceApi.readFails = true
    renderInputBar()
    // read returns a non-throwing failure → degrade to empty, no crash.
    await waitFor(() => {
      expect(getComposerValue()).toBe('')
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

      setComposerValue('typed draft')

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

  it('keeps the typed draft when the session id remaps in place', async () => {
    vi.useFakeTimers()
    try {
      const { rerender } = renderInputBar()
      // Flush the hydrate read so hydratedRef flips true before typing.
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      setComposerValue('wip draft')

      // remapAgentChatSession swaps session.id on the SAME mounted composer —
      // draftKey rekeys to the real session and its (empty) hydrate read must
      // not clobber the in-progress text.
      const remapped = { ...session(), id: 's-real' }
      rerender(
        <TooltipProvider>
          <ChatInputBar
            session={remapped}
            busy={false}
            disabled={false}
            onSend={vi.fn()}
            onSendBlocks={vi.fn()}
            onCancel={vi.fn()}
            commands={[]}
            configOptions={[]}
            modes={remapped.modes}
            onSetConfig={mockSetConfig}
            onSetMode={mockSetMode}
            onSetModel={mockSetModel}
          />
        </TooltipProvider>
      )

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(getComposerValue()).toBe('wip draft')
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

  async function selectSlashOption(name: string | RegExp): Promise<void> {
    // Click in the same wait as the open check. The menu can close on the
    // next tick after the caret settles, so a later getByRole misses it.
    await waitFor(
      () => {
        const listbox = screen.getByRole('listbox')
        fireEvent.click(within(listbox).getByText(name))
      },
      { timeout: 5000 }
    )
  }

  /** The Tiptap NodeView renders the chip name as a visible span; `findByText`
   *  retries until the editor paints the pill. */
  async function findChip(name: string): Promise<HTMLElement> {
    return screen.findByText(name, { ignore: 'option' })
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('splices a skill token inline at the caret when a skill is picked mid-sentence', async () => {
    mockSkills.current = [SKILL_GIT]
    renderInputBar()

    setComposerValue('use this skill /')

    await selectSlashOption('/git-worktree')

    // The `/` filter text is removed and a token is spliced inline; the
    // Tiptap NodeView renders the chip name as a visible span (real DOM node).
    await findChip('git-worktree')
    // The editor's display string now carries the token (filter text removed).
    expect(getComposerValue()).toBe(`use this skill ${PT('git-worktree')} `)
  })

  it('renders two inline chips when two distinct skills are picked at their positions', async () => {
    mockSkills.current = [SKILL_GIT, SKILL_REVIEW]
    renderInputBar()

    setComposerValue('use this /')
    await selectSlashOption('/git-worktree')

    await findChip('git-worktree')

    // Re-open the menu after the chip + trailing space, then pick a second skill.
    setComposerValue(`${PT('git-worktree')} then do /`)
    await selectSlashOption('/release-version')

    await findChip('release-version')
    // Both chips are present; the value carries two tokens.
    expect(getComposerValue()).toBe(`${PT('git-worktree')} then do ${PT('release-version')} `)
  })

  it('allows the same skill inline at multiple positions (no dedupe of tokens)', async () => {
    mockSkills.current = [SKILL_GIT]
    renderInputBar()

    setComposerValue('first /')
    await selectSlashOption('/git-worktree')

    await findChip('git-worktree')

    // Pick the same skill again — the second pick splices a second token (the
    // wire header dedupes by name, but inline positions are preserved).
    setComposerValue(`${PT('git-worktree')} again /`)
    await selectSlashOption('/git-worktree')

    await waitFor(() =>
      expect(getComposerValue()).toBe(`${PT('git-worktree')} again ${PT('git-worktree')} `)
    )
  })

  it('removes a whole chip token on Backspace when the caret is immediately after it', async () => {
    mockSkills.current = [SKILL_GIT]
    renderInputBar()

    setComposerValue('use this /')
    await selectSlashOption('/git-worktree')

    await findChip('git-worktree')
    const valueWithToken = `use this ${PT('git-worktree')} `
    expect(getComposerValue()).toBe(valueWithToken)

    // Place the caret right after the trailing space (the splicer's position),
    // then dispatch a real DOM keydown so the editor's Backspace-pill keymap
    // runs and removes the whole atom node.
    setComposerCaret(valueWithToken.length)
    pressComposerKey('Backspace')

    // The whole chip token + the trailing space are removed; the preceding text
    // ("use this ") stays and the caret lands at the end of it.
    await waitFor(() => expect(getComposerValue()).toBe('use this '))
  })

  it('falls through to the default one-char backspace when the caret is in plain text', async () => {
    mockSkills.current = [SKILL_GIT]
    renderInputBar()

    // Plain text, no tokens; caret at the end.
    setComposerValue('hello world')
    const caret = 'hello world'.length
    setComposerCaret(caret)

    pressComposerKey('Backspace')
    // The editor-native pill-removal handler is a noop when the node before the
    // caret is plain text (no atom skillPill), so it does NOT remove the whole
    // token or anything beyond a single char. ProseMirror's default one-char
    // backspace fires (deletes exactly one char) — the exact value guards the
    // one-char-deletion behavior (a regex like `/^hello wor/` would pass even
    // if the editor ate multiple chars). 'hello world' minus the trailing 'd'
    // is 'hello worl' (one char) — NOT 'hello wor' (two chars).
    await waitFor(() => expect(getComposerValue()).toBe('hello worl'))
  })

  it('emits display (token) + wire (path-framed) blocks on send, then clears the token', async () => {
    const onSendBlocks = vi.fn()
    mockSkills.current = [SKILL_GIT]
    renderInputBar({ onSendBlocks })

    setComposerValue('use this /')
    await selectSlashOption('/git-worktree')

    await findChip('git-worktree')
    // Type after the chip + trailing space.
    setComposerValue(`${PT('git-worktree')} and then`)
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    const wireText = `# Agent Skills\n\ngit-worktree: /home/u/.agents/skills/git-worktree/SKILL.md\n\n---\n\n(git-worktree) and then`
    const displayText = `${PT('git-worktree')} and then`
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
    await waitFor(() => expect(getComposerValue()).toBe(''))
  })

  it('blocks send and toasts when a selected skill has no path (web parity gap)', async () => {
    const onSendBlocks = vi.fn()
    const onSend = vi.fn()
    // A skill surfaced without a path (e.g. a future web skill with no parity
    // route) — the renderer Block If halts the send with a clear error.
    mockSkills.current = [{ name: 'pathless', description: 'no path', scope: 'project', path: '' }]
    renderInputBar({ onSendBlocks, onSend })

    setComposerValue('use this /')
    await selectSlashOption('/pathless')

    await findChip('pathless')
    setComposerValue(`${PT('pathless')} hi`)
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

    setComposerValue('/')

    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    expect(screen.queryByText('Skills')).not.toBeInTheDocument()
  })

  it('re-renders inline chips when the composer is seeded with token text (edit a sent message)', async () => {
    // Editing a user message that carried skill tokens re-seeds the composer
    // with the raw token text; the Tiptap editor re-parses the tokens into
    // pill NodeViews (MessageActions.onEdit passes the token text verbatim).
    mockSkills.current = [SKILL_GIT]
    const seeded = `use this ${PT('git-worktree')} then`
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

    // The editor re-parses the tokens into pill nodes; the chip text renders.
    await waitFor(() => expect(screen.getByText('git-worktree')).toBeInTheDocument())
    await waitFor(() => expect(getComposerValue()).toBe(seeded))
  })
})
