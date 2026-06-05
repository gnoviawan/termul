/**
 * Unified agent model (GH-289): merge CLI terminal-native agents
 * (`TerminalAgentDefinition`) and enabled ACP agents (`StoredAgentConfig`) into a
 * single protocol-tagged list for the launcher selector.
 *
 * Pure module — no store/native access — so the load-bearing join logic is
 * trivially unit-testable. CLI↔ACP identity is joined on the existing linkage:
 * a CLI built-in's `registryId` matched against an enabled ACP config's
 * `templateId` (ADR-004.6).
 */

import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import { findBundledIconByKey } from '@/lib/agents/agent-icon-catalog'
import type { TerminalAgentDefinition } from '@/lib/agents/agent-registry'

/** Call protocol for a selected agent. */
export type AgentMode = 'cli' | 'acp'

/** A single selector row spanning one or both protocols. */
export interface UnifiedAgentEntry {
  /** Stable, protocol-unambiguous row key. */
  key: string
  /** Display name. */
  name: string
  /** Inline SVG markup when an icon is resolvable. */
  iconSvg?: string
  /** Supported modes, in preference order (cli before acp for dual-mode). */
  modes: AgentMode[]
  /** CLI definition; present iff `modes` includes 'cli'. */
  cli?: TerminalAgentDefinition
  /** Enabled ACP config; present iff `modes` includes 'acp'. */
  acp?: StoredAgentConfig
  /** True for app-shipped CLI built-ins (drives selector grouping). */
  isBuiltIn: boolean
}

/** Persisted last-selection shape (GH-289 extends the legacy `{ agentId }`). */
export interface PersistedSelection {
  agentId: string
  mode: AgentMode
}

/** The ACP join token for a config: its template id, else a per-config token. */
function acpJoinToken(config: StoredAgentConfig): string {
  return config.templateId && config.templateId.length > 0 ? config.templateId : `acp:${config.id}`
}

/** Resolve an inline icon for an ACP config from the bundled catalog. */
function acpIconSvg(config: StoredAgentConfig): string | undefined {
  const token = config.templateId
  if (!token) return undefined
  return findBundledIconByKey(`acp:${token}`)?.svg
}

/**
 * Merge CLI agents and enabled ACP configs into unified rows. A CLI agent whose
 * `registryId` matches an enabled ACP config's join token becomes one dual-mode
 * row; everything else stays single-mode. CLI order is preserved first, then
 * any ACP-only configs in their original order.
 */
export function buildUnifiedAgents(
  cliAgents: readonly TerminalAgentDefinition[],
  acpConfigs: readonly StoredAgentConfig[]
): UnifiedAgentEntry[] {
  const acpByToken = new Map<string, StoredAgentConfig>()
  for (const config of acpConfigs) {
    const token = acpJoinToken(config)
    if (!acpByToken.has(token)) acpByToken.set(token, config)
  }

  const consumed = new Set<string>()
  const usedKeys = new Set<string>()
  const entries: UnifiedAgentEntry[] = []

  // Guarantee a unique, stable row key even if two agents collide on id/token
  // (e.g. a custom agent reusing a built-in's registryId), so the selector never
  // renders duplicate React keys.
  const uniqueKey = (base: string): string => {
    let key = base
    let n = 2
    while (usedKeys.has(key)) key = `${base}#${n++}`
    usedKeys.add(key)
    return key
  }

  for (const cli of cliAgents) {
    const token = cli.registryId
    // Only join an ACP config that hasn't already been claimed by an earlier CLI
    // agent sharing the same token; the rest stay CLI-only.
    const acp = token && !consumed.has(token) ? acpByToken.get(token) : undefined
    if (acp && token) {
      consumed.add(token)
      entries.push({
        key: uniqueKey(`unified:${token}`),
        name: cli.name,
        iconSvg: cli.icon ?? acpIconSvg(acp),
        modes: ['cli', 'acp'],
        cli,
        acp,
        isBuiltIn: cli.isBuiltIn
      })
    } else {
      entries.push({
        key: uniqueKey(`cli:${cli.id}`),
        name: cli.name,
        iconSvg: cli.icon,
        modes: ['cli'],
        cli,
        isBuiltIn: cli.isBuiltIn
      })
    }
  }

  for (const config of acpConfigs) {
    const token = acpJoinToken(config)
    // Skip a config already surfaced via a CLI join, but still render any
    // additional config that merely shares a templateId so it stays reachable.
    if (acpByToken.get(token) === config && consumed.has(token)) continue
    if (!consumed.has(token)) consumed.add(token)
    entries.push({
      key: uniqueKey(`acp:${config.id}`),
      name: config.name,
      iconSvg: acpIconSvg(config),
      modes: ['acp'],
      acp: config,
      isBuiltIn: false
    })
  }

  return entries
}

/** The underlying entity id for a given mode on an entry, if supported. */
export function entryAgentId(entry: UnifiedAgentEntry, mode: AgentMode): string | undefined {
  if (mode === 'cli') return entry.cli?.id
  return entry.acp?.id
}

/** Build the persisted shape for a chosen entry + mode. */
export function selectionToPersisted(
  entry: UnifiedAgentEntry,
  mode: AgentMode
): PersistedSelection | null {
  const agentId = entryAgentId(entry, mode)
  if (!agentId) return null
  return { agentId, mode }
}

/**
 * Normalize a raw persisted value into a `PersistedSelection`, migrating the
 * legacy `{ agentId }` (no mode) to `{ agentId, mode: 'cli' }`. Returns null for
 * missing or malformed input.
 */
export function normalizePersistedSelection(raw: unknown): PersistedSelection | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { agentId?: unknown; mode?: unknown }
  if (typeof obj.agentId !== 'string' || obj.agentId.length === 0) return null
  const mode: AgentMode = obj.mode === 'acp' ? 'acp' : 'cli'
  return { agentId: obj.agentId, mode }
}

/**
 * Resolve a persisted selection against the current entries, returning the
 * matching row key and a mode the row actually supports. Returns null when no
 * entry matches (e.g. the agent was removed).
 */
export function resolveSelection(
  entries: readonly UnifiedAgentEntry[],
  saved: PersistedSelection | null
): { key: string; mode: AgentMode } | null {
  if (!saved) return null
  for (const entry of entries) {
    if (entryAgentId(entry, saved.mode) === saved.agentId) {
      return { key: entry.key, mode: saved.mode }
    }
    // Same underlying id under a different (now-unsupported) mode: fall back to
    // the mode the entry currently supports.
    for (const mode of entry.modes) {
      if (entryAgentId(entry, mode) === saved.agentId) {
        return { key: entry.key, mode }
      }
    }
  }
  return null
}
