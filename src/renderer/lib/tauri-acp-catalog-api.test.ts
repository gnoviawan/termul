import { beforeEach, describe, expect, it, vi } from 'vitest'

// Use vi.hoisted so the mock fn is available when vi.mock factory runs
const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => true
}))

import type { AcpCatalog } from '@shared/types/acp-catalog.types'
import { createTauriAcpCatalogApi } from './tauri-acp-catalog-api'

describe('createTauriAcpCatalogApi', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('listCatalog invokes acp_list_catalog and maps IpcResult', async () => {
    const catalog: AcpCatalog = {
      host: {
        os: 'linux',
        arch: 'x86_64',
        runtimes: { npx: true, uvx: false, node: true, bun: false, python3: true }
      },
      agents: []
    }
    invokeMock.mockResolvedValueOnce({ success: true, data: catalog })

    const api = createTauriAcpCatalogApi()
    const result = await api.listCatalog()

    expect(invokeMock).toHaveBeenCalledWith('acp_list_catalog', { refresh: false })
    expect(result.success).toBe(true)
    expect(result.data).toEqual(catalog)
  })

  it('listCatalog passes refresh=true when requested', async () => {
    invokeMock.mockResolvedValueOnce({ success: true, data: { host: {}, agents: [] } })

    const api = createTauriAcpCatalogApi()
    await api.listCatalog(true)

    expect(invokeMock).toHaveBeenCalledWith('acp_list_catalog', { refresh: true })
  })

  it('listCatalog maps invoke failure to INVOKE_ERROR', async () => {
    invokeMock.mockRejectedValueOnce(new Error('IPC panic'))

    const api = createTauriAcpCatalogApi()
    const result = await api.listCatalog()

    expect(result.success).toBe(false)
    expect(result.code).toBe('INVOKE_ERROR')
    expect(result.error).toContain('IPC panic')
  })

  it('setCatalogOptIn invokes acp_set_catalog_opt_in with enabled', async () => {
    invokeMock.mockResolvedValueOnce({ success: true, data: null })

    const api = createTauriAcpCatalogApi()
    const result = await api.setCatalogOptIn(true)

    expect(invokeMock).toHaveBeenCalledWith('acp_set_catalog_opt_in', { enabled: true })
    expect(result.success).toBe(true)
  })

  it('isCatalogOptedIn derives from listCatalog (registry entries present)', async () => {
    invokeMock.mockResolvedValueOnce({
      success: true,
      data: {
        host: { os: 'linux', arch: 'x86_64', runtimes: {} },
        agents: [
          { id: 'a', source: 'bundled' },
          { id: 'b', source: 'registry' }
        ]
      }
    })

    const api = createTauriAcpCatalogApi()
    const result = await api.isCatalogOptedIn()

    expect(result.success).toBe(true)
    expect(result.data).toBe(true)
  })

  it('isCatalogOptedIn derives from listCatalog (no registry entries)', async () => {
    invokeMock.mockResolvedValueOnce({
      success: true,
      data: {
        host: { os: 'linux', arch: 'x86_64', runtimes: {} },
        agents: [{ id: 'a', source: 'bundled' }]
      }
    })

    const api = createTauriAcpCatalogApi()
    const result = await api.isCatalogOptedIn()

    expect(result.success).toBe(true)
    expect(result.data).toBe(false)
  })
})
