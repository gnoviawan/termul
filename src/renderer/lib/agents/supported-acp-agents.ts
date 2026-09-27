import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import { agentEnvIdentity } from '@/lib/agents/acp-config-identity'
import {
  agentPolicy,
  deriveAgentConfig,
  type ManagedNpmInstallPolicy,
  REGISTRY_AGENTS,
  type RegistryAgent,
  type RegistryBinaryTarget,
  registryOsFromHostOs
} from '@/lib/agents/acp-registry'
import { registryConfigId } from '@/lib/agents/registry-config-id'
import { acpCatalogApi } from '@/lib/api'

const REGISTRY_AGENT_IDS = new Set(REGISTRY_AGENTS.map((agent) => agent.id))

/** Preferred default when no last-selected agent is persisted. */
export const PREFERRED_DEFAULT_ACP_AGENT_IDS = [
  'codex-acp',
  'claude-acp',
  'gemini',
  'cursor',
  'opencode',
  'pi-acp'
] as const

export function pickDefaultSupportedAgent(
  entries: readonly SupportedAcpAgentEntry[]
): SupportedAcpAgentEntry | null {
  for (const id of PREFERRED_DEFAULT_ACP_AGENT_IDS) {
    const match = entries.find((entry) => entry.id === id && entry.status === 'ready')
    if (match) return match
  }
  return entries.find((entry) => entry.status === 'ready') ?? entries[0] ?? null
}

export function filterSupportedAcpAgents(
  entries: readonly SupportedAcpAgentEntry[],
  query: string
): SupportedAcpAgentEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...entries]
  return entries.filter(
    (entry) =>
      entry.agent.name.toLowerCase().includes(q) ||
      entry.agent.id.toLowerCase().includes(q) ||
      entry.agent.description.toLowerCase().includes(q)
  )
}

export interface AcpRuntimeAvailability {
  npx: boolean
  uvx: boolean
}

export type SupportedAcpAgentStatus =
  | 'ready'
  | 'install-required'
  | 'needs-runtime'
  | 'manual-install'
  | 'unavailable'

export interface SupportedAcpAgentInstall {
  kind: 'archive'
  archiveUrl: string
  cmd: string
  args: string[]
  env: Record<string, string>
}

export interface SupportedAcpAgentManagedInstall {
  kind: 'managed-npm'
  package: string
}

export interface SupportedAcpAgentManualInstall {
  cmd: string
  args: string[]
  env: Record<string, string>
}

export interface SupportedAcpAgentEntry {
  id: string
  configId: string
  agent: RegistryAgent
  config: StoredAgentConfig | null
  status: SupportedAcpAgentStatus
  install: SupportedAcpAgentInstall | SupportedAcpAgentManagedInstall | null
  manualInstall: SupportedAcpAgentManualInstall | null
  runtimeLauncher: 'npx' | 'uvx' | null
  unavailableReason: string | null
  /**
   * Host-installed manifest version for binary agents (what the user actually
   * runs). Absent for npx/uvx agents and never-installed binaries. Update
   * detection compares this against the registry version.
   */
  installedVersion?: string
}

/**
 * True for a custom (pasted) agent — distinguished from catalog/registry
 * agents by the *config's* id. Catalog entries use `entry.id = agent.id` (not
 * `acp-registry:`-prefixed at the entry level); only the persisted
 * `StoredAgentConfig.id` carries the `acp-registry:` prefix. Custom agents
 * have a saved `config.id` of `custom-<uuid8>`; catalog agents either have no
 * saved config (derived/hostInstalled → `config.id` is `acp-registry:<id>`) or
 * a catalog override whose `config.id` starts with `acp-registry:`.
 */
export function isCustomAgentEntry(entry: SupportedAcpAgentEntry): boolean {
  return !!entry.config && !entry.config.id.startsWith('acp-registry:')
}

function runtimeUnavailableReason(launcher: 'npx' | 'uvx'): string {
  return launcher === 'npx'
    ? 'Install Node.js so npx is available on your PATH.'
    : 'Install uv so uvx is available on your PATH.'
}

function manualInstallReason(agent: RegistryAgent, cmd: string, args: string[]): string {
  const suffix = args.length > 0 ? ` ${args.join(' ')}` : ''
  return `Install ${agent.name} from the vendor, then ensure \`${cmd}${suffix}\` is on your PATH.`
}

/**
 * True when `config` is a persisted registry launcher for `agentId` still
 * pointing at one of the managed install's LEGACY npm package names — i.e. it
 * must migrate to the host-managed install (S2-TS: package names come from the
 * registry policy, not a hardcoded list).
 */
function isLegacyManagedNpmRegistryConfig(
  config: StoredAgentConfig | undefined,
  agentId: string,
  legacyPackageNames: readonly string[]
): boolean {
  if (!config || config.id !== registryConfigId(agentId) || config.command !== 'npx') {
    return false
  }
  return config.args.some((arg) =>
    legacyPackageNames.some((pkg) => arg === pkg || arg.startsWith(`${pkg}@`))
  )
}

function toStoredConfig(agent: RegistryAgent, config: StoredAgentConfig): StoredAgentConfig
function toStoredConfig(
  agent: RegistryAgent,
  config: Omit<StoredAgentConfig, 'id' | 'templateId'>
): StoredAgentConfig
function toStoredConfig(
  agent: RegistryAgent,
  config: StoredAgentConfig | Omit<StoredAgentConfig, 'id' | 'templateId'>
): StoredAgentConfig {
  return {
    id: registryConfigId(agent.id),
    templateId: agent.id,
    ...config
  }
}

export function installedBinaryConfig(
  agent: RegistryAgent,
  installed: { command: string; args: string[] },
  target: Pick<RegistryBinaryTarget, 'env'> = {}
): StoredAgentConfig {
  return toStoredConfig(agent, {
    configId: registryConfigId(agent.id),
    name: agent.name,
    command: installed.command,
    args: installed.args,
    env: { ...(target.env ?? {}) },
    allowTerminal: false
  })
}

export function manualBinaryConfig(
  agent: RegistryAgent,
  command: string,
  manual: SupportedAcpAgentManualInstall
): StoredAgentConfig {
  return installedBinaryConfig(
    agent,
    { command: command.trim(), args: manual.args },
    { env: manual.env }
  )
}

export function buildSupportedAcpAgents(
  persistedConfigs: readonly StoredAgentConfig[],
  platformArch: string,
  registry: readonly RegistryAgent[] = REGISTRY_AGENTS,
  runtime: AcpRuntimeAvailability | null = null
): SupportedAcpAgentEntry[] {
  const persistedById = new Map(persistedConfigs.map((config) => [config.id, config]))
  const entries: SupportedAcpAgentEntry[] = []

  for (const agent of [...registry].sort((a, b) => a.name.localeCompare(b.name))) {
    const id = agent.id
    const configId = registryConfigId(id)
    const persisted = persistedById.get(configId)
    if (persisted) {
      entries.push({
        id,
        configId,
        agent,
        config: persisted,
        status: 'ready',
        install: null,
        manualInstall: null,
        runtimeLauncher: null,
        unavailableReason: null
      })
      continue
    }

    const derived = deriveAgentConfig(agent, platformArch)
    if (derived.kind === 'runnable') {
      const launcher =
        derived.config.command === 'npx' || derived.config.command === 'uvx'
          ? derived.config.command
          : null
      if (launcher === 'npx' && runtime !== null && !runtime.npx) {
        entries.push({
          id,
          configId,
          agent,
          config: null,
          status: 'needs-runtime',
          install: null,
          manualInstall: null,
          runtimeLauncher: 'npx',
          unavailableReason: runtimeUnavailableReason('npx')
        })
        continue
      }
      if (launcher === 'uvx' && runtime !== null && !runtime.uvx) {
        entries.push({
          id,
          configId,
          agent,
          config: null,
          status: 'needs-runtime',
          install: null,
          manualInstall: null,
          runtimeLauncher: 'uvx',
          unavailableReason: runtimeUnavailableReason('uvx')
        })
        continue
      }
      entries.push({
        id,
        configId,
        agent,
        config: toStoredConfig(agent, derived.config),
        status: 'ready',
        install: null,
        manualInstall: null,
        runtimeLauncher: null,
        unavailableReason: null
      })
      continue
    }
    if (derived.kind === 'needs-install' && derived.archiveUrl) {
      entries.push({
        id,
        configId,
        agent,
        config: null,
        status: 'install-required',
        install: {
          kind: 'archive',
          archiveUrl: derived.archiveUrl,
          cmd: derived.cmd,
          args: derived.args,
          env: derived.env
        },
        manualInstall: null,
        runtimeLauncher: null,
        unavailableReason: null
      })
      continue
    }
    if (derived.kind === 'needs-install') {
      entries.push({
        id,
        configId,
        agent,
        config: null,
        status: 'manual-install',
        install: null,
        manualInstall: {
          cmd: derived.cmd,
          args: derived.args,
          env: derived.env
        },
        runtimeLauncher: null,
        unavailableReason: manualInstallReason(agent, derived.cmd, derived.args)
      })
      continue
    }
    entries.push({
      id,
      configId,
      agent,
      config: null,
      status: 'unavailable',
      install: null,
      manualInstall: null,
      runtimeLauncher: null,
      unavailableReason: 'This agent is not available for your platform.'
    })
  }

  return entries
}

export function isSupportedAcpConfigId(configId: string): boolean {
  const id = configId.startsWith('acp-registry:')
    ? configId.slice('acp-registry:'.length)
    : configId
  return REGISTRY_AGENT_IDS.has(id)
}

/** Compare launch-defining fields when reconciling catalog migrations. */
export function needsPersistedConfigUpdate(
  existing: Pick<StoredAgentConfig, 'command' | 'args' | 'env'> | undefined,
  resolved: Pick<StoredAgentConfig, 'command' | 'args' | 'env'>
): boolean {
  if (!existing) return true
  // Env keys are normalized by the canonical identity comparator
  // (`acp-config-identity.ts`) so insertion-order differences (and the former
  // `localeCompare`-vs-`Object.keys().sort()` drift) never spuriously compare.
  return (
    existing.command !== resolved.command ||
    JSON.stringify(existing.args) !== JSON.stringify(resolved.args) ||
    agentEnvIdentity(existing.env) !== agentEnvIdentity(resolved.env)
  )
}

/**
 * CAP-6 / Story 8: resolve supported ACP agents from the host-resolved
 * catalog. Replaces the renderer-side `buildSupportedAcpAgents(...)` derivation
 * (which used `@tauri-apps/plugin-os` — a desktop-only API) with a call to
 * `acpCatalogApi.listCatalog()`. The host resolves OS/arch/runtime + per-agent
 * `SupportedAcpAgentStatus`; the renderer maps `CatalogAgent` →
 * `SupportedAcpAgentEntry` (preserving the existing export shape so callers
 * like `useAcpAgents` don't change their consumption shape).
 *
 * The existing `buildSupportedAcpAgents(...)` is kept for backward compat
 * (tests + existing callers that pass a platform arch directly); the call
 * sites (`useAcpAgents`, `AgentLauncher`, `AcpAgentsSettings`) switch to this
 * async wrapper.
 */
/**
 * CAP-5: surface persisted custom agents (outside the registry/catalog) as
 * `SupportedAcpAgentEntry` rows alongside catalog/registry agents. A persisted
 * config whose `id` does NOT start with `acp-registry:` is a custom agent pasted
 * via the CustomAcpAgentDialog; it is appended verbatim with a synthesized
 * `RegistryAgent` shell (the AgentRow uses `agent.name` / `agent.description` /
 * `agent.version` for display). `seenConfigIds` lets the caller skip configIds
 * already projected from the catalog loop (including a custom agent whose
 * configId collided with a registry agent — the catalog loop's persisted-wins
 * lookup already consumed it).
 */
function customAgentEntriesFromPersisted(
  persistedConfigs: readonly StoredAgentConfig[],
  seenConfigIds: Set<string> = new Set()
): SupportedAcpAgentEntry[] {
  const entries: SupportedAcpAgentEntry[] = []
  for (const config of persistedConfigs) {
    // Guard against malformed persisted data (null/non-object/id-less) so the
    // merge never crashes on `.startsWith`/`.trim`.
    if (typeof config.id !== 'string' || config.id.length === 0) continue
    if (config.id.startsWith('acp-registry:')) continue
    const configId =
      config.configId && config.configId.trim().length > 0 ? config.configId : config.id
    if (seenConfigIds.has(configId)) continue
    seenConfigIds.add(configId)
    entries.push({
      id: config.id,
      configId,
      agent: {
        id: config.id,
        name: config.name,
        version: '',
        description: '',
        distribution: {}
      },
      config,
      status: 'ready',
      install: null,
      manualInstall: null,
      runtimeLauncher: null,
      unavailableReason: null
    })
  }
  return entries
}

export async function resolveSupportedAcpAgents(
  persistedConfigs: readonly StoredAgentConfig[]
): Promise<SupportedAcpAgentEntry[]> {
  const result = await acpCatalogApi.listCatalog()
  if (!result.success) {
    // Catalog unavailable — still surface persisted custom agents so users can
    // manage/export them without a live catalog fetch (CAP-5).
    return customAgentEntriesFromPersisted(persistedConfigs)
  }
  const catalog = result.data
  // CAP-5 / persisted-wins: look up persisted configs by `configId` (not `id`)
  // so a persisted custom agent whose `configId` collides with a registry
  // agent's `configId` (e.g. a user pasted `configId: "acp-registry:gemini"`)
  // is found here and wins over the catalog version (status 'ready', user's
  // command/args/env). This also finds catalog overrides (whose configId IS
  // `acp-registry:<id>`). Precedence is deterministic regardless of input
  // order: a custom record (id NOT starting with `acp-registry:`) always wins
  // over a registry-backed record sharing the same configId; when two records
  // of the same kind collide on configId, the first-encountered one wins
  // (stable tie-breaker). The selected record then participates in the
  // catalog loop below (it is not suppressed by `seenConfigIds`, which only
  // prevents `customAgentEntriesFromPersisted` from double-appending).
  const persistedByConfigId = new Map<string, StoredAgentConfig>()
  for (const c of persistedConfigs) {
    if (typeof c.id !== 'string' || c.id.length === 0) continue
    const key = c.configId && c.configId.trim().length > 0 ? c.configId : c.id
    const existing = persistedByConfigId.get(key)
    if (!existing) {
      persistedByConfigId.set(key, c)
      continue
    }
    const existingIsCustom = !existing.id.startsWith('acp-registry:')
    const candidateIsCustom = !c.id.startsWith('acp-registry:')
    // Custom always overrides registry-backed (regardless of input order).
    // Same-kind collisions keep the first-encountered record (deterministic).
    if (candidateIsCustom && !existingIsCustom) {
      persistedByConfigId.set(key, c)
    }
  }
  const entries: SupportedAcpAgentEntry[] = []
  const seenConfigIds = new Set<string>()

  for (const agent of catalog.agents) {
    const id = agent.id
    const configId = registryConfigId(id)
    seenConfigIds.add(configId)
    const persisted = persistedByConfigId.get(configId)
    // S2-TS: managed-install behavior comes from the registry policy, not an
    // id comparison. Agents without a managed-npm policy never migrate.
    const installPolicy = agentPolicy(id).install
    const managedInstall: ManagedNpmInstallPolicy | null =
      installPolicy.kind === 'managed-npm' ? installPolicy : null
    const shouldMigrateManagedInstall =
      managedInstall != null &&
      isLegacyManagedNpmRegistryConfig(persisted, id, managedInstall.legacyPackageNames)

    // Map the host-resolved status to the existing SupportedAcpAgentEntry shape.
    // The host already computed the status (ready / install-required /
    // needs-runtime / manual-install / unavailable); we just project it.
    const registryAgent: RegistryAgent = {
      id: agent.id,
      name: agent.name,
      version: agent.version,
      description: agent.description,
      distribution: agent.distribution as RegistryAgent['distribution']
    }

    if (persisted && !shouldMigrateManagedInstall) {
      entries.push({
        id,
        configId,
        agent: registryAgent,
        config: persisted,
        status: 'ready',
        install: null,
        manualInstall: null,
        runtimeLauncher: null,
        unavailableReason: null,
        installedVersion: agent.installed?.version ?? undefined
      })
      continue
    }

    // Derive the install/manualInstall info from the distribution (for
    // binary-distributed agents) — the host reports the status but the
    // renderer still needs the archive URL + cmd for the install UI.
    // The host keeps `host.os` as the raw `std::env::consts::OS` value
    // ("macos" on macOS) for display, but the bundled catalog's binary map
    // keys use "darwin-*". Map "macos" -> "darwin" for the binary-target
    // lookup (mirrors the host's `host_platform_arch()` helper); without this
    // the install/manualInstall cmd would miss every "darwin-*" entry on macOS.
    const binaryMapOs = registryOsFromHostOs(catalog.host.os)
    const derived = deriveAgentConfig(registryAgent, `${binaryMapOs}-${catalog.host.arch}`)

    // The host catalog no longer gates on `sha256` — any HTTPS archive is
    // `install-required` (the trusted Zed registry). The host also overlays
    // installed state: an installed agent is reported `ready` with an
    // `installed` block carrying the host-resolved absolute `command`/`args`.
    // Build the spawn config from that `installed` block so the web client
    // (which has no renderer persistence) can spawn a host-installed agent
    // without a persisted `StoredAgentConfig`. Desktop `persisted` (handled
    // above) still wins when present.
    const hostInstalledConfig =
      agent.status === 'ready' && agent.installed
        ? installedBinaryConfig(
            registryAgent,
            { command: agent.installed.command, args: agent.installed.args },
            { env: derived.kind === 'needs-install' ? derived.env : {} }
          )
        : null

    // Managed-npm agents (S2-TS policy) install through the host's pinned npm
    // cache and never derive an unpinned npx launcher config; their preflight
    // copy lives in the registry policy so the strings stay byte-identical.
    const managedPackage = managedInstall ? (registryAgent.distribution.npx?.package ?? null) : null
    const managedNpmInstall =
      managedInstall && agent.status === 'install-required' && typeof managedPackage === 'string'
        ? { kind: 'managed-npm' as const, package: managedPackage }
        : null
    const managedPreflightReason =
      managedInstall && agent.status === 'needs-runtime'
        ? (catalog.host.runtimes.nodeMajor ?? 0) < managedInstall.minNodeMajor
          ? managedInstall.needsRuntimeOldNodeReason
          : managedInstall.needsRuntimeNoNpmReason
        : managedInstall && agent.status === 'manual-install'
          ? managedInstall.manualInstallReason
          : null

    entries.push({
      id,
      configId,
      agent: registryAgent,
      config:
        hostInstalledConfig ??
        (managedNpmInstall
          ? null
          : !managedInstall && derived.kind === 'runnable'
            ? toStoredConfig(registryAgent, derived.config)
            : null),
      status: agent.status,
      installedVersion: agent.installed?.version ?? undefined,
      install:
        managedNpmInstall ??
        (agent.status === 'install-required' &&
        derived.kind === 'needs-install' &&
        derived.archiveUrl
          ? {
              kind: 'archive',
              archiveUrl: derived.archiveUrl,
              cmd: derived.cmd,
              args: derived.args,
              env: derived.env
            }
          : null),
      manualInstall:
        agent.status === 'manual-install' && derived.kind === 'needs-install'
          ? { cmd: derived.cmd, args: derived.args, env: derived.env }
          : null,
      runtimeLauncher:
        derived.kind === 'runnable' &&
        (derived.config.command === 'npx' || derived.config.command === 'uvx')
          ? (derived.config.command as 'npx' | 'uvx')
          : null,
      // Finding 8: the host may know the exact blocker for a managed install —
      // when it reports one, render it verbatim instead of the renderer-derived
      // copy (the derivation stays as the fallback for an absent field).
      unavailableReason:
        catalog.host.runtimes.unavailableReason ??
        managedPreflightReason ??
        (agent.status === 'unavailable'
          ? 'This agent is not available for your platform.'
          : agent.status === 'needs-runtime'
            ? runtimeUnavailableReason(
                derived.kind === 'runnable' && derived.config.command === 'uvx' ? 'uvx' : 'npx'
              )
            : agent.status === 'manual-install' && derived.kind === 'needs-install'
              ? manualInstallReason(registryAgent, derived.cmd, derived.args)
              : null)
    })
  }

  // CAP-5: append persisted custom agents (outside the registry/catalog) that
  // the catalog loop did not project. A custom agent whose configId collided
  // with a registry agent was already consumed by the configId-keyed persisted
  // lookup above (persisted wins); `seenConfigIds` keeps it from being
  // double-appended here.
  entries.push(...customAgentEntriesFromPersisted(persistedConfigs, seenConfigIds))

  return entries
}
