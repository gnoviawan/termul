/**
 * Persistence + validation for user-configured ACP agents.
 *
 * Agent configs are stored under a dedicated `persistenceApi` key (versioned
 * JSON) — deliberately NOT in the flat `AppSettings`. Raw secret values are
 * never written here; env values may hold `$VAR` placeholders whose real value
 * lives in OS secure storage.
 */
import { persistenceApi } from '@/lib/api'
import type { AgentConfig } from '@/lib/acp-api'

export const ACP_AGENTS_KEY = 'acp/agents'

/** A persisted agent config carries a stable local id. */
export interface StoredAgentConfig extends AgentConfig {
  id: string
}

export interface AgentConfigValidation {
  valid: boolean
  errors: string[]
}

/** Validate a config for saving: non-empty name and command are required. */
export function validateAgentConfig(cfg: Partial<AgentConfig>): AgentConfigValidation {
  const errors: string[] = []
  if (!cfg.name || cfg.name.trim().length === 0) errors.push('Name is required.')
  if (!cfg.command || cfg.command.trim().length === 0) errors.push('Command is required.')
  return { valid: errors.length === 0, errors }
}

/** True if an env value looks like a secret literal (not a $VAR placeholder). */
export function looksLikeSecretValue(value: string): boolean {
  const v = value.trim()
  if (v.length === 0) return false
  // A $VAR placeholder is safe to persist; anything else of nontrivial length
  // that isn't a placeholder is treated as a potential secret literal.
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return false
  return v.length >= 12
}

/** Load persisted agent configs (empty list when none stored). */
export async function loadAgentConfigs(): Promise<StoredAgentConfig[]> {
  const res = await persistenceApi.read<StoredAgentConfig[]>(ACP_AGENTS_KEY)
  if (res.success && Array.isArray(res.data)) return res.data
  return []
}

/** Persist the full agent-config list. */
export async function saveAgentConfigs(list: StoredAgentConfig[]): Promise<void> {
  const res = await persistenceApi.write(ACP_AGENTS_KEY, list)
  if (!res.success) {
    throw new Error(res.error ?? 'Failed to persist agent configs')
  }
}
