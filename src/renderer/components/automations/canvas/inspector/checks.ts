/**
 * The host's per-field rules (`graph::check_node`, `model.rs` limits), so a
 * field shows its problem as it is edited. The dry run's issues stay the
 * authority and list in the inspector footer.
 */

import type { NamedTemplate } from '@shared/types/automation.types'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * `FOR_EACH_MAX_ITERATIONS`, `WAIT_MAX_MS`, `APPROVAL_{MIN,MAX}_TIMEOUT_MS`,
 * `AGENT_MAX_TIMEOUT_MS`, `AGENT_MAX_ATTEMPTS` and `MCP_MAX_TIMEOUT_MS` in `model.rs`.
 */
export const LIMITS = {
  agentMaxTimeoutMs: 900_000,
  agentMaxAttempts: 3,
  mcpMaxTimeoutMs: 300_000,
  forEachMaxIterations: 100,
  waitMaxMs: 7 * DAY_MS,
  approvalMinMs: 60_000,
  approvalMaxMs: 7 * DAY_MS
} as const

export function waitError(ms: number): string | null {
  if (ms < 1) return 'Wait at least a moment'
  return ms > LIMITS.waitMaxMs ? 'Wait at most 7 days' : null
}

export function approvalTimeoutError(ms: number): string | null {
  return ms < LIMITS.approvalMinMs || ms > LIMITS.approvalMaxMs
    ? 'Between 1 minute and 7 days'
    : null
}

export function maxIterationsError(n: number): string | null {
  return n < 1 || n > LIMITS.forEachMaxIterations
    ? `Between 1 and ${LIMITS.forEachMaxIterations}`
    : null
}

/** `timeout_ms` must be 1..=`maxMs`; the field counts seconds. */
export function timeoutError(ms: number, maxMs: number): string | null {
  return ms < 1 || ms > maxMs ? `Between 1 and ${maxMs / 1000} seconds` : null
}

export function maxAttemptsError(n: number): string | null {
  return n < 1 || n > LIMITS.agentMaxAttempts ? `Between 1 and ${LIMITS.agentMaxAttempts}` : null
}

export function requiredError(text: string): string | null {
  return text.trim() === '' ? 'Required' : null
}

/** Stands in for each hole while the URL is parsed, as `graph::literal_host` does. */
const HOLE_MARKER = 'termul-template-hole'

/**
 * `graph::check_http_host`: what is wrong with an http step's URL, and the
 * host to allow when that is the fix.
 */
export function urlProblem(
  url: string,
  allowedHosts: readonly string[]
): { message: string; allow?: string } | null {
  if (url.trim() === '') return { message: 'Required' }
  const holes = url.includes('{{')
  let host: string | null
  try {
    const parsed = new URL(url.replace(/\{\{[^}]*\}\}/g, HOLE_MARKER))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { message: 'The URL must start with http:// or https://' }
    }
    if (parsed.hostname === '') return { message: 'The URL has no host' }
    host = parsed.hostname.includes(HOLE_MARKER) ? null : parsed.hostname.toLowerCase()
  } catch {
    if (!holes) return { message: 'Not a valid URL' }
    host = null
  }
  if (host === null) {
    return allowedHosts.length === 0
      ? { message: 'The host comes from a template, so list the hosts it may reach' }
      : null
  }
  if (allowedHosts.some((allowed) => allowed.toLowerCase() === host)) return null
  return { message: `${host} is not an allowed host`, allow: host }
}

/** Empty or repeated names in a header, field or argument list, by row. */
export function nameErrors(items: readonly NamedTemplate[]): (string | null)[] {
  return items.map((item, index) => {
    const name = item.name.trim()
    if (name === '') return 'Needs a name'
    return items.findIndex((other) => other.name.trim() === name) < index
      ? `${name} is already used`
      : null
  })
}

/** Hosts typed as a list: split on commas and spaces, lower-cased, each once. */
export function parseHosts(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean)
    )
  ]
}
