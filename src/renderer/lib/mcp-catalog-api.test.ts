import type { McpCatalogPage, McpCatalogStatus } from '@shared/types/mcp-catalog.types'
import type {
  McpInstallCommitResult,
  McpInstallFormReply,
  McpInstallPlanReply
} from '@shared/types/mcp-install.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { transport } = vi.hoisted(() => ({
  transport: {
    searchMcpCatalog: vi.fn(),
    getMcpCatalogStatus: vi.fn(),
    setMcpCatalogSync: vi.fn(),
    describeMcpInstall: vi.fn(),
    planMcpInstall: vi.fn(),
    commitMcpInstall: vi.fn(),
    cancelMcpInstall: vi.fn()
  }
}))

vi.mock('./acp-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./acp-transport')>()),
  getAcpTransport: () => transport
}))

vi.mock('./web-client-identity', () => ({
  getClientInstanceId: () => 'tab-1'
}))

import { AcpTransportError } from './acp-transport/types'
import { createDesktopMcpCatalogApi } from './desktop-mcp-catalog-api'
import { webMcpCatalogApi } from './web-mcp-catalog-api'

const page: McpCatalogPage = {
  items: [
    {
      name: 'to.hooka/mcp',
      title: null,
      description: 'Hooka MCP server',
      version: '0.1.2',
      status: 'active',
      state: 'needs-runtime',
      reason: { code: 'needs-runtime', runtime: 'npx' },
      defaultOption: { kind: 'package', index: 0 },
      repositoryUrl: 'https://github.com/hooka/mcp'
    }
  ],
  nextCursor: '1',
  total: 2,
  updatedAt: '2026-10-27T03:13:14.559Z',
  sample: false
}

const status: McpCatalogStatus = {
  updatedAt: '2026-10-27T03:13:14.559Z',
  sample: false,
  servers: 54_210,
  sync: { state: 'syncing', full: false, fetched: 0 }
}

const disabled: McpCatalogStatus = { ...status, sync: { state: 'disabled' } }

const forbidden = {
  success: false,
  error: 'Only the host can change MCP catalog sync',
  code: 'FORBIDDEN'
}

const source = { kind: 'catalog', name: 'to.hooka/mcp', version: '0.1.2' } as const

const formReply: McpInstallFormReply = {
  outcome: 'form',
  form: {
    source,
    choice: null,
    title: 'Hooka MCP',
    fields: [
      {
        id: 'env/HOOKA_API_KEY',
        label: 'HOOKA_API_KEY',
        target: { kind: 'env', name: 'HOOKA_API_KEY' },
        variable: null,
        isRequired: true,
        isSecret: true,
        format: 'string',
        choices: null,
        default: null,
        placeholder: null,
        description: 'Your key'
      }
    ]
  }
}

const planReply: McpInstallPlanReply = {
  outcome: 'plan',
  plan: {
    planId: 'p-1',
    name: 'hooka-mcp',
    source,
    choice: null,
    expiresAt: '2026-10-27T03:23:14.559Z',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'hooka-mcp@0.1.2'],
      env: [{ name: 'HOOKA_API_KEY', isSecret: true }]
    },
    form: formReply.form.fields,
    consentView: {
      transport: 'stdio',
      command: 'npx',
      argv: ['npx', '-y', 'hooka-mcp@0.1.2'],
      url: null,
      env: [{ name: 'HOOKA_API_KEY', value: null, isSecret: true, origin: 'user' }],
      headers: [],
      hostMounts: [],
      warnings: ['runs-local-code'],
      provenance: {
        namespace: { kind: 'domain', domain: 'to.hooka' },
        repositoryUrl: 'https://github.com/hooka/mcp',
        version: '0.1.2',
        mutableTag: false,
        snapshotFetchedAt: '2026-10-27T03:13:14.559Z'
      }
    },
    launchDigest: 'sha256:abc'
  }
}

const commitResult: McpInstallCommitResult = {
  name: 'hooka-mcp',
  config: planReply.outcome === 'plan' ? planReply.plan.config : ({} as never),
  secrets: [{ slot: 'env', name: 'HOOKA_API_KEY', value: 'hk_live_1' }],
  provenance: {
    name: 'to.hooka/mcp',
    version: '0.1.2',
    kind: 'package',
    index: 0,
    repositoryId: null
  },
  launchDigest: 'sha256:abc'
}

const fetchMock = vi.fn()

function hostAnswers(body: unknown) {
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body })
}

function postedBody(call: number): unknown {
  const init = fetchMock.mock.calls[call]?.[1] as { body?: string } | undefined
  return JSON.parse(init?.body ?? 'null')
}

describe('MCP catalog facades', () => {
  beforeEach(() => {
    for (const method of Object.values(transport)) method.mockReset()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { location: { origin: 'http://localhost:8080' } })
  })

  it('web search sends the query, cursor and limit to GET /mcp-catalog/search', async () => {
    hostAnswers({ success: true, data: page })

    const result = await webMcpCatalogApi.search({ query: 'git & hub', cursor: '50', limit: 25 })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/mcp-catalog/search?query=git+%26+hub&cursor=50&limit=25',
      expect.objectContaining({ method: 'GET' })
    )
    expect(result).toEqual({ success: true, data: page })
  })

  it('web search with no parameters requests the first page', async () => {
    hostAnswers({ success: true, data: page })

    await webMcpCatalogApi.search({})

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/mcp-catalog/search',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('web search forwards an empty cursor for the host to reject, as the desktop path does', async () => {
    hostAnswers({ success: true, data: page })

    await webMcpCatalogApi.search({ cursor: '' })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/mcp-catalog/search?cursor=',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('web search maps a failed fetch to NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))

    const result = await webMcpCatalogApi.search({})

    expect(result).toMatchObject({ success: false, code: 'NETWORK_ERROR' })
  })

  it('desktop search sends search_mcp_catalog over the transport', async () => {
    transport.searchMcpCatalog.mockResolvedValueOnce(page)

    const result = await createDesktopMcpCatalogApi().search({ query: 'hooka', limit: 5 })

    expect(transport.searchMcpCatalog).toHaveBeenCalledWith({ query: 'hooka', limit: 5 })
    expect(result).toEqual({ success: true, data: page })
  })

  it('desktop and web return the same result for the same host answer', async () => {
    transport.searchMcpCatalog.mockResolvedValueOnce(page)
    hostAnswers({ success: true, data: page })
    expect(await createDesktopMcpCatalogApi().search({})).toEqual(await webMcpCatalogApi.search({}))

    const message = 'limit must be between 1 and 100'
    transport.searchMcpCatalog.mockRejectedValueOnce(
      new AcpTransportError('VALIDATION_ERROR', message)
    )
    hostAnswers({ success: false, error: message, code: 'VALIDATION_ERROR' })
    const desktop = await createDesktopMcpCatalogApi().search({ limit: 500 })
    expect(desktop).toEqual({ success: false, error: message, code: 'VALIDATION_ERROR' })
    expect(desktop).toEqual(await webMcpCatalogApi.search({ limit: 500 }))
  })

  it('web status reads GET /mcp-catalog/status', async () => {
    hostAnswers({ success: true, data: status })

    const result = await webMcpCatalogApi.status()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/mcp-catalog/status',
      expect.objectContaining({ method: 'GET' })
    )
    expect(result).toEqual({ success: true, data: status })
  })

  it('web setSync posts { enabled } to /mcp-catalog/sync and returns the new status', async () => {
    hostAnswers({ success: true, data: disabled })

    const result = await webMcpCatalogApi.setSync(false)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/mcp-catalog/sync',
      expect.objectContaining({ method: 'POST', body: '{"enabled":false}' })
    )
    expect(result).toEqual({ success: true, data: disabled })
  })

  it('web setSync passes a FORBIDDEN refusal through', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => forbidden })

    expect(await webMcpCatalogApi.setSync(true)).toEqual(forbidden)
  })

  it('desktop status and setSync send their requests over the transport', async () => {
    transport.getMcpCatalogStatus.mockResolvedValueOnce(status)
    transport.setMcpCatalogSync.mockResolvedValueOnce(disabled)
    const api = createDesktopMcpCatalogApi()

    expect(await api.status()).toEqual({ success: true, data: status })
    expect(await api.setSync(false)).toEqual({ success: true, data: disabled })
    expect(transport.setMcpCatalogSync.mock.calls).toEqual([[false]])
  })

  it('desktop setSync passes a FORBIDDEN refusal through like the web path', async () => {
    transport.setMcpCatalogSync.mockRejectedValueOnce(
      new AcpTransportError('FORBIDDEN', forbidden.error)
    )

    expect(await createDesktopMcpCatalogApi().setSync(true)).toEqual(forbidden)
  })

  it('web form posts the source to /mcp-catalog/install/form without a client id', async () => {
    hostAnswers({ success: true, data: formReply })

    const result = await webMcpCatalogApi.describeInstall({ source })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/mcp-catalog/install/form',
      expect.objectContaining({ method: 'POST' })
    )
    expect(postedBody(0)).toEqual({ source })
    expect(result).toEqual({ success: true, data: formReply })
  })

  it('web plan, commit and cancel post this tab as the plan caller', async () => {
    hostAnswers({ success: true, data: planReply })
    hostAnswers({ success: true, data: commitResult })
    hostAnswers({ success: true, data: {} })

    const planned = await webMcpCatalogApi.planInstall({ source, inputs: { 'arg/0': 'acme' } })
    const committed = await webMcpCatalogApi.commitInstall({
      planId: 'p-1',
      launchDigest: 'sha256:abc',
      secretValues: { 'env/HOOKA_API_KEY': 'hk_live_1' }
    })
    const cancelled = await webMcpCatalogApi.cancelInstall({ planId: 'p-1' })

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://localhost:8080/mcp-catalog/install/plan',
      'http://localhost:8080/mcp-catalog/install/commit',
      'http://localhost:8080/mcp-catalog/install/cancel'
    ])
    expect(postedBody(0)).toEqual({
      source,
      inputs: { 'arg/0': 'acme' },
      clientInstanceId: 'tab-1'
    })
    expect(postedBody(1)).toEqual({
      planId: 'p-1',
      launchDigest: 'sha256:abc',
      secretValues: { 'env/HOOKA_API_KEY': 'hk_live_1' },
      clientInstanceId: 'tab-1'
    })
    expect(postedBody(2)).toEqual({ planId: 'p-1', clientInstanceId: 'tab-1' })
    expect(planned).toEqual({ success: true, data: planReply })
    expect(committed).toEqual({ success: true, data: commitResult })
    expect(cancelled).toEqual({ success: true, data: {} })
  })

  it('desktop form, plan, commit and cancel send the /ws requests as given', async () => {
    transport.describeMcpInstall.mockResolvedValueOnce(formReply)
    transport.planMcpInstall.mockResolvedValueOnce(planReply)
    transport.commitMcpInstall.mockResolvedValueOnce(commitResult)
    transport.cancelMcpInstall.mockResolvedValueOnce({})
    const api = createDesktopMcpCatalogApi()

    expect(await api.describeInstall({ source })).toEqual({ success: true, data: formReply })
    expect(await api.planInstall({ source, inputs: {} })).toEqual({
      success: true,
      data: planReply
    })
    expect(
      await api.commitInstall({ planId: 'p-1', launchDigest: 'sha256:abc', secretValues: {} })
    ).toEqual({ success: true, data: commitResult })
    expect(await api.cancelInstall({ planId: 'p-1' })).toEqual({ success: true, data: {} })

    expect(transport.describeMcpInstall).toHaveBeenCalledWith({ source })
    expect(transport.planMcpInstall).toHaveBeenCalledWith({ source, inputs: {} })
    expect(transport.commitMcpInstall).toHaveBeenCalledWith({
      planId: 'p-1',
      launchDigest: 'sha256:abc',
      secretValues: {}
    })
    expect(transport.cancelMcpInstall).toHaveBeenCalledWith({ planId: 'p-1' })
  })

  it('desktop and web surface the same plan lifecycle code', async () => {
    const message = 'the plan was already committed'
    transport.commitMcpInstall.mockRejectedValueOnce(
      new AcpTransportError('MCP_PLAN_CONSUMED', message)
    )
    hostAnswers({ success: false, error: message, code: 'MCP_PLAN_CONSUMED' })
    const request = { planId: 'p-1', launchDigest: 'sha256:abc', secretValues: {} }

    const desktop = await createDesktopMcpCatalogApi().commitInstall(request)

    expect(desktop).toEqual({ success: false, error: message, code: 'MCP_PLAN_CONSUMED' })
    expect(desktop).toEqual(await webMcpCatalogApi.commitInstall(request))
  })
})
