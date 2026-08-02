import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import * as supportedAcpAgents from '@/lib/agents/supported-acp-agents'
import {
  buildSupportedAcpAgents,
  pickDefaultSupportedAgent,
  type SupportedAcpAgentEntry
} from '@/lib/agents/supported-acp-agents'
import type { AcpSession } from '@/stores/acp-store'
import { __resetLauncherSelectionCache, AgentLauncher } from './AgentLauncher'

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
  mockAddAgentChatTab,
  mockRemapAgentChatSession,
  mockHideAgentLauncher,
  mockPersistRead,
  mockPersistWrite,
  mockNavigate,
  mockRetargetWarmPool,
  mockSetSelectedAgentConfigId,
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
  mockAddAgentChatTab: vi.fn(),
  mockRemapAgentChatSession: vi.fn(),
  mockHideAgentLauncher: vi.fn(),
  mockPersistRead: vi.fn(),
  mockPersistWrite: vi.fn(),
  mockNavigate: vi.fn(),
  mockRetargetWarmPool: vi.fn(),
  mockSetSelectedAgentConfigId: vi.fn(),
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
      agents: {} as Record<string, { id: string; capabilities: unknown; authMethods?: unknown[] }>
    }
  }
}))

const { mockSkills, mockToastError } = vi.hoisted(() => ({
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
  mockToastError: vi.fn()
}))

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

vi.mock('@/lib/acp-api', () => ({
  acpApi: {
    installRegistryBinary: mockInstallRegistryBinary,
    probeRuntime: vi.fn(async () => ({ npx: true, uvx: true }))
  }
}))

vi.mock('@/lib/worktree-context', () => ({
  getDefaultCwdForProject: () => '/work'
}))

vi.mock('@/stores/project-store', () => {
  const state = {
    activeProjectId: 'p1',
    projects: [{ id: 'p1', name: 'P', path: '/work', defaultShell: undefined }]
  }
  const useProjectStore = (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state)
  useProjectStore.getState = () => state
  const useActiveProject = () => state.projects.find((p) => p.id === state.activeProjectId)
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
  }
  const useAcpStore = (sel?: (s: MockAcpState) => unknown) =>
    sel
      ? sel({
          ...acpStateRef.current,
          saveAgentConfig: mockSaveAgentConfig,
          retargetWarmPool: mockRetargetWarmPool,
          setSelectedAgentConfigId: mockSetSelectedAgentConfigId
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
    agents: {}
  }
  mockAuthenticateAgent.mockResolvedValue(undefined)
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
})

describe('AgentLauncher ACP new thread', () => {
  it('opens chat instantly via placeholder then finalizes ACP in the background', async () => {
    const defaultAgent = defaultReadyAgent()
    renderLauncher()

    fireEvent.change(screen.getByLabelText('Agent prompt'), { target: { value: 'hello acp' } })
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

    fireEvent.change(screen.getByLabelText('Agent prompt'), { target: { value: 'ready now' } })
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
    expect(mockInstallRegistryBinary).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Install'))

    await waitFor(() => expect(mockInstallRegistryBinary).toHaveBeenCalledTimes(1))
    expect(mockInstallRegistryBinary).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'opencode', cmd: './opencode.exe', args: ['acp'] })
    )
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
    vi.spyOn(supportedAcpAgents, 'buildSupportedAcpAgents').mockReturnValue([manualEntry])
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

    fireEvent.change(screen.getByLabelText('Agent prompt'), { target: { value: 'hello cold' } })
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
  const TOKEN = '\uE000git-worktree\uE001'

  function selectSlashOption(name: string | RegExp): void {
    const listbox = screen.getByRole('listbox')
    fireEvent.mouseDown(within(listbox).getByText(name))
  }

  it('shows a Skills section in the launcher slash menu and renders an inline chip on pick', async () => {
    mockSkills.current = [SKILL_GIT]
    renderLauncher()

    const textarea = await screen.findByLabelText('Agent prompt')
    fireEvent.change(textarea, { target: { value: '/' } })

    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    expect(screen.getByText('Skills')).toBeInTheDocument()

    selectSlashOption('/git-worktree')

    // The transparent-textarea overlay renders the chip name as a visible span
    // (after the slash menu closes, it is the stable selector for the chip).
    await waitFor(() => expect(screen.getByText('git-worktree')).toBeInTheDocument())
    // The `/` filter text is cleared; the value carries the token + trailing space.
    expect(textarea).toHaveValue(`${TOKEN} `)
  })

  it('launch injects the wire (path-framed) text into the real send while the optimistic preview carries the display (token) text', async () => {
    mockSkills.current = [SKILL_GIT]
    renderLauncher()

    const textarea = await screen.findByLabelText('Agent prompt')
    fireEvent.change(textarea, { target: { value: '/' } })
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    selectSlashOption('/git-worktree')

    await waitFor(() => expect(screen.getByText('git-worktree')).toBeInTheDocument())
    // Type after the chip + trailing space.
    fireEvent.change(textarea, { target: { value: `${TOKEN} hello` } })
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

    const textarea = await screen.findByLabelText('Agent prompt')
    fireEvent.change(textarea, { target: { value: '/' } })
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
    selectSlashOption('/pathless')

    await waitFor(() => expect(screen.getByText('pathless')).toBeInTheDocument())
    fireEvent.change(textarea, { target: { value: '\uE000pathless\uE001 hello' } })
    fireEvent.click(screen.getByLabelText('Start agent chat'))

    // The toast names the missing path; launch is aborted.
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining('missing a path'))
    expect(mockCreateLaunchPlaceholder).not.toHaveBeenCalled()
    expect(mockHideAgentLauncher).not.toHaveBeenCalled()
  })
})
