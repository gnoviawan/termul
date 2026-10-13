import type { AcpCatalog } from '@shared/types/acp-catalog.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { transport } = vi.hoisted(() => ({
  transport: {
    listCatalog: vi.fn(),
    setCatalogOptIn: vi.fn()
  }
}))

vi.mock('./acp-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./acp-transport')>()),
  getAcpTransport: () => transport
}))

import { _resetCatalogCacheForTesting } from './acp-catalog-cache'
import { AcpTransportError } from './acp-transport/types'
import { createDesktopAcpCatalogApi } from './desktop-acp-catalog-api'

const catalog = (sources: Array<'bundled' | 'registry'> = []): AcpCatalog =>
  ({
    host: {
      os: 'linux',
      arch: 'x86_64',
      runtimes: { npx: true, uvx: false, node: true, bun: false, python3: true }
    },
    agents: sources.map((source, index) => ({ id: `agent-${index}`, source }))
  }) as unknown as AcpCatalog

describe('createDesktopAcpCatalogApi', () => {
  beforeEach(() => {
    transport.listCatalog.mockReset()
    transport.setCatalogOptIn.mockReset()
    _resetCatalogCacheForTesting()
  })

  it('wraps the host catalog in a success IpcResult', async () => {
    transport.listCatalog.mockResolvedValueOnce(catalog())

    const result = await createDesktopAcpCatalogApi().listCatalog()

    expect(transport.listCatalog).toHaveBeenCalledWith(false)
    expect(result).toEqual({ success: true, data: catalog() })
  })

  it('keeps the host error code of a refused catalog read', async () => {
    transport.listCatalog.mockRejectedValueOnce(
      new AcpTransportError('ACP_CATALOG_UNAVAILABLE', 'acp catalog store is unavailable')
    )

    const result = await createDesktopAcpCatalogApi().listCatalog()

    expect(result).toEqual({
      success: false,
      error: 'acp catalog store is unavailable',
      code: 'ACP_CATALOG_UNAVAILABLE'
    })
  })

  it('maps a failure that is not a protocol error to INVOKE_ERROR', async () => {
    transport.listCatalog.mockRejectedValueOnce(new Error('channel closed'))

    const result = await createDesktopAcpCatalogApi().listCatalog()

    expect(result).toEqual({ success: false, error: 'channel closed', code: 'INVOKE_ERROR' })
  })

  it('replays a fresh catalog without a second request, except on explicit refresh', async () => {
    transport.listCatalog.mockResolvedValue(catalog())
    const api = createDesktopAcpCatalogApi()

    await api.listCatalog()
    await api.listCatalog()
    expect(transport.listCatalog).toHaveBeenCalledTimes(1)

    await api.listCatalog(true)
    expect(transport.listCatalog).toHaveBeenCalledTimes(2)
    expect(transport.listCatalog).toHaveBeenLastCalledWith(true)
  })

  it('setCatalogOptIn sends the flag and drops the cached catalog', async () => {
    transport.listCatalog.mockResolvedValue(catalog())
    transport.setCatalogOptIn.mockResolvedValueOnce(undefined)
    const api = createDesktopAcpCatalogApi()
    await api.listCatalog()

    const result = await api.setCatalogOptIn(true)
    await api.listCatalog()

    expect(transport.setCatalogOptIn).toHaveBeenCalledWith(true)
    expect(result.success).toBe(true)
    expect(transport.listCatalog).toHaveBeenCalledTimes(2)
  })

  it('setCatalogOptIn keeps the host error code of a failed write', async () => {
    transport.setCatalogOptIn.mockRejectedValueOnce(
      new AcpTransportError('ACP_CATALOG_OPT_IN_FAILED', 'opt-in persistence failed')
    )

    const result = await createDesktopAcpCatalogApi().setCatalogOptIn(false)

    expect(result).toMatchObject({ success: false, code: 'ACP_CATALOG_OPT_IN_FAILED' })
  })

  it('isCatalogOptedIn is true when the catalog holds a registry entry', async () => {
    transport.listCatalog.mockResolvedValueOnce(catalog(['bundled', 'registry']))

    expect(await createDesktopAcpCatalogApi().isCatalogOptedIn()).toEqual({
      success: true,
      data: true
    })
  })

  it('isCatalogOptedIn is false when the catalog holds bundled entries only', async () => {
    transport.listCatalog.mockResolvedValueOnce(catalog(['bundled']))

    expect(await createDesktopAcpCatalogApi().isCatalogOptedIn()).toEqual({
      success: true,
      data: false
    })
  })
})
