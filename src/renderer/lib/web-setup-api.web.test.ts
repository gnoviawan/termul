/**
 * `webSetupApi` tests (gh-1105) — the web-only setup/reconfigure facade.
 *
 * Covers the settled wire contract (`src/shared/types/server-setup.types.ts`):
 * - `?setup=` token → `Authorization: Bearer` on `/setup/*` ONLY, parsed once,
 *   stripped from the address bar, kept in sessionStorage (reload during the
 *   restart-wait survives) — never localStorage, never logged;
 * - `/server/config` rides the regular web-auth `authHeader()` via
 *   getJson/postJson;
 * - `IpcBody` failure bodies keep their server code on any status; transport
 *   failures map to NETWORK_ERROR;
 * - desktop (`isTauriContext()`) answers an explicit DESKTOP_UNSUPPORTED
 *   without any fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { tauriRef } = vi.hoisted(() => ({
  tauriRef: { current: false as boolean }
}))

vi.mock('@/lib/tauri-runtime', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri-runtime')>('@/lib/tauri-runtime')
  return { ...actual, isTauriContext: () => tauriRef.current }
})

const { mockLogFrontendError } = vi.hoisted(() => ({
  mockLogFrontendError: vi.fn(() => Promise.resolve())
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: mockLogFrontendError
}))

import {
  SETUP_API_PATHS,
  SETUP_TOKEN_PARAM,
  type ServerSetupAnswers
} from '@shared/types/server-setup.types'
import { _resetWebSetupApiForTesting, getSetupToken, webSetupApi } from './web-setup-api'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const SETUP_TOKEN_SESSION_KEY = 'termul.serverSetupToken'
const WEB_AUTH_STORAGE_KEY = 'termul.webAuthToken'

const ANSWERS: ServerSetupAnswers = {
  host: '0.0.0.0',
  port: 8080,
  sessionsDir: '/var/lib/termul/sessions',
  projectsFile: '/var/lib/termul/projects.json',
  allowRemoteWrites: true,
  updateChannel: 'stable',
  updateIntervalSecs: 21600
}

function ipcResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Unauthorized',
    json: async () => body
  } as unknown as Response
}

/** Put the printed `?setup=` boot param on the jsdom location. */
function setSetupUrl(token: string | null): void {
  window.history.replaceState({}, '', token ? `/?${SETUP_TOKEN_PARAM}=${token}` : '/')
}

describe('webSetupApi (web)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockReset()
    tauriRef.current = false
    _resetWebSetupApiForTesting()
    window.sessionStorage.clear()
    window.localStorage.clear()
    setSetupUrl(null)
  })

  afterEach(() => {
    _resetWebSetupApiForTesting()
    window.sessionStorage.clear()
    window.localStorage.clear()
    setSetupUrl(null)
  })

  it('getStatus GETs /setup/status with the ?setup= token as Bearer and maps the IpcBody reply', async () => {
    setSetupUrl('setup-tok-1')
    const status = {
      setupRequired: true,
      defaults: { ...ANSWERS, sessionsDir: '/home/u/.termul/sessions' }
    }
    fetchMock.mockResolvedValueOnce(ipcResponse({ success: true, data: status }))

    const result = await webSetupApi.getStatus()

    expect(result).toEqual({ success: true, data: status })
    expect(fetchMock).toHaveBeenCalledWith(
      `${window.location.origin}${SETUP_API_PATHS.status}`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer setup-tok-1' })
      })
    )
  })

  it('parses the ?setup= token once, strips it from the URL, and keeps it in sessionStorage', async () => {
    setSetupUrl('setup-tok-2')
    fetchMock.mockResolvedValue(ipcResponse({ success: true, data: { setupRequired: true } }))

    await webSetupApi.getStatus()

    // Stripped from the visible URL (same hygiene as the #token= flow).
    expect(new URLSearchParams(window.location.search).get(SETUP_TOKEN_PARAM)).toBeNull()
    // Kept for restart-wait reloads — sessionStorage, never localStorage.
    expect(window.sessionStorage.getItem(SETUP_TOKEN_SESSION_KEY)).toBe('setup-tok-2')
    expect(window.localStorage.getItem(SETUP_TOKEN_SESSION_KEY)).toBeNull()
    expect(getSetupToken()).toBe('setup-tok-2')

    // A later call reuses the cached token — the param is already gone.
    await webSetupApi.getStatus()
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer setup-tok-2' })
      })
    )
  })

  it('reuses the sessionStorage token after a "reload" (module cache cleared, param gone)', async () => {
    setSetupUrl('setup-tok-3')
    fetchMock.mockResolvedValue(ipcResponse({ success: true, data: {} }))
    await webSetupApi.getStatus()

    // Simulate the restart-wait reload: fresh module state, no ?setup= param.
    _resetWebSetupApiForTesting()
    setSetupUrl(null)

    await webSetupApi.getStatus()
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer setup-tok-3' })
      })
    )
  })

  it('validate POSTs the answers to /setup/validate under the setup token', async () => {
    setSetupUrl('setup-tok-4')
    fetchMock.mockResolvedValueOnce(
      ipcResponse({ success: true, data: { ok: false, fieldErrors: { port: 'invalid port' } } })
    )

    const result = await webSetupApi.validate(ANSWERS)

    expect(result).toEqual({
      success: true,
      data: { ok: false, fieldErrors: { port: 'invalid port' } }
    })
    expect(fetchMock).toHaveBeenCalledWith(
      `${window.location.origin}${SETUP_API_PATHS.validate}`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          Authorization: 'Bearer setup-tok-4'
        }),
        body: JSON.stringify(ANSWERS)
      })
    )
  })

  it('apply POSTs the answers to /setup/apply and logs the accepted boundary (never the token)', async () => {
    setSetupUrl('setup-tok-5')
    const reply = { ok: true, host: '0.0.0.0', port: 8080, webAuthToken: 'wat' }
    fetchMock.mockResolvedValueOnce(ipcResponse({ success: true, data: reply }))

    const result = await webSetupApi.apply(ANSWERS)

    expect(result).toEqual({ success: true, data: reply })
    expect(fetchMock).toHaveBeenCalledWith(
      `${window.location.origin}${SETUP_API_PATHS.apply}`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer setup-tok-5' }),
        body: JSON.stringify(ANSWERS)
      })
    )
    const logged = mockLogFrontendError.mock.calls.map(([p]) => String(p.message))
    expect(logged.some((m) => m.includes('restarting'))).toBe(true)
    for (const [payload] of mockLogFrontendError.mock.calls) {
      expect(JSON.stringify(payload)).not.toContain('setup-tok-5')
      expect(JSON.stringify(payload)).not.toContain('wat')
    }
  })

  it('preserves a structured 401 UNAUTHORIZED failure on /setup/* (missing/wrong token)', async () => {
    fetchMock.mockResolvedValueOnce(
      ipcResponse({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, false, 401)
    )

    const result = await webSetupApi.getStatus()

    expect(result).toEqual({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' })
  })

  it('maps a fetch throw on /setup/* to NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket closed'))

    const result = await webSetupApi.getStatus()

    expect(result.success).toBe(false)
    if (!result.success) expect(result.code).toBe('NETWORK_ERROR')
  })

  it('sends NO Authorization header on /setup/* when no token exists, and warns once', async () => {
    fetchMock.mockResolvedValue(
      ipcResponse({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, false, 401)
    )

    await webSetupApi.getStatus()
    await webSetupApi.getStatus()

    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).headers ?? {}).not.toHaveProperty('Authorization')
    }
    const warns = mockLogFrontendError.mock.calls.filter(
      ([p]) => p.level === 'warn' && String(p.message).includes('without a setup token')
    )
    expect(warns).toHaveLength(1)
  })

  it('never sends the web auth token to /setup/* — and never the setup token to /server/config', async () => {
    setSetupUrl('setup-tok-6')
    window.localStorage.setItem(WEB_AUTH_STORAGE_KEY, 'web-auth-tok')
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return ipcResponse({ success: true, data: { config: ANSWERS } })
    })

    await webSetupApi.getStatus()
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer setup-tok-6'
    })

    fetchMock.mockClear()
    await webSetupApi.getServerConfig()
    expect(fetchMock).toHaveBeenCalledWith(
      `${window.location.origin}${SETUP_API_PATHS.serverConfig}`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer web-auth-tok' })
      })
    )
    const [, configInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.stringify(configInit.headers)).not.toContain('setup-tok-6')
  })

  it('applyServerConfig POSTs to /server/config under the web auth token', async () => {
    window.localStorage.setItem(WEB_AUTH_STORAGE_KEY, 'web-auth-tok')
    fetchMock.mockResolvedValueOnce(
      ipcResponse({ success: true, data: { ok: true, host: '127.0.0.1', port: 4477 } })
    )

    const result = await webSetupApi.applyServerConfig(ANSWERS)

    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      `${window.location.origin}${SETUP_API_PATHS.serverConfig}`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer web-auth-tok' }),
        body: JSON.stringify(ANSWERS)
      })
    )
  })

  it('answers DESKTOP_UNSUPPORTED for every method under isTauriContext() — no fetch at all', async () => {
    tauriRef.current = true
    setSetupUrl('setup-tok-desktop')

    for (const result of [
      await webSetupApi.getStatus(),
      await webSetupApi.validate(ANSWERS),
      await webSetupApi.apply(ANSWERS),
      await webSetupApi.getServerConfig(),
      await webSetupApi.applyServerConfig(ANSWERS)
    ]) {
      expect(result.success).toBe(false)
      if (!result.success) expect(result.code).toBe('DESKTOP_UNSUPPORTED')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
