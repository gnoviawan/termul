import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import { useAcpAgents } from './use-acp-agents'

const { mockLoadAgentConfigs, mockPrewarmAgent, stateRef, projectRef } = vi.hoisted(() => ({
  mockLoadAgentConfigs: vi.fn(),
  mockPrewarmAgent: vi.fn(),
  stateRef: { current: { agentConfigs: [] as StoredAgentConfig[] } },
  projectRef: { current: { activeProjectId: 'proj-1' as string } }
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
  })

  it('loads agent configs on mount', async () => {
    renderHook(() => useAcpAgents())
    await waitFor(() => expect(mockLoadAgentConfigs).toHaveBeenCalledTimes(1))
  })

  it('prewarms each enabled agent after configs load', async () => {
    // The store mutates its own state during loadAgentConfigs; simulate that by
    // populating agentConfigs as the load resolves.
    mockLoadAgentConfigs.mockImplementation(async () => {
      stateRef.current.agentConfigs = [config('a'), config('b')]
    })

    renderHook(() => useAcpAgents())

    await waitFor(() => {
      expect(mockPrewarmAgent).toHaveBeenCalledWith('a', '/work/proj-1')
      expect(mockPrewarmAgent).toHaveBeenCalledWith('b', '/work/proj-1')
    })
    expect(mockPrewarmAgent).toHaveBeenCalledTimes(2)
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

  it('prewarms nothing when no agents are enabled', async () => {
    renderHook(() => useAcpAgents())
    await waitFor(() => expect(mockLoadAgentConfigs).toHaveBeenCalled())
    expect(mockPrewarmAgent).not.toHaveBeenCalled()
  })
})
