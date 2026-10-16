/**
 * Web-branch tests for tauri-session-api.ts (CAP-3: Web UI entry parity).
 *
 * The session lives in the persistence facade (the host store on web). The only
 * thing that still differs between the branches is the legacy file a leftover
 * entry is moved from: on desktop it is the `termul-sessions.json` plugin-store
 * file, on web a localStorage shim of it with flat composite keys
 * (`${STORE_FILE}::${key}`, e.g. `termul-sessions.json::sessions/auto-save`).
 *
 * This file asserts that:
 * - the WEB branch reads (and deletes) the localStorage legacy entry and does
 *   NOT touch `Store.load`
 * - the DESKTOP branch uses `Store.load` and does NOT touch localStorage
 * - session reads and writes never touch localStorage on either branch
 */

import type { SessionData } from '@shared/types/ipc.types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakePersistence, validSessionData } from './session-test-support'

const { mockStoreLoad, mockIsTauriContext } = vi.hoisted(() => ({
  mockStoreLoad: vi.fn(),
  mockIsTauriContext: vi.fn()
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: mockStoreLoad
  }
}))

// `vi.mock` factories run before the static imports, so the shared fake can only
// be reached through a dynamic import (it resolves to the same module instance).
vi.mock('../persistence-api', async () => {
  const { fakePersistence: fake } = await import('./session-test-support')
  return { persistenceApi: fake.api }
})

vi.mock('../log-api', () => ({ logFrontendError: vi.fn(async () => {}) }))

vi.mock('../tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

import { jsonBytes, STORE_VALUE_MAX_BYTES } from '../persistence-trim'
import { _resetStoreInstanceForTesting, tauriSessionApi } from '../tauri-session-api'

const STORE_FILE = 'termul-sessions.json'
const SESSION_KEY = 'sessions/auto-save'
const LEGACY_LOCAL_KEY = `${STORE_FILE}::${SESSION_KEY}`

describe('tauriSessionApi (web vs desktop branch)', () => {
  const legacyDesktopStore = {
    get: vi.fn(),
    delete: vi.fn(),
    save: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    _resetStoreInstanceForTesting()
    localStorage.clear()
    fakePersistence.data.clear()

    mockStoreLoad.mockResolvedValue(legacyDesktopStore)
    legacyDesktopStore.get.mockResolvedValue(undefined)
    legacyDesktopStore.delete.mockResolvedValue(true)
    legacyDesktopStore.save.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('web branch: legacy localStorage entry', () => {
    beforeEach(() => {
      mockIsTauriContext.mockReturnValue(false)
    })

    it('hasSession is false when the facade and localStorage are both empty', async () => {
      expect(await tauriSessionApi.hasSession()).toEqual({ success: true, data: false })
      expect(mockStoreLoad).not.toHaveBeenCalled()
    })

    it('moves a valid legacy entry into the facade and removes it from localStorage', async () => {
      const data = validSessionData()
      localStorage.setItem(LEGACY_LOCAL_KEY, JSON.stringify({ _version: 1, data }))

      expect(await tauriSessionApi.hasSession()).toEqual({ success: true, data: true })

      expect(fakePersistence.data.get(SESSION_KEY)).toEqual(data)
      expect(fakePersistence.data.get('sessions/legacy-migrated')).toBe(true)
      expect(localStorage.getItem(LEGACY_LOCAL_KEY)).toBeNull()
      expect(legacyDesktopStore.get).not.toHaveBeenCalled()
      expect(mockStoreLoad).not.toHaveBeenCalled()
    })

    it('keeps a legacy session with no terminals out of hasSession', async () => {
      const data = { ...validSessionData(), terminals: [] }
      localStorage.setItem(LEGACY_LOCAL_KEY, JSON.stringify({ _version: 1, data }))

      expect(await tauriSessionApi.hasSession()).toEqual({ success: true, data: false })
    })

    it('treats corrupted legacy data as an invalid session', async () => {
      const corrupted = { timestamp: 'bad', terminals: 'not-an-array', workspaces: [] }
      localStorage.setItem(LEGACY_LOCAL_KEY, JSON.stringify({ _version: 1, data: corrupted }))

      expect(await tauriSessionApi.hasSession()).toEqual({ success: true, data: false })
      expect(await tauriSessionApi.restore()).toMatchObject({ code: 'SESSION_INVALID' })
    })

    it('treats an unparseable legacy entry as no legacy entry', async () => {
      localStorage.setItem(LEGACY_LOCAL_KEY, '{not-json')

      expect(await tauriSessionApi.hasSession()).toEqual({ success: true, data: false })
      expect(await tauriSessionApi.restore()).toMatchObject({ code: 'SESSION_NOT_FOUND' })
    })

    it('retries the move on a later call when the legacy entry is unreadable', async () => {
      const data = validSessionData()
      localStorage.setItem(LEGACY_LOCAL_KEY, JSON.stringify({ _version: 1, data }))
      const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
        throw new Error('SecurityError')
      })

      try {
        expect(await tauriSessionApi.hasSession()).toEqual({ success: true, data: false })
        expect(fakePersistence.data.has('sessions/legacy-migrated')).toBe(false)
        expect(await tauriSessionApi.hasSession()).toEqual({ success: true, data: true })
        expect(fakePersistence.data.get(SESSION_KEY)).toEqual(data)
      } finally {
        getItem.mockRestore()
      }
    })

    it('marks the move done when the facade already holds a session', async () => {
      fakePersistence.data.set(SESSION_KEY, validSessionData())
      localStorage.setItem(
        LEGACY_LOCAL_KEY,
        JSON.stringify({ _version: 1, data: validSessionData() })
      )

      await tauriSessionApi.hasSession()

      expect(fakePersistence.data.get('sessions/legacy-migrated')).toBe(true)
    })

    it('trims an oversized session to the newest history lines before it writes', async () => {
      const data = validSessionData()
      data.terminals[0].history = Array.from(
        { length: 4000 },
        (_, i) => `cmd ${String(i).padStart(5, '0')} ${'x'.repeat(100)}`
      )

      expect(await tauriSessionApi.save(data)).toMatchObject({ success: true })

      const stored = fakePersistence.data.get(SESSION_KEY) as SessionData
      expect(jsonBytes({ _version: 1, data: stored })).toBeLessThanOrEqual(STORE_VALUE_MAX_BYTES)
      const history = stored.terminals[0].history
      expect(history.length).toBeGreaterThan(0)
      expect(history.length).toBeLessThan(4000)
      expect(history.at(-1)).toBe(data.terminals[0].history.at(-1))
    })

    it('does not read localStorage again once a session is stored', async () => {
      await tauriSessionApi.save(validSessionData())
      const getItem = vi.spyOn(Storage.prototype, 'getItem')

      try {
        _resetStoreInstanceForTesting()
        expect(await tauriSessionApi.hasSession()).toEqual({ success: true, data: true })
        expect(getItem).not.toHaveBeenCalled()
      } finally {
        getItem.mockRestore()
      }
    })

    it('still moves the entry when localStorage.removeItem fails, and marks the move', async () => {
      const data = validSessionData()
      localStorage.setItem(LEGACY_LOCAL_KEY, JSON.stringify({ _version: 1, data }))
      const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new Error('SecurityError')
      })

      try {
        const result = await tauriSessionApi.restore()

        expect(result).toMatchObject({ success: true })
        expect(fakePersistence.data.get('sessions/legacy-migrated')).toBe(true)
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('web branch: session in the facade', () => {
    beforeEach(() => {
      mockIsTauriContext.mockReturnValue(false)
    })

    it('save writes the facade and never localStorage; restore reads it back', async () => {
      const data = validSessionData()
      const setItem = vi.spyOn(Storage.prototype, 'setItem')

      try {
        expect(await tauriSessionApi.save(data)).toEqual({ success: true, data: undefined })
        expect(setItem).not.toHaveBeenCalledWith(LEGACY_LOCAL_KEY, expect.anything())
      } finally {
        setItem.mockRestore()
      }
      expect(mockStoreLoad).not.toHaveBeenCalled()

      const restored = await tauriSessionApi.restore()
      expect(restored.success).toBe(true)
      if (restored.success) {
        expect(restored.data.terminals).toEqual(data.terminals)
        expect(restored.data.workspaces).toEqual(data.workspaces)
      }
    })

    it('restore returns SESSION_NOT_FOUND when nothing is stored', async () => {
      expect(await tauriSessionApi.restore()).toMatchObject({
        success: false,
        code: 'SESSION_NOT_FOUND'
      })
    })

    it('clear removes the session from the facade', async () => {
      await tauriSessionApi.save(validSessionData())

      expect(await tauriSessionApi.clear()).toEqual({ success: true, data: undefined })
      expect(fakePersistence.data.has(SESSION_KEY)).toBe(false)
    })

    it('flush succeeds with no pending data', async () => {
      expect(await tauriSessionApi.flush()).toEqual({ success: true, data: undefined })
    })
  })

  describe('desktop branch: legacy Tauri Store file', () => {
    beforeEach(() => {
      mockIsTauriContext.mockReturnValue(true)
    })

    it('reads the legacy plugin-store file (not localStorage) when the facade has no session', async () => {
      localStorage.setItem(LEGACY_LOCAL_KEY, JSON.stringify({ _version: 1, data: {} }))

      await tauriSessionApi.hasSession()

      expect(mockStoreLoad).toHaveBeenCalledTimes(1)
      expect(legacyDesktopStore.get).toHaveBeenCalledWith(SESSION_KEY)
      expect(localStorage.getItem(LEGACY_LOCAL_KEY)).not.toBeNull()
    })

    it('save and clear go to the facade, not the plugin-store file', async () => {
      await tauriSessionApi.save(validSessionData())
      await tauriSessionApi.clear()

      expect(fakePersistence.api.write).toHaveBeenCalledWith(SESSION_KEY, expect.anything())
      expect(fakePersistence.api.delete).toHaveBeenCalledWith(SESSION_KEY)
      expect(legacyDesktopStore.delete).not.toHaveBeenCalled()
    })
  })

  describe('_resetStoreInstanceForTesting (branch flip)', () => {
    it('re-creates the legacy adapter for the new branch', async () => {
      // Desktop branch — opens the Tauri legacy store.
      mockIsTauriContext.mockReturnValue(true)
      await tauriSessionApi.hasSession()
      expect(mockStoreLoad).toHaveBeenCalledTimes(1)

      // Reset + flip to web — must NOT reuse the Tauri adapter.
      _resetStoreInstanceForTesting()
      fakePersistence.data.clear()
      mockIsTauriContext.mockReturnValue(false)
      await tauriSessionApi.hasSession()

      // No additional Store.load call (web uses localStorage).
      expect(mockStoreLoad).toHaveBeenCalledTimes(1)
    })
  })
})
