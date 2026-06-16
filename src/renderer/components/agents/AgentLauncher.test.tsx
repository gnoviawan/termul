import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { AcpSession } from '@/stores/acp-store'
import { __resetLauncherSelectionCache, AgentLauncher } from './AgentLauncher'

const {
  mockStartChat,
  mockPrepareChat,
  mockCancelPreparedChat,
  mockSendPrompt,
  mockSaveAgentConfig,
  mockSetConfigOption,
  mockSetMode,
  mockInstallRegistryBinary,
  mockAddAgentChatTab,
  mockHideAgentLauncher,
  mockPersistRead,
  mockPersistWrite,
  mockNavigate,
  acpStateRef
} = vi.hoisted(() => ({
  mockStartChat: vi.fn(),
  mockPrepareChat: vi.fn(),
  mockCancelPreparedChat: vi.fn(),
  mockSendPrompt: vi.fn(),
  mockSaveAgentConfig: vi.fn(),
  mockSetConfigOption: vi.fn(),
  mockSetMode: vi.fn(),
  mockInstallRegistryBinary: vi.fn(),
  mockAddAgentChatTab: vi.fn(),
  mockHideAgentLauncher: vi.fn(),
  mockPersistRead: vi.fn(),
  mockPersistWrite: vi.fn(),
  mockNavigate: vi.fn(),
  acpStateRef: {
    current: {
      agentConfigs: [] as StoredAgentConfig[],
      preparedSessions: {} as Record<string, string>,
      preparingChatKeys: {} as Record<string, true>,
      sessions: {} as Record<string, AcpSession>,
      pendingAuth: {},
      commands: {}
    }
  }
}))

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(() => 'windows'),
  arch: vi.fn(() => 'x86_64')
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock('@/lib/api', () => ({
  persistenceApi: { read: mockPersistRead, write: mockPersistWrite }
}))

vi.mock('@/lib/acp-api', () => ({
  acpApi: { installRegistryBinary: mockInstallRegistryBinary }
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
  return { useProjectStore }
})

vi.mock('@/stores/workspace-store', () => {
  const state = {
    hideAgentLauncher: mockHideAgentLauncher,
    addAgentChatTab: mockAddAgentChatTab,
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
    sendPrompt: mockSendPrompt,
    saveAgentConfig: mockSaveAgentConfig,
    setConfigOption: mockSetConfigOption,
    setMode: mockSetMode
  })
  type MockAcpState = typeof acpStateRef.current & { saveAgentConfig: typeof mockSaveAgentConfig }
  const useAcpStore = (sel?: (s: MockAcpState) => unknown) =>
    sel ? sel({ ...acpStateRef.current, saveAgentConfig: mockSaveAgentConfig }) : getState()
  useAcpStore.getState = getState
  const useAcpSession = (sessionId: string | null) =>
    sessionId ? (acpStateRef.current.sessions[sessionId] ?? null) : null
  const prepareChatKey = (configId: string, cwd: string) => `${configId}\0${cwd}\0`
  return { useAcpStore, useAcpSession, prepareChatKey }
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

function preparedSession(config: StoredAgentConfig): AcpSession {
  return {
    id: 'prepared-1',
    agentId: `agent:${config.id}`,
    cwd: '/work',
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
        currentValue: 'm1',
        options: [
          { value: 'm1', name: 'Model One' },
          { value: 'm2', name: 'Model Two' }
        ]
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
    <MemoryRouter>
      <AgentLauncher paneId="pane1" />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetLauncherSelectionCache()
  acpStateRef.current = {
    agentConfigs: [],
    preparedSessions: {},
    preparingChatKeys: {},
    sessions: {},
    pendingAuth: {},
    commands: {}
  }
  mockPersistRead.mockResolvedValue({ success: true, data: undefined })
  mockPersistWrite.mockResolvedValue({ success: true })
  mockStartChat.mockResolvedValue('session-1')
  mockSaveAgentConfig.mockImplementation(async (config: StoredAgentConfig) => {
    const existing = acpStateRef.current.agentConfigs.findIndex((entry) => entry.id === config.id)
    acpStateRef.current.agentConfigs =
      existing === -1
        ? [...acpStateRef.current.agentConfigs, config]
        : acpStateRef.current.agentConfigs.map((entry) => (entry.id === config.id ? config : entry))
  })
  mockSetConfigOption.mockResolvedValue(undefined)
  mockSetMode.mockResolvedValue(undefined)
  mockInstallRegistryBinary.mockResolvedValue({ command: 'opencode.exe', args: ['acp'] })
})

describe('AgentLauncher ACP new thread', () => {
  it('routes submit to ACP startChat + addAgentChatTab and forwards the prompt', async () => {
    renderLauncher()

    fireEvent.change(screen.getByLabelText('Agent prompt'), { target: { value: 'hello acp' } })
    fireEvent.click(screen.getByLabelText('Start agent chat'))

    await waitFor(() => expect(mockStartChat).toHaveBeenCalledTimes(1))
    expect(mockStartChat).toHaveBeenCalledWith('acp-registry:codex-acp', '/work')
    await waitFor(() => expect(mockAddAgentChatTab).toHaveBeenCalledWith('session-1', 'pane1'))
    expect(mockSendPrompt).toHaveBeenCalledWith('session-1', 'hello acp')
    expect(mockPersistWrite).toHaveBeenCalledWith('agents/last-selected', {
      agentId: 'acp-registry:codex-acp',
      mode: 'acp'
    })
  })

  it('prepares the selected ACP session in the background', async () => {
    renderLauncher()

    await waitFor(() =>
      expect(mockPrepareChat).toHaveBeenCalledWith('acp-registry:codex-acp', '/work')
    )
    expect(mockStartChat).not.toHaveBeenCalled()
  })

  it('reaps an unconsumed prepared session when the launcher unmounts', async () => {
    const { unmount } = render(
      <MemoryRouter>
        <AgentLauncher paneId="pane1" />
      </MemoryRouter>
    )

    await waitFor(() =>
      expect(mockPrepareChat).toHaveBeenCalledWith('acp-registry:codex-acp', '/work')
    )
    unmount()

    expect(mockCancelPreparedChat).toHaveBeenCalledWith('acp-registry:codex-acp\0/work\0')
  })

  it('restores a persisted ACP selection', async () => {
    acpStateRef.current.agentConfigs = [ACP_CONFIG, OTHER_ACP_CONFIG]
    mockPersistRead.mockResolvedValue({
      success: true,
      data: { agentId: 'acp-registry:opencode', mode: 'acp' }
    })
    renderLauncher()

    await waitFor(() =>
      expect(mockPrepareChat).toHaveBeenCalledWith('acp-registry:opencode', '/work')
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

    expect(
      await screen.findByRole('button', { name: 'Select ACP agent: Claude Agent' })
    ).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Select model: Model One' }))
    fireEvent.click(await screen.findByText('Model Two'))
    expect(mockSetConfigOption).toHaveBeenCalledWith('prepared-1', 'model', 'm2')

    mockSetConfigOption.mockClear()
    expect(screen.getAllByRole('button', { name: /^Agent$/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /^Agent$/ }))
    fireEvent.click(await screen.findByText('Plan'))
    expect(mockSetMode).toHaveBeenCalledWith('prepared-1', 'plan')
    expect(mockSetConfigOption).not.toHaveBeenCalled()
  }, 10000)

  it('shows supported ACP agents when no configs are persisted', async () => {
    renderLauncher()

    expect(screen.queryByText('No ACP agents enabled')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Select ACP agent: Codex CLI' }))
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
  })

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
})
