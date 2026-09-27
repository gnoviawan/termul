import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, authHeader, isTauriContext } = vi.hoisted(() => ({
  invoke: vi.fn(),
  authHeader: vi.fn(() => ({ Authorization: 'Bearer test-host-token' })),
  isTauriContext: vi.fn(() => true)
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/lib/web-auth-token', () => ({ authHeader }))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext }))

import { factoryKeyApi } from './factory-key-api'

const config = {
  name: 'Factory Droid',
  command: 'npx',
  args: ['-y', 'droid@0.218.1', 'exec', '--output-format', 'acp-daemon'],
  env: {}
}

describe('factoryKeyApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isTauriContext.mockReturnValue(true)
  })

  it('uses Tauri commands for both status and validated save', async () => {
    invoke.mockResolvedValueOnce(true).mockResolvedValueOnce(undefined)
    expect(await factoryKeyApi.status()).toBe(true)
    await factoryKeyApi.save(config, ' fk-example ')
    expect(invoke).toHaveBeenNthCalledWith(1, 'acp_factory_key_status')
    expect(invoke).toHaveBeenNthCalledWith(2, 'acp_factory_key_save', {
      config,
      key: 'fk-example'
    })
  })

  it('never echoes a key returned in a backend error', async () => {
    invoke.mockRejectedValue('fk-example is invalid')
    await expect(factoryKeyApi.save(config, 'fk-example')).rejects.toThrow(
      'Factory API key could not be validated or stored'
    )
  })

  it('explains when the host has no persistent secret store', async () => {
    invoke.mockRejectedValue('OS keychain unavailable')
    await expect(factoryKeyApi.save(config, 'fk-example')).rejects.toThrow(
      'Set up macOS Keychain, Windows Credential Manager, or Linux Secret Service'
    )
  })

  it('requires a host auth token before sending a key from the browser', async () => {
    isTauriContext.mockReturnValue(false)
    authHeader.mockReturnValueOnce(undefined as never)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(factoryKeyApi.save(config, 'fk-example')).rejects.toThrow(
      'Sign in to the Termul server'
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('passes a key only in an authenticated web request body', async () => {
    isTauriContext.mockReturnValue(false)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true })
    } as Response)
    await factoryKeyApi.save(config, 'fk-example')
    expect(fetchSpy).toHaveBeenCalledWith(
      `${window.location.origin}/acp/factory-key`,
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer test-host-token', 'content-type': 'application/json' },
        body: JSON.stringify({ config, key: 'fk-example' })
      })
    )
    fetchSpy.mockRestore()
  })

  it('reads only the configured flag from the authenticated web route', async () => {
    isTauriContext.mockReturnValue(false)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ configured: true })
    } as Response)
    expect(await factoryKeyApi.status()).toBe(true)
    expect(fetchSpy).toHaveBeenCalledWith(`${window.location.origin}/acp/factory-key`, {
      headers: { Authorization: 'Bearer test-host-token' }
    })
    fetchSpy.mockRestore()
  })

  it('surfaces web status request failures', async () => {
    isTauriContext.mockReturnValue(false)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503
    } as Response)
    await expect(factoryKeyApi.status()).rejects.toThrow(
      'Could not check Factory API key status (HTTP 503)'
    )
    fetchSpy.mockRestore()
  })
})
