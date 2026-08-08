/**
 * Web-branch tests for tauri-release-notes.ts (CAP-3: Web UI entry parity).
 *
 * `getCurrentAppVersion`, `getLastSeenVersion`, and `setLastSeenVersion`
 * branch on `isTauriContext()`: desktop calls Tauri's `getVersion()` +
 * `@tauri-apps/plugin-store`; web reads the build-time `VITE_APP_VERSION`
 * define (fallback `'0.0.0'`) + a localStorage-backed adapter. This file
 * asserts, per the `log-api.test.ts` dual-branch pattern, that:
 * - the WEB branch uses `import.meta.env.VITE_APP_VERSION` + localStorage
 * - the DESKTOP branch uses `getVersion()` + the Tauri `Store`
 * - `_resetReleaseNotesStoreForTesting` clears the shared singleton so each
 *   test re-creates the adapter for the current branch.
 *
 * `fetchReleaseNotes` is already web-safe (browser-native `fetch`) and is
 * covered by the existing `tauri-release-notes.test.ts`; this file does not
 * re-test it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetVersion, mockStoreLoad, mockIsTauriContext } = vi.hoisted(() => ({
  mockGetVersion: vi.fn(),
  mockStoreLoad: vi.fn(),
  mockIsTauriContext: vi.fn()
}))

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: mockGetVersion
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: mockStoreLoad
  }
}))

vi.mock('../tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

import {
  _resetReleaseNotesStoreForTesting,
  getCurrentAppVersion,
  getLastSeenVersion,
  setLastSeenVersion
} from '../tauri-release-notes'

const STORE_FILE = 'whats-new.json'
const LAST_SEEN_VERSION_KEY = 'whatsNew.lastSeenVersion'

describe('tauri-release-notes (web vs desktop branch)', () => {
  const mockTauriStore = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    save: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    _resetReleaseNotesStoreForTesting()
    localStorage.clear()

    mockStoreLoad.mockResolvedValue(mockTauriStore)
    mockTauriStore.get.mockResolvedValue(null)
    mockTauriStore.set.mockResolvedValue(undefined)
    mockTauriStore.save.mockResolvedValue(undefined)

    // `VITE_APP_VERSION` is undefined under Vitest (the `define` only applies
    // in the web Vite build). Tests that want the env-constant path stub it
    // explicitly with `vi.stubEnv`.
    vi.stubEnv('VITE_APP_VERSION', '')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('getCurrentAppVersion', () => {
    it('web: returns import.meta.env.VITE_APP_VERSION when defined', async () => {
      mockIsTauriContext.mockReturnValue(false)
      vi.stubEnv('VITE_APP_VERSION', '0.4.8')

      await expect(getCurrentAppVersion()).resolves.toBe('0.4.8')
      expect(mockGetVersion).not.toHaveBeenCalled()
    })

    it('web: falls back to "0.0.0" when VITE_APP_VERSION is undefined (test/SSR)', async () => {
      mockIsTauriContext.mockReturnValue(false)
      vi.stubEnv('VITE_APP_VERSION', '')

      await expect(getCurrentAppVersion()).resolves.toBe('0.0.0')
      expect(mockGetVersion).not.toHaveBeenCalled()
    })

    it('desktop: calls Tauri getVersion()', async () => {
      mockIsTauriContext.mockReturnValue(true)
      mockGetVersion.mockResolvedValue('0.4.8')

      await expect(getCurrentAppVersion()).resolves.toBe('0.4.8')
      expect(mockGetVersion).toHaveBeenCalledTimes(1)
    })
  })

  describe('getLastSeenVersion (web branch: localStorage)', () => {
    it('web: returns null when localStorage is empty (fresh install)', async () => {
      mockIsTauriContext.mockReturnValue(false)

      await expect(getLastSeenVersion()).resolves.toBeNull()
      expect(mockStoreLoad).not.toHaveBeenCalled()
    })

    it('web: reads the stored value from the localStorage adapter', async () => {
      mockIsTauriContext.mockReturnValue(false)
      localStorage.setItem(`${STORE_FILE}::${LAST_SEEN_VERSION_KEY}`, JSON.stringify('0.4.7'))

      await expect(getLastSeenVersion()).resolves.toBe('0.4.7')
      expect(mockTauriStore.get).not.toHaveBeenCalled()
    })

    it('web: returns null when the stored JSON is corrupt', async () => {
      mockIsTauriContext.mockReturnValue(false)
      localStorage.setItem(`${STORE_FILE}::${LAST_SEEN_VERSION_KEY}`, '{not-json')

      await expect(getLastSeenVersion()).resolves.toBeNull()
    })

    it('web: returns null when the stored value is absent (key missing)', async () => {
      mockIsTauriContext.mockReturnValue(false)
      localStorage.setItem(`${STORE_FILE}::other`, JSON.stringify('value'))

      await expect(getLastSeenVersion()).resolves.toBeNull()
    })
  })

  describe('setLastSeenVersion (web branch: localStorage)', () => {
    it('web: writes the value to localStorage and is readable back', async () => {
      mockIsTauriContext.mockReturnValue(false)

      await setLastSeenVersion('0.4.8')

      const raw = localStorage.getItem(`${STORE_FILE}::${LAST_SEEN_VERSION_KEY}`)
      expect(raw).not.toBeNull()
      expect(JSON.parse(raw!)).toBe('0.4.8')

      // Round-trip: getLastSeenVersion reads what setLastSeenVersion wrote.
      await expect(getLastSeenVersion()).resolves.toBe('0.4.8')
      expect(mockTauriStore.set).not.toHaveBeenCalled()
    })

    it('web: preserves other keys when writing', async () => {
      mockIsTauriContext.mockReturnValue(false)
      localStorage.setItem(`${STORE_FILE}::other`, JSON.stringify('preserved'))
      localStorage.setItem(`${STORE_FILE}::${LAST_SEEN_VERSION_KEY}`, JSON.stringify('0.4.6'))

      await setLastSeenVersion('0.4.8')

      expect(JSON.parse(localStorage.getItem(`${STORE_FILE}::${LAST_SEEN_VERSION_KEY}`)!)).toBe(
        '0.4.8'
      )
      expect(JSON.parse(localStorage.getItem(`${STORE_FILE}::other`)!)).toBe('preserved')
    })
  })

  describe('getLastSeenVersion / setLastSeenVersion (desktop branch: Tauri Store)', () => {
    it('desktop: getLastSeenVersion reads from the Tauri Store', async () => {
      mockIsTauriContext.mockReturnValue(true)
      mockTauriStore.get.mockResolvedValue('0.4.6')

      await expect(getLastSeenVersion()).resolves.toBe('0.4.6')
      expect(mockStoreLoad).toHaveBeenCalledTimes(1)
      expect(mockTauriStore.get).toHaveBeenCalledWith(LAST_SEEN_VERSION_KEY)
    })

    it('desktop: setLastSeenVersion writes + saves via the Tauri Store', async () => {
      mockIsTauriContext.mockReturnValue(true)

      await setLastSeenVersion('0.4.8')

      expect(mockTauriStore.set).toHaveBeenCalledWith(LAST_SEEN_VERSION_KEY, '0.4.8')
      expect(mockTauriStore.save).toHaveBeenCalledTimes(1)
    })

    it('desktop: reuses the loaded Store instance between calls', async () => {
      mockIsTauriContext.mockReturnValue(true)
      mockTauriStore.get.mockResolvedValue('0.4.6')

      await getLastSeenVersion()
      await getLastSeenVersion()

      expect(mockStoreLoad).toHaveBeenCalledTimes(1)
    })
  })

  describe('_resetReleaseNotesStoreForTesting', () => {
    it('clears the shared singleton so the next getStore() re-creates the adapter', async () => {
      // Desktop branch — creates a Tauri Store adapter.
      mockIsTauriContext.mockReturnValue(true)
      mockTauriStore.get.mockResolvedValue('0.4.6')
      await getLastSeenVersion()
      expect(mockStoreLoad).toHaveBeenCalledTimes(1)

      // Reset + flip to web — the next call must NOT reuse the Tauri adapter.
      _resetReleaseNotesStoreForTesting()
      mockIsTauriContext.mockReturnValue(false)
      localStorage.setItem(`${STORE_FILE}::${LAST_SEEN_VERSION_KEY}`, JSON.stringify('0.4.7'))
      await getLastSeenVersion()

      // No additional Tauri Store.load call (web uses localStorage).
      expect(mockStoreLoad).toHaveBeenCalledTimes(1)
    })
  })
})
