import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() }
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true),
  cleanupTauriListener: vi.fn()
}))
vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))
vi.mock('@/lib/acp-mcp-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-mcp-persistence')>()
  return {
    ...actual,
    loadMcpServers: vi.fn(async () => []),
    saveMcpServers: vi.fn(async () => {}),
    syncMcpRegistryToProjectBestEffort: vi.fn(async () => {})
  }
})

import { invoke } from '@tauri-apps/api/core'
import { acpApi, type ProbeResult } from '@/lib/acp-api'
import { loadMcpServers } from '@/lib/acp-mcp-persistence'
import { useAcpStore } from '@/stores/acp-store'
import { deferred } from './testkit'

const CONNECTED: ProbeResult = { status: 'connected', tools: [{ name: 'read_file' }] }
const REFUSED: ProbeResult = { status: 'disconnected', tools: [], error: 'spawn failed' }
const AUTH_REQUIRED: ProbeResult = { status: 'authRequired', tools: [], error: 'sign in required' }
const OAUTH_SERVER = {
  id: 'gh',
  type: 'http',
  name: 'GitHub',
  url: 'https://mcp.test/gh',
  enabled: true
} as const

function probedConfigs(): unknown[] {
  return vi
    .mocked(invoke)
    .mock.calls.filter(([cmd]) => cmd === 'acp_probe_mcp_server')
    .map(([, args]) => (args as { server: unknown }).server)
}

async function settle(): Promise<void> {
  await vi.waitFor(() => expect(useAcpStore.getState().mcpProbing.fs).not.toBe(true))
}

describe('MCP probe refresh', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.mocked(invoke).mockReset()
    useAcpStore.setState({
      mcpServers: [{ id: 'fs', type: 'stdio', name: 'Files', command: 'old-cmd', enabled: true }],
      mcpProbeStatus: { fs: 'disconnected' },
      mcpTools: { fs: [] },
      mcpToolsLoaded: { fs: true },
      mcpProbing: {},
      mcpProbeError: { fs: 'spawn failed' },
      mcpOAuthConnected: {},
      mcpOAuthConnecting: {}
    })
  })

  it('re-probes an existing server with its new config after an edit is saved', async () => {
    vi.mocked(invoke).mockResolvedValue(CONNECTED)

    await useAcpStore
      .getState()
      .saveMcpServer({ id: 'fs', type: 'stdio', name: 'Files', command: 'new-cmd', enabled: true })
    await settle()

    expect(probedConfigs()).toEqual([{ type: 'stdio', name: 'Files', command: 'new-cmd' }])
    expect(useAcpStore.getState().mcpProbeStatus.fs).toBe('connected')
    expect(useAcpStore.getState().mcpTools.fs).toEqual([{ name: 'read_file' }])
    expect(useAcpStore.getState().mcpProbeError.fs).toBeUndefined()
  })

  it('does not re-probe when a saved edit leaves the probe config unchanged', async () => {
    await useAcpStore
      .getState()
      .saveMcpServer({ id: 'fs', type: 'stdio', name: 'Files', command: 'old-cmd', enabled: true })

    expect(probedConfigs()).toEqual([])
    expect(useAcpStore.getState().mcpProbeStatus.fs).toBe('disconnected')
  })

  it('clears the stale status of an edited disabled server without probing it', async () => {
    await useAcpStore
      .getState()
      .saveMcpServer({ id: 'fs', type: 'stdio', name: 'Files', command: 'new-cmd', enabled: false })

    expect(probedConfigs()).toEqual([])
    expect(useAcpStore.getState().mcpProbeStatus.fs).toBeUndefined()
    expect(useAcpStore.getState().mcpToolsLoaded.fs).toBe(false)
  })

  it('discards a probe of the old config that finishes after the edit and probes the new one', async () => {
    const oldProbe = deferred<ProbeResult>()
    vi.mocked(invoke).mockReturnValueOnce(oldProbe.promise).mockResolvedValueOnce(REFUSED)

    const inFlight = useAcpStore.getState().probeMcpServer('fs')
    await useAcpStore
      .getState()
      .saveMcpServer({ id: 'fs', type: 'stdio', name: 'Files', command: 'new-cmd', enabled: true })
    oldProbe.resolve(CONNECTED)
    await inFlight
    await settle()

    expect(probedConfigs()).toEqual([
      { type: 'stdio', name: 'Files', command: 'old-cmd' },
      { type: 'stdio', name: 'Files', command: 'new-cmd' }
    ])
    expect(useAcpStore.getState().mcpProbeStatus.fs).toBe('disconnected')
    expect(useAcpStore.getState().mcpTools.fs).toEqual([])
  })

  it('drops an in-flight probe of the old config without probing a server the edit disabled', async () => {
    const oldProbe = deferred<ProbeResult>()
    vi.mocked(invoke).mockReturnValueOnce(oldProbe.promise)

    const inFlight = useAcpStore.getState().probeMcpServer('fs')
    await useAcpStore
      .getState()
      .saveMcpServer({ id: 'fs', type: 'stdio', name: 'Files', command: 'new-cmd', enabled: false })
    oldProbe.resolve(CONNECTED)
    await inFlight

    expect(probedConfigs()).toEqual([{ type: 'stdio', name: 'Files', command: 'old-cmd' }])
    expect(useAcpStore.getState().mcpProbeStatus.fs).toBeUndefined()
    expect(useAcpStore.getState().mcpProbing.fs).toBe(false)
  })

  it('forgets a server deleted while its probe was in flight', async () => {
    const probe = deferred<ProbeResult>()
    vi.mocked(invoke).mockReturnValueOnce(probe.promise).mockResolvedValueOnce(REFUSED)

    const inFlight = useAcpStore.getState().probeMcpServer('fs')
    await useAcpStore.getState().deleteMcpServer('fs')
    probe.resolve(CONNECTED)
    await inFlight

    const afterDelete = useAcpStore.getState()
    expect([
      afterDelete.mcpProbeStatus,
      afterDelete.mcpTools,
      afterDelete.mcpToolsLoaded,
      afterDelete.mcpProbing,
      afterDelete.mcpProbeError
    ]).toEqual([{}, {}, {}, {}, {}])

    await useAcpStore
      .getState()
      .saveMcpServer({ id: 'fs', type: 'stdio', name: 'Files', command: 'old-cmd', enabled: true })
    await useAcpStore.getState().loadMcpTools('fs')

    expect(probedConfigs()).toHaveLength(2)
    expect(useAcpStore.getState().mcpProbeStatus.fs).toBe('disconnected')
    expect(useAcpStore.getState().mcpTools.fs).toEqual([])
    expect(useAcpStore.getState().mcpProbeError.fs).toBe('spawn failed')
  })

  it('keeps the result of a probe that finishes while another project is active', async () => {
    const probe = deferred<ProbeResult>()
    vi.mocked(invoke).mockReturnValueOnce(probe.promise)
    const projectA = useAcpStore.getState().mcpServers

    const inFlight = useAcpStore.getState().probeMcpServer('fs')
    vi.mocked(loadMcpServers).mockResolvedValueOnce([])
    await useAcpStore.getState().loadMcpServers()
    probe.resolve(CONNECTED)
    await inFlight
    vi.mocked(loadMcpServers).mockResolvedValueOnce(projectA)
    await useAcpStore.getState().loadMcpServers()

    expect(useAcpStore.getState().mcpProbeStatus.fs).toBe('connected')
    expect(useAcpStore.getState().mcpTools.fs).toEqual([{ name: 'read_file' }])
  })

  it('retries a server whose last probe ended disconnected when its tool list is expanded', async () => {
    vi.mocked(invoke).mockResolvedValue(CONNECTED)

    await useAcpStore.getState().loadMcpTools('fs')

    expect(probedConfigs()).toEqual([{ type: 'stdio', name: 'Files', command: 'old-cmd' }])
    expect(useAcpStore.getState().mcpProbeStatus.fs).toBe('connected')
    expect(useAcpStore.getState().mcpTools.fs).toEqual([{ name: 'read_file' }])
  })

  it.each([
    [
      'sign-in',
      (id: string) => useAcpStore.getState().connectMcpOAuth('p1', id),
      AUTH_REQUIRED,
      CONNECTED
    ],
    [
      'sign-out',
      (id: string) => useAcpStore.getState().disconnectMcpOAuth('p1', id),
      CONNECTED,
      AUTH_REQUIRED
    ]
  ])('shows the post-%s status when an earlier probe was still in flight', async (_, oauthAction, staleResult, freshResult) => {
    vi.spyOn(acpApi, 'startMcpOAuth').mockResolvedValue(undefined)
    vi.spyOn(acpApi, 'disconnectMcpOAuth').mockResolvedValue(undefined)
    useAcpStore.setState({ mcpServers: [OAUTH_SERVER] })
    const staleProbe = deferred<ProbeResult>()
    vi.mocked(invoke).mockReturnValueOnce(staleProbe.promise).mockResolvedValueOnce(freshResult)

    const inFlight = useAcpStore.getState().probeMcpServer('gh')
    await oauthAction('gh')
    staleProbe.resolve(staleResult)
    await inFlight
    await vi.waitFor(() => expect(useAcpStore.getState().mcpProbing.gh).toBe(false))

    expect(useAcpStore.getState().mcpProbeStatus.gh).toBe(freshResult.status)
    expect(useAcpStore.getState().mcpTools.gh).toEqual(freshResult.tools)
    expect(probedConfigs()).toHaveLength(2)
  })

  it('does not show a re-added server as signed in when its predecessor was', async () => {
    useAcpStore.setState({
      mcpServers: [OAUTH_SERVER],
      mcpOAuthConnected: { gh: true },
      mcpOAuthConnecting: { gh: true }
    })
    vi.mocked(invoke).mockResolvedValue(AUTH_REQUIRED)

    await useAcpStore.getState().deleteMcpServer('gh')
    await useAcpStore.getState().saveMcpServer({ ...OAUTH_SERVER, url: 'https://mcp.test/other' })

    expect(useAcpStore.getState().mcpOAuthConnected).toEqual({})
    expect(useAcpStore.getState().mcpOAuthConnecting).toEqual({})
  })

  it.each([
    [
      'sign-in',
      (id: string) => useAcpStore.getState().connectMcpOAuth('p1', id),
      () => {
        const flow = deferred<undefined>()
        vi.spyOn(acpApi, 'startMcpOAuth').mockReturnValue(flow.promise)
        return () => {
          flow.resolve(undefined)
        }
      }
    ],
    [
      'status check',
      (id: string) => useAcpStore.getState().checkMcpOAuthStatus('p1', id),
      () => {
        const status = deferred<boolean>()
        vi.spyOn(acpApi, 'hasMcpOAuthToken').mockReturnValue(status.promise)
        return () => {
          status.resolve(true)
        }
      }
    ]
  ])('drops the OAuth %s result that lands after its server was deleted and re-added', async (_, oauthAction, arm) => {
    useAcpStore.setState({ mcpServers: [OAUTH_SERVER] })
    vi.mocked(invoke).mockResolvedValue(AUTH_REQUIRED)
    const land = arm()

    const inFlight = oauthAction('gh')
    await useAcpStore.getState().deleteMcpServer('gh')
    await useAcpStore.getState().saveMcpServer({ ...OAUTH_SERVER, url: 'https://mcp.test/other' })
    land()
    await inFlight

    expect(useAcpStore.getState().mcpOAuthConnected).toEqual({})
    expect(useAcpStore.getState().mcpOAuthConnecting).toEqual({})
  })

  it('does not carry a queued re-probe over to a server re-added after deletion', async () => {
    vi.spyOn(acpApi, 'startMcpOAuth').mockResolvedValue(undefined)
    useAcpStore.setState({ mcpServers: [OAUTH_SERVER] })
    const staleProbe = deferred<ProbeResult>()
    vi.mocked(invoke).mockReturnValueOnce(staleProbe.promise).mockResolvedValue(CONNECTED)

    const inFlight = useAcpStore.getState().probeMcpServer('gh')
    await useAcpStore.getState().connectMcpOAuth('p1', 'gh')
    await useAcpStore.getState().deleteMcpServer('gh')
    staleProbe.resolve(AUTH_REQUIRED)
    await inFlight
    await useAcpStore.getState().saveMcpServer(OAUTH_SERVER)
    await useAcpStore.getState().loadMcpTools('gh')
    await vi.waitFor(() => expect(useAcpStore.getState().mcpProbing.gh).toBe(false))

    expect(probedConfigs()).toHaveLength(2)
    expect(useAcpStore.getState().mcpProbeStatus.gh).toBe('connected')
  })
})
