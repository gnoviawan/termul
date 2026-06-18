import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn()
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: vi.fn()
  }
}))

import { getVersion } from '@tauri-apps/api/app'
import { Store } from '@tauri-apps/plugin-store'
import {
  _resetReleaseNotesStoreForTesting,
  compareVersions,
  fetchReleaseNotes,
  getCurrentAppVersion,
  getLastSeenVersion,
  normalizeVersion,
  setLastSeenVersion
} from '../tauri-release-notes'

const mockStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  save: vi.fn()
}

const originalFetch = globalThis.fetch

function mockFetchResponse(body: unknown, ok = true, status = 200): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    json: vi.fn().mockResolvedValue(body)
  }) as never
}

describe('tauri-release-notes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetReleaseNotesStoreForTesting()

    vi.mocked(Store.load).mockResolvedValue(mockStore as never)
    mockStore.get.mockResolvedValue(null)
    mockStore.set.mockResolvedValue(undefined)
    mockStore.delete.mockResolvedValue(undefined)
    mockStore.save.mockResolvedValue(undefined)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('normalizeVersion', () => {
    it('strips leading v and build/prerelease metadata', () => {
      expect(normalizeVersion('v0.4.7')).toBe('0.4.7')
      expect(normalizeVersion('0.4.7-beta.1')).toBe('0.4.7')
      expect(normalizeVersion('0.4.7+build.5')).toBe('0.4.7')
    })
  })

  describe('compareVersions', () => {
    it('returns positive when a is newer', () => {
      expect(compareVersions('0.4.7', '0.4.6')).toBeGreaterThan(0)
    })

    it('returns negative when a is older', () => {
      expect(compareVersions('0.4.6', '0.4.7')).toBeLessThan(0)
    })

    it('returns zero when equal', () => {
      expect(compareVersions('0.4.7', 'v0.4.7')).toBe(0)
    })
  })

  describe('getCurrentAppVersion', () => {
    it('returns the Tauri app version', async () => {
      vi.mocked(getVersion).mockResolvedValue('0.4.7')
      await expect(getCurrentAppVersion()).resolves.toBe('0.4.7')
    })
  })

  describe('last-seen version store', () => {
    it('getLastSeenVersion returns null when nothing stored', async () => {
      const result = await getLastSeenVersion()
      expect(result).toBeNull()
      expect(mockStore.get).toHaveBeenCalledWith('whatsNew.lastSeenVersion')
    })

    it('getLastSeenVersion returns the stored value', async () => {
      mockStore.get.mockResolvedValue('0.4.6')
      await expect(getLastSeenVersion()).resolves.toBe('0.4.6')
    })

    it('setLastSeenVersion stores and saves', async () => {
      await setLastSeenVersion('0.4.7')
      expect(mockStore.set).toHaveBeenCalledWith('whatsNew.lastSeenVersion', '0.4.7')
      expect(mockStore.save).toHaveBeenCalledTimes(1)
    })

    it('reuses the loaded store instance between calls', async () => {
      await getLastSeenVersion()
      await getLastSeenVersion()
      expect(Store.load).toHaveBeenCalledTimes(1)
    })
  })

  describe('fetchReleaseNotes', () => {
    it('maps a successful response with notes', async () => {
      mockFetchResponse({
        tag_name: 'v0.4.7',
        body: '### Features\n- Something new',
        html_url: 'https://github.com/gnoviawan/termul/releases/tag/v0.4.7'
      })

      const result = await fetchReleaseNotes('0.4.7')

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/gnoviawan/termul/releases/tags/v0.4.7',
        expect.objectContaining({
          headers: { Accept: 'application/vnd.github+json' }
        })
      )
      expect(result).toEqual({
        version: '0.4.7',
        notes: '### Features\n- Something new',
        htmlUrl: 'https://github.com/gnoviawan/termul/releases/tag/v0.4.7'
      })
    })

    it('returns null notes when the release body is empty', async () => {
      mockFetchResponse({ tag_name: 'v0.4.7', body: '   ', html_url: 'https://example.com' })
      const result = await fetchReleaseNotes('0.4.7')
      expect(result).toEqual({ version: '0.4.7', notes: null, htmlUrl: 'https://example.com' })
    })

    it('returns null when the release tag is not found (404)', async () => {
      mockFetchResponse({}, false, 404)
      await expect(fetchReleaseNotes('0.4.7')).resolves.toBeNull()
    })

    it('returns null when the request throws (network error / timeout)', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('aborted')) as never
      await expect(fetchReleaseNotes('0.4.7')).resolves.toBeNull()
    })

    it('returns null for an empty version', async () => {
      const fetchSpy = vi.fn()
      globalThis.fetch = fetchSpy as never
      await expect(fetchReleaseNotes('')).resolves.toBeNull()
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })
})
