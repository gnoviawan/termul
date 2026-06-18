import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import { useAcpAgents } from './use-acp-agents'

const {
  mockLoadAgentConfigs,
  mockPrewarmAgent,
  mockSaveAgentConfig,
  mockPersistRead,
  stateRef,
  projectRef
} = vi.hoisted(() => ({
  mockLoadAgentConfigs: vi.fn(),
  mockPrewarmAgent: vi.fn(),
  mockSaveAgentConfig: vi.fn(),
  mockPersistRead: vi.fn(),
  stateRef: { current: { agentConfigs: [] as StoredAgentConfig[] } },
  projectRef: { current: { activeProjectId: 'proj-1' as string } }
}))

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(() => 'windows'),
  arch: vi.fn(() => 'x86_64')
}))

vi.mock('@/lib/api', () => ({
  persistenceApi: { read: mockPersistRead }
}))

vi.mock('@/lib/worktree-context', () => ({
  getDefaultCwdForProject: (projectId: string) => `/work/${projectId}`
}))

vi.mock('@/stores/project-store', () => {
  const getState = () => ({ activeProjectId: projectRef.current.activeProjectId })
  const useProjectStore = (sel?: (s: ReturnType<typeof getState>) => unknown) =>
    sel ? sel(getState()) : getState()
  useProjectStore.getState = getState
  return { useProjectStore }
})

vi.mock('@/stores/acp-store', () => {
  const getState = () => ({
    agentConfigs: stateRef.current.agentConfigs,
    loadAgentConfigs: mockLoadAgentConfigs,
    saveAgentConfig: mockSaveAgentConfig,
    prewarmAgent: mockPrewarmAgent
  })
  const useAcpStore = (sel?: (s: ReturnType<typeof getState>) => unknown) =>
    sel ? sel(getState()) : getState()
  useAcpStore.getState = getState
  return { useAcpStore }
})

function config(id: string): StoredAgentConfig {
  return { id, name: id, command: 'npx', args: [], env: {}, templateId: id }
}

describe('useAcpAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stateRef.current.agentConfigs = []
    projectRef.current.activeProjectId = 'proj-1'
    mockLoadAgentConfigs.mockResolvedValue(undefined)
    mockPersistRead.mockResolvedValue({ success: true, data: undefined })
    mockSaveAgentConfig.mockImplementation(async (entry: StoredAgentConfig) => {
      stateRef.current.agentConfigs = [...stateRef.current.agentConfigs, entry]
    })
  })

  it('loads agent configs on mount', async () => {
    renderHook(() => useAcpAgents())
    await waitFor(() => expect(mockLoadAgentConfigs).toHaveBeenCalledTimes(1))
  })

  it('prewarms only the selected ready agent after configs load', async () => {
    // The store mutates its own state during loadAgentConfigs; simulate that by
    // populating agentConfigs as the load resolves.
    mockLoadAgentConfigs.mockImplementation(async () => {
      stateRef.current.agentConfigs = [
        config('acp-registry:claude-acp'),
        config('acp-registry:gemini')
      ]
    })
    mockPersistRead.mockResolvedValue({
      success: true,
      data: { agentId: 'acp-registry:gemini', mode: 'acp' }
    })

    renderHook(() => useAcpAgents())

    await waitFor(() => {
      expect(mockPrewarmAgent).toHaveBeenCalledWith('acp-registry:gemini', '/work/proj-1')
    })
    expect(mockPrewarmAgent).toHaveBeenCalledTimes(1)
  })

  it('prewarms the default supported agent when no selection is persisted', async () => {
    renderHook(() => useAcpAgents())

    await waitFor(() => {
      expect(mockPrewarmAgent).toHaveBeenCalledWith('acp-registry:codex-acp', '/work/proj-1')
    })
    expect(mockSaveAgentConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'acp-registry:codex-acp', templateId: 'codex-acp' })
    )
    expect(mockPrewarmAgent).toHaveBeenCalledTimes(1)
  })

  it('prewarms nothing when no active project cwd is available', async () => {
    projectRef.current.activeProjectId = ''
    mockLoadAgentConfigs.mockImplementation(async () => {
      stateRef.current.agentConfigs = [config('a')]
    })

    renderHook(() => useAcpAgents())

    await waitFor(() => expect(mockLoadAgentConfigs).toHaveBeenCalled())
    expect(mockPrewarmAgent).not.toHaveBeenCalled()
  })
})
