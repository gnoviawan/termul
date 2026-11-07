#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { readPin } from './figcraft-pin.mjs'

const root = resolve(import.meta.dirname, '..', '..')

function parseArgs(argv) {
  const opts = {
    pin: resolve(root, 'canvas', 'figcraft.pin'),
    out: resolve(root, 'canvas', 'bundle'),
    zip: null
  }
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (!['--pin', '--out', '--zip'].includes(key) || value === undefined) {
      throw new Error(`usage: fetch-figcraft-bundle.mjs [--pin file] [--out dir] [--zip local.zip]`)
    }
    opts[key.slice(2)] = resolve(value)
  }
  return opts
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function verifyChecksum(bytes, expected) {
  const actual = sha256Hex(bytes)
  if (actual !== expected) {
    throw new Error(`figcraft bundle sha256 mismatch: expected ${expected}, got ${actual}`)
  }
}

export function readZipEntries(zip) {
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('figcraft bundle is not a zip archive')
  const count = zip.readUInt16LE(eocd + 10)
  let cursor = zip.readUInt32LE(eocd + 16)
  const entries = []
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error('corrupt zip central directory')
    const method = zip.readUInt16LE(cursor + 10)
    const compressedSize = zip.readUInt32LE(cursor + 20)
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    const localOffset = zip.readUInt32LE(cursor + 42)
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    const localNameLength = zip.readUInt16LE(localOffset + 26)
    const localExtraLength = zip.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = zip.subarray(dataStart, dataStart + compressedSize)
    if (method !== 0 && method !== 8)
      throw new Error(`unsupported zip method ${method} for ${name}`)
    entries.push({
      name,
      isDir: name.endsWith('/'),
      read: () => (method === 0 ? raw : inflateRawSync(raw))
    })
  }
  return entries
}

export function extractBundle(zip, outDir) {
  const entries = readZipEntries(zip).filter((entry) => entry.name !== '')
  const roots = new Set(entries.map((entry) => entry.name.split('/')[0]))
  const strip = roots.size === 1 && entries.some((entry) => entry.name.includes('/')) ? 1 : 0

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  let written = 0
  for (const entry of entries) {
    const rel = entry.name.split('/').slice(strip).join('/')
    if (rel === '' || entry.isDir) continue
    const target = resolve(outDir, rel)
    if (target !== outDir && !target.startsWith(outDir + sep)) {
      throw new Error(`zip entry escapes the output directory: ${entry.name}`)
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.read())
    written++
  }
  if (written === 0) throw new Error('figcraft bundle archive is empty')
  return written
}

const RELEASE_ASSET_PREFIX = 'https://github.com/gnoviawan/figcraft/releases/download/termul-'
const RELEASE_ASSET =
  /^https:\/\/github\.com\/gnoviawan\/figcraft\/releases\/download\/termul-[A-Za-z0-9._-]+\/figcraft-web-termul-[A-Za-z0-9._-]+\.zip$/

/**
 * The pin's url when it names a figcraft-web release asset of the Termul
 * fork, the only place the bundle is downloaded from; anything else throws.
 * The bytes are checked against the pin's sha256 after the download, so a
 * redirect elsewhere cannot change what gets embedded.
 */
export function pinnedBundleUrl(url) {
  const parsed = URL.canParse(url) ? new URL(url) : null
  const plain = parsed !== null && parsed.href === url && !url.includes('/../')
  if (!plain || !url.startsWith(RELEASE_ASSET_PREFIX) || !RELEASE_ASSET.test(url)) {
    throw new Error(`the pin url is not a figcraft-web release asset of gnoviawan/figcraft: ${url}`)
  }
  return parsed.href
}

async function download(url) {
  const response = await fetch(pinnedBundleUrl(url), { redirect: 'follow' })
  if (!response.ok) throw new Error(`download failed: ${response.status} ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const pin = readPin(opts.pin)
  const bytes = opts.zip ? readFileSync(opts.zip) : await download(pin.url)
  verifyChecksum(bytes, pin.sha256)
  const written = extractBundle(bytes, opts.out)
  console.log(
    `figcraft bundle ${pin.tag}: sha256 verified, ${written} files extracted to ${opts.out}`
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error.message ?? error))
    process.exit(1)
  })
}
