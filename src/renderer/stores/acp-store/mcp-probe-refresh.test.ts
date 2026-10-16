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
import type { ProbeResult } from '@/lib/acp-api'
import { useAcpStore } from '@/stores/acp-store'
import { deferred } from './testkit'

const CONNECTED: ProbeResult = { status: 'connected', tools: [{ name: 'read_file' }] }
const REFUSED: ProbeResult = { status: 'disconnected', tools: [], error: 'spawn failed' }

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
    vi.mocked(invoke).mockReset()
    useAcpStore.setState({
      mcpServers: [{ id: 'fs', type: 'stdio', name: 'Files', command: 'old-cmd', enabled: true }],
      mcpProbeStatus: { fs: 'disconnected' },
      mcpTools: { fs: [] },
      mcpToolsLoaded: { fs: true },
      mcpProbing: {},
      mcpProbeError: { fs: 'spawn failed' }
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

  it('re-probes the canvas entry when a canvas open moves it to a new URL', async () => {
    useAcpStore.setState({
      mcpServers: [
        {
          id: 'canvas-mcp-p1',
          type: 'http',
          name: 'OpenPencil Canvas',
          url: 'http://127.0.0.1:5100/canvas/mcp',
          enabled: true
        }
      ],
      mcpProbeStatus: { 'canvas-mcp-p1': 'disconnected' },
      mcpToolsLoaded: { 'canvas-mcp-p1': true }
    })
    vi.mocked(invoke).mockResolvedValue(CONNECTED)

    await useAcpStore
      .getState()
      .upsertCanvasMcpServer('p1', 'http://127.0.0.1:5200/canvas/mcp', null)
    await vi.waitFor(() =>
      expect(useAcpStore.getState().mcpProbeStatus['canvas-mcp-p1']).toBe('connected')
    )

    expect(probedConfigs()).toEqual([
      { type: 'http', name: 'OpenPencil Canvas', url: 'http://127.0.0.1:5200/canvas/mcp' }
    ])
  })

  it('retries a server whose last probe ended disconnected when its tool list is expanded', async () => {
    vi.mocked(invoke).mockResolvedValue(CONNECTED)

    await useAcpStore.getState().loadMcpTools('fs')

    expect(probedConfigs()).toEqual([{ type: 'stdio', name: 'Files', command: 'old-cmd' }])
    expect(useAcpStore.getState().mcpProbeStatus.fs).toBe('connected')
    expect(useAcpStore.getState().mcpTools.fs).toEqual([{ name: 'read_file' }])
  })
})
