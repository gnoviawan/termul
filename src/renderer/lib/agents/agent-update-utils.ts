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
import { registryConfigId } from '@/lib/agents/registry-config-id'

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

/**
 * Compare dotted numeric versions. Missing parts count as 0.
 * Returns -1 when `current` is older, 0 when equal, 1 when `current` is
 * newer, and null when either version is not a dotted number.
 */
export function compareDottedVersions(current: string, target: string): -1 | 0 | 1 | null {
  const parse = (version: string): bigint[] | null => {
    if (!/^\d+(\.\d+)*$/.test(version)) return null
    return version.split('.').map((part) => BigInt(part))
  }
  const left = parse(current)
  const right = parse(target)
  if (!left || !right) return null
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a < b) return -1
    if (a > b) return 1
  }
  return 0
}

export interface DeriveAgentUpdatesParams {
  /** The registry whose versions are the update TARGET (applied or advisory). */
  registry: readonly RegistryAgent[]
  /** The version each agent's next spawn would launch (see `deriveSpawnBasis`). */
  spawnBasis: readonly AgentSpawnBasis[]
}

/**
 * Derive per-agent updates. An agent is flagged only when the registry
 * version is strictly newer than the version the user would spawn today.
 * Agents absent from the registry (or new in it) are not updates.
 */
export function deriveAgentUpdates(params: DeriveAgentUpdatesParams): AgentUpdate[] {
  const { registry, spawnBasis } = params
  const registryById = new Map(registry.map((agent) => [agent.id, agent]))
  const updates: AgentUpdate[] = []
  for (const basis of spawnBasis) {
    const registryAgent = registryById.get(basis.agentId)
    if (!registryAgent || basis.spawnVersion === undefined) continue
    const order = compareDottedVersions(basis.spawnVersion, registryAgent.version)
    if (order === null || order >= 0) continue
    updates.push({
      agentId: basis.agentId,
      configId: registryConfigId(basis.agentId),
      fromVersion: basis.spawnVersion,
      toVersion: registryAgent.version
    })
  }
  return updates
}
