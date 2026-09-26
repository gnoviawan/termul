/**
 * Update Check (see CONTEXT.md): advisory per-agent version drift between the
 * version the user would spawn TODAY and a target registry's version. Pure
 * computation — no transport, no persistence, no side effects.
 *
 * The drift basis is the SPAWN basis (the pin in the persisted config for
 * npx/uvx agents, the host-installed manifest version for binary agents), NOT
 * the active registry: once a Remote Snapshot is applied, the active registry
 * tracks the latest fetch, so registry-vs-registry comparison would never see
 * drift again. Registry-level drift (bundled vs remote, for the "N updates
 * available" summary) is `compareRegistryVersions` in `acp-registry.ts`.
 */

import type { RegistryAgent } from '@/lib/agents/acp-registry'

/** Registry-derived config id for a registry agent (matches the catalog). */
function registryConfigId(agentId: string): string {
  return `acp-registry:${agentId}`
}

/** One actionable version drift for an Updatable Agent. */
export interface AgentUpdate {
  agentId: string
  configId: string
  fromVersion: string
  toVersion: string
}

/** The version a user's next spawn would launch, per agent. */
export interface AgentSpawnBasis {
  agentId: string
  /** `undefined` = no persisted state; the next spawn derives fresh (current). */
  spawnVersion?: string
}

/** Minimal entry shape `deriveSpawnBasis` needs (subset of SupportedAcpAgentEntry). */
export interface SupportedAcpAgentEntryLike {
  id: string
  configId: string
  installedVersion?: string
  config: { command: string; args: string[] } | null
}

/**
 * Extract the pinned version from a package-manager launcher invocation:
 * `['-y', 'droid@0.218.1', ...]` → `'0.218.1'`. Handles scoped packages
 * (`@scope/agent@1.2.3`); returns `undefined` for unpinned packages and for
 * commands that are not `npx`/`uvx`.
 */
export function pinnedVersionFromLauncherArgs(
  command: string,
  args: readonly string[]
): string | undefined {
  if (command !== 'npx' && command !== 'uvx') return undefined
  const packageArg = command === 'npx' ? args[1] : args[0]
  if (typeof packageArg !== 'string') return undefined
  const at = packageArg.lastIndexOf('@')
  if (at <= 0) return undefined
  const version = packageArg.slice(at + 1)
  return version.length > 0 ? version : undefined
}

/**
 * Derive the spawn basis for registry agents from their resolved entries:
 * the persisted config pin for npx/uvx agents, the host-installed manifest
 * version for binary agents. Custom agents (config id outside the
 * `acp-registry:` namespace) and agents with no persisted state are omitted —
 * they have no actionable version to update.
 */
export function deriveSpawnBasis(
  entries: readonly SupportedAcpAgentEntryLike[]
): AgentSpawnBasis[] {
  const basis: AgentSpawnBasis[] = []
  for (const entry of entries) {
    if (!entry.configId.startsWith('acp-registry:')) continue
    if (!entry.config) continue
    const pinned = pinnedVersionFromLauncherArgs(entry.config.command, entry.config.args)
    const spawnVersion = pinned ?? entry.installedVersion
    if (!spawnVersion) continue
    basis.push({ agentId: entry.id, spawnVersion })
  }
  return basis
}

export interface DeriveAgentUpdatesParams {
  /** The registry whose versions are the update TARGET (applied or advisory). */
  registry: readonly RegistryAgent[]
  /** The version each agent's next spawn would launch (see `deriveSpawnBasis`). */
  spawnBasis: readonly AgentSpawnBasis[]
}

/**
 * Derive per-agent updates: an agent is flagged when the registry reports a
 * different version than the version the user would spawn today. Agents
 * absent from the registry (or new in it) are not updates.
 */
export function deriveAgentUpdates(params: DeriveAgentUpdatesParams): AgentUpdate[] {
  const { registry, spawnBasis } = params
  const registryById = new Map(registry.map((agent) => [agent.id, agent]))
  const updates: AgentUpdate[] = []
  for (const basis of spawnBasis) {
    const registryAgent = registryById.get(basis.agentId)
    if (!registryAgent || basis.spawnVersion === undefined) continue
    if (basis.spawnVersion === registryAgent.version) continue
    updates.push({
      agentId: basis.agentId,
      configId: registryConfigId(basis.agentId),
      fromVersion: basis.spawnVersion,
      toVersion: registryAgent.version
    })
  }
  return updates
}
