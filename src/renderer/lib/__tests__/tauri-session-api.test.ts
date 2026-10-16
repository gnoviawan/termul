/**
 * Unit tests for tauri-session-api.ts (desktop branch).
 *
 * The session lives in the persistence facade under `sessions/auto-save`. A
 * leftover entry of the legacy `termul-sessions.json` plugin-store file is moved
 * once, then that file is never read again. The web branch (localStorage shim
 * of the legacy file) is covered by `tauri-session-api.web.test.ts`.
 */

import type { SessionData } from '@shared/types/ipc.types'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { fakePersistence, validSessionData } from './session-test-support'

const { mockStoreLoad, mockLogFrontendError } = vi.hoisted(() => ({
  mockStoreLoad: vi.fn(),
  mockLogFrontendError: vi.fn(async () => {})
}))

vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: mockStoreLoad } }))

// `vi.mock` factories run before the static imports, so the shared fake can only
// be reached through a dynamic import (it resolves to the same module instance).
vi.mock('../persistence-api', async () => {
  const { fakePersistence: fake } = await import('./session-test-support')
  return { persistenceApi: fake.api }
})

vi.mock('../log-api', () => ({ logFrontendError: mockLogFrontendError }))

// Desktop branch: without this stub `isTauriContext()` is false under Vitest and
// the legacy file is the localStorage shim (covered by the web test file).
vi.mock('../tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true)
}))

import {
  _resetStoreInstanceForTesting,
  createTauriSessionApi,
  tauriSessionApi
} from '../tauri-session-api'

const SESSION_KEY = 'sessions/auto-save'
const MARKER_KEY = 'sessions/legacy-migrated'
const LEGACY_ENTRY = 'sessions/auto-save'

type LegacyStore = { get: Mock; delete: Mock; save: Mock }

describe('tauriSessionApi', () => {
  let legacy: LegacyStore
  let legacyData: Map<string, unknown>

  const stored = (): unknown => fakePersistence.data.get(SESSION_KEY)

  /** Makes the next facade call of `method` fail once with `error`. */
  function failNext(method: 'read' | 'write' | 'delete', error: string, code = 'WS_ERROR'): void {
    fakePersistence.api[method].mockResolvedValueOnce({ success: false, error, code } as never)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    _resetStoreInstanceForTesting()
    fakePersistence.data.clear()
    // The facade has the marker already, so most tests never open the legacy file.
    fakePersistence.data.set(MARKER_KEY, true)

    legacyData = new Map()
    legacy = {
      get: vi.fn(async (key: string) => legacyData.get(key)),
      delete: vi.fn(async (key: string) => legacyData.delete(key)),
      save: vi.fn(async () => {})
    }
    mockStoreLoad.mockResolvedValue(legacy)
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  describe('save', () => {
    it('writes the session itself (not an envelope) under the session key', async () => {
      const sessionData = validSessionData()

      const result = await tauriSessionApi.save(sessionData)

      expect(result.success).toBe(true)
      expect(stored()).toEqual(
        expect.objectContaining({
          terminals: sessionData.terminals,
          workspaces: sessionData.workspaces
        })
      )
      expect(stored()).not.toHaveProperty('_version')
      expect(mockStoreLoad).not.toHaveBeenCalled()
    })

    it('stamps a fresh timestamp', async () => {
      const sessionData = validSessionData()
      await vi.advanceTimersByTimeAsync(10)

      await tauriSessionApi.save(sessionData)

      const saved = stored() as SessionData
      expect(new Date(saved.timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(sessionData.timestamp).getTime()
      )
    })

    it('returns SESSION_INVALID for invalid session data and writes nothing', async () => {
      const invalidData = {
        timestamp: 'not-a-valid-session',
        terminals: 'not-an-array',
        workspaces: []
      } as unknown as SessionData

      const result = await tauriSessionApi.save(invalidData)

      expect(result).toMatchObject({ success: false, code: 'SESSION_INVALID' })
      if (!result.success) expect(result.error).toContain('Invalid session data structure')
      expect(fakePersistence.api.write).not.toHaveBeenCalled()
    })

    it('validates that terminal id, shell and cwd are present', async () => {
      const invalidTerminals: SessionData = {
        timestamp: new Date().toISOString(),
        terminals: [{ id: '', shell: 'bash', cwd: '/home/user', history: [] }],
        workspaces: []
      }

      expect(await tauriSessionApi.save(invalidTerminals)).toMatchObject({
        success: false,
        code: 'SESSION_INVALID'
      })
    })

    it('validates the workspace structure', async () => {
      const invalidWorkspaces: SessionData = {
        timestamp: new Date().toISOString(),
        terminals: [],
        workspaces: [{ projectId: '', activeTerminalId: null, terminals: [] }]
      }

      expect(await tauriSessionApi.save(invalidWorkspaces)).toMatchObject({
        success: false,
        code: 'SESSION_INVALID'
      })
    })

    it('reports a facade write failure as SESSION_STORE_ERROR', async () => {
      failNext('write', 'Disk full', 'STORE_WRITE_FAILED')

      const result = await tauriSessionApi.save(validSessionData())

      expect(result).toMatchObject({ success: false, code: 'SESSION_STORE_ERROR' })
      if (!result.success) expect(result.error).toContain('Disk full')
    })
  })

  describe('restore', () => {
    it('restores the stored session', async () => {
      const sessionData = validSessionData()
      fakePersistence.data.set(SESSION_KEY, sessionData)

      const result = await tauriSessionApi.restore()

      expect(result).toEqual({ success: true, data: sessionData })
    })

    it('returns SESSION_NOT_FOUND when no session exists', async () => {
      const result = await tauriSessionApi.restore()

      expect(result).toMatchObject({ success: false, code: 'SESSION_NOT_FOUND' })
      if (!result.success) expect(result.error).toContain('No saved session found')
    })

    it('returns SESSION_INVALID for corrupted session data', async () => {
      fakePersistence.data.set(SESSION_KEY, {
        timestamp: '2024-01-01T00:00:00Z',
        terminals: 'not-an-array',
        workspaces: []
      })

      expect(await tauriSessionApi.restore()).toMatchObject({
        success: false,
        code: 'SESSION_INVALID'
      })
    })

    it('reports a facade read failure as SESSION_STORE_ERROR', async () => {
      failNext('read', 'Read failed')

      const result = await tauriSessionApi.restore()

      expect(result).toMatchObject({ success: false, code: 'SESSION_STORE_ERROR' })
      if (!result.success) expect(result.error).toContain('Read failed')
    })
  })

  describe('clear', () => {
    it('deletes the stored session', async () => {
      fakePersistence.data.set(SESSION_KEY, validSessionData())

      const result = await tauriSessionApi.clear()

      expect(result.success).toBe(true)
      expect(fakePersistence.data.has(SESSION_KEY)).toBe(false)
    })

    it('reports a facade delete failure as SESSION_STORE_ERROR', async () => {
      failNext('delete', 'Delete failed')

      expect(await tauriSessionApi.clear()).toMatchObject({
        success: false,
        code: 'SESSION_STORE_ERROR'
      })
    })
  })

  describe('flush', () => {
    it('succeeds with nothing pending', async () => {
      expect(await tauriSessionApi.flush()).toEqual({ success: true, data: undefined })
    })
  })

  describe('hasSession', () => {
    it('is true when a valid session exists', async () => {
      fakePersistence.data.set(SESSION_KEY, validSessionData())

      expect(await tauriSessionApi.hasSession()).toEqual({ success: true, data: true })
    })

    it('is false when no session exists', async () => {
      expect(await tauriSessionApi.hasSession()).toEqual({ success: true, data: false })
    })

    it('is false for invalid session data', async () => {
      fakePersistence.data.set(SESSION_KEY, {
        timestamp: '2024-01-01T00:00:00Z',
        terminals: 'invalid',
        workspaces: []
      })

      expect(await tauriSessionApi.hasSession()).toEqual({ success: true, data: false })
    })

    it('is false for a valid session with no terminals', async () => {
      fakePersistence.data.set(SESSION_KEY, { ...validSessionData(), terminals: [] })

      expect(await tauriSessionApi.hasSession()).toEqual({ success: true, data: false })
    })

    it('reports a facade read failure as SESSION_STORE_ERROR', async () => {
      failNext('read', 'Read failed')

      expect(await tauriSessionApi.hasSession()).toMatchObject({
        success: false,
        code: 'SESSION_STORE_ERROR'
      })
    })
  })

  describe('rapid saves', () => {
    it('applies every save and keeps the last', async () => {
      const results = await Promise.all([
        tauriSessionApi.save(validSessionData()),
        tauriSessionApi.save(validSessionData()),
        tauriSessionApi.save(validSessionData())
      ])

      for (const result of results) expect(result.success).toBe(true)
      expect(fakePersistence.api.write).toHaveBeenCalledTimes(3)
    })
  })

  describe('createTauriSessionApi factory', () => {
    it('returns the singleton instance with every method', () => {
      const api = createTauriSessionApi()

      expect(api).toBe(tauriSessionApi)
      for (const method of ['save', 'restore', 'clear', 'flush', 'hasSession'] as const) {
        expect(typeof api[method]).toBe('function')
      }
    })
  })

  describe('data integrity', () => {
    it('preserves terminals and workspaces across save/restore', async () => {
      const sessionData: SessionData = {
        timestamp: new Date().toISOString(),
        terminals: [
          {
            id: 'term-1',
            shell: 'bash',
            cwd: '/home/user',
            history: ['cmd1', 'cmd2', 'cmd3'],
            env: { TEST: 'value' }
          }
        ],
        workspaces: [
          {
            projectId: 'proj-1',
            activeTerminalId: 'term-1',
            terminals: [{ id: 'term-1', shell: 'bash', cwd: '/home/user', history: [] }]
          },
          { projectId: 'proj-2', activeTerminalId: null, terminals: [] }
        ]
      }

      await tauriSessionApi.save(sessionData)
      const result = await tauriSessionApi.restore()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.terminals[0].history).toEqual(['cmd1', 'cmd2', 'cmd3'])
        expect(result.data.terminals[0].env).toEqual({ TEST: 'value' })
        expect(result.data.workspaces.map((w) => w.activeTerminalId)).toEqual(['term-1', null])
      }
    })
  })

  describe('legacy plugin-store entry', () => {
    beforeEach(() => {
      fakePersistence.data.delete(MARKER_KEY)
    })

    it('moves a versioned legacy entry into the facade, marks it and deletes the entry', async () => {
      const sessionData = validSessionData()
      legacyData.set(LEGACY_ENTRY, { _version: 1, data: sessionData })

      const result = await tauriSessionApi.restore()

      expect(result).toEqual({ success: true, data: sessionData })
      expect(stored()).toEqual(sessionData)
      expect(fakePersistence.data.get(MARKER_KEY)).toBe(true)
      expect(legacy.delete).toHaveBeenCalledWith(LEGACY_ENTRY)
      expect(legacy.save).toHaveBeenCalled()
      expect(legacyData.has(LEGACY_ENTRY)).toBe(false)
    })

    it('moves an unversioned legacy entry too', async () => {
      const sessionData = validSessionData()
      legacyData.set(LEGACY_ENTRY, sessionData)

      expect(await tauriSessionApi.hasSession()).toEqual({ success: true, data: true })
      expect(stored()).toEqual(sessionData)
    })

    it('never opens the legacy file when the facade already holds a session', async () => {
      fakePersistence.data.set(SESSION_KEY, validSessionData())

      await tauriSessionApi.restore()

      expect(mockStoreLoad).not.toHaveBeenCalled()
    })

    it('never opens the legacy file once the move is marked, even with no session', async () => {
      fakePersistence.data.set(MARKER_KEY, true)

      expect(await tauriSessionApi.restore()).toMatchObject({ code: 'SESSION_NOT_FOUND' })
      expect(mockStoreLoad).not.toHaveBeenCalled()
    })

    it('marks the move even when the legacy file holds nothing, then never reads it again', async () => {
      expect(await tauriSessionApi.restore()).toMatchObject({ code: 'SESSION_NOT_FOUND' })
      expect(fakePersistence.data.get(MARKER_KEY)).toBe(true)
      expect(legacy.delete).not.toHaveBeenCalled()

      // A later legacy entry (an older build wrote one) is ignored: the process
      // does not reopen the file, and the next launch finds the marker.
      legacyData.set(LEGACY_ENTRY, validSessionData())
      await tauriSessionApi.clear()
      _resetStoreInstanceForTesting()
      expect(await tauriSessionApi.restore()).toMatchObject({ code: 'SESSION_NOT_FOUND' })
      expect(mockStoreLoad).toHaveBeenCalledTimes(1)
    })

    it('reads the legacy file once per process', async () => {
      legacyData.set(LEGACY_ENTRY, validSessionData())

      await tauriSessionApi.restore()
      await tauriSessionApi.hasSession()
      await tauriSessionApi.clear()
      await tauriSessionApi.restore()

      expect(mockStoreLoad).toHaveBeenCalledTimes(1)
      expect(legacy.get).toHaveBeenCalledTimes(1)
    })

    it('keeps the legacy entry and retries when the facade write fails', async () => {
      const sessionData = validSessionData()
      legacyData.set(LEGACY_ENTRY, { _version: 1, data: sessionData })
      failNext('write', 'host down')

      const first = await tauriSessionApi.restore()

      expect(first).toMatchObject({ success: false, code: 'SESSION_STORE_ERROR' })
      expect(legacyData.has(LEGACY_ENTRY)).toBe(true)
      expect(fakePersistence.data.has(MARKER_KEY)).toBe(false)

      expect(await tauriSessionApi.restore()).toEqual({ success: true, data: sessionData })
      expect(legacyData.has(LEGACY_ENTRY)).toBe(false)
    })

    it('does not bring a stale legacy entry back when clear runs first', async () => {
      legacyData.set(LEGACY_ENTRY, validSessionData())

      expect(await tauriSessionApi.clear()).toEqual({ success: true, data: undefined })

      expect(await tauriSessionApi.restore()).toMatchObject({ code: 'SESSION_NOT_FOUND' })
      expect(legacyData.has(LEGACY_ENTRY)).toBe(false)
    })

    it('lets the session API work when the legacy file cannot be opened', async () => {
      mockStoreLoad.mockRejectedValue(new Error('corrupt store file'))

      expect(await tauriSessionApi.restore()).toMatchObject({ code: 'SESSION_NOT_FOUND' })
      expect(mockLogFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'tauri-session-api.legacy-read' })
      )
      expect((await tauriSessionApi.save(validSessionData())).success).toBe(true)
    })

    it('still succeeds when the legacy entry cannot be deleted', async () => {
      const sessionData = validSessionData()
      legacyData.set(LEGACY_ENTRY, sessionData)
      legacy.delete.mockRejectedValue(new Error('read-only file'))

      expect(await tauriSessionApi.restore()).toEqual({ success: true, data: sessionData })
      expect(fakePersistence.data.get(MARKER_KEY)).toBe(true)
      expect(mockLogFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'tauri-session-api.legacy-delete' })
      )
    })
  })
})
