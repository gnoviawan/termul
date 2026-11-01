import type { IpcResult } from '@shared/types/ipc.types'
import type { McpCatalogRow } from '@shared/types/mcp-catalog.types'
import type {
  McpInstallCommitRequest,
  McpInstallCommitResult,
  McpInstallField,
  McpInstallFormReply,
  McpInstallFormRequest,
  McpInstallPlan,
  McpInstallPlanReply,
  McpInstallPlanRequest
} from '@shared/types/mcp-install.types'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  describeInstall: vi.fn<(r: McpInstallFormRequest) => Promise<IpcResult<McpInstallFormReply>>>(),
  planInstall: vi.fn<(r: McpInstallPlanRequest) => Promise<IpcResult<McpInstallPlanReply>>>(),
  commitInstall:
    vi.fn<(r: McpInstallCommitRequest) => Promise<IpcResult<McpInstallCommitResult>>>(),
  cancelInstall: vi.fn(async (_r: { planId: string }) => ({ success: true as const, data: {} }))
}))

vi.mock('@/lib/mcp-catalog-api', () => ({ mcpCatalogApi: api }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true),
  cleanupTauriListener: vi.fn()
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/acp-mcp-persistence', async (orig) => ({
  ...(await orig<typeof import('@/lib/acp-mcp-persistence')>()),
  loadMcpServers: vi.fn(async () => []),
  saveMcpServers: vi.fn(async () => {}),
  syncMcpRegistryToProjectBestEffort: vi.fn(async () => {})
}))

import { invoke } from '@tauri-apps/api/core'
import { acpApi } from '@/lib/acp-api'
import { saveMcpServers } from '@/lib/acp-mcp-persistence'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { useMcpCatalogInstall } from './use-mcp-catalog-install'

const ROW: McpCatalogRow = {
  name: 'io.example/weather',
  title: 'Weather Tools',
  description: '',
  version: '1.2.0',
  status: 'active',
  state: 'installable',
  reason: null,
  defaultOption: { kind: 'remote', index: 0 },
  repositoryUrl: null,
  hasIcon: false
}

const KEY_FIELD: McpInstallField = {
  id: 'header:Authorization:key',
  label: 'API key',
  target: { kind: 'header', name: 'Authorization' },
  variable: 'key',
  isRequired: true,
  isSecret: true,
  format: 'string',
  choices: null,
  default: null,
  placeholder: null,
  description: null
}

const REGION_FIELD: McpInstallField = {
  ...KEY_FIELD,
  id: 'header:X-Region',
  label: 'Region',
  target: { kind: 'header', name: 'X-Region' },
  variable: null,
  isRequired: false,
  isSecret: false,
  default: 'eu'
}

const SOURCE = { kind: 'catalog', name: ROW.name, version: ROW.version } as const

function formReply(fields: McpInstallField[]): IpcResult<McpInstallFormReply> {
  return {
    success: true,
    data: {
      outcome: 'form',
      form: { source: SOURCE, choice: ROW.defaultOption, title: 'Weather Tools', fields }
    }
  }
}

const PLAN: McpInstallPlan = {
  planId: 'plan-1234abcd',
  name: 'weather-tools',
  source: SOURCE,
  choice: { kind: 'remote', index: 0 },
  expiresAt: '2026-11-01T00:10:00Z',
  config: {
    transport: 'http',
    url: 'https://weather.example/mcp',
    headers: [
      { name: 'Authorization', isSecret: true },
      { name: 'X-Region', isSecret: false }
    ]
  },
  form: [KEY_FIELD, REGION_FIELD],
  consentView: {
    transport: 'http',
    command: null,
    argv: [],
    url: 'https://weather.example/mcp',
    env: [],
    headers: [],
    hostMounts: [],
    warnings: ['sends-data-remote'],
    provenance: null
  },
  launchDigest: 'digest-0123456789abcdef'
}

const COMMITTED: McpInstallCommitResult = {
  name: 'weather-tools',
  config: PLAN.config,
  secrets: [
    { slot: 'header', name: 'Authorization', value: 'Bearer sk-live' },
    { slot: 'header', name: 'X-Region', value: 'eu' }
  ],
  provenance: {
    name: ROW.name,
    version: '1.2.0',
    kind: 'remote',
    index: 0,
    repositoryId: 'R_1'
  },
  launchDigest: PLAN.launchDigest
}

function probeReturns(result: unknown): void {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'acp_probe_mcp_server') return result
    throw new Error(`unexpected ${command}`)
  })
}

async function toConsent() {
  const hook = renderHook(() => useMcpCatalogInstall())
  act(() => hook.result.current.start(ROW))
  await waitFor(() => expect(hook.result.current.flow.step).toBe('form'))
  act(() => hook.result.current.change(KEY_FIELD.id, 'sk-live'))
  act(() => hook.result.current.submit())
  await waitFor(() => expect(hook.result.current.flow.step).toBe('consent'))
  return hook
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.mocked(isTauriContext).mockReturnValue(true)
  api.describeInstall.mockResolvedValue(formReply([KEY_FIELD, REGION_FIELD]))
  api.planInstall.mockResolvedValue({ success: true, data: { outcome: 'plan', plan: PLAN } })
  api.commitInstall.mockResolvedValue({ success: true, data: COMMITTED })
  useProjectStore.setState({ activeProjectId: 'p1' })
  useAcpStore.setState({
    mcpServers: [],
    mcpServersLoaded: true,
    mcpProbeStatus: {},
    mcpTools: {},
    mcpToolsLoaded: {},
    mcpProbing: {},
    mcpProbeError: {},
    mcpOAuthConnected: {},
    mcpOAuthConnecting: {}
  })
})

describe('useMcpCatalogInstall', () => {
  it('plans with the non-secret values, commits the secret, saves the entry and probes it', async () => {
    probeReturns({ status: 'connected', tools: [{ name: 'forecast' }, { name: 'alerts' }] })
    const hook = await toConsent()

    act(() => hook.result.current.approve())
    await waitFor(() => expect(hook.result.current.flow.step).toBe('done'))

    expect(api.describeInstall.mock.calls).toEqual([
      [{ source: SOURCE, choice: { kind: 'remote', index: 0 } }]
    ])
    expect(api.planInstall.mock.calls).toEqual([
      [
        {
          source: SOURCE,
          choice: { kind: 'remote', index: 0 },
          inputs: { 'header:X-Region': 'eu' }
        }
      ]
    ])
    expect(api.commitInstall.mock.calls).toEqual([
      [
        {
          planId: 'plan-1234abcd',
          launchDigest: 'digest-0123456789abcdef',
          secretValues: { 'header:Authorization:key': 'sk-live' }
        }
      ]
    ])
    const [saved] = useAcpStore.getState().mcpServers
    expect(saved).toEqual({
      id: expect.any(String),
      type: 'http',
      name: 'weather-tools',
      url: 'https://weather.example/mcp',
      headers: [
        { name: 'Authorization', value: 'Bearer sk-live' },
        { name: 'X-Region', value: 'eu' }
      ],
      enabled: true,
      catalog: {
        source: 'mcp-registry',
        name: 'io.example/weather',
        version: '1.2.0',
        kind: 'remote',
        index: 0,
        repositoryId: 'R_1',
        launchDigest: 'digest-0123456789abcdef'
      }
    })
    expect(vi.mocked(saveMcpServers).mock.calls).toEqual([[[saved], 'p1']])
    expect(hook.result.current.flow).toMatchObject({
      step: 'done',
      probe: { status: 'connected', tools: 2 }
    })
  })

  it('goes straight to consent when the server needs no input', async () => {
    api.describeInstall.mockResolvedValue(formReply([]))
    const hook = renderHook(() => useMcpCatalogInstall())

    act(() => hook.result.current.start(ROW))
    await waitFor(() => expect(hook.result.current.flow.step).toBe('consent'))

    expect(api.planInstall.mock.calls).toEqual([
      [{ source: SOURCE, choice: { kind: 'remote', index: 0 }, inputs: {} }]
    ])
  })

  it('keeps the form open and names the empty required field instead of planning', async () => {
    const hook = renderHook(() => useMcpCatalogInstall())
    act(() => hook.result.current.start(ROW))
    await waitFor(() => expect(hook.result.current.flow.step).toBe('form'))

    act(() => hook.result.current.submit())

    expect(hook.result.current.flow).toMatchObject({
      step: 'form',
      fieldErrors: { 'header:Authorization:key': 'Fill this in to continue.' }
    })
    expect(api.planInstall).not.toHaveBeenCalled()
  })

  it('returns to the form with the host message when the host rejects a value', async () => {
    api.planInstall.mockResolvedValue({
      success: false,
      error: 'Region must be one of eu, us',
      code: 'VALIDATION_ERROR'
    })
    const hook = renderHook(() => useMcpCatalogInstall())
    act(() => hook.result.current.start(ROW))
    await waitFor(() => expect(hook.result.current.flow.step).toBe('form'))
    act(() => hook.result.current.change(KEY_FIELD.id, 'sk-live'))
    act(() => hook.result.current.submit())

    await waitFor(() =>
      expect(hook.result.current.flow).toMatchObject({
        step: 'form',
        error: 'Region must be one of eu, us',
        values: { 'header:Authorization:key': 'sk-live', 'header:X-Region': 'eu' }
      })
    )
  })

  it('fails with the runtime reason when the runner vanished before planning', async () => {
    api.planInstall.mockResolvedValue({
      success: true,
      data: { outcome: 'unsupported', reason: { code: 'needs-runtime', runtime: 'npx' } }
    })
    const hook = renderHook(() => useMcpCatalogInstall())
    act(() => hook.result.current.start(ROW))
    await waitFor(() => expect(hook.result.current.flow.step).toBe('form'))
    act(() => hook.result.current.change(KEY_FIELD.id, 'sk-live'))
    act(() => hook.result.current.submit())

    await waitFor(() =>
      expect(hook.result.current.flow).toEqual({
        step: 'failed',
        target: {
          name: 'io.example/weather',
          version: '1.2.0',
          title: 'Weather Tools',
          choice: { kind: 'remote', index: 0 },
          projectId: 'p1'
        },
        failure: { kind: 'unsupported', reason: { code: 'needs-runtime', runtime: 'npx' } }
      })
    )
  })

  it('cancels the plan on the host when the consent is cancelled', async () => {
    const hook = await toConsent()

    act(() => hook.result.current.dismiss())

    expect(hook.result.current.flow).toEqual({ step: 'idle' })
    expect(api.cancelInstall.mock.calls).toEqual([[{ planId: 'plan-1234abcd' }]])
  })

  it('cancels a plan that arrives after the flow was cancelled', async () => {
    let answer: (reply: IpcResult<McpInstallPlanReply>) => void = () => {}
    api.planInstall.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const hook = renderHook(() => useMcpCatalogInstall())
    act(() => hook.result.current.start(ROW))
    await waitFor(() => expect(hook.result.current.flow.step).toBe('form'))
    act(() => hook.result.current.change(KEY_FIELD.id, 'sk-live'))
    act(() => hook.result.current.submit())
    act(() => hook.result.current.dismiss())

    await act(async () => answer({ success: true, data: { outcome: 'plan', plan: PLAN } }))

    expect(hook.result.current.flow).toEqual({ step: 'idle' })
    expect(api.cancelInstall.mock.calls).toEqual([[{ planId: 'plan-1234abcd' }]])
  })

  it('fails with the host code when the plan expired and starts over from the form', async () => {
    api.commitInstall.mockResolvedValue({
      success: false,
      error: 'the plan expired',
      code: 'MCP_PLAN_EXPIRED'
    })
    const hook = await toConsent()

    act(() => hook.result.current.approve())
    await waitFor(() =>
      expect(hook.result.current.flow).toMatchObject({
        step: 'failed',
        failure: { kind: 'host', code: 'MCP_PLAN_EXPIRED' }
      })
    )
    expect(useAcpStore.getState().mcpServers).toEqual([])

    act(() => hook.result.current.startOver())
    await waitFor(() => expect(hook.result.current.flow.step).toBe('form'))
    expect(api.describeInstall).toHaveBeenCalledTimes(2)
  })

  it('ignores a cancel while the approval is being committed', async () => {
    let answer: (reply: IpcResult<McpInstallCommitResult>) => void = () => {}
    api.commitInstall.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    probeReturns({ status: 'connected', tools: [] })
    const hook = await toConsent()

    act(() => hook.result.current.approve())
    act(() => hook.result.current.dismiss())
    expect(hook.result.current.flow.step).toBe('committing')

    await act(async () => answer({ success: true, data: COMMITTED }))
    await waitFor(() => expect(hook.result.current.flow.step).toBe('done'))
    expect(api.cancelInstall).not.toHaveBeenCalled()
    expect(useAcpStore.getState().mcpServers.map((server) => server.name)).toEqual([
      'weather-tools'
    ])
  })

  it('offers sign-in when the installed remote server asks for it and starts OAuth on the click', async () => {
    probeReturns({ status: 'authRequired', tools: [], error: 'sign in required' })
    const startOAuth = vi.spyOn(acpApi, 'startMcpOAuth').mockReturnValue(new Promise(() => {}))
    const hook = await toConsent()

    act(() => hook.result.current.approve())
    await waitFor(() => expect(hook.result.current.flow.step).toBe('done'))
    expect(hook.result.current.flow).toMatchObject({ probe: { status: 'sign-in-required' } })
    expect(startOAuth.mock.calls).toEqual([])

    act(() => hook.result.current.signIn())

    expect(startOAuth.mock.calls).toEqual([['p1', 'https://weather.example/mcp']])
  })

  it('cancels the plan when the commit never reached the host', async () => {
    api.commitInstall.mockResolvedValue({ success: false, error: 'offline', code: 'NETWORK_ERROR' })
    const hook = await toConsent()

    act(() => hook.result.current.approve())
    await waitFor(() =>
      expect(hook.result.current.flow).toMatchObject({
        step: 'failed',
        failure: { kind: 'host', code: 'NETWORK_ERROR' }
      })
    )
    expect(api.cancelInstall.mock.calls).toEqual([[{ planId: 'plan-1234abcd' }]])
  })

  it('refuses to save before the MCP list has loaded, so the stored list is never replaced', async () => {
    useAcpStore.setState({ mcpServersLoaded: false })
    const hook = await toConsent()

    act(() => hook.result.current.approve())

    await waitFor(() =>
      expect(hook.result.current.flow).toMatchObject({ step: 'failed', failure: { kind: 'save' } })
    )
    expect(vi.mocked(saveMcpServers).mock.calls).toEqual([])
    expect(useAcpStore.getState().mcpServers).toEqual([])
  })

  it('refuses a web save into a project other than the one the install started in', async () => {
    vi.mocked(isTauriContext).mockReturnValue(false)
    const hook = await toConsent()
    useProjectStore.setState({ activeProjectId: 'p2' })

    act(() => hook.result.current.approve())

    await waitFor(() =>
      expect(hook.result.current.flow).toMatchObject({ step: 'failed', failure: { kind: 'save' } })
    )
    expect(vi.mocked(saveMcpServers).mock.calls).toEqual([])
  })

  it('does not offer to start over when the catalog no longer lists the version', async () => {
    api.describeInstall.mockResolvedValue({
      success: false,
      error: 'no such version',
      code: 'MCP_CATALOG_NOT_FOUND'
    })
    const hook = renderHook(() => useMcpCatalogInstall())
    act(() => hook.result.current.start(ROW))
    await waitFor(() => expect(hook.result.current.flow.step).toBe('failed'))

    act(() => hook.result.current.startOver())

    expect(api.describeInstall).toHaveBeenCalledTimes(1)
    expect(hook.result.current.flow.step).toBe('failed')
  })

  it('reports the save failure and keeps nothing when persisting fails', async () => {
    vi.mocked(saveMcpServers).mockRejectedValueOnce(new Error('disk full'))
    const hook = await toConsent()

    act(() => hook.result.current.approve())

    await waitFor(() =>
      expect(hook.result.current.flow).toMatchObject({ step: 'failed', failure: { kind: 'save' } })
    )
    expect(useAcpStore.getState().mcpServers).toEqual([])
  })
})
