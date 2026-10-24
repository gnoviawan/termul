import { describe as suite, expect, test } from 'bun:test'
import { compareVersions, describe, evaluateFeed, FEED_URL } from './update-check'

const FEED = {
  version: '0.4.53',
  platforms: {
    'linux-x86_64-deb': { url: 'https://example.test/Termul.Manager_0.4.53_amd64.deb' }
  }
}

suite('update check', () => {
  test('reads the Tauri updater endpoint', () => {
    expect(FEED_URL).toBe(
      'https://github.com/gnoviawan/termul/releases/latest/download/latest.json'
    )
  })

  test('orders versions by semver precedence', () => {
    expect(compareVersions('0.4.53', '0.4.52')).toBeGreaterThan(0)
    expect(compareVersions('0.4.52', '0.4.52')).toBe(0)
    expect(compareVersions('0.4.9', '0.4.10')).toBeLessThan(0)
    expect(compareVersions('v1.0.0', '1.0.0-nightly.3')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-nightly.10', '1.0.0-nightly.9')).toBeGreaterThan(0)
    expect(() => compareVersions('latest', '1.0.0')).toThrow('not a version: latest')
  })

  test('a newer feed without a GPUIX asset points at the Tauri build', () => {
    const check = evaluateFeed('0.4.52', FEED)
    expect(check).toEqual({
      kind: 'available',
      current: '0.4.52',
      latest: '0.4.53',
      gpuixUrl: null,
      tauriUrl: 'https://example.test/Termul.Manager_0.4.53_amd64.deb'
    })
    expect(describe(check)).toBe(
      'Termul Manager 0.4.53 is available (this GPUIX build is 0.4.52). That release has no GPUIX package yet; the Tauri build is https://example.test/Termul.Manager_0.4.53_amd64.deb.'
    )
  })

  test('a GPUIX asset in the feed is the download', () => {
    const feed = {
      ...FEED,
      platforms: { 'linux-x86_64-gpuix-deb': { url: 'https://example.test/termul-gpuix.deb' } }
    }
    expect(describe(evaluateFeed('0.4.52', feed))).toBe(
      'Termul Manager 0.4.53 is available (this GPUIX build is 0.4.52). Download: https://example.test/termul-gpuix.deb'
    )
  })

  test('the same or an older feed version is current', () => {
    expect(describe(evaluateFeed('0.4.53', FEED))).toBe(
      'Termul Manager (GPUIX) 0.4.53 is up to date (latest release 0.4.53).'
    )
    expect(evaluateFeed('0.5.0', FEED).kind).toBe('current')
  })

  test('a malformed feed is an error, not "up to date"', () => {
    expect(() => evaluateFeed('0.4.52', { platforms: {} })).toThrow('feed has no version string')
    expect(() => evaluateFeed('0.4.52', 'nope')).toThrow('feed is not a JSON object')
  })
})
