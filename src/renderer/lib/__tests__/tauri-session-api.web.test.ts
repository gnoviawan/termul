/**
 * Web-branch tests for tauri-session-api.ts (CAP-3: Web UI entry parity).
 *
 * `getStore` branches on `isTauriContext()`: desktop calls
 * `Store.load(STORE_FILE, ...)`; web constructs a `WebSessionStore` backed by
 * flat composite localStorage keys (`${STORE_FILE}::${key}`, e.g.
 * `termul-sessions.json::sessions/auto-save`), matching the spec's I/O
 * matrix. All session methods (`save`/`restore`/`clear`/`flush`/`hasSession`)
 * go through `getStore`, so branching in `getStore` makes them all web-aware.
 *
 * This file asserts, per the `log-api.test.ts` dual-branch pattern, that:
 * - the WEB branch reads/writes localStorage and does NOT touch `Store.load`
 * - the DESKTOP branch uses `Store.load` and does NOT touch localStorage
 * - corrupted localStorage (schema mismatch) makes `hasSession` return false
 *
 * The existing `tauri-session-api.test.ts` covers the desktop branch's
 * validation/error paths in depth; this file focuses on the web branch +
 * the branch boundary.
 */

import type { SessionData } from '@shared/types/ipc.types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockStoreLoad, mockIsTauriContext } = vi.hoisted(() => ({
  mockStoreLoad: vi.fn(),
  mockIsTauriContext: vi.fn()
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: mockStoreLoad
  }
}))

vi.mock('../tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

import { _resetStoreInstanceForTesting, tauriSessionApi } from '../tauri-session-api'

const STORE_FILE = 'termul-sessions.json'
const SESSION_KEY = 'sessions/auto-save'

function validSessionData(): SessionData {
  return {
    timestamp: new Date().toISOString(),
    terminals: [
      {
        id: 'term-1',
        shell: 'bash',
        cwd: '/home/user',
        history: ['ls', 'cd /tmp']
      }
    ],
    workspaces: [
      {
        projectId: 'proj-1',
        activeTerminalId: 'term-1',
        terminals: [{ id: 'term-1', shell: 'bash', cwd: '/home/user', history: [] }]
      }
    ]
  }
}

describe('tauriSessionApi (web vs desktop branch)', () => {
  const mockTauriStore = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    save: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    _resetStoreInstanceForTesting()
    localStorage.clear()

    mockStoreLoad.mockResolvedValue(mockTauriStore)
    mockTauriStore.get.mockResolvedValue(undefined)
    mockTauriStore.set.mockResolvedValue(undefined)
    mockTauriStore.delete.mockResolvedValue(undefined)
    mockTauriStore.save.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('hasSession (web branch: localStorage)', () => {
    it('web: returns false when localStorage is empty', async () => {
      mockIsTauriContext.mockReturnValue(false)

      const result = await tauriSessionApi.hasSession()

      expect(result).toEqual({ success: true, data: false })
      expect(mockStoreLoad).not.toHaveBeenCalled()
    })

    it('web: returns true when a valid session is persisted', async () => {
      mockIsTauriContext.mockReturnValue(false)
      const data = validSessionData()
      const persisted = { _version: 1, data }
      localStorage.setItem(`${STORE_FILE}::${SESSION_KEY}`, JSON.stringify(persisted))

      const result = await tauriSessionApi.hasSession()

      expect(result).toEqual({ success: true, data: true })
      expect(mockTauriStore.get).not.toHaveBeenCalled()
    })

    it('web: returns false when the persisted session has no terminals', async () => {
      mockIsTauriContext.mockReturnValue(false)
      const data = validSessionData()
      const persisted = { _version: 1, data: { ...data, terminals: [] } }
      localStorage.setItem(`${STORE_FILE}::${SESSION_KEY}`, JSON.stringify(persisted))

      const result = await tauriSessionApi.hasSession()

      expect(result).toEqual({ success: true, data: false })
    })

    it('web: returns false when localStorage holds corrupted (schema-mismatch) data', async () => {
      mockIsTauriContext.mockReturnValue(false)
      const corrupted = {
        _version: 1,
        data: {
          timestamp: 'bad',
          terminals: 'not-an-array',
          workspaces: []
        }
      }
      localStorage.setItem(`${STORE_FILE}::${SESSION_KEY}`, JSON.stringify(corrupted))

      const result = await tauriSessionApi.hasSession()

      expect(result).toEqual({ success: true, data: false })
    })

    it('web: returns false when the stored JSON is unparseable', async () => {
      mockIsTauriContext.mockReturnValue(false)
      localStorage.setItem(`${STORE_FILE}::${SESSION_KEY}`, '{not-json')

      const result = await tauriSessionApi.hasSession()

      expect(result).toEqual({ success: true, data: false })
    })
  })

  describe('save + restore (web branch: localStorage round-trip)', () => {
    it('web: save writes to localStorage; restore reads it back', async () => {
      mockIsTauriContext.mockReturnValue(false)
      const data = validSessionData()

      const saveResult = await tauriSessionApi.save(data)
      expect(saveResult).toEqual({ success: true, data: undefined })
      expect(mockTauriStore.set).not.toHaveBeenCalled()

      const restoreResult = await tauriSessionApi.restore()
      expect(restoreResult.success).toBe(true)
      if (restoreResult.success) {
        expect(restoreResult.data.terminals).toEqual(data.terminals)
        expect(restoreResult.data.workspaces).toEqual(data.workspaces)
      }
    })

    it('web: restore returns SESSION_NOT_FOUND when nothing saved', async () => {
      mockIsTauriContext.mockReturnValue(false)

      const result = await tauriSessionApi.restore()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('SESSION_NOT_FOUND')
      }
    })

    it('web: save rejects invalid session data with SESSION_INVALID', async () => {
      mockIsTauriContext.mockReturnValue(false)
      const invalid = {
        timestamp: 'x',
        terminals: 'not-array',
        workspaces: []
      } as unknown as SessionData

      const result = await tauriSessionApi.save(invalid)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('SESSION_INVALID')
      }
    })

    it('web: save returns SESSION_STORE_ERROR when the localStorage write fails (quota)', async () => {
      mockIsTauriContext.mockReturnValue(false)
      const data = validSessionData()
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })

      try {
        const result = await tauriSessionApi.save(data)

        expect(result.success).toBe(false)
        if (!result.success) {
          expect(result.code).toBe('SESSION_STORE_ERROR')
        }
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('clear (web branch: localStorage)', () => {
    it('web: clear removes the session key from localStorage', async () => {
      mockIsTauriContext.mockReturnValue(false)
      const data = validSessionData()
      await tauriSessionApi.save(data)

      const result = await tauriSessionApi.clear()

      expect(result).toEqual({ success: true, data: undefined })
      expect(localStorage.getItem(`${STORE_FILE}::${SESSION_KEY}`)).toBeNull()
      expect(mockTauriStore.delete).not.toHaveBeenCalled()
    })
  })

  describe('flush (web branch: localStorage)', () => {
    it('web: flush succeeds with no pending data (localStorage is sync, save is no-op)', async () => {
      mockIsTauriContext.mockReturnValue(false)

      const result = await tauriSessionApi.flush()

      expect(result).toEqual({ success: true, data: undefined })
    })
  })

  describe('desktop branch: Tauri Store', () => {
    it('desktop: hasSession reads from the Tauri Store (not localStorage)', async () => {
      mockIsTauriContext.mockReturnValue(true)
      mockTauriStore.get.mockResolvedValue(undefined)

      await tauriSessionApi.hasSession()

      expect(mockStoreLoad).toHaveBeenCalledTimes(1)
      expect(mockTauriStore.get).toHaveBeenCalledWith(SESSION_KEY)
      // localStorage must not be touched on the desktop branch.
      expect(localStorage.getItem(STORE_FILE)).toBeNull()
    })

    it('desktop: save writes via the Tauri Store', async () => {
      mockIsTauriContext.mockReturnValue(true)
      const data = validSessionData()

      await tauriSessionApi.save(data)

      expect(mockTauriStore.set).toHaveBeenCalledWith(
        SESSION_KEY,
        expect.objectContaining({ _version: 1, data: expect.objectContaining({}) })
      )
      expect(mockTauriStore.save).toHaveBeenCalled()
      expect(localStorage.getItem(STORE_FILE)).toBeNull()
    })

    it('desktop: clear deletes via the Tauri Store', async () => {
      mockIsTauriContext.mockReturnValue(true)

      await tauriSessionApi.clear()

      expect(mockTauriStore.delete).toHaveBeenCalledWith(SESSION_KEY)
      expect(mockTauriStore.save).toHaveBeenCalled()
    })
  })

  describe('_resetStoreInstanceForTesting (branch flip)', () => {
    it('clears the shared singleton so the next call re-creates the adapter for the new branch', async () => {
      // Desktop branch — creates a Tauri Store adapter.
      mockIsTauriContext.mockReturnValue(true)
      mockTauriStore.get.mockResolvedValue(undefined)
      await tauriSessionApi.hasSession()
      expect(mockStoreLoad).toHaveBeenCalledTimes(1)

      // Reset + flip to web — must NOT reuse the Tauri adapter.
      _resetStoreInstanceForTesting()
      mockIsTauriContext.mockReturnValue(false)
      await tauriSessionApi.hasSession()

      // No additional Store.load call (web uses localStorage).
      expect(mockStoreLoad).toHaveBeenCalledTimes(1)
    })
  })
})
