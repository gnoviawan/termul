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
  mockSetConfigOption,
  mockSetMode,
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
  mockSetConfigOption: vi.fn(),
  mockSetMode: vi.fn(),
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

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock('@/lib/api', () => ({
  persistenceApi: { read: mockPersistRead, write: mockPersistWrite }
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
    setConfigOption: mockSetConfigOption,
    setMode: mockSetMode
  })
  const useAcpStore = (sel?: (s: typeof acpStateRef.current) => unknown) =>
    sel ? sel(acpStateRef.current) : getState()
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
      currentModeId: 'build',
      availableModes: [
        { id: 'build', name: 'Build' },
        { id: 'plan', name: 'Plan' }
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
  mockSetConfigOption.mockResolvedValue(undefined)
  mockSetMode.mockResolvedValue(undefined)
})

describe('AgentLauncher ACP new thread', () => {
  it('routes submit to ACP startChat + addAgentChatTab and forwards the prompt', async () => {
    acpStateRef.current.agentConfigs = [ACP_CONFIG]
    renderLauncher()

    fireEvent.change(screen.getByLabelText('Agent prompt'), { target: { value: 'hello acp' } })
    fireEvent.click(screen.getByLabelText('Start agent chat'))

    await waitFor(() => expect(mockStartChat).toHaveBeenCalledTimes(1))
    expect(mockStartChat).toHaveBeenCalledWith('acp-registry:claude-acp', '/work')
    await waitFor(() => expect(mockAddAgentChatTab).toHaveBeenCalledWith('session-1', 'pane1'))
    expect(mockSendPrompt).toHaveBeenCalledWith('session-1', 'hello acp')
    expect(mockPersistWrite).toHaveBeenCalledWith('agents/last-selected', {
      agentId: 'acp-registry:claude-acp',
      mode: 'acp'
    })
  })

  it('prepares the selected ACP session in the background', async () => {
    acpStateRef.current.agentConfigs = [ACP_CONFIG]
    renderLauncher()

    await waitFor(() =>
      expect(mockPrepareChat).toHaveBeenCalledWith('acp-registry:claude-acp', '/work')
    )
    expect(mockStartChat).not.toHaveBeenCalled()
  })

  it('reaps an unconsumed prepared session when the launcher unmounts', async () => {
    acpStateRef.current.agentConfigs = [ACP_CONFIG]
    const { unmount } = render(
      <MemoryRouter>
        <AgentLauncher paneId="pane1" />
      </MemoryRouter>
    )

    await waitFor(() =>
      expect(mockPrepareChat).toHaveBeenCalledWith('acp-registry:claude-acp', '/work')
    )
    unmount()

    expect(mockCancelPreparedChat).toHaveBeenCalledWith('acp-registry:claude-acp\0/work\0')
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

  it('uses the prepared session for model and Agent/mode picker actions', async () => {
    const key = 'acp-registry:claude-acp\0/work\0'
    acpStateRef.current.agentConfigs = [ACP_CONFIG]
    acpStateRef.current.preparedSessions = { [key]: 'prepared-1' }
    acpStateRef.current.sessions = { 'prepared-1': preparedSession(ACP_CONFIG) }
    renderLauncher()

    fireEvent.click(screen.getByText('Model One'))
    fireEvent.click(await screen.findByText('Model Two'))
    expect(mockSetConfigOption).toHaveBeenCalledWith('prepared-1', 'model', 'm2')

    fireEvent.click(screen.getByText('Build'))
    fireEvent.click(await screen.findByText('Plan'))
    expect(mockSetMode).toHaveBeenCalledWith('prepared-1', 'plan')
  })

  it('shows preferences empty state when no ACP agents are enabled', () => {
    renderLauncher()

    expect(screen.getByText('No ACP agents enabled')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Open Preferences'))
    expect(mockNavigate).toHaveBeenCalledWith('/preferences')
  })
})
