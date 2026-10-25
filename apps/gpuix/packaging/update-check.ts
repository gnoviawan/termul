/**
 * Check-only update probe for the packaged GPUIX app: `termul-gpuix --check-update`.
 *
 * It reads the Tauri updater feed (`plugins.updater.endpoints` in `src-tauri/tauri.conf.json`,
 * a `latest.json` with `version` and per-platform `url`s) and says whether a newer release
 * exists. It never downloads or installs. The feed has no GPUIX asset yet; the key this reads
 * for one is `linux-x86_64-gpuix-deb`, after kybern's `darwin-<arch>-gpuix` convention.
 */

import tauriConf from '../../../src-tauri/tauri.conf.json' with { type: 'json' }

export const FEED_URL: string = tauriConf.plugins.updater.endpoints[0]
export const GPUIX_PLATFORM_KEY = 'linux-x86_64-gpuix-deb'
export const TAURI_PLATFORM_KEY = 'linux-x86_64-deb'

interface Version {
  core: [number, number, number]
  pre: string | null
}

function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(text.trim())
  if (!match) return null
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null }
}

/** Semver precedence, prerelease identifiers compared as one string: enough for vX.Y.Z[-nightly.N]. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) throw new Error(`not a version: ${left ? b : a}`)
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i]
  }
  if (left.pre === right.pre) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  return left.pre.localeCompare(right.pre, 'en', { numeric: true })
}

export type UpdateCheck =
  | { kind: 'current'; current: string; latest: string }
  | {
      kind: 'available'
      current: string
      latest: string
      /** The GPUIX package in that release, when the feed lists one. */
      gpuixUrl: string | null
      /** The Tauri .deb in that release, for the "no GPUIX build yet" case. */
      tauriUrl: string | null
    }

interface Feed {
  version: string
  platforms?: Record<string, { url?: string }>
}

function parseFeed(body: unknown): Feed {
  if (!body || typeof body !== 'object') throw new Error('feed is not a JSON object')
  const { version, platforms } = body as { version?: unknown; platforms?: unknown }
  if (typeof version !== 'string') throw new Error('feed has no version string')
  if (platforms !== undefined && (typeof platforms !== 'object' || platforms === null)) {
    throw new Error('feed platforms is not an object')
  }
  return { version, platforms: platforms as Feed['platforms'] }
}

export function evaluateFeed(current: string, body: unknown): UpdateCheck {
  const feed = parseFeed(body)
  if (compareVersions(feed.version, current) <= 0) {
    return { kind: 'current', current, latest: feed.version }
  }
  const url = (key: string) => feed.platforms?.[key]?.url ?? null
  return {
    kind: 'available',
    current,
    latest: feed.version,
    gpuixUrl: url(GPUIX_PLATFORM_KEY),
    tauriUrl: url(TAURI_PLATFORM_KEY)
  }
}

export function describe(check: UpdateCheck): string {
  if (check.kind === 'current') {
    return `Termul Manager (GPUIX) ${check.current} is up to date (latest release ${check.latest}).`
  }
  const where = check.gpuixUrl
    ? `Download: ${check.gpuixUrl}`
    : `That release has no GPUIX package yet${check.tauriUrl ? `; the Tauri build is ${check.tauriUrl}` : ''}.`
  return `Termul Manager ${check.latest} is available (this GPUIX build is ${check.current}). ${where}`
}

async function main(): Promise<number> {
  const current = import.meta.env.PACKAGE_VERSION
  if (!current) throw new Error('PACKAGE_VERSION was not defined at bundle time')
  const response = await fetch(FEED_URL, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`GET ${FEED_URL}: HTTP ${response.status}`)
  console.log(describe(evaluateFeed(current, await response.json())))
  return 0
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(
        `[termul-gpuix] error update-check: ${error instanceof Error ? error.message : error}`
      )
      process.exit(1)
    }
  )
}
