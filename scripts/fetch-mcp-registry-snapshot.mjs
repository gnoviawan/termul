#!/usr/bin/env node
// Builds the MCP catalog snapshot the host embeds (spine AD-3). The release
// workflow runs this in a job with no secrets and swaps the output in for the
// committed dev fixture before `cargo build`. Never run from build.rs.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

const root = resolve(import.meta.dirname, '..')
const REGISTRY = 'https://registry.modelcontextprotocol.io/v0.1/servers'
const OFFICIAL = 'io.modelcontextprotocol.registry/official'
const PAGE_LIMIT = 100
const MAX_PAGES = 5000
const MAX_PAGE_BYTES = 8 * 1024 * 1024
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const RETRIES = 4

export const SNAPSHOT_FILE = 'mcp-registry-snapshot.json.gz'
export const META_FILE = 'mcp-registry-snapshot.meta.json'

// A release snapshot smaller than this is a truncated crawl, not the registry.
const MIN_RELEASE_SERVERS = 1000

function parseArgs(argv) {
  const opts = {
    out: resolve(root, 'src-tauri', 'resources', 'mcp-registry'),
    only: null,
    verify: null
  }
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (!['--out', '--only', '--verify'].includes(key) || value === undefined) {
      throw new Error(
        'usage: fetch-mcp-registry-snapshot.mjs [--out dir] [--only names.txt] | --verify dir'
      )
    }
    opts[key.slice(2)] = resolve(value)
  }
  return opts
}

/** Fails unless `dir` holds a snapshot whose bytes match its recorded sha256. */
export function verifySnapshot(dir, minServers = MIN_RELEASE_SERVERS) {
  const gz = readFileSync(resolve(dir, SNAPSHOT_FILE))
  const meta = JSON.parse(readFileSync(resolve(dir, META_FILE), 'utf8'))
  const sha256 = createHash('sha256').update(gz).digest('hex')
  if (sha256 !== meta.sha256)
    throw new Error(`snapshot sha256 ${sha256} does not match ${meta.sha256}`)
  if (meta.sample) throw new Error('snapshot is the --only sample, not a release snapshot')
  const snapshot = JSON.parse(gunzipSync(gz).toString('utf8'))
  if (snapshot.formatVersion !== 1) throw new Error(`snapshot format ${snapshot.formatVersion}`)
  if (snapshot.servers.length !== meta.servers || snapshot.servers.length < minServers) {
    throw new Error(
      `snapshot has ${snapshot.servers.length} servers (meta ${meta.servers}, minimum ${minServers})`
    )
  }
  return meta
}

function readNameList(path) {
  return new Set(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  )
}

/** Stops reading once the body passes `maxBytes`, so an oversized page is never buffered whole. */
export async function readBody(response, maxBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of response.body ?? []) {
    total += chunk.length
    if (total > maxBytes) throw new Error(`registry page exceeds ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function fetchPage(cursor) {
  const url = new URL(REGISTRY)
  url.searchParams.set('limit', String(PAGE_LIMIT))
  url.searchParams.set('include_deleted', 'true')
  if (cursor) url.searchParams.set('cursor', cursor)
  let lastError
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`)
      const body = await readBody(response, MAX_PAGE_BYTES)
      return JSON.parse(body.toString('utf8'))
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`registry page fetch failed after ${RETRIES + 1} attempts: ${lastError}`)
}

export async function crawl(fetcher = fetchPage) {
  const rows = []
  let cursor = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await fetcher(cursor)
    if (!Array.isArray(body?.servers)) throw new Error('registry page has no servers array')
    rows.push(...body.servers)
    cursor = body.metadata?.nextCursor ?? null
    if (!cursor) return rows
  }
  throw new Error(`registry crawl did not finish within ${MAX_PAGES} pages`)
}

// The host never reads these: icons are never fetched (AD-15), publisher
// `_meta` is enrichment (deferred), and parsing never depends on `$schema`.
const DROPPED_SERVER_FIELDS = new Set(['$schema', 'icons', '_meta'])

function slimServer(server) {
  return Object.fromEntries(
    Object.entries(server).filter(([key]) => !DROPPED_SERVER_FIELDS.has(key))
  )
}

/**
 * Latest rows keep their `server.json` (deleted ones too, so the host filters
 * them itself). Every version, latest included, also gets a status-only
 * `[name, version, status]` row.
 */
export function buildSnapshot(rows, only = null) {
  const servers = []
  const versions = []
  for (const row of rows) {
    const name = row?.server?.name
    const version = row?.server?.version
    const official = row?._meta?.[OFFICIAL]
    if (typeof name !== 'string' || typeof version !== 'string' || !official) continue
    if (only && !only.has(name)) continue
    const status = String(official.status ?? 'active')
    versions.push([name, version, status])
    if (official.isLatest === true) {
      servers.push({
        server: slimServer(row.server),
        _meta: {
          [OFFICIAL]: {
            status,
            isLatest: true,
            publishedAt: official.publishedAt,
            updatedAt: official.updatedAt
          }
        }
      })
    }
  }
  servers.sort((a, b) => a.server.name.localeCompare(b.server.name))
  versions.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  return { formatVersion: 1, servers, versions }
}

function writeAtomic(path, bytes) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, bytes)
  renameSync(tmp, path)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.verify) {
    const meta = verifySnapshot(opts.verify)
    console.log(`mcp registry snapshot verified: ${meta.servers} servers, sha256 ${meta.sha256}`)
    return
  }
  const only = opts.only ? readNameList(opts.only) : null
  const fetchedAt = new Date().toISOString()
  const rows = await crawl()
  const snapshot = buildSnapshot(rows, only)
  if (snapshot.servers.length === 0) throw new Error('snapshot has no latest rows')
  if (only) {
    const missing = [...only].filter(
      (name) => !snapshot.servers.some((row) => row.server.name === name)
    )
    if (missing.length > 0) throw new Error(`names not in the registry: ${missing.join(', ')}`)
  }
  const gz = gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'), { level: 9 })
  if (gz.length > MAX_SNAPSHOT_BYTES)
    throw new Error(`snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`)
  const meta = {
    sha256: createHash('sha256').update(gz).digest('hex'),
    fetchedAt,
    bytes: gz.length,
    servers: snapshot.servers.length,
    versions: snapshot.versions.length,
    // The host crawls the whole registry on its first sync over a sample.
    ...(only && { sample: true })
  }
  mkdirSync(opts.out, { recursive: true })
  writeAtomic(resolve(opts.out, SNAPSHOT_FILE), gz)
  writeAtomic(resolve(opts.out, META_FILE), `${JSON.stringify(meta, null, 2)}\n`)
  console.log(
    `mcp registry snapshot: ${meta.servers} servers, ${meta.versions} versions, ${meta.bytes} bytes, sha256 ${meta.sha256}`
  )
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
