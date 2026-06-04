/**
 * Registry-driven ACP agent catalog.
 *
 * Reads the offline-first snapshot synced by `scripts/sync-acp-icons.mjs`
 * (`assets/agent-icons/acp/agents.json`) and derives a runnable `AgentConfig`
 * from each agent's `distribution` for the current OS/arch. No runtime network.
 */

import { arch as osArch, platform as osPlatform } from '@tauri-apps/plugin-os'
import agentsSnapshot from '@/assets/agent-icons/acp/agents.json'
import type { AgentConfig } from '@/lib/acp-api'

/** A launcher block for the `npx` / `uvx` distribution kinds. */
export interface RegistryLauncher {
  package: string
  args?: string[]
  env?: Record<string, string>
}

/** A per-`platform-arch` binary target. */
export interface RegistryBinaryTarget {
  cmd: string
  args?: string[]
  env?: Record<string, string>
}

export interface RegistryDistribution {
  npx?: RegistryLauncher
  uvx?: RegistryLauncher
  binary?: Record<string, RegistryBinaryTarget>
}

export interface RegistryAgent {
  id: string
  name: string
  version: string
  description: string
  distribution: RegistryDistribution
}

/**
 * Normalize the untrusted JSON snapshot into well-formed entries: require a
 * usable `id`, `name`, and `distribution`; default missing strings; and drop
 * duplicate ids (first wins). Guards the UI from a malformed sync output.
 */
function normalizeSnapshot(raw: unknown): RegistryAgent[] {
  if (!Array.isArray(raw)) return []
  const out: RegistryAgent[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Partial<RegistryAgent>
    const id = typeof e.id === 'string' ? e.id : ''
    if (!id || seen.has(id)) continue
    if (!e.distribution || typeof e.distribution !== 'object') continue
    seen.add(id)
    out.push({
      id,
      name: typeof e.name === 'string' && e.name.length > 0 ? e.name : id,
      version: typeof e.version === 'string' ? e.version : '',
      description: typeof e.description === 'string' ? e.description : '',
      distribution: e.distribution
    })
  }
  return out
}

/** The bundled registry catalog (normalized; sorted by id at sync time). */
export const REGISTRY_AGENTS: readonly RegistryAgent[] = normalizeSnapshot(agentsSnapshot)

/**
 * Outcome of deriving a launch config for the current platform:
 * - `runnable`: a ready `AgentConfig` (npx/uvx, or an installed binary).
 * - `needs-install`: a binary distribution exists for this platform-arch but
 *   requires the user to install it first (download/extraction is out of scope).
 * - `unavailable`: no distribution targets this platform-arch.
 */
export type DeriveResult =
  | { kind: 'runnable'; config: AgentConfig }
  | { kind: 'needs-install'; cmd: string; args: string[]; env: Record<string, string> }
  | { kind: 'unavailable' }

/**
 * The registry keys binary distributions by `{os}-{arch}`, using `darwin` for
 * macOS and `x86_64`/`aarch64` for arch. Tauri's `platform()` returns
 * `macos|linux|windows` and `arch()` returns `x86_64|aarch64`, so only the
 * macOS → darwin rename is needed.
 */
export function currentPlatformArch(): string {
  const p = osPlatform()
  const os = p === 'macos' ? 'darwin' : p
  return `${os}-${osArch()}`
}

/**
 * A package name must not be interpretable as a CLI flag — guard against a
 * malformed/hostile snapshot turning the positional package into an `npx`/`uvx`
 * option (flag injection).
 */
function isSafePackage(pkg: string): boolean {
  return pkg.length > 0 && !pkg.startsWith('-')
}

/** Derive an `AgentConfig` (or unavailability) for the given platform-arch. */
export function deriveAgentConfig(agent: RegistryAgent, platformArch: string): DeriveResult {
  const dist = agent.distribution
  const env = (e?: Record<string, string>): Record<string, string> => ({ ...(e ?? {}) })

  // Prefer zero-install runners (npx > uvx) over binaries.
  if (dist.npx && isSafePackage(dist.npx.package)) {
    return {
      kind: 'runnable',
      config: {
        name: agent.name,
        command: 'npx',
        args: ['-y', dist.npx.package, ...(dist.npx.args ?? [])],
        env: env(dist.npx.env),
        allowTerminal: false
      }
    }
  }

  if (dist.uvx && isSafePackage(dist.uvx.package)) {
    return {
      kind: 'runnable',
      config: {
        name: agent.name,
        command: 'uvx',
        args: [dist.uvx.package, ...(dist.uvx.args ?? [])],
        env: env(dist.uvx.env),
        allowTerminal: false
      }
    }
  }

  const target = dist.binary?.[platformArch]
  if (target) {
    return {
      kind: 'needs-install',
      cmd: target.cmd,
      args: [...(target.args ?? [])],
      env: env(target.env)
    }
  }

  return { kind: 'unavailable' }
}
