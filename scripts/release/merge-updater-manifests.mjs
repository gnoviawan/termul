#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const requiredPlatformKeys = [
  'windows-x86_64',
  'windows-x86_64-msi',
  'windows-x86_64-nsis',
  'linux-x86_64',
  'linux-x86_64-appimage',
  'linux-x86_64-deb',
  'linux-x86_64-rpm',
  'darwin-aarch64',
  'darwin-aarch64-app',
  'darwin-x86_64',
  'darwin-x86_64-app',
  // Standalone `termul-server` binary (linux-x64 only today). Each channel's
  // manifest covers both the desktop targets and the server target so a single
  // manifest drives both updaters.
  'linux-x86_64-server'
]

function assertNonEmptyString(value, description) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${description} must be a nonempty string`)
  }
}

function assertPlainObject(value, description) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object`)
  }
}

function assertStringArray(value, description) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry === '')) {
    throw new Error(`${description} must be an array of nonempty strings`)
  }
}

function releaseUrlAssetName(url, tag, description) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${description} must be a valid URL`)
  }
  const expectedPrefix = `/gnoviawan/termul/releases/download/${encodeURIComponent(tag)}/`
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    !parsed.pathname.startsWith(expectedPrefix)
  ) {
    throw new Error(`${description} must target the current ${tag} GitHub release`)
  }
  const encodedName = parsed.pathname.slice(expectedPrefix.length)
  if (!encodedName || encodedName.includes('/')) {
    throw new Error(`${description} must identify one release asset`)
  }
  try {
    return decodeURIComponent(encodedName)
  } catch {
    throw new Error(`${description} contains an invalid encoded asset name`)
  }
}

/**
 * Resolve the GitHub release tag the channel's assets live under.
 *
 * Stable and Insider RC tags are the versioned tag (`v<version>`). Nightly
 * assets live under the moving `nightly` tag regardless of the synthesized
 * `0.0.0-nightly.*` version, so the URL validator must use `nightly` as the
 * tag prefix for that channel. An explicit `tag` override wins.
 */
function resolveReleaseTag(channel, tag, version) {
  if (tag) return tag
  if (channel === 'nightly') return 'nightly'
  return `v${version}`
}

export async function mergeUpdaterManifests({
  inputPaths,
  outputPath,
  version,
  notes,
  pubDate,
  channel = 'stable',
  tag
}) {
  assertNonEmptyString(version, 'version')
  assertNonEmptyString(pubDate, 'pub_date')
  if (typeof notes !== 'string') throw new Error('notes must be a string')
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error('At least one updater manifest is required')
  }

  const releaseTag = resolveReleaseTag(channel, tag, version)
  const platforms = {}
  for (const inputPath of inputPaths) {
    const manifest = JSON.parse(await readFile(inputPath, 'utf8'))
    assertPlainObject(manifest, `Updater manifest ${inputPath}`)
    if (manifest.version !== version) {
      throw new Error(
        `Updater manifest version mismatch: ${inputPath} has ${String(manifest.version)}, expected ${version}`
      )
    }
    assertStringArray(manifest.assetNames, `Updater manifest assetNames in ${inputPath}`)
    const assetNames = new Set(manifest.assetNames)
    assertPlainObject(manifest.platforms, `Updater manifest platforms in ${inputPath}`)

    for (const [key, record] of Object.entries(manifest.platforms)) {
      assertPlainObject(record, `Updater record ${key} in ${inputPath}`)
      assertNonEmptyString(record.url, `Updater record ${key} url`)
      assertNonEmptyString(record.signature, `Updater record ${key} signature`)
      const normalized = { url: record.url.trim(), signature: record.signature.trim() }
      const assetName = releaseUrlAssetName(normalized.url, releaseTag, `Updater record ${key} url`)
      if (!assetNames.has(assetName)) {
        throw new Error(`Updater record ${key} references uncollected release asset ${assetName}`)
      }
      if (!assetNames.has(`${assetName}.sig`)) {
        throw new Error(
          `Updater record ${key} is missing collected signature asset ${assetName}.sig`
        )
      }
      if (basename(assetName) !== assetName) {
        throw new Error(`Updater record ${key} asset name must not contain a path`)
      }
      if (platforms[key]) {
        if (
          platforms[key].url !== normalized.url ||
          platforms[key].signature !== normalized.signature
        ) {
          throw new Error(`Conflicting duplicate updater record for ${key}`)
        }
        continue
      }
      platforms[key] = normalized
    }
  }

  const missing = requiredPlatformKeys.filter((key) => !platforms[key])
  if (missing.length > 0) {
    throw new Error(`Missing required updater platforms: ${missing.join(', ')}`)
  }

  const output = { version, notes, pub_date: pubDate, platforms }
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`)
  return output
}

async function runCli() {
  const argv = process.argv.slice(2)
  const options = { channel: undefined, tag: undefined }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--channel') {
      options.channel = argv[index + 1]
      index += 1
    } else if (arg === '--tag') {
      options.tag = argv[index + 1]
      index += 1
    } else {
      positional.push(arg)
    }
  }

  const [outputPath, version, notesPath, pubDate, ...inputPaths] = positional
  if (!outputPath || !version || !notesPath || !pubDate || inputPaths.length === 0) {
    throw new Error(
      'Usage: merge-updater-manifests.mjs [--channel <stable|insider|nightly>] [--tag <tag>] <output> <version> <notes-file> <pub-date> <manifest> [manifest...]'
    )
  }
  await mergeUpdaterManifests({
    inputPaths,
    outputPath,
    version,
    notes: await readFile(notesPath, 'utf8'),
    pubDate,
    channel: options.channel,
    tag: options.tag
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
