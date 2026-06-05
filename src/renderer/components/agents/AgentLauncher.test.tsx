import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { TerminalAgentDefinition } from '@/lib/agents/agent-registry'
import { __resetLauncherSelectionCache, AgentLauncher } from './AgentLauncher'

const {
  mockLaunchAgentInPane,
  mockStartChat,
  mockSendPrompt,
  mockAddAgentChatTab,
  mockHideAgentLauncher,
  mockShowAgentLauncher,
  mockGetAvailableShells,
  mockPersistRead,
  mockPersistWrite,
  mockLoadAllAgents,
  mockNavigate,
  acpConfigsRef
} = vi.hoisted(() => ({
  mockLaunchAgentInPane: vi.fn(),
  mockStartChat: vi.fn(),
  mockSendPrompt: vi.fn(),
  mockAddAgentChatTab: vi.fn(),
  mockHideAgentLauncher: vi.fn(),
  mockShowAgentLauncher: vi.fn(),
  mockGetAvailableShells: vi.fn(),
  mockPersistRead: vi.fn(),
  mockPersistWrite: vi.fn(),
  mockLoadAllAgents: vi.fn(),
  mockNavigate: vi.fn(),
  acpConfigsRef: { current: [] as StoredAgentConfig[] }
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock('@/lib/agent-launch', () => ({ launchAgentInPane: mockLaunchAgentInPane }))

vi.mock('@/lib/api', () => ({
  shellApi: { getAvailableShells: mockGetAvailableShells },
  persistenceApi: { read: mockPersistRead, write: mockPersistWrite }
}))

vi.mock('@/lib/agents/custom-agents', () => ({
  loadAllAgents: mockLoadAllAgents,
  upsertCustomAgent: vi.fn()
}))

vi.mock('@/lib/worktree-context', () => ({
  getDefaultCwdForProject: () => '/work'
}))

vi.mock('@/stores/app-settings-store', () => ({
  useDefaultShell: () => undefined,
  useMaxTerminalsPerProject: () => 10
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
    showAgentLauncher: mockShowAgentLauncher,
    addAgentChatTab: mockAddAgentChatTab,
    activePaneId: 'pane1'
  }
  const useWorkspaceStore = (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state)
  useWorkspaceStore.getState = () => state
  return { useWorkspaceStore }
})

vi.mock('@/stores/acp-store', () => {
  const getState = () => ({ startChat: mockStartChat, sendPrompt: mockSendPrompt })
  const useAcpStore = (sel?: (s: { agentConfigs: StoredAgentConfig[] }) => unknown) =>
    sel ? sel({ agentConfigs: acpConfigsRef.current }) : getState()
  useAcpStore.getState = getState
  return { useAcpStore }
})

const CLI_AGENT: TerminalAgentDefinition = {
  id: 'claude-code',
  name: 'Claude Code',
  command: 'claude',
  baseArgs: [],
  promptMode: 'positional',
  registryId: 'claude-acp',
  isBuiltIn: true
}

const ACP_CONFIG: StoredAgentConfig = {
  id: 'acp-registry:claude-acp',
  name: 'Claude (ACP)',
  command: 'npx',
  args: ['-y', 'claude-acp'],
  env: {},
  templateId: 'claude-acp'
}

function renderLauncher(agents?: TerminalAgentDefinition[]): void {
  render(
    <MemoryRouter>
      <AgentLauncher paneId="pane1" agents={agents} />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetLauncherSelectionCache()
  acpConfigsRef.current = []
  mockGetAvailableShells.mockResolvedValue({ success: true, data: { available: [] } })
  mockPersistRead.mockResolvedValue({ success: true, data: undefined })
  mockPersistWrite.mockResolvedValue({ success: true })
  mockLoadAllAgents.mockResolvedValue([CLI_AGENT])
  mockLaunchAgentInPane.mockResolvedValue({ success: true })
  mockStartChat.mockResolvedValue('session-1')
})

describe('AgentLauncher routing', () => {
  it('routes a CLI-mode submit to launchAgentInPane', async () => {
    renderLauncher()
    await waitFor(() => expect(mockLoadAllAgents).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('Agent prompt'), { target: { value: 'do it' } })
    fireEvent.click(screen.getByLabelText(/Launch/))

    await waitFor(() => expect(mockLaunchAgentInPane).toHaveBeenCalledTimes(1))
    expect(mockStartChat).not.toHaveBeenCalled()
    const [paneId, projectId, cwd, def, prompt] = mockLaunchAgentInPane.mock.calls[0]
    expect(paneId).toBe('pane1')
    expect(projectId).toBe('p1')
    expect(cwd).toBe('/work')
    expect(def.id).toBe('claude-code')
    expect(prompt).toBe('do it')
    expect(mockPersistWrite).toHaveBeenCalledWith('agents/last-selected', {
      agentId: 'claude-code',
      mode: 'cli'
    })
  })

  it('routes an ACP-mode submit to startChat + addAgentChatTab and forwards the prompt', async () => {
    acpConfigsRef.current = [ACP_CONFIG]
    renderLauncher()
    await waitFor(() => expect(mockLoadAllAgents).toHaveBeenCalled())

    // Dual-mode agent: switch to ACP.
    fireEvent.click(screen.getByLabelText('Run as ACP'))
    fireEvent.change(screen.getByLabelText('Agent prompt'), { target: { value: 'hello acp' } })
    fireEvent.click(screen.getByLabelText(/Launch/))

    await waitFor(() => expect(mockStartChat).toHaveBeenCalledTimes(1))
    expect(mockStartChat).toHaveBeenCalledWith('acp-registry:claude-acp', '/work')
    await waitFor(() => expect(mockAddAgentChatTab).toHaveBeenCalledWith('session-1', 'pane1'))
    expect(mockSendPrompt).toHaveBeenCalledWith('session-1', 'hello acp')
    expect(mockLaunchAgentInPane).not.toHaveBeenCalled()
  })

  it('locks a single-mode CLI agent to cli (no toggle rendered)', async () => {
    mockLoadAllAgents.mockResolvedValue([{ ...CLI_AGENT, registryId: undefined }])
    renderLauncher()
    await waitFor(() => expect(mockLoadAllAgents).toHaveBeenCalled())

    expect(screen.queryByLabelText('Run as ACP')).toBeNull()
    fireEvent.click(screen.getByLabelText(/Launch/))
    await waitFor(() => expect(mockLaunchAgentInPane).toHaveBeenCalledTimes(1))
  })

  it('restores a persisted ACP selection, migrating mode', async () => {
    acpConfigsRef.current = [ACP_CONFIG]
    mockPersistRead.mockResolvedValue({
      success: true,
      data: { agentId: 'acp-registry:claude-acp', mode: 'acp' }
    })
    renderLauncher()
    await waitFor(() => expect(mockLoadAllAgents).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('Agent prompt'), { target: { value: 'x' } })
    fireEvent.click(screen.getByLabelText(/Launch/))
    await waitFor(() => expect(mockStartChat).toHaveBeenCalledTimes(1))
  })

  it('has no launchable agent and does not route when none are available', async () => {
    // Force the empty state: no CLI agents (prop) and no enabled ACP configs.
    acpConfigsRef.current = []
    renderLauncher([])
    fireEvent.change(screen.getByLabelText('Agent prompt'), { target: { value: 'x' } })
    fireEvent.click(screen.getByLabelText(/Launch/))
    await Promise.resolve()
    expect(mockLaunchAgentInPane).not.toHaveBeenCalled()
    expect(mockStartChat).not.toHaveBeenCalled()
  })
})
