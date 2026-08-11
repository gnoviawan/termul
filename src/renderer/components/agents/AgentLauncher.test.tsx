import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
// RTL auto-cleanup is left ENABLED (default). The `afterEach` below destroys
// lingering Tiptap editors BEFORE React unmounts — vitest runs `afterEach`
// hooks in reverse registration order, so this file's hook (registered after
// RTL's import-time hook) runs first, releasing ProseMirror's
// `MutationObserver`/rAF callbacks while the DOM is still attached. Then
// RTL's auto-cleanup unmounts React. Mirrors `ChatInputBar.test.tsx`.
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getComposerValue,
  pressComposerKey,
  setComposerValue
} from '@/components/chat/composer/chat-composer-test-helpers'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import {
  buildSupportedAcpAgents,
  pickDefaultSupportedAgent,
  type SupportedAcpAgentEntry
} from '@/lib/agents/supported-acp-agents'
import { SKILL_PAD_DEFAULT } from '@/lib/composer/doc-to-prompt'
import { skillToken } from '@/lib/skill-tokens'
import { isTauriContext } from '@/lib/tauri-runtime'
import type { AcpSession } from '@/stores/acp-store'
import { __resetLauncherSelectionCache, AgentLauncher } from './AgentLauncher'

// jsdom omits `document.elementFromPoint`. Radix/floating-ui call it during
// popover open/positioning; without a stub the agent/model pickers never open
// (the click doesn't toggle `data-state="open"`). Return `null` so the popover
// still opens (positioning degrades to the default offset in jsdom).
if (typeof document.elementFromPoint !== 'function') {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => null,
    configurable: true,
    writable: true
  })
}

function clickMenuOption(name: string | RegExp): void {
  const dialog = screen.getByRole('dialog')
  fireEvent.pointerDown(within(dialog).getByText(name))
}

function defaultReadyAgent(): SupportedAcpAgentEntry {
  const entries = buildSupportedAcpAgents([], 'windows-x86_64')
  return pickDefaultSupportedAgent(entries) ?? entries[0]
}

function pickerLabel(name: string): string {
  return name.endsWith(' CLI') ? name.slice(0, -4) : name
}

const {
  mockStartChat,
  mockPrepareChat,
  mockCancelPreparedChat,
  mockClaimPreparedChat,
  mockCreateLaunchPlaceholder,
  mockFinalizeChatLaunch,
  mockApplyPendingLauncherOptions,
  mockSeedLaunchUserMessage,
  mockClearLaunchingSession,
  mockPrewarmAgent,
  mockSendPrompt,
  mockSaveAgentConfig,
  mockSetConfigOption,
  mockSetMode,
  mockSetModel,
  mockAuthenticateAgent,
  mockInstallRegistryBinary,
  mockInstallAcpAgent,
  mockAddAgentChatTab,
  mockRemapAgentChatSession,
  mockHideAgentLauncher,
  mockPersistRead,
  mockPersistWrite,
  mockNavigate,
  mockRetargetWarmPool,
  mockSetSelectedAgentConfigId,
  mockSetMcpServerEnabled,
  mockLoadMcpTools,
  acpStateRef
} = vi.hoisted(() => ({
  mockStartChat: vi.fn(),
  mockPrepareChat: vi.fn(),
  mockCancelPreparedChat: vi.fn(),
  mockClaimPreparedChat: vi.fn(),
  mockCreateLaunchPlaceholder: vi.fn(),
  mockFinalizeChatLaunch: vi.fn(),
  mockApplyPendingLauncherOptions: vi.fn(),
  mockSeedLaunchUserMessage: vi.fn(),
  mockClearLaunchingSession: vi.fn(),
  mockPrewarmAgent: vi.fn(),
  mockSendPrompt: vi.fn(),
  mockSaveAgentConfig: vi.fn(),
  mockSetConfigOption: vi.fn(),
  mockSetMode: vi.fn(),
  mockSetModel: vi.fn(),
  mockAuthenticateAgent: vi.fn(),
  mockInstallRegistryBinary: vi.fn(),
  mockInstallAcpAgent: vi.fn(),
  mockAddAgentChatTab: vi.fn(),
  mockRemapAgentChatSession: vi.fn(),
  mockHideAgentLauncher: vi.fn(),
  mockPersistRead: vi.fn(),
  mockPersistWrite: vi.fn(),
  mockNavigate: vi.fn(),
  mockRetargetWarmPool: vi.fn(),
  mockSetSelectedAgentConfigId: vi.fn(),
  mockSetMcpServerEnabled: vi.fn(),
  mockLoadMcpTools: vi.fn(),
  acpStateRef: {
    current: {
      agentConfigs: [] as StoredAgentConfig[],
      preparedSessions: {} as Record<string, string>,
      preparingChatKeys: {} as Record<string, true>,
      prepareChatErrors: {} as Record<string, unknown>,
      agentOptionsCache: {} as Record<
        string,
        {
          models: AcpSession['models']
          modes: AcpSession['modes']
          configOptions: AcpSession['configOptions']
          updatedAt: number
        }
      >,
      launchingSessionIds: {} as Record<string, true>,
      sessions: {} as Record<string, AcpSession>,
      commands: {},
      configToLiveAgent: {} as Record<string, string>,
      agents: {} as Record<string, { id: string; capabilities: unknown; authMethods?: unknown[] }>,
      mcpServers: [] as Array<{ id: string; name: string; enabled?: boolean }>,
      mcpProbeStatus: {} as Record<string, string>,
      mcpTools: {} as Record<string, unknown[]>
    }
  }
}))

const { mockSkills, mockToastError, mockResolvedAgentsOverride, mockProjectOverride } = vi.hoisted(
  () => ({
    // Override-able skills list (defaults to [] — web/no-skills parity). Skill
    // tests push entries here so useAgentSkills surfaces them in the slash menu.
    // `path` is required so the launch wire prompt can cite it.
    mockSkills: {
      current: [] as Array<{
        name: string
        description: string
        scope: string
        path: string
      }>
    },
    mockToastError: vi.fn(),
    // CAP-6 / Story 8: the launcher resolves supported agents from the host
    // catalog via `useResolvedSupportedAcpAgents`. Component tests mock the hook
    // to the synchronous offline-first derivation so they can exercise launch
    // behavior without the async catalog fetch. Set this to inject a specific
    // entry list (e.g. the manual-install agent).
    mockResolvedAgentsOverride: { current: null as SupportedAcpAgentEntry[] | null },
    // CAP-2/3 worktree-mode override: the default project mock is a non-git
    // folder so the worktree selector is hidden. Worktree tests push a git
    // project + branch here so `canUseWorktree` becomes true.
    mockProjectOverride: {
      current: null as { isGitRepo?: boolean; gitBranch?: string | null } | null
    }
  })
)

vi.mock('sonner', () => ({
  toast: { error: mockToastError, success: vi.fn() }
}))

vi.mock('@/hooks/use-agent-skills', async () => {
  // Use the real (sync) buildPromptWithLoadedSkills so the wire framing is
  // exercised end-to-end — no mock needed now that paths are captured at pick
  // time (no IPC read at launch). Only useAgentSkills is overridden.
  const actual = await vi.importActual<typeof import('@/hooks/use-agent-skills')>(
    '@/hooks/use-agent-skills'
  )
  return { ...actual, useAgentSkills: () => ({ skills: mockSkills.current }) }
})

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(() => 'windows'),
  arch: vi.fn(() => 'x86_64')
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock('@/lib/api', () => ({
  persistenceApi: { read: mockPersistRead, write: mockPersistWrite },
  filesystemApi: {
    onFileChanged: vi.fn(() => () => {}),
    onFileCreated: vi.fn(() => () => {}),
    onFileDeleted: vi.fn(() => () => {})
  }
}))

vi.mock('@/lib/dialog-api', () => ({
  dialogApi: {
    selectFile: vi.fn(async () => ({ success: true, data: 'C:/tools/legacy.exe' }))
  }
}))

vi.mock('@/hooks/use-acp-runtime-probe', () => ({
  useAcpRuntimeProbe: () => ({ npx: true, uvx: true })
}))

vi.mock('@/hooks/use-resolved-supported-acp-agents', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agents/supported-acp-agents')>(
    '@/lib/agents/supported-acp-agents'
  )
  return {
    useResolvedSupportedAcpAgents: (configs: readonly StoredAgentConfig[]) =>
      mockResolvedAgentsOverride.current ??
      actual.buildSupportedAcpAgents(configs, 'windows-x86_64')
  }
})

vi.mock('@/lib/acp-api', () => ({
  acpApi: {
    installRegistryBinary: mockInstallRegistryBinary,
    installAcpAgent: mockInstallAcpAgent,
    probeRuntime: vi.fn(async () => ({ npx: true, uvx: true }))
  }
}))

vi.mock('@/lib/worktree-context', () => ({
  getDefaultCwdForProject: () => '/work',
  getProjectRootPath: () => '/work'
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => false)
}))

// Radix Select portals don't render reliably under jsdom; shim with a native
// `<select>`. `Select` walks its children for `SelectItem`s and exposes them
// via context so `SelectTrigger` can render one `<select>` with all options.
vi.mock('@/components/ui/select', async () => {
  const { createContext, useContext, Children, isValidElement } = await import('react')
  type Item = { value: string; label: React.ReactNode }
  const SelectCtx = createContext<{
    value?: string
    onValueChange?: (v: string) => void
    items: Item[]
  }>({ items: [] })
  const SelectItem = (_props: { value: string; children: React.ReactNode }) => null
  return {
    Select: ({
      value,
      onValueChange,
      children
    }: {
      value?: string
      onValueChange?: (v: string) => void
      children: React.ReactNode
    }) => {
      const items: Item[] = []
      const walk = (node: React.ReactNode): void => {
        if (!isValidElement(node)) return
        if (node.type === SelectItem) {
          items.push({ value: node.props.value, label: node.props.children })
        }
        Children.forEach(node.props.children, walk)
      }
      Children.forEach(children, walk)
      return (
        <SelectCtx.Provider value={{ value, onValueChange, items }}>{children}</SelectCtx.Provider>
      )
    },
    SelectTrigger: ({
      className,
      children,
      ...props
    }: {
      className?: string
      children?: React.ReactNode
      [k: string]: unknown
    }) => {
      const ctx = useContext(SelectCtx)
      const ariaLabel = (props as Record<string, unknown>)['aria-label'] as string | undefined
      return (
        <select
          className={className}
          value={ctx.value ?? ''}
          onChange={(e) => ctx.onValueChange?.(e.target.value)}
          aria-label={ariaLabel}
        >
          {ctx.items.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      )
    },
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem,
    SelectGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectLabel: () => null,
    SelectSeparator: () => null,
    SelectScrollUpButton: () => null,
    SelectScrollDownButton: () => null
  }
})

const { mockWorktreeCreate, mockWorktreeCopyInclude, mockWorktreeResolveBaseBranch } = vi.hoisted(
  () => ({
    mockWorktreeCreate: vi.fn(),
    mockWorktreeCopyInclude: vi.fn(),
    mockWorktreeResolveBaseBranch: vi.fn()
  })
)

vi.mock('@/lib/worktree-api', () => ({
  worktreeApi: {
    create: mockWorktreeCreate,
    copyIncludeFiles: mockWorktreeCopyInclude,
    resolveBaseBranch: mockWorktreeResolveBaseBranch,
    list: vi.fn(),
    remove: vi.fn(),
    branches: vi.fn(),
    checkDirty: vi.fn(),
    removeAllManaged: vi.fn(),
    parseGitignore: vi.fn(),
    createSymlinks: vi.fn(),
    ensureSymlinks: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    mergePreview: vi.fn(),
    mergeExecute: vi.fn()
  }
}))

vi.mock('@/stores/project-store', () => {
  const baseProject = { id: 'p1', name: 'P', path: '/work', defaultShell: undefined }
  const state = {
    activeProjectId: 'p1',
    projects: [baseProject]
  }
  const withOverride = () => ({
    ...state,
    projects: state.projects.map((p) => ({ ...p, ...(mockProjectOverride.current ?? {}) }))
  })
  const useProjectStore = (sel?: (s: typeof state) => unknown) => {
    const merged = withOverride()
    return sel ? sel(merged) : merged
  }
  useProjectStore.getState = () => state
  const useActiveProject = () => withOverride().projects.find((p) => p.id === state.activeProjectId)
  return { useProjectStore, useActiveProject }
})

vi.mock('@/stores/workspace-store', () => {
  const state = {
    hideAgentLauncher: mockHideAgentLauncher,
    addAgentChatTab: mockAddAgentChatTab,
    remapAgentChatSession: mockRemapAgentChatSession,
    activePaneId: 'pane1'
  }
  const useWorkspaceStore = (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state)
  useWorkspaceStore.getState = () => state
  return { useWorkspaceStore }
})

vi.mock('@/stores/acp-store', () => {
  const getState = () => ({
    startChat: mockStartChat,
    prepareChat: mockPrepareChat,
    cancelPreparedChat: mockCancelPreparedChat,
    claimPreparedChat: mockClaimPreparedChat,
    createLaunchPlaceholder: mockCreateLaunchPlaceholder,
    finalizeChatLaunch: mockFinalizeChatLaunch,
    applyPendingLauncherOptions: mockApplyPendingLauncherOptions,
    seedLaunchUserMessage: mockSeedLaunchUserMessage,
    clearLaunchingSession: mockClearLaunchingSession,
    prewarmAgent: mockPrewarmAgent,
    sendPrompt: mockSendPrompt,
    sendPromptBlocks: mockSendPrompt,
    saveAgentConfig: mockSaveAgentConfig,
    setConfigOption: mockSetConfigOption,
    setMode: mockSetMode,
    setModel: mockSetModel,
    authenticateAgent: mockAuthenticateAgent,
    retargetWarmPool: mockRetargetWarmPool,
    setSelectedAgentConfigId: mockSetSelectedAgentConfigId
  })
  type MockAcpState = typeof acpStateRef.current & {
    saveAgentConfig: typeof mockSaveAgentConfig
    retargetWarmPool: typeof mockRetargetWarmPool
    setSelectedAgentConfigId: typeof mockSetSelectedAgentConfigId
    setMcpServerEnabled: typeof mockSetMcpServerEnabled
    loadMcpTools: typeof mockLoadMcpTools
  }
  const useAcpStore = (sel?: (s: MockAcpState) => unknown) =>
    sel
      ? sel({
          ...acpStateRef.current,
          saveAgentConfig: mockSaveAgentConfig,
          retargetWarmPool: mockRetargetWarmPool,
          setSelectedAgentConfigId: mockSetSelectedAgentConfigId,
          setMcpServerEnabled: mockSetMcpServerEnabled,
          loadMcpTools: mockLoadMcpTools
        })
      : getState()
  useAcpStore.getState = getState
  const useAcpSession = (sessionId: string | null) =>
    sessionId ? (acpStateRef.current.sessions[sessionId] ?? null) : null
  const prepareChatKey = (configId: string, cwd: string) => `${configId}\0${cwd}\0`
  const agentReuseKey = (configId: string, cwd: string) => `${configId}\0${cwd.trim()}`
  const hasModelRelevantOptionsCache = (
    entry:
      | {
          models: AcpSession['models']
          modes: AcpSession['modes']
          configOptions: AcpSession['configOptions']
          updatedAt: number
        }
      | null
      | undefined
  ) => {
    if (!entry) return false
    if (entry.models && entry.models.availableModels.length > 0) return true
    return entry.configOptions.some(
      (option) => option.category === 'model' && option.options.length > 0
    )
  }
  return {
    useAcpStore,
    useAcpSession,
    prepareChatKey,
    agentReuseKey,
    hasModelRelevantOptionsCache
  }
})

const ACP_CONFIG: StoredAgentConfig = {
  id: 'acp-registry:claude-acp',
  name: 'Claude Agent',
  command: 'npx',
  args: ['-y', 'claude-acp'],
  env: {},
  templateId: 'claude-acp'
}

const OTHER_ACP_CONFIG: StoredAgentConfig = {
  id: 'acp-registry:opencode',
  name: 'OpenCode',
  command: 'npx',
  args: ['-y', 'opencode-acp'],
  env: {},
  templateId: 'opencode'
}

function preparedSession(
  config: StoredAgentConfig,
  modelOptions: Array<{ value: string; name: string }> = [
    { value: 'm1', name: 'Model One' },
    { value: 'm2', name: 'Model Two' }
  ]
): AcpSession {
  return {
    id: 'prepared-1',
    agentId: `agent:${config.id}`,
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
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: modelOptions[0]?.value ?? 'm1',
        options: modelOptions
      },
      {
        id: 'thinking',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: 'medium',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' }
        ]
      },
      {
        id: 'mode',
        name: 'Agent',
        category: 'mode',
        type: 'select',
        currentValue: 'agent',
        options: [
          { value: 'agent', name: 'Agent' },
          { value: 'plan', name: 'Plan' },
          { value: 'ask', name: 'Ask' }
        ]
      }
    ],
    lastError: null,
    createdAt: 1
  }
}

function renderLauncher(): void {
  render(
    <TooltipProvider>
      <MemoryRouter>
        <AgentLauncher paneId="pane1" />
      </MemoryRouter>
    </TooltipProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  __resetLauncherSelectionCache()
  // Start each test from a clean skill slate (web/no-skills default). Skill
  // tests override mockSkills.current.
  mockSkills.current = []
  // Reset the supported-agents override (default: delegate to the offline-first
  // derivation).
  mockResolvedAgentsOverride.current = null
  acpStateRef.current = {
    agentConfigs: [],
    preparedSessions: {},
    preparingChatKeys: {},
    prepareChatErrors: {},
    agentOptionsCache: {},
    launchingSessionIds: {},
    sessions: {},
    commands: {},
    configToLiveAgent: {},
    agents: {},
    mcpServers: [],
    mcpProbeStatus: {},
    mcpTools: {}
  }
  mockAuthenticateAgent.mockResolvedValue(undefined)
  mockSetMcpServerEnabled.mockResolvedValue(undefined)
  mockPersistRead.mockResolvedValue({ success: true, data: undefined })
  mockPersistWrite.mockResolvedValue({ success: true })
  mockStartChat.mockResolvedValue('session-1')
  mockClaimPreparedChat.mockReturnValue(null)
  mockCreateLaunchPlaceholder.mockReturnValue('launch-placeholder-1')
  mockFinalizeChatLaunch.mockImplementation(
    async (args: { adoptSession?: (a: string, b: string) => void; placeholderId: string }) => {
      args.adoptSession?.(args.placeholderId, 'session-1')
      return 'session-1'
    }
  )
  mockApplyPendingLauncherOptions.mockResolvedValue(undefined)
  mockSeedLaunchUserMessage.mockImplementation(() => undefined)
  mockClearLaunchingSession.mockImplementation(() => undefined)
  mockPrepareChat.mockImplementation(() => undefined)
  mockCancelPreparedChat.mockImplementation(() => undefined)
  mockPrewarmAgent.mockResolvedValue(undefined)
  mockSendPrompt.mockResolvedValue(undefined)
  mockSaveAgentConfig.mockImplementation(async (config: StoredAgentConfig) => {
    const existing = acpStateRef.current.agentConfigs.findIndex((entry) => entry.id === config.id)
    acpStateRef.current.agentConfigs =
      existing === -1
        ? [...acpStateRef.current.agentConfigs, config]
        : acpStateRef.current.agentConfigs.map((entry) => (entry.id === config.id ? config : entry))
  })
  mockSetConfigOption.mockResolvedValue(undefined)
  mockSetMode.mockResolvedValue(undefined)
  mockSetModel.mockResolvedValue(undefined)
  mockInstallRegistryBinary.mockResolvedValue({ command: 'opencode.exe', args: ['acp'] })
  mockInstallAcpAgent.mockResolvedValue({ command: 'opencode.exe', args: ['acp'] })
  // Worktree-mode defaults: web context, no git repo, no worktree calls.
  vi.mocked(isTauriContext).mockReturnValue(false)
  mockProjectOverride.current = null
  mockWorktreeCreate.mockReset()
  mockWorktreeCopyInclude.mockReset()
  mockWorktreeResolveBaseBranch.mockReset()
  mockWorktreeCopyInclude.mockResolvedValue({
    success: true,
    data: { ran: 0, copied: 0, skipped: [] }
  })
  mockWorktreeResolveBaseBranch.mockResolvedValue({
    success: true,
    data: { defaultBase: 'feat/x', currentBranch: 'feat/x', isDetached: false }
  })
})

// Explicitly destroy lingering Tiptap/ProseMirror editors BEFORE React's
// auto-cleanup unmounts (RTL's auto-cleanup runs AFTER this hook in vitest's
// reverse afterEach order). ProseMirror's `EditorView.destroy` must run while
// the DOM is still attached so its `MutationObserver`/rAF callbacks are
// released; otherwise they accumulate across tests in jsdom and hang the file.
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

describe('AgentLauncher ACP new thread', () => {
  it('does not launch when Enter confirms an IME composition', async () => {
    renderLauncher()

    await screen.findByLabelText('Agent prompt')
    setComposerValue('composing')
    pressComposerKey('Enter', { isComposing: true })

    expect(mockCreateLaunchPlaceholder).not.toHaveBeenCalled()
    expect(mockFinalizeChatLaunch).not.toHaveBeenCalled()
  })

  it('opens chat instantly via placeholder then finalizes ACP in the background', async () => {
    const defaultAgent = defaultReadyAgent()
    renderLauncher()

    setComposerValue('hello acp')
    fireEvent.click(screen.getByLabelText('Start agent chat'))

    expect(mockCreateLaunchPlaceholder).toHaveBeenCalled()
    expect(mockAddAgentChatTab).toHaveBeenCalledWith('launch-placeholder-1', 'pane1')
    expect(mockHideAgentLauncher).toHaveBeenCalled()

    await waitFor(() => expect(mockFinalizeChatLaunch).toHaveBeenCalledTimes(1))
    expect(mockFinalizeChatLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        placeholderId: 'launch-placeholder-1',
        configId: defaultAgent.configId,
        cwd: '/work',
        projectId: 'p1',
        initialBlocks: [{ type: 'text', text: 'hello acp' }],
        adoptSession: expect.any(Function)
      })
    )
    expect(mockRemapAgentChatSession).toHaveBeenCalledWith(
      'launch-placeholder-1',
      'session-1',
      'pane1'
    )
    expect(mockPersistWrite).toHaveBeenCalledWith('agents/last-selected', {
      agentId: defaultAgent.configId,
      mode: 'acp'
    })
  })

  it('claims a prepared session so launch skips the placeholder path', async () => {
    const defaultAgent = defaultReadyAgent()
    const key = `${defaultAgent.configId}\0/work\0`
    mockClaimPreparedChat.mockReturnValue('prepared-ready-1')
    acpStateRef.current.preparedSessions = { [key]: 'prepared-ready-1' }
    renderLauncher()

    setComposerValue('ready now')
    fireEvent.click(screen.getByLabelText('Start agent chat'))

    expect(mockClaimPreparedChat).toHaveBeenCalledWith(key, 'p1')
    expect(mockCreateLaunchPlaceholder).not.toHaveBeenCalled()
    expect(mockSeedLaunchUserMessage).toHaveBeenCalledWith('prepared-ready-1', [
      { type: 'text', text: 'ready now' }
    ])
    expect(mockAddAgentChatTab).toHaveBeenCalledWith('prepared-ready-1', 'pane1')
    expect(mockHideAgentLauncher).toHaveBeenCalled()

    await waitFor(() =>
      expect(mockSendPrompt).toHaveBeenCalledWith(
        'prepared-ready-1',
        [{ type: 'text', text: 'ready now' }],
        { skipUserAppend: true }
      )
    )
  })

  it('prepares the selected ACP session in the background', async () => {
    const defaultAgent = defaultReadyAgent()
    renderLauncher()

    await waitFor(() =>
      expect(mockRetargetWarmPool).toHaveBeenCalledWith(defaultAgent.configId, '/work', 'p1')
    )
    expect(mockStartChat).not.toHaveBeenCalled()
  })

  it('surfaces a timeout prepare error with a distinct label and retries preparation', async () => {
    const defaultAgent = defaultReadyAgent()
    const key = `${defaultAgent.configId}\0/work\0`
    acpStateRef.current.prepareChatErrors = {
      [key]: {
        category: 'timeout',
        label: 'Session setup timed out',
        detail: 'session/new timed out after 30s'
      }
    }
    renderLauncher()

    await waitFor(() =>
      expect(mockRetargetWarmPool).toHaveBeenCalledWith(defaultAgent.configId, '/work', 'p1')
    )
    mockPrepareChat.mockClear()
    // A timeout reads as "Session setup timed out", never a misleading "Model unavailable".
    expect(
      screen.queryByRole('button', { name: 'Select model: Model unavailable' })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Select model: Session setup timed out' }))

    expect(await screen.findByText('Could not load model options.')).toBeInTheDocument()
    expect(screen.getByText('session/new timed out after 30s')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(mockCancelPreparedChat).toHaveBeenCalledWith(key)
    expect(mockPrepareChat).toHaveBeenCalledWith(defaultAgent.configId, '/work', undefined, 'p1')
  })

  it('shows an agent-connection-lost label and retries after a transport failure', async () => {
    const defaultAgent = defaultReadyAgent()
    const key = `${defaultAgent.configId}\0/work\0`
    acpStateRef.current.prepareChatErrors = {
      [key]: {
        category: 'transport',
        label: 'Agent connection lost',
        detail: 'the stream was destroyed'
      }
    }
    renderLauncher()

    await waitFor(() =>
      expect(mockRetargetWarmPool).toHaveBeenCalledWith(defaultAgent.configId, '/work', 'p1')
    )
    mockRetargetWarmPool.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Select model: Agent connection lost' }))
    expect(screen.getByText('the stream was destroyed')).toBeInTheDocument()
    // Retry re-prepares, which (after backend eviction) spawns a fresh process.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mockCancelPreparedChat).toHaveBeenCalledWith(key)
    expect(mockPrepareChat).toHaveBeenCalledWith(defaultAgent.configId, '/work', undefined, 'p1')
  })

  it('offers Sign-in from the advertised method metadata on an auth failure', async () => {
    const defaultAgent = defaultReadyAgent()
    const key = `${defaultAgent.configId}\0/work\0`
    const reuseKey = `${defaultAgent.configId}\0/work`
    acpStateRef.current.prepareChatErrors = {
      [key]: {
        category: 'auth',
        label: 'Authentication required',
        detail: 'Run `cursor login` to continue'
      }
    }
    acpStateRef.current.configToLiveAgent = { [reuseKey]: 'agent-live' }
    acpStateRef.current.agents = {
      'agent-live': {
        id: 'agent-live',
        capabilities: {},
        authMethods: [{ id: 'cursor_login', name: 'Cursor' }]
      }
    }
    renderLauncher()

    await waitFor(() =>
      expect(mockRetargetWarmPool).toHaveBeenCalledWith(defaultAgent.configId, '/work', 'p1')
    )
    mockRetargetWarmPool.mockClear()
    // Zed-style banner is visible without opening the model picker popover.
    expect(screen.getByText('Run `cursor login` to continue')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cursor' }))
    await waitFor(() =>
      expect(mockAuthenticateAgent).toHaveBeenCalledWith('agent-live', 'cursor_login')
    )
    await waitFor(() =>
      expect(mockPrepareChat).toHaveBeenCalledWith(defaultAgent.configId, '/work', undefined, 'p1')
    )
  })

  it('presents per-method sign-in buttons for multi-method auth (Zed-style)', async () => {
    const defaultAgent = defaultReadyAgent()
    const key = `${defaultAgent.configId}\0/work\0`
    const reuseKey = `${defaultAgent.configId}\0/work`
    acpStateRef.current.prepareChatErrors = {
      [key]: {
        category: 'multi-auth',
        label: 'Multiple sign-in methods',
        detail: 'This agent advertises multiple sign-in methods (Cursor, API key).'
      }
    }
    acpStateRef.current.configToLiveAgent = { [reuseKey]: 'agent-live' }
    acpStateRef.current.agents = {
      'agent-live': {
        id: 'agent-live',
        capabilities: {},
        authMethods: [
          { id: 'cursor_login', name: 'Cursor' },
          { id: 'api_key', name: 'API key' }
        ]
      }
    }
    renderLauncher()

    await waitFor(() =>
      expect(mockRetargetWarmPool).toHaveBeenCalledWith(defaultAgent.configId, '/work', 'p1')
    )
    expect(
      screen.getByText('Choose one of the following authentication options:')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'API key' }))
    await waitFor(() => expect(mockAuthenticateAgent).toHaveBeenCalledWith('agent-live', 'api_key'))
  })

  it('does not reap a prepared session on unmount (the warm pool owns lifecycle)', async () => {
    const defaultAgent = defaultReadyAgent()
    const { unmount } = render(
      <TooltipProvider>
        <MemoryRouter>
          <AgentLauncher paneId="pane1" />
        </MemoryRouter>
      </TooltipProvider>
    )

    await waitFor(() =>
      expect(mockRetargetWarmPool).toHaveBeenCalledWith(defaultAgent.configId, '/work', 'p1')
    )
    unmount()

    // The app-level warm pool owns the session lifecycle, so unmounting the
    // launcher must NOT cancel the warm session (it stays ready for the next
    // chat / a project switch-back).
    expect(mockCancelPreparedChat).not.toHaveBeenCalled()
  })

  it('invalidates + re-prepares the warm session when an MCP server is toggled', async () => {
    const defaultAgent = defaultReadyAgent()
    acpStateRef.current.mcpServers = [{ id: 's1', name: 'Files', enabled: true }]
    renderLauncher()

    // Wait for the warm pool to retarget (prepares the session).
    await waitFor(() =>
      expect(mockRetargetWarmPool).toHaveBeenCalledWith(defaultAgent.configId, '/work', 'p1')
    )

    // Open the MCP servers popover and toggle the "Files" server off.
    fireEvent.click(screen.getByRole('button', { name: /mcp servers/i }))
    const filesSwitch = await screen.findByRole('switch', { name: /Disable Files/i })
    fireEvent.click(filesSwitch)

    // The toggle persists to the registry, then cancels + re-prepares so the
    // next launch resolves MCP from the updated registry instead of the stale
    // pre-warmed session.
    await waitFor(() => expect(mockSetMcpServerEnabled).toHaveBeenCalledWith('s1', false))
    const key = `${defaultAgent.configId}\0${'/work'}\0`
    expect(mockCancelPreparedChat).toHaveBeenCalledWith(key)
    expect(mockPrepareChat).toHaveBeenCalledWith(defaultAgent.configId, '/work', undefined, 'p1')
  })

  it('restores a persisted ACP selection', async () => {
    acpStateRef.current.agentConfigs = [ACP_CONFIG, OTHER_ACP_CONFIG]
    mockPersistRead.mockResolvedValue({
      success: true,
      data: { agentId: 'acp-registry:opencode', mode: 'acp' }
    })
    renderLauncher()

    await waitFor(() =>
      expect(mockRetargetWarmPool).toHaveBeenCalledWith('acp-registry:opencode', '/work', 'p1')
    )
  })

  it('uses model config and native Agent/mode picker actions without duplicate Agent chips', async () => {
    const key = 'acp-registry:claude-acp\0/work\0'
    acpStateRef.current.agentConfigs = [ACP_CONFIG]
    mockPersistRead.mockResolvedValue({
      success: true,
      data: { agentId: 'acp-registry:claude-acp', mode: 'acp' }
    })
    acpStateRef.current.preparedSessions = { [key]: 'prepared-1' }
    acpStateRef.current.sessions = { 'prepared-1': preparedSession(ACP_CONFIG) }
    renderLauncher()

    const agentPicker = await screen.findByRole('button', {
      name: 'Select ACP agent: Claude Agent'
    })
    expect(agentPicker).toBeInTheDocument()
    expect(agentPicker).toHaveTextContent('Claude Agent')
    expect(agentPicker).not.toHaveTextContent('ACP:')
    fireEvent.click(await screen.findByRole('button', { name: 'Select model: Model One' }))
    clickMenuOption('Model Two')
    expect(mockSetConfigOption).toHaveBeenCalledWith('prepared-1', 'model', 'm2')

    mockSetConfigOption.mockClear()
    expect(screen.getAllByRole('button', { name: /^Agent$/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /^Agent$/ }))
    clickMenuOption('Plan')
    expect(mockSetMode).toHaveBeenCalledWith('prepared-1', 'plan')
    expect(mockSetConfigOption).not.toHaveBeenCalled()
  }, 10000)

  it('shows optimistic model label and pending spinner while setConfigOption is in flight', async () => {
    const key = 'acp-registry:claude-acp\0/work\0'
    let resolveConfig!: () => void
    mockSetConfigOption.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveConfig = resolve
        })
    )
    acpStateRef.current.agentConfigs = [ACP_CONFIG]
    mockPersistRead.mockResolvedValue({
      success: true,
      data: { agentId: 'acp-registry:claude-acp', mode: 'acp' }
    })
    acpStateRef.current.preparedSessions = { [key]: 'prepared-1' }
    acpStateRef.current.sessions = { 'prepared-1': preparedSession(ACP_CONFIG) }
    renderLauncher()

    fireEvent.click(await screen.findByRole('button', { name: 'Select model: Model One' }))
    clickMenuOption('Model Two')

    const pendingChip = await screen.findByRole('button', { name: 'Select model: Model Two' })
    expect(pendingChip).toHaveAttribute('aria-busy', 'true')
    expect(mockSetConfigOption).toHaveBeenCalledWith('prepared-1', 'model', 'm2')

    await act(async () => {
      resolveConfig()
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Select model: Model Two' })).not.toHaveAttribute(
        'aria-busy'
      )
    })
  }, 10000)

  it('uses native ACP session models when configOptions has no model option', async () => {
    const key = 'acp-registry:claude-acp\0/work\0'
    acpStateRef.current.agentConfigs = [ACP_CONFIG]
    mockPersistRead.mockResolvedValue({
      success: true,
      data: { agentId: 'acp-registry:claude-acp', mode: 'acp' }
    })
    acpStateRef.current.preparedSessions = { [key]: 'prepared-1' }
    acpStateRef.current.sessions = {
      'prepared-1': {
        ...preparedSession(ACP_CONFIG),
        configOptions: [],
        models: {
          currentModelId: 'kiro/claude-opus-4-8',
          availableModels: [
            { modelId: 'kiro/claude-opus-4-8', name: 'kiro/Claude Opus 4.8' },
            { modelId: 'openrouter/gpt-5.5', name: 'OpenRouter/GPT-5.5' }
          ]
        }
      }
    }
    renderLauncher()

    fireEvent.click(
      await screen.findByRole('button', { name: 'Select model: kiro/Claude Opus 4.8' })
    )
    clickMenuOption('OpenRouter/GPT-5.5')

    expect(mockSetModel).toHaveBeenCalledWith('prepared-1', 'openrouter/gpt-5.5')
    expect(mockSetConfigOption).not.toHaveBeenCalled()
  })

  it('searches and scroll-limits large model menus', async () => {
    const key = 'acp-registry:claude-acp\0/work\0'
    const manyModels = [
      { value: 'gpt-54-mini-fast', name: 'OpenAI/GPT-5.4 mini Fast' },
      { value: 'gpt-55', name: 'OpenAI/GPT-5.5' },
      { value: 'gpt-55-fast', name: 'OpenAI/GPT-5.5 Fast' },
      { value: 'gpt-55-pro', name: 'OpenAI/GPT-5.5 Pro' },
      { value: 'grok-420-non-reasoning', name: 'xAI/Grok 4.20 (Non-Reasoning)' },
      { value: 'grok-420-reasoning', name: 'xAI/Grok 4.20 (Reasoning)' },
      { value: 'grok-43', name: 'xAI/Grok 4.3' },
      { value: 'big-pickle', name: 'OpenCode Zen/Big Pickle' }
    ]
    acpStateRef.current.agentConfigs = [ACP_CONFIG]
    mockPersistRead.mockResolvedValue({
      success: true,
      data: { agentId: 'acp-registry:claude-acp', mode: 'acp' }
    })
    acpStateRef.current.preparedSessions = { [key]: 'prepared-1' }
    acpStateRef.current.sessions = { 'prepared-1': preparedSession(ACP_CONFIG, manyModels) }
    renderLauncher()

    fireEvent.click(
      await screen.findByRole('button', { name: 'Select model: OpenAI/GPT-5.4 mini Fast' })
    )

    expect(screen.getByLabelText('Search models')).toBeInTheDocument()
    expect(screen.getByTestId('acp-model-options')).toHaveClass('max-h-[180px]', 'overflow-y-auto')

    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'grok 4.3' } })

    expect(screen.getByText('xAI/Grok 4.3')).toBeInTheDocument()
    expect(screen.queryByText('OpenAI/GPT-5.5 Pro')).not.toBeInTheDocument()
    clickMenuOption('xAI/Grok 4.3')
    expect(mockSetConfigOption).toHaveBeenCalledWith('prepared-1', 'model', 'grok-43')
  })

  it('shows supported ACP agents when no configs are persisted', async () => {
    const defaultAgent = defaultReadyAgent()
    renderLauncher()

    expect(screen.queryByText('No ACP agents enabled')).not.toBeInTheDocument()
    const agentPicker = await screen.findByRole('button', {
      name: `Select ACP agent: ${pickerLabel(defaultAgent.agent.name)}`
    })
    expect(agentPicker).toHaveTextContent(pickerLabel(defaultAgent.agent.name))
    fireEvent.click(agentPicker)
    expect(await screen.findByText('Claude Agent')).toBeInTheDocument()
    expect(screen.getByText('Gemini CLI')).toBeInTheDocument()
    expect(screen.getByText('Cursor')).toBeInTheDocument()
    expect(screen.getByText('OpenCode')).toBeInTheDocument()
    expect(screen.getByText('pi ACP')).toBeInTheDocument()
  })

  it('switches ACP agents independently from the model picker', async () => {
    acpStateRef.current.agentConfigs = [ACP_CONFIG, OTHER_ACP_CONFIG]
    mockPersistRead.mockResolvedValue({
      success: true,
      data: { agentId: 'acp-registry:claude-acp', mode: 'acp' }
    })
    renderLauncher()

    fireEvent.click(await screen.findByRole('button', { name: 'Select ACP agent: Claude Agent' }))
    fireEvent.click(await screen.findByRole('button', { name: 'OpenCode' }))

    expect(
      await screen.findByRole('button', { name: 'Select ACP agent: OpenCode' })
    ).toBeInTheDocument()
    expect(mockPersistWrite).toHaveBeenCalledWith('agents/last-selected', {
      agentId: 'acp-registry:opencode',
      mode: 'acp'
    })
  }, 10000)

  it('installs OpenCode only after the user chooses it and clicks Install', async () => {
    mockPersistRead.mockResolvedValue({
      success: true,
      data: { agentId: 'acp-registry:opencode', mode: 'acp' }
    })
    renderLauncher()

    expect(await screen.findByText('Install required')).toBeInTheDocument()
    expect(mockInstallAcpAgent).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Install'))

    await waitFor(() => expect(mockInstallAcpAgent).toHaveBeenCalledTimes(1))
    // CAP-6 / Story 9: the request is `{ agentId }` only; the host resolves
    // everything from the trusted catalog.
    expect(mockInstallAcpAgent).toHaveBeenCalledWith('opencode')
    await waitFor(() =>
      expect(mockSaveAgentConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'acp-registry:opencode',
          templateId: 'opencode',
          command: 'opencode.exe',
          args: ['acp']
        })
      )
    )
  })

  it('saves a custom binary path for manual-install agents', async () => {
    const manualEntry: SupportedAcpAgentEntry = {
      id: 'legacy',
      configId: 'acp-registry:legacy',
      agent: {
        id: 'legacy',
        name: 'Legacy Agent',
        version: '1.0.0',
        description: 'Legacy desc',
        distribution: { binary: { 'windows-x86_64': { cmd: './legacy.exe', args: ['acp'] } } }
      },
      config: null,
      status: 'manual-install',
      install: null,
      manualInstall: { cmd: './legacy.exe', args: ['acp'], env: {} },
      runtimeLauncher: null,
      unavailableReason: 'Install Legacy Agent from the vendor.'
    }
    mockResolvedAgentsOverride.current = [manualEntry]
    mockPersistRead.mockResolvedValue({
      success: true,
      data: { agentId: 'acp-registry:legacy', mode: 'acp' }
    })

    renderLauncher()

    expect(await screen.findByText('Manual install')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('ACP agent executable path'), {
      target: { value: 'C:/tools/legacy.exe' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(mockSaveAgentConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'acp-registry:legacy',
          templateId: 'legacy',
          command: 'C:/tools/legacy.exe',
          args: ['acp']
        })
      )
    )
  })

  it('paints cached model options while preparing (cold agent, cache hit)', async () => {
    const defaultAgent = defaultReadyAgent()
    const key = `${defaultAgent.configId}\0/work\0`
    acpStateRef.current.preparingChatKeys = { [key]: true }
    acpStateRef.current.agentOptionsCache = {
      [defaultAgent.configId]: {
        models: null,
        modes: {
          currentModeId: 'agent',
          availableModes: [
            { id: 'agent', name: 'Agent' },
            { id: 'plan', name: 'Plan' }
          ]
        },
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'cached-m1',
            options: [
              { value: 'cached-m1', name: 'Cached Model' },
              { value: 'cached-m2', name: 'Cached Two' }
            ]
          }
        ],
        updatedAt: Date.now()
      }
    }
    renderLauncher()

    expect(screen.getByLabelText('Agent prompt')).not.toBeDisabled()
    const modelChip = await screen.findByRole('button', { name: 'Select model: Cached Model' })
    expect(modelChip).toBeEnabled()
    expect(
      screen.queryByRole('button', { name: 'Select model: Loading model…' })
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/Connecting/)).not.toBeInTheDocument()
    const modeChip = screen.getByRole('button', { name: /^Agent$/ })
    expect(modeChip).toBeEnabled()

    fireEvent.click(modelChip)
    clickMenuOption('Cached Two')
    expect(
      await screen.findByRole('button', { name: 'Select model: Cached Two' })
    ).toBeInTheDocument()
  })

  it('still shows Loading model when cache has modes only (no model options)', async () => {
    const defaultAgent = defaultReadyAgent()
    const key = `${defaultAgent.configId}\0/work\0`
    acpStateRef.current.preparingChatKeys = { [key]: true }
    acpStateRef.current.agentOptionsCache = {
      [defaultAgent.configId]: {
        models: null,
        modes: {
          currentModeId: 'agent',
          availableModes: [{ id: 'agent', name: 'Agent' }]
        },
        configOptions: [],
        updatedAt: Date.now()
      }
    }
    renderLauncher()

    expect(
      await screen.findByRole('button', { name: 'Select model: Loading model…' })
    ).toBeInTheDocument()
  })

  it('keeps Retry reachable when prepare failed but cached models exist', async () => {
    const defaultAgent = defaultReadyAgent()
    const key = `${defaultAgent.configId}\0/work\0`
    acpStateRef.current.prepareChatErrors = {
      [key]: {
        category: 'timeout',
        label: 'Session setup timed out',
        detail: 'session/new timed out after 30s'
      }
    }
    acpStateRef.current.agentOptionsCache = {
      [defaultAgent.configId]: {
        models: null,
        modes: null,
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'cached-m1',
            options: [{ value: 'cached-m1', name: 'Cached Model' }]
          }
        ],
        updatedAt: Date.now()
      }
    }
    renderLauncher()

    const modelChip = await screen.findByRole('button', {
      name: 'Select model: Session setup timed out'
    })
    expect(modelChip).not.toBeDisabled()
    fireEvent.click(modelChip)
    expect(await screen.findByText('Could not load model options.')).toBeInTheDocument()
    expect(screen.getByText('session/new timed out after 30s')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mockCancelPreparedChat).toHaveBeenCalledWith(key)
  })

  it('keeps composer usable with loading chip when cold and no cache', async () => {
    const defaultAgent = defaultReadyAgent()
    const key = `${defaultAgent.configId}\0/work\0`
    acpStateRef.current.preparingChatKeys = { [key]: true }
    renderLauncher()

    expect(screen.getByLabelText('Agent prompt')).not.toBeDisabled()
    expect(
      await screen.findByRole('button', { name: 'Select model: Loading model…' })
    ).toBeInTheDocument()
  })

  it('retargets the warm pool when the launcher opens', async () => {
    const defaultAgent = defaultReadyAgent()
    renderLauncher()

    await waitFor(() =>
      expect(mockSetSelectedAgentConfigId).toHaveBeenCalledWith(defaultAgent.configId)
    )
    await waitFor(() =>
      expect(mockRetargetWarmPool).toHaveBeenCalledWith(defaultAgent.configId, '/work', 'p1')
    )
  })

  it('opens chat instantly while finalizeChatLaunch runs in the background (send-while-cold)', async () => {
    let resolveFinalize!: (id: string) => void
    mockFinalizeChatLaunch.mockImplementation(
      (args: { adoptSession?: (a: string, b: string) => void; placeholderId: string }) =>
        new Promise<string>((resolve) => {
          resolveFinalize = (id: string) => {
            args.adoptSession?.(args.placeholderId, id)
            resolve(id)
          }
        })
    )
    renderLauncher()

    setComposerValue('hello cold')
    fireEvent.click(screen.getByLabelText('Start agent chat'))

    expect(mockCreateLaunchPlaceholder).toHaveBeenCalledWith(
      expect.objectContaining({
        initialUserBlocks: [{ type: 'text', text: 'hello cold' }]
      })
    )
    expect(mockAddAgentChatTab).toHaveBeenCalledWith('launch-placeholder-1', 'pane1')
    expect(mockHideAgentLauncher).toHaveBeenCalled()
    expect(screen.getByLabelText('Start agent chat').querySelector('.animate-spin')).toBeNull()

    await waitFor(() => expect(mockFinalizeChatLaunch).toHaveBeenCalled())

    await act(async () => {
      resolveFinalize('session-cold')
    })

    await waitFor(() =>
      expect(mockRemapAgentChatSession).toHaveBeenCalledWith(
        'launch-placeholder-1',
        'session-cold',
        'pane1'
      )
    )
  })
})

describe('AgentLauncher skill chips (inline tokens)', () => {
  const SKILL_GIT = {
    name: 'git-worktree',
    description: 'Isolated worktree',
    scope: 'project',
    path: '/home/u/.agents/skills/git-worktree/SKILL.md'
  }
  // Padded token form — matches what `docToDisplayText` re-emits (pills carry
  // the `\uE002<pad>\uE003` block for on-disk draft byte-stability) and what
  // `handleSelect` splices. Editor/display assertions use this so they match
  // the editor's serialized output.
  const TOKEN = skillToken('git-worktree', SKILL_PAD_DEFAULT)

  function selectSlashOption(name: string | RegExp): void {
    const listbox = screen.getByRole('listbox')
    fireEvent.mouseDown(within(listbox).getByText(name))
  }

  it('shows a Skills section in the launcher slash menu and renders an inline chip on pick', async () => {
    mockSkills.current = [SKILL_GIT]
    renderLauncher()

    await screen.findByLabelText('Agent prompt')
    setComposerValue('/')

    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    expect(screen.getByText('Skills')).toBeInTheDocument()

    selectSlashOption('/git-worktree')

    // The Tiptap NodeView renders the chip name as a visible span (after the
    // slash menu closes, it is the stable selector for the chip).
    await waitFor(() => expect(screen.getByText('git-worktree')).toBeInTheDocument())
    // The `/` filter text is cleared; the value carries the token + trailing space.
    expect(getComposerValue()).toBe(`${TOKEN} `)
  })

  it('launch injects the wire (path-framed) text into the real send while the optimistic preview carries the display (token) text', async () => {
    mockSkills.current = [SKILL_GIT]
    renderLauncher()

    await screen.findByLabelText('Agent prompt')
    setComposerValue('/')
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    selectSlashOption('/git-worktree')

    await waitFor(() => expect(screen.getByText('git-worktree')).toBeInTheDocument())
    // Type after the chip + trailing space.
    setComposerValue(`${TOKEN} hello`)
    fireEvent.click(screen.getByLabelText('Start agent chat'))

    const wireText = `# Agent Skills\n\ngit-worktree: /home/u/.agents/skills/git-worktree/SKILL.md\n\n---\n\n(git-worktree) hello`
    const displayText = `${TOKEN} hello`

    // The optimistic syncBlocks carry the DISPLAY (token) text so the chat
    // timeline renders inline chips.
    await waitFor(() =>
      expect(mockCreateLaunchPlaceholder).toHaveBeenCalledWith(
        expect.objectContaining({
          initialUserBlocks: [{ type: 'text', text: displayText }]
        })
      )
    )
    expect(mockHideAgentLauncher).toHaveBeenCalled()
    expect(mockAddAgentChatTab).toHaveBeenCalledWith('launch-placeholder-1', 'pane1')

    // The real send (finalize) carries the WIRE (path-framed) text — the agent
    // receives paths, not tokens.
    await waitFor(() =>
      expect(mockFinalizeChatLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          initialBlocks: [{ type: 'text', text: wireText }]
        })
      )
    )
  })

  it('toasts and aborts launch when a selected skill has no path (web parity gap)', async () => {
    mockSkills.current = [{ name: 'pathless', description: 'no path', scope: 'project', path: '' }]
    renderLauncher()

    await screen.findByLabelText('Agent prompt')
    setComposerValue('/')
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    selectSlashOption('/pathless')

    await waitFor(() => expect(screen.getByText('pathless')).toBeInTheDocument())
    setComposerValue('\uE000pathless\uE001 hello')
    fireEvent.click(screen.getByLabelText('Start agent chat'))

    // The toast names the missing path; launch is aborted.
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining('missing a path'))
    expect(mockCreateLaunchPlaceholder).not.toHaveBeenCalled()
    expect(mockHideAgentLauncher).not.toHaveBeenCalled()
  })
})

describe('AgentLauncher slash menu parity (mid-text + command chip)', () => {
  const SKILL = {
    name: 'git-worktree',
    description: 'Isolated worktree',
    scope: 'project',
    path: '/home/u/.agents/skills/git-worktree/SKILL.md'
  }

  function selectSlashOption(name: string | RegExp): void {
    const listbox = screen.getByRole('listbox')
    fireEvent.mouseDown(within(listbox).getByText(name))
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens the slash menu at a mid-text slash (parity with the running chatbox)', async () => {
    mockSkills.current = [SKILL]
    renderLauncher()

    await screen.findByLabelText('Agent prompt')
    // Type text before the slash so the trigger is mid-text, not leading.
    // Previously the launcher used `isSlashTrigger` (leading-only) and the
    // menu never opened here; the shared hook now uses `isSlashTriggerAny`.
    setComposerValue('hello /')

    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
  })

  it('renders a CommandChip when a slash command is selected from the menu', async () => {
    const key = 'acp-registry:claude-acp\0/work\0'
    acpStateRef.current.agentConfigs = [ACP_CONFIG]
    mockPersistRead.mockResolvedValue({
      success: true,
      data: { agentId: 'acp-registry:claude-acp', mode: 'acp' }
    })
    acpStateRef.current.preparedSessions = { [key]: 'prepared-1' }
    acpStateRef.current.sessions = { 'prepared-1': preparedSession(ACP_CONFIG) }
    acpStateRef.current.commands = {
      'prepared-1': [{ name: 'compact', description: 'Compact the conversation' }]
    }
    renderLauncher()

    await screen.findByLabelText('Agent prompt')
    setComposerValue('/')

    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    selectSlashOption('/compact')

    // Previously the launcher inserted bare `/compact ` text; it now creates a
    // CommandChip (parity with the running chatbox).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove /compact command' })).toBeInTheDocument()
    )
    // The `/compact` filter text is cleared from the input.
    expect(getComposerValue()).toBe('')
  })
})

describe('AgentLauncher mobile empty-state overflow', () => {
  // CAP-5 / ship-blocker P2: at a 390px mobile viewport the empty-state
  // launcher (hero + suggestion cards + composer) must not clip past the
  // right viewport edge. jsdom cannot measure layout, so this is a structural
  // regression guard asserting the width-constraining Tailwind utilities are
  // present on the launcher root, hero heading, composer column, and
  // suggestion grid. Real-device no-clip is the production signal (see the
  // spec's Verification section).
  it('clamps horizontal overflow via overflow-x-hidden + width constraints', () => {
    renderLauncher()

    // The hero <h1> is the stable entry point (role + level). From it we walk
    // the rendered tree to the hero div, launcher root, and composer column —
    // jsdom preserves the className strings exactly.
    const heading = screen.getByRole('heading', {
      level: 1,
      name: /what should we do in/i
    })
    // Hero div wraps the logo + heading.
    const hero = heading.parentElement!
    // Launcher root is the hero's parent (the absolute inset-0 container).
    const launcherRoot = hero.parentElement!
    // Composer column is the sibling div after the hero, inside the launcher
    // root. It carries `max-w-4xl` + the new `min-w-0`.
    const composerColumn = Array.from(launcherRoot.children).find(
      (el) => el !== hero && el.tagName === 'DIV'
    )!

    // Launcher root: `overflow-x-hidden` backstop + responsive padding.
    expect(launcherRoot.className).toContain('overflow-x-hidden')
    expect(launcherRoot.className).toContain('p-4')
    expect(launcherRoot.className).toContain('sm:p-8')
    // Hero div spans the content box; heading wraps instead of forcing width.
    expect(hero.className).toContain('w-full')
    expect(heading.className).toContain('break-words')
    // Composer column allows flex children to shrink.
    expect(composerColumn.className).toContain('min-w-0')
  })
})

// ============================================================================
// CAP-1/2/3/4 — Worktree-isolated agent chat
// ============================================================================

describe('AgentLauncher worktree isolation', () => {
  function renderLauncher(): void {
    render(
      <TooltipProvider>
        <MemoryRouter>
          <AgentLauncher paneId="pane1" />
        </MemoryRouter>
      </TooltipProvider>
    )
  }

  function enableDesktopGitRepo(branch = 'feat/x'): void {
    vi.mocked(isTauriContext).mockReturnValue(true)
    mockProjectOverride.current = { isGitRepo: true, gitBranch: branch }
  }

  beforeEach(() => {
    enableDesktopGitRepo()
    mockWorktreeCreate.mockReset()
    // Default success: returns a worktree at /work/.termul/worktrees/{name}/
    mockWorktreeCreate.mockResolvedValue({
      success: true,
      data: {
        name: 'abcd1234',
        branch: 'chat/abcd1234',
        path: '/work/.termul/worktrees/abcd1234',
        headCommit: ''
      }
    })
    mockWorktreeCopyInclude.mockReset()
    mockWorktreeCopyInclude.mockResolvedValue({
      success: true,
      data: { ran: 1, copied: 1, skipped: [] }
    })
    mockWorktreeResolveBaseBranch.mockReset()
    // "Clean repo on feat/x, base auto" — no origin/HEAD, so the fallback
    // chain resolves to the current branch (feat/x).
    mockWorktreeResolveBaseBranch.mockResolvedValue({
      success: true,
      data: { defaultBase: 'feat/x', currentBranch: 'feat/x', isDetached: false }
    })
  })

  // CAP-1: the launcher surfaces an isolation-mode selector for git repos;
  // the project branch appears as a worktree base option.
  it('surfaces the project git branch as a worktree base option (CAP-1)', async () => {
    renderLauncher()
    expect(
      screen.getByRole('heading', { level: 1, name: /what should we do in/i })
    ).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Isolation mode' })).toBeInTheDocument()
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Isolation mode' }) as HTMLSelectElement,
      {
        target: { value: 'worktree' }
      }
    )
    await screen.findByRole('option', { name: /feat\/x/ })

    for (const name of ['Isolation mode', 'Base branch']) {
      expect(screen.getByRole('combobox', { name })).toHaveClass(
        'focus-visible:ring-2',
        'focus-visible:ring-ring',
        'focus-visible:ring-offset-2'
      )
    }
  })

  it('renders worktree controls in a separate context strip below the composer', () => {
    renderLauncher()
    const composer = document.querySelector('[data-agent-launcher-composer="true"]')
    const contextStrip = document.querySelector('[data-agent-launcher-context-strip="true"]')

    expect(composer).toBeInTheDocument()
    expect(contextStrip).toBeInTheDocument()
    expect(composer).not.toContainElement(contextStrip)
    expect(composer?.compareDocumentPosition(contextStrip as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('shows the isolation selector when gitBranch is null (CAP-1)', () => {
    mockProjectOverride.current = { isGitRepo: true, gitBranch: null }
    renderLauncher()
    expect(screen.getByRole('combobox', { name: 'Isolation mode' })).toBeInTheDocument()
  })

  // CAP-2: selector hidden on web / non-repo
  it('hides the isolation selector when not a git repo (CAP-2)', () => {
    vi.mocked(isTauriContext).mockReturnValue(true)
    mockProjectOverride.current = null // no isGitRepo
    renderLauncher()
    expect(screen.queryByRole('combobox', { name: 'Base branch' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Isolation mode' })).not.toBeInTheDocument()
  })

  it('hides the isolation selector on web (CAP-2)', () => {
    vi.mocked(isTauriContext).mockReturnValue(false)
    mockProjectOverride.current = { isGitRepo: true, gitBranch: 'feat/x' }
    renderLauncher()
    expect(screen.queryByRole('combobox', { name: 'Base branch' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Isolation mode' })).not.toBeInTheDocument()
  })

  /**
   * Switch to New worktree mode via the isolation-mode selector, then pick the
   * base branch from the context-strip selector via the native `<select>` shim.
   * Waits for the branch option to populate from the async base-branch
   * resolution.
   */
  async function chooseWorktreeBaseBranch(branch: string): Promise<void> {
    const mode = screen.getByRole('combobox', { name: 'Isolation mode' }) as HTMLSelectElement
    fireEvent.change(mode, { target: { value: 'worktree' } })
    await screen.findByRole('option', { name: new RegExp(branch) })
    const base = screen.getByRole('combobox', { name: 'Base branch' }) as HTMLSelectElement
    fireEvent.change(base, { target: { value: branch } })
  }

  // CAP-3: launch in worktree mode calls worktreeApi.create once with chat/{id}
  // then copyIncludeFiles, then threads cwd=worktreePath
  it('creates a worktree, copies includes, and threads cwd=worktreePath on launch (CAP-3)', async () => {
    renderLauncher()
    await chooseWorktreeBaseBranch('feat/x')

    setComposerValue('hi wt')
    fireEvent.click(screen.getByLabelText('Start agent chat'))

    await waitFor(() => expect(mockWorktreeCreate).toHaveBeenCalledTimes(1))
    const createArgs = mockWorktreeCreate.mock.calls[0][0] as {
      branch: string
      isNewBranch: boolean
      startRef: string
    }
    expect(createArgs.branch).toMatch(/^chat\/[a-f0-9]+$/)
    expect(createArgs.isNewBranch).toBe(true)
    expect(createArgs.startRef).toBe('feat/x')

    // copyIncludeFiles ran after create
    await waitFor(() => expect(mockWorktreeCopyInclude).toHaveBeenCalledTimes(1))
    expect(mockWorktreeCopyInclude).toHaveBeenCalledWith('/work', expect.any(String))

    // finalizeChatLaunch received cwd = the worktree path (not /work)
    await waitFor(() => expect(mockFinalizeChatLaunch).toHaveBeenCalledTimes(1))
    const finalizeArgs = mockFinalizeChatLaunch.mock.calls[0][0] as {
      cwd: string
      worktreePath?: string
      worktreeBranch?: string
    }
    expect(finalizeArgs.cwd).toBe('/work/.termul/worktrees/abcd1234')
    expect(finalizeArgs.worktreePath).toBe('/work/.termul/worktrees/abcd1234')
    expect(finalizeArgs.worktreeBranch).toMatch(/^chat\/[a-f0-9]+$/)
  })

  // CAP-4: relaunch of a persisted-worktree session does NOT call worktreeApi.create
  it('does not call worktreeApi.create when relaunching a persisted-worktree session (CAP-4)', async () => {
    // The launcher's launch() only creates a worktree when isolationMode ===
    // 'worktree'. On relaunch, openHistorySession carries the persisted
    // worktreePath onto the live AcpSession, and the launcher is not involved
    // (the chat tab opens directly). So the relevant invariant is: launch()
    // with isolationMode === 'current' (default) never calls worktreeApi.create.
    renderLauncher()
    // Default mode is 'current' — confirm no worktree create on a normal launch.
    setComposerValue('hi')
    fireEvent.click(screen.getByLabelText('Start agent chat'))

    await waitFor(() => expect(mockFinalizeChatLaunch).toHaveBeenCalledTimes(1))
    expect(mockWorktreeCreate).not.toHaveBeenCalled()
    const finalizeArgs = mockFinalizeChatLaunch.mock.calls[0][0] as {
      cwd: string
      worktreePath?: string
    }
    expect(finalizeArgs.cwd).toBe('/work')
    expect(finalizeArgs.worktreePath).toBeUndefined()
  })

  // CAP-3 collision: retry appends `-2` once
  it('retries with a -2 suffix on a single WORKTREE_EXISTS collision (CAP-3)', async () => {
    mockWorktreeCreate.mockReset()
    mockWorktreeCreate
      .mockResolvedValueOnce({ success: false, error: 'exists', code: 'WORKTREE_EXISTS' })
      .mockResolvedValueOnce({
        success: true,
        data: {
          name: 'abcd1234-2',
          branch: 'chat/abcd1234-2',
          path: '/work/.termul/worktrees/abcd1234-2',
          headCommit: ''
        }
      })
    renderLauncher()
    await chooseWorktreeBaseBranch('feat/x')

    setComposerValue('collide')
    fireEvent.click(screen.getByLabelText('Start agent chat'))

    await waitFor(() => expect(mockWorktreeCreate).toHaveBeenCalledTimes(2))
    const firstBranch = (mockWorktreeCreate.mock.calls[0][0] as { branch: string }).branch
    const retryBranch = (mockWorktreeCreate.mock.calls[1][0] as { branch: string }).branch
    expect(retryBranch).toBe(`${firstBranch}-2`)

    await waitFor(() => expect(mockFinalizeChatLaunch).toHaveBeenCalledTimes(1))
    const finalizeArgs = mockFinalizeChatLaunch.mock.calls[0][0] as {
      worktreePath: string
      worktreeBranch: string
    }
    expect(finalizeArgs.worktreeBranch).toBe(`${firstBranch}-2`)
  })

  // CAP-2: on detached HEAD, worktree mode blocks launch until a base branch
  // is picked from the context-strip selector.
  it('blocks worktree launch on detached HEAD until a base branch is picked (CAP-2)', async () => {
    mockWorktreeResolveBaseBranch.mockResolvedValue({
      success: true,
      data: { defaultBase: 'main', currentBranch: undefined, isDetached: true }
    })
    renderLauncher()
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Isolation mode' }) as HTMLSelectElement,
      {
        target: { value: 'worktree' }
      }
    )
    // Wait for the base-branch resolution to settle so the detached-HEAD hint
    // renders (the effect runs async after mode selection).
    await waitFor(() => expect(screen.getByText(/detached head/i)).toBeInTheDocument())
    // No base picked + detached HEAD -> disabled
    expect(screen.getByLabelText('Start agent chat')).toBeDisabled()

    // Picking a base branch unblocks the worktree launch off that ref.
    await screen.findByRole('option', { name: /main/ })
    const select = screen.getByRole('combobox', { name: 'Base branch' }) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'main' } })

    setComposerValue('hi')
    fireEvent.click(screen.getByLabelText('Start agent chat'))

    await waitFor(() => expect(mockWorktreeCreate).toHaveBeenCalledTimes(1))
    const createArgs = mockWorktreeCreate.mock.calls[0][0] as { startRef: string }
    expect(createArgs.startRef).toBe('main')
  })
})

describe('AgentLauncher placeholder', () => {
  it('renders the launcher default placeholder in the empty editor on a ready agent', async () => {
    renderLauncher()

    await screen.findByLabelText('Agent prompt')
    await waitFor(() => {
      expect(document.querySelector('[data-composer-editor="true"] p')).toHaveAttribute(
        'data-placeholder',
        'Ask anything.. (@ for files, / for commands)'
      )
    })
  })

  it('renders the unavailable hint when the selected agent is install-required (composer disabled)', async () => {
    const installRequiredEntry: SupportedAcpAgentEntry = {
      id: 'install-req',
      configId: 'acp-registry:install-req',
      agent: {
        id: 'install-req',
        name: 'Install Required Agent',
        version: '1.0.0',
        description: 'Needs install',
        distribution: { binary: { 'windows-x86_64': { cmd: './install-req.exe', args: ['acp'] } } }
      },
      config: null,
      status: 'install-required',
      install: {
        archiveUrl: 'https://example.invalid/install-req.zip',
        cmd: 'install-req',
        args: ['acp'],
        env: {}
      },
      manualInstall: null,
      runtimeLauncher: null,
      unavailableReason: null
    }
    mockResolvedAgentsOverride.current = [installRequiredEntry]

    renderLauncher()

    // The composer is disabled (selectedEntry.status !== 'ready'), so the
    // Tiptap editor is non-editable. `ChatComposerEditor.tsx:237-240`
    // configures `Placeholder` with `showOnlyWhenEditable: true`, and
    // Tiptap's `buildPlaceholderDecorations` returns `null` when
    // `!editor.isEditable` — so the `data-placeholder` attribute is NOT
    // painted to the DOM while the composer is disabled. The placeholder
    // PROP still evaluates to 'Composer unavailable' (the conditional
    // mirrors ChatInputBar.tsx:664-670), but it is only re-emitted to the
    // DOM once the editor becomes editable again.
    //
    // Non-vacuous regression guard: the attribute must be either absent
    // (Tiptap's `showOnlyWhenEditable` suppresses the decoration when
    // `!editor.isEditable`, so the disabled composer paints no
    // `data-placeholder`) or exactly `'Composer unavailable'` — never the
    // old "follow-up changes" wording, never the launcher default, never
    // any other string.
    await screen.findByLabelText('Agent prompt')
    await waitFor(() => {
      const p = document.querySelector('[data-composer-editor="true"] p')
      const attr = p?.getAttribute('data-placeholder') ?? null
      expect(attr).not.toBe(
        'Ask for follow-up changes or attach files (@ for files, / for commands)'
      )
      expect(attr).not.toBe('Ask anything.. (@ for files, / for commands)')
      expect([null, 'Composer unavailable']).toContain(attr)
    })
  })

  it('renders the optional-message hint when a slash command is staged', async () => {
    const key = 'acp-registry:claude-acp\0/work\0'
    acpStateRef.current.agentConfigs = [ACP_CONFIG]
    mockPersistRead.mockResolvedValue({
      success: true,
      data: { agentId: 'acp-registry:claude-acp', mode: 'acp' }
    })
    acpStateRef.current.preparedSessions = { [key]: 'prepared-1' }
    acpStateRef.current.sessions = { 'prepared-1': preparedSession(ACP_CONFIG) }
    acpStateRef.current.commands = {
      'prepared-1': [{ name: 'compact', description: 'Compact the conversation' }]
    }
    renderLauncher()

    await screen.findByLabelText('Agent prompt')
    setComposerValue('/')

    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    fireEvent.mouseDown(within(screen.getByRole('listbox')).getByText('/compact'))

    await waitFor(() => {
      expect(document.querySelector('[data-composer-editor="true"] p')).toHaveAttribute(
        'data-placeholder',
        'Add a message (optional)…'
      )
    })
  })
})
