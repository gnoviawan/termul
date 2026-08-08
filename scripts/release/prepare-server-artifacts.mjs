#!/usr/bin/env node

// Produces the per-channel `linux-x86_64-server` platform-manifest fragment
// consumed by `merge-updater-manifests.mjs`. The standalone `termul-server`
// binary is a plain `cargo build` artifact (not a Tauri bundle), so it is not
// collected by `prepare-platform-artifacts.mjs` (which reads tauri-action's
// desktop bundle output). This helper reads the binary's minisign signature
// (produced via `tauri signer sign`) and emits a manifest with the same shape
// so the central merge can validate + merge it alongside the desktop entries.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const SERVER_PLATFORM_KEY = 'linux-x86_64-server'

function fail(message) {
  throw new Error(message)
}

function assertNonEmptyString(value, description) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${description} must be a nonempty string`)
  }
}

function readArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined) {
      fail(`Invalid arguments: ${argv.join(' ')}`)
    }
    options[name.slice(2)] = value
  }
  return options
}

export async function prepareServerArtifacts({
  binaryName = 'termul-server',
  signaturePath,
  tag,
  version,
  outputPath,
  platformKey = SERVER_PLATFORM_KEY
}) {
  assertNonEmptyString(binaryName, 'binary-name')
  assertNonEmptyString(signaturePath, 'signature')
  assertNonEmptyString(tag, 'tag')
  assertNonEmptyString(version, 'version')
  assertNonEmptyString(outputPath, 'output')

  const signature = (await readFile(signaturePath, 'utf8')).trim()
  assertNonEmptyString(signature, 'signature content')

  const url = `https://github.com/gnoviawan/termul/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(binaryName)}`
  const manifest = {
    platform: 'standalone-server',
    version,
    assetNames: [binaryName, `${binaryName}.sig`],
    platforms: {
      [platformKey]: { url, signature }
    }
  }
  // Ensure the output directory exists (the workflow passes a nested path like
  // `server-collected/server-manifest.json` whose dir may not exist yet).
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

async function runCli() {
  const options = readArguments(process.argv.slice(2))
  await prepareServerArtifacts({
    binaryName: options['binary-name'] ?? 'termul-server',
    signaturePath: options.signature,
    tag: options.tag,
    version: options.version,
    outputPath: options.output,
    platformKey: options['platform-key'] ?? SERVER_PLATFORM_KEY
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export { SERVER_PLATFORM_KEY }
