import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
// @ts-expect-error The production helper is intentionally plain ESM for direct workflow use.
import { mergeUpdaterManifests, requiredPlatformKeys } from './merge-updater-manifests.mjs'

const version = '1.2.3'
const assetName = (suffix: string) => `Termul-${version}-${suffix}.bin`
const record = (suffix: string) => ({
  url: `https://github.com/gnoviawan/termul/releases/download/v${version}/${assetName(suffix)}`,
  signature: `signature-${suffix}`
})

async function fixtureDir() {
  return mkdtemp(join(tmpdir(), 'termul-updater-manifest-'))
}

async function writeManifest(
  path: string,
  platforms: Record<string, unknown>,
  manifestVersion = version,
  assetNames = Object.keys(platforms).flatMap((key) => [assetName(key), `${assetName(key)}.sig`])
) {
  await writeFile(path, JSON.stringify({ version: manifestVersion, assetNames, platforms }))
}

function completePlatforms() {
  return Object.fromEntries(requiredPlatformKeys.map((key: string) => [key, record(key)]))
}

function completeAssetNames() {
  return requiredPlatformKeys.flatMap((key: string) => [assetName(key), `${assetName(key)}.sig`])
}

describe('mergeUpdaterManifests', () => {
  test('authoritatively merges all historical Tauri platform keys', async () => {
    const dir = await fixtureDir()
    const inputs = await Promise.all(
      Object.entries(completePlatforms()).map(async ([key, value], index) => {
        const path = join(dir, `${index}.json`)
        await writeManifest(path, { [key]: value })
        return path
      })
    )
    const outputPath = join(dir, 'latest.json')

    const merged = await mergeUpdaterManifests({
      inputPaths: inputs,
      outputPath,
      version,
      notes: 'notes',
      pubDate: '2026-01-01T00:00:00.000Z'
    })

    expect(Object.keys(merged.platforms).sort()).toEqual([...requiredPlatformKeys].sort())
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(merged)
  })

  test('rejects a missing updater platform', async () => {
    const dir = await fixtureDir()
    const platforms = completePlatforms()
    delete platforms['darwin-x86_64-app']
    const input = join(dir, 'manifest.json')
    await writeManifest(input, platforms)

    await expect(
      mergeUpdaterManifests({
        inputPaths: [input],
        outputPath: join(dir, 'latest.json'),
        version,
        notes: 'notes',
        pubDate: '2026-01-01T00:00:00.000Z'
      })
    ).rejects.toThrow('Missing required updater platforms: darwin-x86_64-app')
  })

  test.each([
    ['empty url', { url: '', signature: 'signature' }, 'url must be a nonempty string'],
    [
      'missing signature',
      { url: record('linux-x86_64').url },
      'signature must be a nonempty string'
    ],
    ['non-object record', 'broken', 'must be an object']
  ])('rejects malformed updater entries: %s', async (_name, malformed, error) => {
    const dir = await fixtureDir()
    const platforms = completePlatforms()
    platforms['linux-x86_64'] = malformed as never
    const input = join(dir, 'manifest.json')
    await writeManifest(input, platforms, version, completeAssetNames())

    await expect(
      mergeUpdaterManifests({
        inputPaths: [input],
        outputPath: join(dir, 'latest.json'),
        version,
        notes: 'notes',
        pubDate: '2026-01-01T00:00:00.000Z'
      })
    ).rejects.toThrow(error)
  })

  test('rejects conflicting duplicate updater records', async () => {
    const dir = await fixtureDir()
    const first = join(dir, 'first.json')
    const second = join(dir, 'second.json')
    await writeManifest(first, completePlatforms(), version, completeAssetNames())
    await writeManifest(second, { 'windows-x86_64': record('different') }, version, [
      assetName('different'),
      `${assetName('different')}.sig`
    ])

    await expect(
      mergeUpdaterManifests({
        inputPaths: [first, second],
        outputPath: join(dir, 'latest.json'),
        version,
        notes: 'notes',
        pubDate: '2026-01-01T00:00:00.000Z'
      })
    ).rejects.toThrow('Conflicting duplicate updater record for windows-x86_64')
  })

  test.each([
    [
      'a different release tag',
      `https://github.com/gnoviawan/termul/releases/download/v9.9.9/${assetName('linux-x86_64')}`,
      'must target the current v1.2.3 GitHub release'
    ],
    [
      'an uncollected asset',
      `https://github.com/gnoviawan/termul/releases/download/v${version}/uncollected.bin`,
      'references uncollected release asset uncollected.bin'
    ]
  ])('rejects updater URLs referencing %s', async (_name, url, error) => {
    const dir = await fixtureDir()
    const platforms = completePlatforms()
    platforms['linux-x86_64'] = { ...record('linux-x86_64'), url }
    const input = join(dir, 'manifest.json')
    await writeManifest(input, platforms, version, completeAssetNames())

    await expect(
      mergeUpdaterManifests({
        inputPaths: [input],
        outputPath: join(dir, 'latest.json'),
        version,
        notes: 'notes',
        pubDate: '2026-01-01T00:00:00.000Z'
      })
    ).rejects.toThrow(error)
  })

  test('rejects a manifest without the collected signature asset', async () => {
    const dir = await fixtureDir()
    const input = join(dir, 'manifest.json')
    const assets = completeAssetNames().filter(
      (name: string) => name !== `${assetName('linux-x86_64')}.sig`
    )
    await writeManifest(input, completePlatforms(), version, assets)

    await expect(
      mergeUpdaterManifests({
        inputPaths: [input],
        outputPath: join(dir, 'latest.json'),
        version,
        notes: 'notes',
        pubDate: '2026-01-01T00:00:00.000Z'
      })
    ).rejects.toThrow(
      `Updater record linux-x86_64 is missing collected signature asset ${assetName('linux-x86_64')}.sig`
    )
  })

  test('requires the linux-x86_64-server platform key covering the server target', async () => {
    const dir = await fixtureDir()
    const platforms = completePlatforms()
    delete platforms['linux-x86_64-server']
    const input = join(dir, 'manifest.json')
    await writeManifest(input, platforms, version, completeAssetNames())

    await expect(
      mergeUpdaterManifests({
        inputPaths: [input],
        outputPath: join(dir, 'latest.json'),
        version,
        notes: 'notes',
        pubDate: '2026-01-01T00:00:00.000Z'
      })
    ).rejects.toThrow('Missing required updater platforms: linux-x86_64-server')
  })

  describe('channel and release-tag selection', () => {
    test('derives the nightly moving tag for the nightly channel', async () => {
      const dir = await fixtureDir()
      const nightlyVersion = '0.0.0-nightly.20260807.abc1234'
      const nightlyAssetNames = requiredPlatformKeys.flatMap((key: string) => [
        assetName(key),
        `${assetName(key)}.sig`
      ])
      const nightlyPlatforms = Object.fromEntries(
        requiredPlatformKeys.map((key: string) => [
          key,
          {
            url: `https://github.com/gnoviawan/termul/releases/download/nightly/${assetName(key)}`,
            signature: `signature-${key}`
          }
        ])
      )
      const input = join(dir, 'manifest.json')
      await writeManifest(input, nightlyPlatforms, nightlyVersion, nightlyAssetNames)

      const outputPath = join(dir, 'latest-nightly.json')
      const merged = await mergeUpdaterManifests({
        inputPaths: [input],
        outputPath,
        version: nightlyVersion,
        notes: 'nightly notes',
        pubDate: '2026-08-07T00:00:00.000Z',
        channel: 'nightly'
      })

      expect(merged.platforms['linux-x86_64-server'].url).toBe(
        `https://github.com/gnoviawan/termul/releases/download/nightly/${assetName('linux-x86_64-server')}`
      )
      expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(merged)
    })

    test('rejects a nightly manifest that targets the versioned tag instead of the nightly tag', async () => {
      const dir = await fixtureDir()
      const nightlyVersion = '0.0.0-nightly.20260807.abc1234'
      const nightlyAssetNames = completeAssetNames()
      const nightlyPlatforms = completePlatforms()
      // URL uses v<version> (the versioned tag) but the nightly channel expects
      // the moving `nightly` tag.
      nightlyPlatforms['linux-x86_64'] = {
        url: `https://github.com/gnoviawan/termul/releases/download/v${nightlyVersion}/${assetName('linux-x86_64')}`,
        signature: `signature-linux-x86_64`
      }
      const input = join(dir, 'manifest.json')
      await writeManifest(input, nightlyPlatforms, nightlyVersion, nightlyAssetNames)

      await expect(
        mergeUpdaterManifests({
          inputPaths: [input],
          outputPath: join(dir, 'latest-nightly.json'),
          version: nightlyVersion,
          notes: 'notes',
          pubDate: '2026-08-07T00:00:00.000Z',
          channel: 'nightly'
        })
      ).rejects.toThrow('must target the current nightly GitHub release')
    })

    test('accepts an explicit tag override regardless of channel', async () => {
      const dir = await fixtureDir()
      const rcVersion = '0.5.0-rc.1'
      const rcAssetNames = completeAssetNames()
      const rcPlatforms = Object.fromEntries(
        requiredPlatformKeys.map((key: string) => [
          key,
          {
            url: `https://github.com/gnoviawan/termul/releases/download/v${rcVersion}/${assetName(key)}`,
            signature: `signature-${key}`
          }
        ])
      )
      const input = join(dir, 'manifest.json')
      await writeManifest(input, rcPlatforms, rcVersion, rcAssetNames)

      const merged = await mergeUpdaterManifests({
        inputPaths: [input],
        outputPath: join(dir, 'latest-insider.json'),
        version: rcVersion,
        notes: 'rc notes',
        pubDate: '2026-08-07T00:00:00.000Z',
        channel: 'insider',
        tag: `v${rcVersion}`
      })

      expect(merged.platforms['linux-x86_64-server'].url).toContain(
        `/releases/download/v${rcVersion}/`
      )
    })
  })
})
