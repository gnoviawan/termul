import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRegistryCatalog, mockListCatalog } = vi.hoisted(() => ({
  mockRegistryCatalog: {
    usingRemoteRegistry: true,
    remoteAvailable: false,
    advisorySummary: null,
    checking: false,
    lastCheckedAt: null as string | null,
    checkForUpdates: vi.fn(),
    applyRemoteRegistry: vi.fn(),
    useBundledRegistry: vi.fn(),
    activeRegistry: [] as unknown[],
    remoteRegistry: [] as unknown[]
  },
  mockListCatalog: vi.fn()
}))

vi.mock('@/hooks/use-acp-registry-catalog', () => ({
  useAcpRegistryCatalog: () => mockRegistryCatalog
}))
vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return { ...actual, acpCatalogApi: { ...actual.acpCatalogApi, listCatalog: mockListCatalog } }
})
vi.mock('@/components/agents/CustomAcpAgentDialog', () => ({
  CustomAcpAgentDialog: () => null,
  exportAgentConfig: vi.fn(() => '{}')
}))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => true,
  cleanupTauriListener: vi.fn()
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/acp-agents-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-agents-persistence')>()
  return {
    ...actual,
    loadAgentConfigs: vi.fn(async () => []),
    saveAgentConfigs: vi.fn(async () => {})
  }
})
vi.mock('@/lib/acp-history-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-history-persistence')>()
  return {
    ...actual,
    loadSessionIndex: vi.fn(async () => []),
    saveSessionIndex: vi.fn(async () => {}),
    saveSessionPayload: vi.fn(async () => {}),
    queueSessionPayloadSave: vi.fn(async () => {}),
    queueSessionPayloadDelete: vi.fn(async () => {}),
    loadSessionPayload: vi.fn(async () => null),
    loadSessionPayloadTail: vi.fn(async () => null)
  }
})
vi.mock('@/lib/acp-mcp-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-mcp-persistence')>()
  return { ...actual, loadMcpServers: vi.fn(async () => []), saveMcpServers: vi.fn(async () => {}) }
})

import { AcpAgentsSettings } from '@/components/settings/AcpAgentsSettings'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { RegistryAgent } from '@/lib/agents/acp-registry'
import { useAcpStore } from '@/stores/acp-store'

function npxRegistryAgent(version: string): RegistryAgent {
  return {
    id: 'factory-droid',
    name: 'Factory Droid',
    version,
    description: 'Factory Droid - AI coding agent powered by Factory AI',
    distribution: { npx: { package: `droid@${version}`, args: ['exec', '--output-format', 'acp'] } }
  }
}

function persistedDroidConfig(version: string): StoredAgentConfig {
  return {
    id: 'acp-registry:factory-droid',
    templateId: 'factory-droid',
    configId: 'acp-registry:factory-droid',
    name: 'Factory Droid',
    command: 'npx',
    args: ['-y', `droid@${version}`, 'exec', '--output-format', 'acp'],
    env: {},
    allowTerminal: false
  }
}

function seedCatalog(): void {
  mockListCatalog.mockResolvedValue({
    success: true,
    data: {
      host: { os: 'macos', arch: 'aarch64', runtimes: { npx: true } },
      agents: [
        {
          id: 'factory-droid',
          name: 'Factory Droid',
          version: '0.219.0',
          description: 'Factory Droid - AI coding agent powered by Factory AI',
          source: 'bundled',
          distribution: {
            npx: { package: 'droid@0.219.0', args: ['exec', '--output-format', 'acp'] }
          },
          runtimeRequirements: ['npx'],
          status: 'ready',
          platformTargets: [],
          installed: null
        }
      ]
    }
  })
}

describe('AcpAgentsSettings per-agent update', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAcpStore.setState({ agentConfigs: [] })
    seedCatalog()
  })

  it('shows a version-drift badge and an Update button that rewrites the persisted pin', async () => {
    useAcpStore.setState({ agentConfigs: [persistedDroidConfig('0.218.1')] })
    mockRegistryCatalog.usingRemoteRegistry = true
    mockRegistryCatalog.activeRegistry = [npxRegistryAgent('0.219.0')]

    render(<AcpAgentsSettings />)

    // The resolved entry carries the registry version (0.219.0); the persisted
    // config still pins 0.218.1 → the row must surface the drift.
    await screen.findByText('0.218.1 → 0.219.0')

    fireEvent.click(screen.getByRole('button', { name: /update to 0\.219\.0/i }))

    await waitFor(() => {
      const updated = useAcpStore
        .getState()
        .agentConfigs.find((c) => c.id === 'acp-registry:factory-droid')
      expect(updated?.args).toEqual(['-y', 'droid@0.219.0', 'exec', '--output-format', 'acp'])
    })
  })

  it('updates in one click from bundled — the registry opt-in is absorbed into the click', async () => {
    useAcpStore.setState({ agentConfigs: [persistedDroidConfig('0.218.1')] })
    mockRegistryCatalog.usingRemoteRegistry = false
    mockRegistryCatalog.remoteRegistry = [npxRegistryAgent('0.219.0')]

    render(<AcpAgentsSettings />)

    // Agent language only: drift badge plus a direct per-agent action. No
    // registry concepts, no dead end.
    await screen.findByText('0.218.1 → 0.219.0')
    expect(screen.queryByText(/apply registry/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /update to 0\.219\.0/i }))
    await waitFor(() => {
      // The click opt-ins into the newer registry on the user's behalf, then
      // rewrites the pin — one action, explicit user consent preserved.
      expect(mockRegistryCatalog.applyRemoteRegistry).toHaveBeenCalledTimes(1)
      const updated = useAcpStore
        .getState()
        .agentConfigs.find((c) => c.id === 'acp-registry:factory-droid')
      expect(updated?.args).toEqual(['-y', 'droid@0.219.0', 'exec', '--output-format', 'acp'])
    })
  })

  it('shows a Latest chip for checked agents whose spawn version has no drift', async () => {
    useAcpStore.setState({ agentConfigs: [persistedDroidConfig('0.219.0')] })
    mockRegistryCatalog.usingRemoteRegistry = true
    mockRegistryCatalog.activeRegistry = [npxRegistryAgent('0.219.0')]

    render(<AcpAgentsSettings />)

    await screen.findByText('Latest')
  })
})
