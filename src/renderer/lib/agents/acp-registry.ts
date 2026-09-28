/**
 * Registry-driven ACP agent catalog.
 *
 * Reads the bundled offline-first snapshot
 * (`assets/agent-icons/acp/agents.json` — a frozen, trusted baseline) and
 * derives a runnable `AgentConfig` from each agent's `distribution` for the
 * current OS/arch. No runtime network.
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
  /** HTTPS release archive (.zip or .tar.gz) from the ACP registry. */
  archive?: string
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
 * Per-agent install/update policy for the managed-npm distribution kind
 * (S2-TS): declarative facts that replace hardcoded
 * `agent.id === 'claude-acp'` if-chains in `supported-acp-agents.ts` and
 * `acp-store.ts` `applyAgentUpdate`. Agents whose policy install kind is NOT
 * `managed-npm` derive install/update behavior from their `distribution`
 * (`archive` targets or a generic `npx`/`uvx` package-manager launcher).
 *
 * User-facing strings are carried verbatim in the policy so tests that assert
 * them stay byte-identical.
 */
export interface ManagedNpmInstallPolicy {
  kind: 'managed-npm'
  /** Minimum Node major version the managed npm install requires. */
  minNodeMajor: number
  /**
   * Legacy npm package names (bare, without a `@version` suffix) whose
   * persisted `npx` launcher configs must migrate to the managed install.
   * Matched as `arg === pkg || arg.startsWith(`${pkg}@`)`.
   */
  legacyPackageNames: string[]
  /** Preflight reason when the host Node major is below `minNodeMajor`. */
  needsRuntimeOldNodeReason: string
  /** Preflight reason when npm is missing (Node 22+ present). */
  needsRuntimeNoNpmReason: string
  /** Reason when no archive exists and a manual vendor install is required. */
  manualInstallReason: string
}

/**
 * Non-managed install kinds: behavior is derived from the agent's
 * `distribution` at runtime — an HTTPS `archive` target, or a generic
 * `package-manager` (`npx`/`uvx`) launcher.
 */
export type DerivedInstallPolicy = { kind: 'archive' } | { kind: 'package-manager' }

export type AgentInstallPolicy = ManagedNpmInstallPolicy | DerivedInstallPolicy

/**
 * Per-agent auth policy (S2-TS/S3-store): declarative facts that replace
 * hardcoded `'factory-droid'` / `'factory-api-key'` string comparisons in the
 * renderer. Exported from `acp-registry.ts` so the launcher UI, the browser
 * auth dialog, and the store all consume one contract.
 *
 * - `mode: 'host-managed'` — the host validates auth before spawn and reports
 *   readiness via `SpawnAgentResult.hostAuthReady` (the wire expression of
 *   this fact — see the residual note on `SpawnAgentResult` in `acp-api.ts`).
 * - `mode: 'acp'` — auth flows through ACP `authenticate` in the renderer.
 */
export interface AgentAuthPolicy {
  mode: 'host-managed' | 'acp'
  /**
   * `mode: 'acp'` only: the advertised auth method id that is offered as an
   * inline key form in the UI (AgentLauncher) instead of a round-trip through
   * ACP `authenticate`. The key itself is stored on the host
   * (`factoryKeyApi`), never sent through the agent. Absent for agents whose
   * auth is driven entirely by advertised ACP methods.
   */
  inlineKeyFormMethodId?: string
  /**
   * `mode: 'acp'` only: when the agent advertises more than one method and a
   * prior browser login has persisted host-side credentials, let
   * `session/new` run with those credentials instead of auto-choosing a
   * method or throwing `AmbiguousAuthError`.
   */
  reusePersistedCredentials?: boolean
  /**
   * The agent resets the model of every session in its process when
   * `session/new` runs: a new chat must be isolated from active sessions —
   * `ensureLiveAgent` detaches the canonical reuse key into a
   * `detachedReuseKey` and spawns a fresh process, and the warm-pool reseed
   * after promotion is skipped.
   */
  isolateNewSessions?: boolean
}

/** Per-agent behavior policy keyed by registry agent id (see `agentPolicy`). */
export interface AgentPolicy {
  install: AgentInstallPolicy
  auth: AgentAuthPolicy
}

/**
 * Registry-adjacent policy map (S2-TS). Keyed by registry agent id; agents
 * absent from the map get the defaults in {@link DEFAULT_AGENT_POLICY}:
 * install behavior derived from the `distribution`, and ACP-driven auth.
 */
const AGENT_POLICIES: Record<string, AgentPolicy> = {
  'claude-acp': {
    install: {
      kind: 'managed-npm',
      minNodeMajor: 22,
      legacyPackageNames: [
        '@agentclientprotocol/claude-agent-acp',
        '@zed-industries/claude-code-acp',
        'claude-agent-acp'
      ],
      needsRuntimeOldNodeReason:
        'Claude Agent ACP requires Node.js 22 or newer. Install or upgrade Node.js, then restart Termul.',
      needsRuntimeNoNpmReason:
        'Claude Agent ACP requires npm. Install npm alongside Node.js 22 or newer, then restart Termul.',
      manualInstallReason:
        'Install Claude Code CLI from Anthropic, then run `claude auth login` in a terminal.'
    },
    auth: { mode: 'host-managed' }
  },
  'factory-droid': {
    install: { kind: 'package-manager' },
    auth: {
      mode: 'acp',
      inlineKeyFormMethodId: 'factory-api-key',
      reusePersistedCredentials: true,
      isolateNewSessions: true
    }
  }
}

const DEFAULT_AGENT_POLICY: AgentPolicy = {
  install: { kind: 'package-manager' },
  auth: { mode: 'acp' }
}

/** The behavior policy for a registry agent id (defaults for unknown ids). */
export function agentPolicy(registryAgentId: string): AgentPolicy {
  return AGENT_POLICIES[registryAgentId] ?? DEFAULT_AGENT_POLICY
}

/**
 * The behavior policy for a persisted agent config id. Registry configs use
 * the `acp-registry:<id>` form; custom agents fall through to the defaults.
 */
export function agentPolicyForConfigId(configId: string): AgentPolicy {
  return agentPolicy(
    configId.startsWith('acp-registry:') ? configId.slice('acp-registry:'.length) : configId
  )
}

/**
 * Map a host-reported OS (`std::env::consts::OS`: `macos`/`linux`/`windows`)
 * to the registry's binary-map OS key. The registry keys binary distributions
 * by `{os}-{arch}` using `darwin` for macOS; only the macOS → darwin rename is
 * needed. Single owner for the catalog consumers (`supported-acp-agents.ts`,
 * `acp-store.ts` `applyAgentUpdate`) that previously duplicated the ternary.
 */
export function registryOsFromHostOs(hostOs: string): string {
  return hostOs === 'macos' ? 'darwin' : hostOs
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

/** Normalize untrusted registry JSON (bundled snapshot or CDN fetch). */
export function normalizeRegistrySnapshot(raw: unknown): RegistryAgent[] {
  return normalizeSnapshot(raw)
}

export function compareRegistryVersions(
  bundled: readonly RegistryAgent[],
  remote: readonly RegistryAgent[]
): { updatedCount: number; newAgentIds: string[] } {
  const bundledById = new Map(bundled.map((agent) => [agent.id, agent.version]))
  const remoteIds = new Set(remote.map((agent) => agent.id))
  const newAgentIds: string[] = []
  let updatedCount = 0
  for (const agent of remote) {
    const bundledVersion = bundledById.get(agent.id)
    if (bundledVersion === undefined) {
      newAgentIds.push(agent.id)
      updatedCount++
      continue
    }
    if (bundledVersion !== agent.version) updatedCount++
  }
  // Count removed agents (bundled but absent from remote) so the summary can't
  // report "up to date" while the available agent list has actually shrunk.
  for (const agent of bundled) {
    if (!remoteIds.has(agent.id)) updatedCount++
  }
  return { updatedCount, newAgentIds }
}

/**
 * Outcome of deriving a launch config for the current platform:
 * - `runnable`: a ready `AgentConfig` (npx/uvx, or an installed binary).
 * - `needs-install`: a binary distribution exists for this platform-arch but
 *   requires the user to install it first (download/extraction is out of scope).
 * - `unavailable`: no distribution targets this platform-arch.
 */
export type DeriveResult =
  | { kind: 'runnable'; config: AgentConfig }
  | {
      kind: 'needs-install'
      cmd: string
      args: string[]
      env: Record<string, string>
      archiveUrl?: string
    }
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

/**
 * An archive is installable only when it is an HTTPS URL whose path ends with a
 * format the Rust installer can extract (zip / gzip-tar). Anything else (raw
 * binaries, `.tar.bz2`, ...) returns `undefined` so the agent is not marked
 * installable from a format we cannot unpack.
 */
function supportedArchiveUrl(archive: string | undefined): string | undefined {
  if (typeof archive !== 'string' || !archive.startsWith('https://')) return undefined
  const path = archive.split(/[?#]/)[0].toLowerCase()
  return path.endsWith('.zip') || path.endsWith('.tar.gz') || path.endsWith('.tgz')
    ? archive
    : undefined
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
    const archiveUrl = supportedArchiveUrl(target.archive)
    return {
      kind: 'needs-install',
      cmd: target.cmd,
      args: [...(target.args ?? [])],
      env: env(target.env),
      archiveUrl
    }
  }

  return { kind: 'unavailable' }
}
