import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import {
  buildSupportedAcpAgents,
  pickDefaultSupportedAgent
} from '@/lib/agents/supported-acp-agents'
import { useAcpAgents } from './use-acp-agents'

const {
  mockLoadAgentConfigs,
  mockPrewarmAgent,
  mockSaveAgentConfig,
  mockSetSelectedAgentConfigId,
  mockRetargetWarmPool,
  mockPersistRead,
  stateRef,
  projectRef
} = vi.hoisted(() => ({
  mockLoadAgentConfigs: vi.fn(),
  mockPrewarmAgent: vi.fn(),
  mockSaveAgentConfig: vi.fn(),
  mockSetSelectedAgentConfigId: vi.fn(),
  mockRetargetWarmPool: vi.fn(),
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

vi.mock('@/lib/acp-api', () => ({
  acpApi: {
    probeRuntime: vi.fn(async () => ({ npx: true, uvx: true }))
  }
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
    prewarmAgent: mockPrewarmAgent,
    setSelectedAgentConfigId: mockSetSelectedAgentConfigId,
    retargetWarmPool: mockRetargetWarmPool
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
    expect(mockSetSelectedAgentConfigId).toHaveBeenCalledWith('acp-registry:gemini')
    expect(mockRetargetWarmPool).toHaveBeenCalledWith(
      'acp-registry:gemini',
      '/work/proj-1',
      'proj-1'
    )
  })

  it('prewarms the default supported agent when no selection is persisted', async () => {
    const defaultAgent = pickDefaultSupportedAgent(
      buildSupportedAcpAgents([], 'windows-x86_64', undefined, {
        npx: true,
        uvx: true
      })
    )
    expect(defaultAgent).toBeDefined()

    renderHook(() => useAcpAgents())

    await waitFor(() => {
      expect(mockPrewarmAgent).toHaveBeenCalledWith(defaultAgent?.configId, '/work/proj-1')
    })
    expect(mockSaveAgentConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        id: defaultAgent?.configId,
        templateId: defaultAgent?.id
      })
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

  it('re-warms when activeProjectId changes after mount', async () => {
    projectRef.current.activeProjectId = 'proj-1'
    mockLoadAgentConfigs.mockImplementation(async () => {
      stateRef.current.agentConfigs = [config('acp-registry:claude-acp')]
    })
    mockPersistRead.mockResolvedValue({ success: true, data: undefined })

    const { rerender } = renderHook(() => useAcpAgents())

    await waitFor(() => {
      expect(mockPrewarmAgent).toHaveBeenCalledWith(expect.any(String), '/work/proj-1')
    })

    const firstCallCount = mockPrewarmAgent.mock.calls.length

    // Simulate project switch
    projectRef.current.activeProjectId = 'proj-2'
    rerender()

    await waitFor(() => {
      expect(mockPrewarmAgent).toHaveBeenCalledWith(expect.any(String), '/work/proj-2')
    })
    expect(mockPrewarmAgent.mock.calls.length).toBeGreaterThan(firstCallCount)
  })

  it('does not prewarm on mount when activeProjectId is empty, then prewarms after it resolves', async () => {
    projectRef.current.activeProjectId = ''
    mockLoadAgentConfigs.mockImplementation(async () => {
      stateRef.current.agentConfigs = [config('acp-registry:claude-acp')]
    })
    mockPersistRead.mockResolvedValue({ success: true, data: undefined })

    const { rerender } = renderHook(() => useAcpAgents())

    await waitFor(() => expect(mockLoadAgentConfigs).toHaveBeenCalled())
    expect(mockPrewarmAgent).not.toHaveBeenCalled()

    // Project resolves after mount
    projectRef.current.activeProjectId = 'proj-late'
    rerender()

    await waitFor(() => {
      expect(mockPrewarmAgent).toHaveBeenCalledWith(expect.any(String), '/work/proj-late')
    })
  })

  it('cancels the stale prewarm run when the active project switches mid-flight', async () => {
    projectRef.current.activeProjectId = 'proj-1'
    mockLoadAgentConfigs.mockImplementation(async () => {
      stateRef.current.agentConfigs = [config('acp-registry:claude-acp')]
    })
    // Block each in-flight run at persistenceApi.read (which runs AFTER the cwd
    // snapshot) so a project switch can happen while run #1 is still in flight.
    const persistResolvers: Array<() => void> = []
    mockPersistRead.mockImplementation(
      () =>
        new Promise<{ success: boolean; data: unknown }>((resolve) => {
          persistResolvers.push(() => resolve({ success: true, data: undefined }))
        })
    )

    const { rerender } = renderHook(() => useAcpAgents())

    // Run #1 (proj-1) is in flight, blocked on persistRead; cwd = '/work/proj-1'.
    await waitFor(() => expect(persistResolvers).toHaveLength(1))

    // Switch project + re-render: cleanup cancels run #1; run #2 (proj-2) starts.
    projectRef.current.activeProjectId = 'proj-2'
    rerender()
    await waitFor(() => expect(persistResolvers).toHaveLength(2))

    // Resume run #1 (cancelled) — it must NOT prewarm the stale proj-1 cwd.
    persistResolvers[0]()
    // Resume run #2 (the latest) — it prewarms the proj-2 cwd.
    persistResolvers[1]()

    await waitFor(() => {
      expect(mockPrewarmAgent).toHaveBeenCalledWith(expect.any(String), '/work/proj-2')
    })
    expect(mockPrewarmAgent).not.toHaveBeenCalledWith(expect.any(String), '/work/proj-1')
  })

  it('cancels the in-flight prewarm when the component unmounts before persistRead resolves', async () => {
    projectRef.current.activeProjectId = 'proj-1'
    mockLoadAgentConfigs.mockImplementation(async () => {
      stateRef.current.agentConfigs = [config('acp-registry:claude-acp')]
    })
    // Block the run at persistenceApi.read (which runs AFTER the cwd snapshot)
    // so unmount can happen while the prewarm sequence is still in flight.
    let resolvePersistRead!: () => void
    mockPersistRead.mockImplementation(
      () =>
        new Promise<{ success: boolean; data: unknown }>((resolve) => {
          resolvePersistRead = () => resolve({ success: true, data: undefined })
        })
    )

    const { unmount } = renderHook(() => useAcpAgents())

    // The run is in flight, blocked on persistRead; cwd = '/work/proj-1'.
    await waitFor(() => expect(mockPersistRead).toHaveBeenCalledTimes(1))

    // Unmount fires the effect cleanup -> cancelled = true.
    unmount()

    // Resume the in-flight continuation; it must no-op and never prewarm.
    resolvePersistRead()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockPrewarmAgent).not.toHaveBeenCalled()
  })
})
