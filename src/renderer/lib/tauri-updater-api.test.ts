import { beforeEach, describe, expect, it, vi } from 'vitest'

// Use vi.hoisted so the mock fns exist when vi.mock factories run (before any
// import of the module under test).
const { mockInvoke, mockGetVersion } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockGetVersion: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke
}))

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: mockGetVersion
}))

import {
  _resetUpdaterStateForTesting,
  checkForUpdates,
  compareVersions,
  DEFAULT_UPDATE_CHANNEL,
  getChannelManifestUrl,
  getChannelReleasePageUrl,
  normalizeUpdateChannel,
  normalizeVersion,
  type UpdateChannel
} from './tauri-updater-api'

describe('normalizeVersion', () => {
  it('strips a leading v and build metadata but preserves the prerelease', () => {
    expect(normalizeVersion('v0.5.0')).toBe('0.5.0')
    expect(normalizeVersion('0.5.0-rc.1')).toBe('0.5.0-rc.1')
    expect(normalizeVersion('v1.2.3-beta.4+macos.7')).toBe('1.2.3-beta.4')
    expect(normalizeVersion(' 0.0.0-nightly.20260807.abc1234 ')).toBe(
      '0.0.0-nightly.20260807.abc1234'
    )
  })

  it('keeps an already-normalized stable version', () => {
    expect(normalizeVersion('0.4.8')).toBe('0.4.8')
  })
})

describe('compareVersions — SemVer prerelease precedence', () => {
  it('orders stable releases numerically', () => {
    expect(compareVersions('0.4.8', '0.4.7')).toBeGreaterThan(0)
    expect(compareVersions('0.5.0', '0.4.8')).toBeGreaterThan(0)
    expect(compareVersions('0.4.8', '0.4.8')).toBe(0)
  })

  it('treats a release as greater than its own prerelease', () => {
    expect(compareVersions('0.5.0', '0.5.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('0.5.0-rc.1', '0.5.0')).toBeLessThan(0)
  })

  it('orders release candidates by their numeric prerelease identifier', () => {
    expect(compareVersions('0.5.0-rc.2', '0.5.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('0.5.0-rc.1', '0.5.0-rc.2')).toBeLessThan(0)
    expect(compareVersions('0.5.0-rc.1', '0.5.0-rc.1')).toBe(0)
  })

  it('orders nightly builds by date/sha while staying below any real release', () => {
    expect(
      compareVersions('0.0.0-nightly.20260808.def', '0.0.0-nightly.20260807.abc')
    ).toBeGreaterThan(0)
    // Nightly core is 0.0.0, so it is always less than a real release.
    expect(compareVersions('0.0.0-nightly.20260808.def', '0.4.8')).toBeLessThan(0)
    expect(compareVersions('0.0.0-nightly.20260808.def', '0.5.0-rc.1')).toBeLessThan(0)
  })

  it('ensures a nightly user that switches to stable is offered the stable build', () => {
    // current nightly vs manifest stable
    expect(compareVersions('0.5.0', '0.0.0-nightly.20260807.abc')).toBeGreaterThan(0)
  })

  it('compares prerelease identifiers with numeric-before-alphanumeric ordering', () => {
    // rc.1 < rc.2 < rc.10 (numeric, not lexical)
    expect(compareVersions('0.5.0-rc.10', '0.5.0-rc.2')).toBeGreaterThan(0)
    // numeric identifiers precede alphanumeric ones
    expect(compareVersions('0.5.0-1', '0.5.0-alpha')).toBeLessThan(0)
  })

  it('pads short core versions to three components', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0)
  })
})

describe('channel URL selection', () => {
  it('returns the manifest URL for each channel per the spec hosting scheme', () => {
    expect(getChannelManifestUrl('stable')).toBe(
      'https://github.com/gnoviawan/termul/releases/latest/download/latest-stable.json'
    )
    expect(getChannelManifestUrl('insider')).toBe(
      'https://github.com/gnoviawan/termul/releases/download/insider/latest-insider.json'
    )
    expect(getChannelManifestUrl('nightly')).toBe(
      'https://github.com/gnoviawan/termul/releases/download/nightly/latest-nightly.json'
    )
  })

  it('returns the release page URL for manual download fallbacks', () => {
    expect(getChannelReleasePageUrl('stable')).toBe(
      'https://github.com/gnoviawan/termul/releases/latest'
    )
    expect(getChannelReleasePageUrl('insider')).toBe(
      'https://github.com/gnoviawan/termul/releases/tag/insider'
    )
    expect(getChannelReleasePageUrl('nightly')).toBe(
      'https://github.com/gnoviawan/termul/releases/tag/nightly'
    )
  })

  it('normalizes unknown/null channel values back to stable', () => {
    expect(normalizeUpdateChannel('stable')).toBe('stable')
    expect(normalizeUpdateChannel('insider')).toBe('insider')
    expect(normalizeUpdateChannel('nightly')).toBe('nightly')
    expect(normalizeUpdateChannel('bogus')).toBe(DEFAULT_UPDATE_CHANNEL)
    expect(normalizeUpdateChannel(null)).toBe(DEFAULT_UPDATE_CHANNEL)
    expect(normalizeUpdateChannel(undefined)).toBe(DEFAULT_UPDATE_CHANNEL)
  })

  it('defaults the UpdateChannel type to stable', () => {
    const channel: UpdateChannel = DEFAULT_UPDATE_CHANNEL
    expect(channel).toBe('stable')
  })
})

describe('fetchChannelManifest via invoke (CSP/CORS-free server-side fetch)', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockGetVersion.mockReset()
    _resetUpdaterStateForTesting()
  })

  it('routes the nightly manifest fetch through updater_fetch_channel_manifest', async () => {
    mockInvoke.mockResolvedValue({
      success: true,
      data: {
        version: '0.9.0',
        notes: 'nightly build',
        pub_date: '2026-08-09T00:00:00Z',
        platforms: {}
      }
    })
    mockGetVersion.mockResolvedValue('0.4.8')

    const update = await checkForUpdates('nightly')

    expect(mockInvoke).toHaveBeenCalledWith('updater_fetch_channel_manifest', {
      channel: 'nightly'
    })
    expect(update).not.toBeNull()
    expect(update?.version).toBe('0.9.0')
    expect(update?.releaseNotes).toBe('nightly build')
    expect(update?.downloadUrl).toBe('https://github.com/gnoviawan/termul/releases/tag/nightly')
  })

  it('surfaces an IpcResult error as createUpdaterCheckError naming the manifest URL', async () => {
    mockInvoke.mockResolvedValue({
      success: false,
      error: 'channel manifest returned HTTP 404',
      code: 'UPDATE_CHECK_FAILED'
    })

    await expect(checkForUpdates('nightly')).rejects.toThrow(
      'Failed to check for updates from https://github.com/gnoviawan/termul/releases/download/nightly/latest-nightly.json: channel manifest returned HTTP 404'
    )
  })

  it('surfaces an invoke rejection as createUpdaterCheckError naming the manifest URL', async () => {
    mockInvoke.mockRejectedValue(new Error('network down'))

    await expect(checkForUpdates('nightly')).rejects.toThrow(
      'Failed to check for updates from https://github.com/gnoviawan/termul/releases/download/nightly/latest-nightly.json: network down'
    )
  })
})
